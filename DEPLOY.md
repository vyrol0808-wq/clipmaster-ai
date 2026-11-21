# Deploying ClipMaster AI — make it live on the internet

ClipMaster AI is a **long-running video-processing server**: it downloads whole
videos and runs FFmpeg on them. That decides where it can run.

## ❌ Where NOT to deploy

- **Vercel / Netlify** — serverless functions time out after seconds/minutes,
  have no FFmpeg or yt-dlp, and no persistent disk. Not suitable.

## ✅ Option 1 — Render (easiest, Docker)

1. Push this folder to a GitHub repo.
2. In Render: **New → Web Service → Build from your repo → Docker**.
3. Render auto-detects the `Dockerfile`. Set:
   - **Plan:** Free (works for testing, but see limits below).
   - **Disk:** add a persistent disk mounted at `/app/media` (1 GB is enough
     to start; videos are deleted only when you clean them).
   - **Port:** 3000 (already in the Dockerfile).
4. Deploy → you get a `https://clipmaster-ai.onrender.com` URL.

**Free-tier limits to know:** the free instance sleeps after ~15 min of no
traffic (first request after that takes ~1 min to wake up), and it has
~512 MB RAM / shared CPU, so one 1080p job at a time is realistic. Paid
Starter (~$7/mo) removes the sleeping.

## ✅ Option 2 — Railway or Fly.io

Same idea, also Docker-based:

- **Railway:** New Project → Deploy from GitHub → it builds the Dockerfile.
  Add a volume at `/app/media`. Give the service 1 GB RAM if you can.
- **Fly.io:** `fly launch` (pick the Dockerfile), then
  `fly volumes create media --size 2` and mount it at `/app/media` in
  `fly.toml`. `fly deploy`.

Both stay awake on their cheapest paid tiers (~$5/mo) and are a good fit.

## ✅ Option 3 — Cheap VPS (most control, ~$4–6/mo)

Any Ubuntu 22.04/24.04 VPS (Hetzner, DigitalOcean, Linode…):

```bash
# 1. Install the stack
sudo apt update && sudo apt install -y nodejs npm ffmpeg curl python3 git
sudo npm install -g pm2
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp

# 2. Get the code and run it
git clone <your-repo> clipmaster-ai && cd clipmaster-ai
npm install
pm2 start server.js --name clipmaster
pm2 save && pm2 startup   # auto-restart on reboot

# 3. Put it behind HTTPS (optional but recommended)
sudo apt install -y nginx certbot python3-certbot-nginx
# point your domain at the VPS, then:
sudo certbot --nginx -d yourdomain.com
# nginx: proxy_pass http://127.0.0.1:3000;
```

PM2 keeps the server alive and restarts it if it crashes. Check logs with
`pm2 logs clipmaster`.

## Production notes

- **Disk:** each job downloads a source video + 5 clips. Watch `/app/media`
  and clean old `source.mp4` files regularly (a small cron job works).
- **One job at a time:** the app queues jobs by design — on a small server
  that's a feature, not a bug.
- **Legal:** only clip videos you own or are authorized to use. Some
  platforms' terms restrict downloading; the app surfaces a clear error for
  private/unavailable videos.
- **No secrets needed:** there are no API keys in this project.
