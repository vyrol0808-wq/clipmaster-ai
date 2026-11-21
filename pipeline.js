// ClipMaster AI pipeline: download (yt-dlp), captions, cutting, subtitles, titles.
// Everything here runs real ffmpeg / yt-dlp commands. No placeholder output.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { run, probe, sceneChanges, audioEnergy, silenceIntervals, scoreWindows, trimSilenceEdges, FFMPEG } = require('./analyze');

const YTDLP = process.env.YTDLP_PATH || '/home/hatch/.local/bin/yt-dlp';
const MEDIA = path.join(__dirname, '..', 'media');
const IS_DIRECT_MEDIA = /\.(mp4|webm|mov|mkv|m4v)(\?.*)?$/i;

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout || 15 * 60 * 1000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').slice(-1200);
        return reject(new Error(`${path.basename(cmd)} failed: ${msg}`));
      }
      resolve({ stdout, stderr });
    });
  });
}

// ---------- metadata (no download) ----------
async function fetchMetadata(url) {
  // Direct media file?
  if (/\.(mp4|webm|mov|mkv|m4v)(\?.*)?$/i.test(url)) {
    return {
      url, isDirect: true, title: url.split('/').pop().split('?')[0],
      duration: null, thumbnail: null, formats: ['direct mp4/webm'],
      uploader: null, webpage_url: url,
    };
  }
  const { stdout } = await runCmd(YTDLP, [
    '--dump-json', '--no-playlist', '--no-warnings',
    '--socket-timeout', '30', url,
  ], { timeout: 2 * 60 * 1000 });
  const j = JSON.parse(stdout);
  const formats = [...new Set((j.formats || []).map(f => f.format_note || `${f.height || '?'}p`).filter(Boolean))].slice(0, 12);
  return {
    url, isDirect: false,
    title: j.title || 'Untitled video',
    duration: j.duration || null,
    thumbnail: j.thumbnail || null,
    uploader: j.uploader || j.channel || null,
    webpage_url: j.webpage_url || url,
    is_live: !!j.is_live,
    formats,
  };
}

function formatSelector(quality) {
  // Prefer mp4 video+audio at requested height, fall back gracefully.
  const h = quality === '1080p' ? 1080 : 720;
  return `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`;
}

// ---------- download ----------
// Direct media files download with curl (faster + more reliable than yt-dlp's
// generic extractor); everything else goes through yt-dlp.
function downloadDirect(url, outPath, onProgress) {
  return new Promise((resolve, reject) => {
    const p = spawn('curl', ['-L', '--fail', '--retry', '2', '--connect-timeout', '30', '-o', outPath, url]);
    let errBuf = '';
    p.stderr.on('data', d => { errBuf += d.toString().slice(-1000); });
    p.on('error', reject);
    p.on('close', code => {
      if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 50000) return resolve(outPath);
      reject(new Error(`Direct download failed (curl exit ${code}): ${errBuf.slice(-500) || 'could not fetch the media file'}`));
    });
  });
}

function downloadVideo(url, outPath, quality, onProgress) {
  if (IS_DIRECT_MEDIA.test(url)) return downloadDirect(url, outPath, onProgress);
  return new Promise((resolve, reject) => {
    const args = ['-f', formatSelector(quality), '--no-playlist', '--no-warnings',
      '--merge-output-format', 'mp4', '--no-part', '-o', outPath, url];
    const p = spawn(YTDLP, args);
    let errBuf = '';
    const onData = d => {
      const s = d.toString();
      errBuf += s.slice(-2000);
      const m = s.match(/(\d+(?:\.\d+)?)%/);
      if (m && onProgress) onProgress(parseFloat(m[1]));
    };
    // yt-dlp writes progress to stderr (older) or stdout (newer) — watch both.
    p.stderr.on('data', onData);
    p.stdout.on('data', onData);
    p.on('error', reject);
    p.on('close', code => {
      if (code === 0 && fs.existsSync(outPath)) return resolve(outPath);
      reject(new Error(`yt-dlp download failed (exit ${code}): ${errBuf.slice(-800) || 'unknown error'}`));
    });
  });
}

// Download at most `maxSeconds` of a live stream (captures what's broadcast so far).
function downloadLive(url, outPath, maxSeconds, onProgress) {
  return new Promise((resolve, reject) => {
    const args = ['-f', 'best[height<=720]/best', '--no-playlist', '--no-warnings',
      '--no-part', '--live-from-start', '-o', outPath, url];
    // Cap wall-clock capture time so a live stream can't run forever.
    const p = spawn(YTDLP, args);
    let errBuf = '';
    const timer = setTimeout(() => { try { p.kill('SIGINT'); } catch (_) {} }, (maxSeconds + 45) * 1000);
    p.stderr.on('data', d => { errBuf += d.toString().slice(-2000); });
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => {
      clearTimeout(timer);
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 100000) return resolve(outPath);
      reject(new Error(`Live capture failed (exit ${code}): ${errBuf.slice(-800) || 'no stream data received — the stream may be offline or not retrievable'}`));
    });
  });
}

