// ClipMaster AI frontend — vanilla JS, polls real job progress.
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

const state = {
  meta: null,
  settings: { duration: 30, format: '9:16', quality: '720p', subtitles: true, subStyle: 'white', aiTitles: true },
  pollTimer: null,
  livePollTimer: null,
  editorClip: null,
};

function fmtDur(sec) {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m ? `${m}m ${s}s` : `${s}s`;
}
function fmtBytes(n) {
  if (!n) return '';
  return (n / 1048576).toFixed(1) + ' MB';
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------- views ----------
function showView(name) {
  $$('.view').forEach(v => v.classList.add('hidden'));
  const el = $('#view-' + name);
  if (el) el.classList.remove('hidden');
  $$('.navlink').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'dashboard') loadDashboard();
  if (name === 'projects') loadProjects();
  if (name === 'downloads') loadDownloads();
  window.scrollTo({ top: 0 });
}
$$('.navlink').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));

// ---------- settings pills ----------
function bindPills(containerId, key) {
  const c = document.getElementById(containerId);
  c.addEventListener('click', e => {
    const btn = e.target.closest('[data-v]');
    if (!btn) return;
    c.querySelectorAll('[data-v]').forEach(x => x.classList.remove('active'));
    btn.classList.add('active');
    state.settings[key] = key === 'duration' ? +btn.dataset.v : btn.dataset.v;
  });
}
bindPills('durPills', 'duration');
bindPills('fmtPills', 'format');
bindPills('qPills', 'quality');
bindPills('subPills', 'subStyle');
bindPills('editorFmt', 'format');

function toggleSetting(key, el) {
  el.classList.toggle('on');
  state.settings[key] = el.classList.contains('on');
  if (key === 'subtitles') $('#subStyleRow').style.display = state.settings.subtitles ? '' : 'none';
}

// ---------- fetch video ----------
async function fetchVideo() {
  const url = $('#urlInput').value.trim();
  const err = $('#fetchError'), load = $('#fetchLoading'), card = $('#videoCard');
  err.classList.add('hidden'); card.classList.add('hidden'); $('#settingsCard').classList.add('hidden');
  if (!url) { err.textContent = 'Paste a video URL first.'; err.classList.remove('hidden'); return; }
  load.classList.remove('hidden');
  $('#fetchBtn').disabled = true;
  try {
    const r = await fetch('/api/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Failed to read this URL.');
    state.meta = j.meta;
    $('#videoTitle').textContent = j.meta.title;
    $('#videoMeta').textContent = [j.meta.uploader, j.meta.duration ? 'Duration: ' + fmtDur(j.meta.duration) : null, j.meta.is_live ? '🔴 LIVE' : null].filter(Boolean).join(' · ');
    $('#videoFormats').textContent = j.meta.formats?.length ? 'Formats: ' + j.meta.formats.join(', ') : '';
    const th = $('#videoThumb');
    if (j.meta.thumbnail) { th.src = j.meta.thumbnail; th.style.display = ''; } else { th.style.display = 'none'; }
    card.classList.remove('hidden');
    $('#settingsCard').classList.remove('hidden');
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
  } finally {
    load.classList.add('hidden');
    $('#fetchBtn').disabled = false;
  }
}

// ---------- generate ----------
async function generateClips() {
  const url = $('#urlInput').value.trim();
  if (!state.meta) { $('#fetchError').textContent = 'Fetch the video first.'; $('#fetchError').classList.remove('hidden'); return; }
  const btn = $('#genBtn');
  btn.disabled = true;
  $('#clipsSection').classList.add('hidden');
  $('#progressCard').classList.remove('hidden');
  $('#jobError').classList.add('hidden');
  try {
    const r = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, meta: state.meta, settings: state.settings, kind: 'video' }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Could not start the job.');
    pollJob(j.job.id, false);
  } catch (e) {
    showJobError(e.message);
    btn.disabled = false;
  }
}

function showJobError(msg) {
  const el = $('#jobError');
  el.textContent = '❌ ' + msg;
  el.classList.remove('hidden');
  $('#progressStage').textContent = 'Failed';
}

