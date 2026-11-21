// ClipMaster AI — Node.js + Express backend.
// Real pipeline: yt-dlp download -> ffmpeg highlight analysis -> ffmpeg clip cutting.
// No fake progress, no placeholder clips: a job reports FAILED with the real error
// if any step fails, and clips only appear after ffmpeg actually writes them.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { load, save, uid } = require('./lib/store');
const P = require('./lib/pipeline');
const A = require('./lib/analyze');

const app = express();
const PORT = process.env.PORT || 3000;
const MEDIA = P.MEDIA;
fs.mkdirSync(MEDIA, { recursive: true });

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(MEDIA));

// ---------- helpers ----------
function getDb() { return load(); }
function putDb(db) { save(db); }

function updateJob(jobId, patch) {
  const db = getDb();
  const j = db.jobs.find(x => x.id === jobId);
  if (j) { Object.assign(j, patch); putDb(db); }
  return j;
}

function safeMediaPath(rel) {
  const p = path.normalize(path.join(MEDIA, rel));
  if (!p.startsWith(MEDIA)) throw new Error('invalid media path');
  return p;
}

// ---------- job queue (one pipeline at a time; others wait) ----------
const queue = [];
let running = false;

function enqueue(jobId) {
  queue.push(jobId);
  pump();
}

async function pump() {
  if (running) return;
  const jobId = queue.shift();
  if (!jobId) return;
  running = true;
  try { await runJob(jobId); } catch (e) { console.error('[job]', jobId, e); }
  running = false;
  pump();
}