// ---------- captions (video's own subs; never invented) ----------
async function fetchCaptions(url, workDir) {
  // Try manual subs, then auto subs, English first.
  const base = ['--skip-download', '--no-playlist', '--no-warnings', '--sub-format', 'vtt', '-o', path.join(workDir, 'subs')];
  for (const mode of [['--write-sub', '--sub-lang', 'en.*'], ['--write-auto-sub', '--sub-lang', 'en.*']]) {
    try {
      await runCmd(YTDLP, [...base, ...mode, url], { timeout: 3 * 60 * 1000 });
      const files = fs.readdirSync(workDir).filter(f => f.startsWith('subs') && f.endsWith('.vtt'));
      if (files.length) return path.join(workDir, files[0]);
    } catch (_) { /* try next mode */ }
  }
  return null;
}

function parseVtt(file) {
  if (!file || !fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const cues = [];
  const re = /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\n([\s\S]*?)(?:\n\n|\n$|$)/g;
  let m;
  const toSec = (h, mi, s, ms) => (+h) * 3600 + (+mi) * 60 + (+s) + (+ms) / 1000;
  while ((m = re.exec(text)) !== null) {
    const t = (m[8] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (t) cues.push({ start: toSec(m[1], m[2], m[3], m[4]), end: toSec(m[5], m[6], m[7], m[8]), text: t });
  }
  return cues;
}

// Merge cue lines overlapping [start, end] into one SRT file for the clip.
function writeClipSrt(cues, start, end, outPath) {
  const sel = cues.filter(c => c.end > start && c.start < end);
  if (!sel.length) return null;
  const fmt = s => {
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const sec = String(Math.floor(s % 60)).padStart(2, '0');
    const ms = String(Math.round((s % 1) * 1000)).padStart(3, '0');
    return `${h}:${m}:${sec},${ms}`;
  };
  const body = sel.map((c, i) =>
    `${i + 1}\n${fmt(Math.max(0, c.start - start))} --> ${fmt(Math.max(0, c.end - start))}\n${c.text}\n`).join('\n');
  fs.writeFileSync(outPath, body);
  return outPath;
}

// Title from the caption text inside the window: longest substantive line.
// Never invents quotes — falls back to "Highlight N".
function titleFromCues(cues, start, end, fallback) {
  const lines = cues.filter(c => c.end > start && c.start < end).map(c => c.text);
  const cleaned = lines
    .map(t => t.replace(/\[.*?\]/g, '').trim())
    .filter(t => t.length >= 12 && t.length <= 90 && /[a-zA-Z]{3,}/.test(t));
  if (!cleaned.length) return fallback;
  cleaned.sort((a, b) => b.length - a.length);
  let t = cleaned[0];
  if (t.length > 70) t = t.slice(0, 67).trim() + '…';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ---------- cutting ----------
const FORMAT_SPECS = {
  '9:16': { w: 1080, h: 1920, crop: 'crop=ih*9/16:ih' },
  '16:9': { w: 1920, h: 1080, crop: null },
  '1:1': { w: 1080, h: 1080, crop: 'crop=ih:ih' },
};

function formatFilters(format, quality) {
  const spec = FORMAT_SPECS[format] || FORMAT_SPECS['9:16'];
  const h = quality === '1080p' ? spec.h : Math.round(spec.h * 720 / 1080);
  const w = quality === '1080p' ? spec.w : Math.round(spec.w * 720 / 1080);
  // For 16:9 at 720p: 1280x720. For 9:16 at 720p: 720x1280. For 1:1: 720x720.
  const filters = [];
  if (spec.crop) filters.push(spec.crop);
  filters.push(`scale=${w}:${h}:force_original_aspect_ratio=increase`, `crop=${w}:${h}`, 'setsar=1');
  return filters.join(',');
}

const SUB_STYLES = {
  yellow: "FontName=DejaVu Sans,FontSize=22,Bold=1,PrimaryColour=&H0000FFFF,OutlineColour=&H00000000,Outline=2,Shadow=1,Alignment=2,MarginV=28",
  white: "FontName=DejaVu Sans,FontSize=22,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Shadow=1,Alignment=2,MarginV=28",
};

function escapeSubPath(p) {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

// Cut one clip. start/end are seconds in the source. srtPath optional.
async function cutClip({ src, start, end, out, format, quality, srtPath, subStyle }) {
  const dur = Math.max(1, end - start);
  const vf = [formatFilters(format, quality)];
  if (srtPath) vf.push(`subtitles=filename='${escapeSubPath(srtPath)}':force_style='${SUB_STYLES[subStyle] || SUB_STYLES.white}'`);
  const args = [
    '-ss', String(start), '-t', String(dur), '-i', src,
    '-vf', vf.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart', '-y', out,
  ];
  await run(FFMPEG, args, { timeout: 10 * 60 * 1000 });
  if (!fs.existsSync(out) || fs.statSync(out).size < 10000) throw new Error('ffmpeg produced no usable clip file');
  return out;
}

module.exports = {
  MEDIA, fetchMetadata, downloadVideo, downloadLive, fetchCaptions, parseVtt,
  writeClipSrt, titleFromCues, cutClip, probe, FORMAT_SPECS, SUB_STYLES, formatSelector,
};