function clipCard(c) {
  const badge = c.subtitles ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-200">CC</span>' : '';
  return `<div class="clip-card glass rounded-2xl overflow-hidden fade-in">
    <video src="/media/${esc(c.file)}" controls playsinline preload="metadata" class="w-full aspect-video object-cover"></video>
    <div class="p-4">
      <div class="font-semibold text-sm leading-snug">${esc(c.title)} ${badge}</div>
      <div class="text-xs text-white/45 mt-1">${esc(c.format)} · ${esc(c.quality)} · ${fmtDur(c.duration)} · ${fmtDur(c.start)}–${fmtDur(c.end)} in source</div>
      <div class="flex gap-2 mt-3">
        <a href="/api/clips/${c.id}/download" class="flex-1 text-center bg-emerald-500/80 hover:bg-emerald-500 text-xs font-semibold px-3 py-2 rounded-lg">⬇ Download</a>
        <button onclick="openEditor('${c.id}')" class="flex-1 bg-white/10 hover:bg-white/15 text-xs font-semibold px-3 py-2 rounded-lg border border-white/10">✏️ Edit</button>
      </div>
    </div>
  </div>`;
}

function pollJob(jobId, isLive) {
  const bar = isLive ? $('#liveBar') : $('#progressBar');
  const pct = isLive ? $('#livePct') : $('#progressPct');
  const stage = isLive ? $('#liveStage') : $('#progressStage');
  const msg = isLive ? $('#liveMsg') : $('#progressMsg');
  const badge = $('#jobBadge');
  const tick = async () => {
    try {
      const r = await fetch('/api/jobs/' + jobId);
      const j = await r.json();
      const job = j.job;
      bar.style.width = job.progress + '%';
      pct.textContent = job.progress + '%';
      stage.textContent = ({ queued: 'Queued…', downloading: 'Downloading…', capturing: 'Capturing live stream…', analyzing: 'Analyzing highlights…', cutting: 'Cutting clips…', done: 'Done ✓', failed: 'Failed' })[job.stage] || job.stage;
      msg.textContent = job.message || '';
      badge.classList.remove('hidden');
      badge.textContent = job.status === 'done' ? '✓ Job complete' : job.status === 'failed' ? '✗ Job failed' : `⏳ ${job.stage} ${job.progress}%`;
      if (job.status === 'done') {
        clearInterval(state.pollTimer); clearInterval(state.livePollTimer);
        $('#genBtn') && ($('#genBtn').disabled = false);
        $('#liveBtn') && ($('#liveBtn').disabled = false);
        badge.textContent = '✓ Job complete';
        renderClips(j.clips, isLive);
        if (j.project && j.project.hasCaptions === false) $('#capsNote').classList.remove('hidden');
        loadDashboard();
        return;
      }
      if (job.status === 'failed') {
        clearInterval(state.pollTimer); clearInterval(state.livePollTimer);
        $('#genBtn') && ($('#genBtn').disabled = false);
        $('#liveBtn') && ($('#liveBtn').disabled = false);
        if (!isLive) showJobError(job.error || job.message || 'Processing failed.');
        else { const e = $('#liveError'); e.textContent = '❌ ' + (job.error || job.message); e.classList.remove('hidden'); }
        badge.textContent = '✗ Job failed';
        return;
      }
    } catch (e) { /* keep polling */ }
  };
  tick();
  const timer = setInterval(tick, 1500);
  if (isLive) state.livePollTimer = timer; else state.pollTimer = timer;
}

function renderClips(clips, isLive) {
  const grid = isLive ? $('#liveClips') : $('#clipsGrid');
  const section = isLive ? null : $('#clipsSection');
  if (!clips.length) return;
  grid.innerHTML = clips.map(clipCard).join('');
  if (section) {
    section.classList.remove('hidden');
    $('#clipsCount').textContent = `(${clips.length} clips)`;
  }
}

// ---------- live ----------
async function startLive() {
  const url = $('#liveUrlInput').value.trim();
  const err = $('#liveError');
  err.classList.add('hidden');
  if (!url) { err.textContent = 'Paste a live stream URL first.'; err.classList.remove('hidden'); return; }
  $('#liveBtn').disabled = true;
  $('#liveProgress').classList.remove('hidden');
  $('#liveClips').innerHTML = '';
  try {
    const r = await fetch('/api/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Could not read this URL.');
    const r2 = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, meta: j.meta, settings: { ...state.settings, duration: 30 }, kind: 'live' }) });
    const j2 = await r2.json();
    if (!r2.ok) throw new Error(j2.error || 'Could not start the live job.');
    pollJob(j2.job.id, true);
  } catch (e) {
    err.textContent = '❌ ' + e.message;
    err.classList.remove('hidden');
    $('#liveBtn').disabled = false;
  }
}

