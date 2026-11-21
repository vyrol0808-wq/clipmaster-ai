// Highlight detection for ClipMaster AI — no ML models, no fake scores.
// Real signals from ffmpeg:
//   1. Scene changes (select='gt(scene,0.35)') — visual activity.
//   2. Audio energy — EBU R128 momentary loudness (M) bucketed per 5s window.
//   3. Silence — silencedetect, to penalise dead-air windows and trim clip edges.
// Windows of `clipLen` seconds are scored and the best non-overlapping ones win.
const { execFile } = require('child_process');
const path = require('path');

const FFMPEG = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || '/usr/bin/ffprobe';

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout || 10 * 60 * 1000 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(`${cmd} failed: ${(stderr || err.message).slice(-800)}`);
        e.code = err.code;
        return reject(e);
      }
      resolve({ stdout, stderr });
    });
  });
}

async function probe(file) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error', '-show_entries', 'format=duration,size',
    '-show_entries', 'stream=width,height,codec_type,codec_name',
    '-of', 'json', file,
  ]);
  const j = JSON.parse(stdout);
  const v = (j.streams || []).find(s => s.codec_type === 'video') || {};
  return {
    duration: parseFloat(j.format.duration || 0),
    size: parseInt(j.format.size || 0, 10),
    width: v.width || 0,
    height: v.height || 0,
  };
}

// Scene-change timestamps via lavfi metadata.
async function sceneChanges(file) {
  const { stderr } = await run(FFMPEG, [
    '-v', 'info', '-i', file,
    '-vf', "select='gt(scene,0.35)',metadata=print:key=lavfi.scene_score",
    '-f', 'null', '-',
  ]);
  const times = [];
  const re = /pts_time:([0-9.]+)/g;
  let m;
  while ((m = re.exec(stderr)) !== null) times.push(parseFloat(m[1]));
  return times;
}

// EBU R128 momentary loudness per 5s bucket (peak M in the bucket).
async function audioEnergy(file, duration) {
  const { stderr } = await run(FFMPEG, [
    '-v', 'info', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-',
  ]);
  const buckets = {}; // bucketStart -> max M
  const re = /t: ([0-9.]+)\s+TARGET[^M]*M:\s*(-?[0-9.]+)/g;
  let m;
  while ((m = re.exec(stderr)) !== null) {
    const t = parseFloat(m[1]);
    const v = parseFloat(m[2]);
    if (v < -70) continue; // ignore near-silence floor
    const b = Math.floor(t / 5) * 5;
    if (buckets[b] === undefined || v > buckets[b]) buckets[b] = v;
  }
  return buckets; // { bucketStart: peakM }
}

// Silent intervals [start, end] via silencedetect.
async function silenceIntervals(file) {
  const { stderr } = await run(FFMPEG, [
    '-v', 'info', '-i', file,
    '-af', 'silencedetect=noise=-35dB:d=0.6', '-f', 'null', '-',
  ]);
  const out = [];
  const re = /silence_start: ([0-9.]+)[\s\S]*?silence_end: ([0-9.]+)/g;
  let m;
  while ((m = re.exec(stderr)) !== null) out.push([parseFloat(m[1]), parseFloat(m[2])]);
  return out;
}

function silenceFractionIn(intervals, start, end) {
  let s = 0;
  for (const [a, b] of intervals) {
    const lo = Math.max(a, start), hi = Math.min(b, end);
    if (hi > lo) s += hi - lo;
  }
  return s / Math.max(1, end - start);
}

// Score candidate windows of clipLen seconds across the video.
// Returns array of { start, end, score } sorted best-first, non-overlapping.
function scoreWindows({ duration, scenes, energy, silences, clipLen, count }) {
  const step = Math.max(2, Math.floor(clipLen / 3));
  const cands = [];
  for (let start = 0; start + clipLen <= duration; start += step) {
    const end = start + clipLen;
    // Scene changes inside window.
    const sceneCount = scenes.filter(t => t >= start && t < end).length;
    // Mean peak loudness across 5s buckets in window.
    let loudSum = 0, loudN = 0;
    for (let b = Math.floor(start / 5) * 5; b < end; b += 5) {
      if (energy[b] !== undefined) { loudSum += energy[b]; loudN++; }
    }
    const meanLoud = loudN ? loudSum / loudN : -60; // LUFS-ish, higher = louder
    const silFrac = silenceFractionIn(silences, start, end);
    // Normalised-ish score: scenes (0..~20) + loudness (-60..-10 mapped 0..1) - silence penalty.
    const loudScore = Math.max(0, Math.min(1, (meanLoud + 45) / 30));
    const score = sceneCount * 1.0 + loudScore * 8 - silFrac * 10;
    cands.push({ start, end, score, sceneCount, meanLoud, silFrac });
  }
  cands.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const c of cands) {
    if (picked.length >= count) break;
    // Require at least 75% non-overlap with already picked windows, so the
    // clips cover different moments instead of clustering on one peak.
    const overlaps = picked.some(p => Math.min(c.end, p.end) - Math.max(c.start, p.start) > clipLen * 0.25);
    if (!overlaps) picked.push(c);
  }
  // If video too short / few candidates, fall back to evenly spaced windows.
  if (picked.length < count) {
    const span = Math.max(0, duration - clipLen);
    for (let i = picked.length; i < count && span > 0; i++) {
      const start = (span * i) / Math.max(1, count - 1);
      if (!picked.some(p => Math.abs(p.start - start) < clipLen * 0.5)) {
        picked.push({ start, end: start + clipLen, score: 0, sceneCount: 0, meanLoud: -60, silFrac: 0, fallback: true });
      }
    }
  }
  picked.sort((a, b) => a.start - b.start);
  return picked;
}

// Trim leading/trailing silence inside [start, end] using the silence intervals.
// Never trims more than 25% of the clip from either side.
async function trimSilenceEdges(intervals, start, end) {
  const maxTrim = (end - start) * 0.25;
  let s = start, e = end;
  for (const [a, b] of intervals) {
    if (a <= s + 0.05 && b > s && b - s <= maxTrim) s = b; // leading silence
    if (b >= e - 0.05 && a < e && e - a <= maxTrim) e = a; // trailing silence
  }
  if (e - s < 5) return [start, end];
  return [s, e];
}

module.exports = { run, probe, sceneChanges, audioEnergy, silenceIntervals, scoreWindows, trimSilenceEdges, FFMPEG, FFPROBE };