// ---------- the real pipeline ----------
async function runJob(jobId) {
  const db = getDb();
  const job = db.jobs.find(j => j.id === jobId);
  if (!job) return;
  const project = db.projects.find(p => p.id === job.projectId);
  const s = project.settings;
  const workDir = path.join(MEDIA, jobId);
  fs.mkdirSync(workDir, { recursive: true });

  const setStage = (stage, progress, message) => {
    updateJob(jobId, { stage, progress, message, status: 'processing' });
    console.log(`[job ${jobId}] ${stage} ${progress}% ${message || ''}`);
  };

  try {
    // ---- 1. download / capture ----
    const srcPath = path.join(workDir, 'source.mp4');
    if (job.kind === 'live') {
      setStage('capturing', 5, 'Capturing live stream…');
      const meta = await P.fetchMetadata(project.url);
      if (meta.is_live) {
        await P.downloadLive(project.url, srcPath, 600, () => {});
        setStage('capturing', 25, 'Live segment captured');
      } else if (meta.duration) {
        setStage('downloading', 5, 'Stream has ended — using the available VOD');
        await P.downloadVideo(project.url, srcPath, s.quality, p => setStage('downloading', Math.round(5 + p * 0.2), `Downloading VOD… ${Math.round(p)}%`));
      } else {
        throw new Error('This URL is not a live stream and has no retrievable video. The stream may be offline, private, or unsupported.');
      }
    } else {
      setStage('downloading', 5, 'Downloading video…');
      await P.downloadVideo(project.url, srcPath, s.quality, p => setStage('downloading', Math.round(5 + p * 0.25), `Downloading… ${Math.round(p)}%`));
    }
    if (!fs.existsSync(srcPath) || fs.statSync(srcPath).size < 50000) {
      throw new Error('Download produced no usable video file. The URL may be private, region-locked, or unsupported.');
    }

    // ---- 2. analyze ----
    setStage('analyzing', 32, 'Reading video info…');
    const info = await A.probe(srcPath);
    if (!info.duration || info.duration < 8) throw new Error(`Video is too short to clip (${info.duration.toFixed(1)}s). Need at least 8 seconds.`);
    const clipLen = Math.min(s.duration, Math.floor(info.duration));
    setStage('analyzing', 38, 'Detecting scene changes…');
    const scenes = await A.sceneChanges(srcPath);
    setStage('analyzing', 46, 'Measuring audio energy…');
    const energy = await A.audioEnergy(srcPath, info.duration);
    setStage('analyzing', 52, 'Finding silence…');
    const silences = await A.silenceIntervals(srcPath);
    setStage('analyzing', 56, 'Scoring highlight windows…');
    const windows = A.scoreWindows({ duration: info.duration, scenes, energy, silences, clipLen, count: 5 });
    if (!windows.length) throw new Error('No highlight windows found in this video.');

    // ---- 3. captions (video's own subs only; honest if none) ----
    setStage('analyzing', 58, 'Fetching captions (if available)…');
    const vttPath = await P.fetchCaptions(project.url, workDir);
    const cues = P.parseVtt(vttPath);
    const hasSubs = cues.length > 0;
    if (!hasSubs) console.log(`[job ${jobId}] no captions available for this video`);

    // ---- 4. cut clips ----
    const clips = [];
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      const [ts, te] = await A.trimSilenceEdges(silences, w.start, w.end);
      const outName = `clip-${i + 1}.mp4`;
      const outPath = path.join(workDir, outName);
      setStage('cutting', Math.round(60 + (i / windows.length) * 38), `Cutting clip ${i + 1} of ${windows.length}…`);
      let srtPath = null;
      if (s.subtitles && hasSubs) {
        srtPath = P.writeClipSrt(cues, ts, te, path.join(workDir, `clip-${i + 1}.srt`));
      }
      await P.cutClip({
        src: srcPath, start: ts, end: te, out: outPath,
        format: s.format, quality: s.quality, srtPath, subStyle: s.subStyle,
      });
      const ci = await A.probe(outPath);
      const title = s.aiTitles
        ? P.titleFromCues(cues, ts, te, `Highlight ${i + 1}`)
        : `Highlight ${i + 1}`;
      const clip = {
        id: uid('clip'), projectId: project.id, jobId,
        title, file: path.join(jobId, outName),
        start: +ts.toFixed(2), end: +te.toFixed(2),
        duration: +ci.duration.toFixed(2),
        width: ci.width, height: ci.height,
        format: s.format, quality: s.quality,
        subtitles: !!(s.subtitles && srtPath), subStyle: s.subStyle,
        score: +w.score.toFixed(2), createdAt: new Date().toISOString(),
      };
      const db2 = getDb();
      db2.clips.push(clip);
      const pr = db2.projects.find(p => p.id === project.id);
      pr.clips = pr.clips || [];
      pr.clips.push(clip.id);
      putDb(db2);
      clips.push(clip);
    }

    const db3 = getDb();
    const pr3 = db3.projects.find(p => p.id === project.id);
    pr3.status = 'completed';
    pr3.sourceDuration = +info.duration.toFixed(1);
    pr3.hasCaptions = hasSubs;
    putDb(db3);
    updateJob(jobId, { stage: 'done', progress: 100, message: `Done — ${clips.length} clips created${hasSubs ? '' : ' (no captions were available for this video)'}`, status: 'done', doneAt: new Date().toISOString() });
  } catch (e) {
    console.error(`[job ${jobId}] FAILED:`, e.message);
    updateJob(jobId, { stage: 'failed', progress: 0, message: e.message, status: 'failed', error: e.message, doneAt: new Date().toISOString() });
    const db4 = getDb();
    const pr4 = db4.projects.find(p => p.id === project.id);
    if (pr4) { pr4.status = 'failed'; pr4.error = e.message; putDb(db4); }
  }
}

// ---------- API ----------
// 1. Fetch metadata for a URL (no download).
app.post('/api/fetch', async (req, res) => {
  const { url } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Please paste a valid http(s) video URL.' });
  try {
    const meta = await P.fetchMetadata(url);
    if (!meta.isDirect && !meta.duration && !meta.is_live) {
      return res.status(422).json({ error: 'Could not read this URL. It may be private, unavailable, or not a supported video page.' });
    }
    if (meta.isDirect) {
      // Probe the direct file quickly with yt-dlp (headers) — duration via a HEAD probe is unreliable;
      // we report duration as unknown and let the pipeline detect it after download.
      meta.note = 'Direct media link — duration will be detected during processing.';
    }
    res.json({ meta });
  } catch (e) {
    const msg = e.message || 'Failed to read this URL.';
    const friendly = /private|login|sign in|age|unavailable|not available|unsupported url/i.test(msg)
      ? 'This video is unavailable, private, or not supported by the downloader. Please try a public video URL.'
      : msg;
    res.status(422).json({ error: friendly });
  }
});