// ---------- dashboard / projects / downloads ----------
async function loadDashboard() {
  try {
    const j = await (await fetch('/api/dashboard')).json();
    $('#statClips').textContent = j.totalClips;
    $('#statProcessing').textContent = j.processing;
    $('#statDone').textContent = j.completedClips;
    $('#statDownloads').textContent = j.downloads;
    $('#dashProjects').innerHTML = j.recentProjects.length ? j.recentProjects.map(p => `
      <div class="flex items-center gap-3 bg-black/20 border border-white/5 rounded-xl px-3 py-2.5 cursor-pointer hover:border-violet-400/40" onclick="openProject('${p.id}')">
        <span>${p.kind === 'live' ? '🔴' : '🎬'}</span>
        <span class="flex-1 min-w-0 truncate">${esc(p.title)}</span>
        <span class="text-xs px-2 py-0.5 rounded-full ${p.status === 'completed' ? 'bg-emerald-500/15 text-emerald-300' : p.status === 'failed' ? 'bg-red-500/15 text-red-300' : 'bg-amber-500/15 text-amber-300'}">${esc(p.status)}</span>
      </div>`).join('') : '<div class="text-white/40">No projects yet — create your first clips!</div>';
    $('#dashClips').innerHTML = j.recentClips.length ? j.recentClips.map(c => `
      <div class="flex items-center gap-3 bg-black/20 border border-white/5 rounded-xl px-3 py-2.5">
        <span class="flex-1 min-w-0 truncate">${esc(c.title)}</span>
        <span class="text-white/40 text-xs">${esc(c.format)} · ${fmtDur(c.duration)}</span>
        <a href="/api/clips/${c.id}/download" class="text-emerald-300 hover:underline text-xs">Download</a>
      </div>`).join('') : '<div class="text-white/40">No clips yet.</div>';
  } catch (_) {}
}

async function loadProjects() {
  const j = await (await fetch('/api/projects')).json();
  $('#projectsList').innerHTML = j.projects.length ? j.projects.map(p => `
    <div class="glass rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center gap-3 cursor-pointer hover:border-violet-400/40" onclick="openProject('${p.id}')">
      ${p.thumbnail ? `<img src="${esc(p.thumbnail)}" class="w-full sm:w-40 rounded-xl object-cover">` : ''}
      <div class="flex-1 min-w-0">
        <div class="font-bold truncate">${esc(p.title)}</div>
        <div class="text-xs text-white/45 mt-1">${p.kind === 'live' ? '🔴 Live' : '🎬 Video'} · ${p.settings.format} · ${p.settings.duration}s clips · ${p.settings.quality} · ${new Date(p.createdAt).toLocaleString()}</div>
        ${p.error ? `<div class="text-xs text-red-300 mt-1">Failed: ${esc(p.error)}</div>` : ''}
      </div>
      <span class="text-xs px-2.5 py-1 rounded-full ${p.status === 'completed' ? 'bg-emerald-500/15 text-emerald-300' : p.status === 'failed' ? 'bg-red-500/15 text-red-300' : 'bg-amber-500/15 text-amber-300'}">${esc(p.status)} · ${(p.clips || []).length} clips</span>
    </div>`).join('') : '<div class="glass rounded-2xl p-6 text-white/50">No projects yet. Go to <b class="text-white">New Clips</b> and paste a video URL.</div>';
}

async function openProject(id) {
  const j = await (await fetch('/api/projects/' + id)).json();
  $('#detailTitle').textContent = j.project.title;
  $('#detailMeta').textContent = `${j.project.kind === 'live' ? '🔴 Live' : '🎬 Video'} · ${j.project.settings.format} · ${j.project.settings.duration}s clips · ${j.project.settings.quality} · ${new Date(j.project.createdAt).toLocaleString()}`;
  $('#detailClips').innerHTML = j.clips.length ? j.clips.map(clipCard).join('') : '<div class="glass rounded-2xl p-6 text-white/50 col-span-full">No clips yet for this project.</div>';
  showView('project');
}

