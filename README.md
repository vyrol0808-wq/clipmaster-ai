# ClipMaster AI

Paste a video URL → get multiple short, ready-to-edit clips. A real full-stack
product: Node.js + Express backend, vanilla JS frontend (Tailwind via CDN),
FFmpeg + yt-dlp for the actual video work. No API keys required.

## How it works (real pipeline, nothing faked)

1. **Fetch** — `yt-dlp --dump-json` reads the URL's title, duration, thumbnail
   and formats (YouTube and any other yt-dlp-supported site, plus direct .mp4 links).
2. **Download** — the video is downloaded server-side at the requested quality
   (720p / 1080p).
3. **Analyze — highlight detection (scene + audio energy)**:
   - scene-change detection (`select='gt(scene,0.35)'`),
   - EBU R128 momentary loudness bucketed per 5 seconds,
   - `silencedetect` to penalise dead air and to trim silence at clip edges.
   The best-scoring non-overlapping windows win. Up to 5 clips.
4. **Cut** — FFmpeg cuts each clip and converts it to the chosen format
   (9:16 / 16:9 / 1:1) at the chosen quality.
5. **Subtitles** — the video's *own* captions are fetched with yt-dlp
   (`--write-sub` / `--write-auto-sub`), converted to SRT and burned in with
   the chosen style. If a video has no captions, the UI says so honestly and
   the clips are made without them.
6. **Titles** — taken from the spoken caption lines inside each clip window;
   falls back to "Highlight N". Quotes are never invented.

Progress is real: the job endpoint reports `fetching → downloading →
analyzing → cutting clip i/N → done` with a percentage. Any failed step
reports `FAILED` with the real error — a clip is only listed after FFmpeg
has actually written it to disk.

**Live streams:** paste a live URL and ClipMaster captures up to the first
10 minutes broadcast so far, then runs the same pipeline. If the stream has
already ended, the available VOD is used instead. If the URL isn't live and
has no retrievable video, it reports that clearly.

## Run it

```bash
cd clipmaster-ai
npm install
npm start
# open http://localhost:3000
```

Requirements: Node 18+, FFmpeg 8+ at `/usr/bin/ffmpeg`, and the standalone
yt-dlp binary (this project uses the absolute path
`/home/hatch/.local/bin/yt-dlp` — edit `lib/pipeline.js` `YTDLP` if yours
lives elsewhere).

## API

| Method | Endpoint | What it does |
|---|---|---|
| POST | `/api/fetch` | Metadata for a URL (title, duration, thumbnail, formats) |
| POST | `/api/projects` | Create project + start a generate job |
| GET | `/api/jobs/:id` | Real job status + progress + clips so far |
| GET | `/api/dashboard` | Stats, recent projects/clips, download history |
| GET | `/api/projects` / `/api/projects/:id` | Project list / detail with clips |
| GET | `/api/clips/:id/download` | Stream the clip file (logged in download history) |
| POST | `/api/clips/:id/trim` | Re-cut with new start/end (server-side, from source) |
| POST | `/api/clips/:id/retitle` | Rename a clip |
| POST | `/api/clips/:id/reformat` | Re-render in another format / toggle subtitles |
| GET | `/api/downloads` | Download history |

## Data

All state lives in `data/db.json` (projects, jobs, clips, download log).
Videos and clips live under `media/<jobId>/`. No database server needed.

## Honest limitations

- Clipping only works on videos yt-dlp can legally access (public videos;
  private / login-walled / DRM content fails with a clear error).
- "AI" here = highlight detection from scene changes + audio energy + the
  video's own captions. No speech-to-text model runs locally (no Whisper
  downloads), so subtitle availability depends on the source video.
- Live capture is capped at 10 minutes per job.
- One pipeline job runs at a time; further jobs queue.
- Users must only clip videos they own or are authorized to use, and must
  respect copyright and platform terms (shown in the UI).