// 2. Create project + start generate job.
app.post('/api/projects', (req, res) => {
  const { url, meta, settings, kind } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL required.' });
  const s = {
    duration: [15, 30, 45, 60, 90].includes(+settings?.duration) ? +settings.duration : 30,
    format: ['9:16', '16:9', '1:1'].includes(settings?.format) ? settings.format : '9:16',
    quality: settings?.quality === '1080p' ? '1080p' : '720p',
    subtitles: settings?.subtitles !== false,
    subStyle: settings?.subStyle === 'yellow' ? 'yellow' : 'white',
    aiTitles: settings?.aiTitles !== false,
  };
  const db = getDb();
  const project = {
    id: uid('proj'), url, kind: kind === 'live' ? 'live' : 'video',
    title: meta?.title || url, thumbnail: meta?.thumbnail || null,
    duration: meta?.duration || null, uploader: meta?.uploader || null,
    settings: s, status: 'queued', clips: [], createdAt: new Date().toISOString(),
  };
  const job = { id: uid('job'), projectId: project.id, kind: project.kind, stage: 'queued', progress: 0, message: 'Waiting to start…', status: 'queued', createdAt: new Date().toISOString() };
  db.projects.unshift(project);
  db.jobs.unshift(job);
  putDb(db);
  enqueue(job.id);
  res.json({ project, job });
});

// 3. Job status (polled by the frontend).
app.get('/api/jobs/:id', (req, res) => {
  const db = getDb();
  const job = db.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  const project = db.projects.find(p => p.id === job.projectId);
  const clips = db.clips.filter(c => c.jobId === job.id);
  res.json({ job, project, clips });
});

// 4. Dashboard stats.
app.get('/api/dashboard', (req, res) => {
  const db = getDb();
  const processing = db.jobs.filter(j => j.status === 'processing' || j.status === 'queued').length;
  res.json({
    totalClips: db.clips.length,
    processing,
    completedClips: db.clips.length,
    totalProjects: db.projects.length,
    downloads: db.downloads.length,
    recentProjects: db.projects.slice(0, 8),
    recentClips: db.clips.slice(-8).reverse(),
    downloadsHistory: db.downloads.slice(-20).reverse(),
  });
});

// 5. Projects.
app.get('/api/projects', (req, res) => res.json({ projects: getDb().projects }));
app.get('/api/projects/:id', (req, res) => {
  const db = getDb();
  const project = db.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  const clips = db.clips.filter(c => c.projectId === project.id);
  const jobs = db.jobs.filter(j => j.projectId === project.id);
  res.json({ project, clips, jobs });
});

// 6. Clip download (logged) — streams the real file.
app.get('/api/clips/:id/download', (req, res) => {
  const db = getDb();
  const clip = db.clips.find(c => c.id === req.params.id);
  if (!clip) return res.status(404).json({ error: 'Clip not found.' });
  const file = safeMediaPath(clip.file);
  if (!fs.existsSync(file)) return res.status(410).json({ error: 'Clip file is no longer on disk.' });
  db.downloads.unshift({ id: uid('dl'), clipId: clip.id, title: clip.title, at: new Date().toISOString(), size: fs.statSync(file).size });
  putDb(db);
  res.download(file, `${clip.title.replace(/[^\w\- ]+/g, '').trim() || 'clip'}.mp4`);
});