async function loadDownloads() {
  const j = await (await fetch('/api/downloads')).json();
  $('#downloadsList').innerHTML = j.downloads.length ? j.downloads.map(d => `
    <div class="glass rounded-xl px-4 py-3 flex items-center gap-3">
      <span>⬇</span><span class="flex-1 truncate">${esc(d.title)}</span>
      <span class="text-white/40 text-xs">${fmtBytes(d.size)} · ${new Date(d.at).toLocaleString()}</span>
    </div>`).join('') : '<div class="glass rounded-2xl p-6 text-white/50">No downloads yet.</div>';
}

// ---------- editor ----------
let editorClip = null;
async function openEditor(clipId) {
  const all = await (await fetch('/api/projects')).json();
  let clip = null;
  for (const p of all.projects) {
    const d = await (await fetch('/api/projects/' + p.id)).json();
    clip = d.clips.find(c => c.id === clipId);
    if (clip) break;
  }
  if (!clip) { alert('Clip not found.'); return; }
  editorClip = clip;
  $('#editorVideo').src = '/media/' + clip.file;
  $('#editorTitle').value = clip.title;
  $('#trimStart').value = 0;
  $('#trimEnd').value = clip.duration;
  const range = $('#trimRange');
  range.max = clip.duration; range.value = clip.duration;
  $('#trimLabel').textContent = `0s – ${clip.duration.toFixed(1)}s (clip is ${clip.duration.toFixed(1)}s)`;
  $$('#editorFmt [data-v]').forEach(b => b.classList.toggle('active', b.dataset.v === clip.format));
  $('#editorSubToggle').classList.toggle('on', !!clip.subtitles);
  $('#editorDownload').onclick = () => { window.location.href = '/api/clips/' + clip.id + '/download'; };
  const msg = $('#editorMsg'); msg.classList.add('hidden');
  $('#editorModal').classList.remove('hidden');
}
function closeEditor() { $('#editorModal').classList.add('hidden'); $('#editorVideo').pause(); }
$('#trimRange').addEventListener('input', e => { $('#trimEnd').value = e.target.value; });

async function editorPost(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Request failed.');
  return j;
}
function editorMsg(text, ok) {
  const m = $('#editorMsg');
  m.textContent = text;
  m.className = 'text-xs rounded-xl px-3 py-2 ' + (ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300');
  m.classList.remove('hidden');
}
async function saveTitle() {
  try {
    const j = await editorPost(`/api/clips/${editorClip.id}/retitle`, { title: $('#editorTitle').value });
    editorClip = j.clip;
    editorMsg('✓ Title saved.', true);
    loadDashboard();
  } catch (e) { editorMsg('❌ ' + e.message, false); }
}
async function applyTrim() {
  try {
    editorMsg('⏳ Re-cutting from source…', true);
    const j = await editorPost(`/api/clips/${editorClip.id}/trim`, { start: +$('#trimStart').value, end: +$('#trimEnd').value });
    editorClip = j.clip;
    $('#editorVideo').src = '/media/' + j.clip.file;
    $('#trimEnd').value = j.clip.duration;
    editorMsg('✓ Trim applied — clip re-cut server-side.', true);
    loadDashboard();
  } catch (e) { editorMsg('❌ ' + e.message, false); }
}
async function applyFormat() {
  try {
    const fmt = $('#editorFmt .pill.active')?.dataset.v || editorClip.format;
    editorMsg('⏳ Re-rendering in ' + fmt + '…', true);
    const j = await editorPost(`/api/clips/${editorClip.id}/reformat`, { format: fmt, subtitles: $('#editorSubToggle').classList.contains('on') });
    editorClip = j.clip;
    $('#editorVideo').src = '/media/' + j.clip.file;
    editorMsg('✓ Re-rendered in ' + fmt + (j.clip.subtitles ? ' with subtitles.' : ' (no captions available).'), true);
    loadDashboard();
  } catch (e) { editorMsg('❌ ' + e.message, false); }
}
$('#editorModal').addEventListener('click', e => { if (e.target.id === 'editorModal') closeEditor(); });

// init
loadDashboard();