// 7. Editor: trim (new start/end relative to current clip, in seconds).
app.post('/api/clips/:id/trim', async (req, res) => {
  const { start, end } = req.body || {};
  const db = getDb();
  const clip = db.clips.find(c => c.id === req.params.id);
  if (!clip) return res.status(404).json({ error: 'Clip not found.' });
  const ns = Math.max(0, +start || 0);
  const ne = Math.min(clip.duration, +end || clip.duration);
  if (ne - ns < 2) return res.status(400).json({ error: 'Trimmed clip must be at least 2 seconds long.' });
  const project = db.projects.find(p => p.id === clip.projectId);
  const jobDir = path.join(MEDIA, clip.jobId);
  const srcPath = path.join(jobDir, 'source.mp4');
  if (!fs.existsSync(srcPath)) return res.status(410).json({ error: 'Source video is no longer available for re-editing.' });
  try {
    const absStart = clip.start + ns, absEnd = clip.start + ne;
    const vttPath = path.join(jobDir, 'subs.en.vtt');
    const cues = P.parseVtt(fs.existsSync(vttPath) ? vttPath : null);
    let srtPath = null;
    if (clip.subtitles && cues.length) srtPath = P.writeClipSrt(cues, absStart, absEnd, path.join(jobDir, `${clip.id}-trim.srt`));
    const outName = `${clip.id}-v${Date.now().toString(36)}.mp4`;
    await P.cutClip({ src: srcPath, start: absStart, end: absEnd, out: path.join(jobDir, outName), format: clip.format, quality: clip.quality, srtPath, subStyle: clip.subStyle });
    const oldFile = safeMediaPath(clip.file);
    clip.file = path.join(clip.jobId, outName);
    clip.start = +absStart.toFixed(2); clip.end = +absEnd.toFixed(2);
    const ci = await A.probe(path.join(jobDir, outName));
    clip.duration = +ci.duration.toFixed(2); clip.width = ci.width; clip.height = ci.height;
    putDb(db);
    try { fs.unlinkSync(oldFile); } catch (_) {}
    res.json({ clip });
  } catch (e) { res.status(500).json({ error: 'Trim failed: ' + e.message }); }
});

// 8. Editor: retitle.
app.post('/api/clips/:id/retitle', (req, res) => {
  const { title } = req.body || {};
  const db = getDb();
  const clip = db.clips.find(c => c.id === req.params.id);
  if (!clip) return res.status(404).json({ error: 'Clip not found.' });
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title cannot be empty.' });
  clip.title = title.trim().slice(0, 120);
  putDb(db);
  res.json({ clip });
});

// 9. Editor: reformat / subtitle toggle (re-render from source).
app.post('/api/clips/:id/reformat', async (req, res) => {
  const { format, quality, subtitles, subStyle } = req.body || {};
  const db = getDb();
  const clip = db.clips.find(c => c.id === req.params.id);
  if (!clip) return res.status(404).json({ error: 'Clip not found.' });
  const project = db.projects.find(p => p.id === clip.projectId);
  const jobDir = path.join(MEDIA, clip.jobId);
  const srcPath = path.join(jobDir, 'source.mp4');
  if (!fs.existsSync(srcPath)) return res.status(410).json({ error: 'Source video is no longer available for re-editing.' });
  try {
    const nf = ['9:16', '16:9', '1:1'].includes(format) ? format : clip.format;
    const nq = quality === '1080p' ? '1080p' : '720p';
    const nsub = subtitles === undefined ? clip.subtitles : !!subtitles;
    const nstyle = subStyle === 'yellow' ? 'yellow' : 'white';
    const vttPath = path.join(jobDir, 'subs.en.vtt');
    const cues = P.parseVtt(fs.existsSync(vttPath) ? vttPath : null);
    let srtPath = null;
    if (nsub && cues.length) srtPath = P.writeClipSrt(cues, clip.start, clip.end, path.join(jobDir, `${clip.id}-re.srt`));
    const outName = `${clip.id}-v${Date.now().toString(36)}.mp4`;
    await P.cutClip({ src: srcPath, start: clip.start, end: clip.end, out: path.join(jobDir, outName), format: nf, quality: nq, srtPath, subStyle: nstyle });
    const oldFile = safeMediaPath(clip.file);
    clip.file = path.join(clip.jobId, outName);
    clip.format = nf; clip.quality = nq; clip.subtitles = !!srtPath; clip.subStyle = nstyle;
    const ci = await A.probe(path.join(jobDir, outName));
    clip.width = ci.width; clip.height = ci.height;
    putDb(db);
    try { fs.unlinkSync(oldFile); } catch (_) {}
    res.json({ clip });
  } catch (e) { res.status(500).json({ error: 'Re-render failed: ' + e.message }); }
});

// 10. Download history.
app.get('/api/downloads', (req, res) => res.json({ downloads: getDb().downloads.slice(0, 50) }));

// SPA fallback (Express 5: use a middleware, not a '*' route).
app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n  ClipMaster AI running at http://localhost:${PORT}\n  Media dir: ${MEDIA}\n`);
});
