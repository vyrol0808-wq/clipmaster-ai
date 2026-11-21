# ClipMaster AI — Docker image (Node + ffmpeg + yt-dlp)
FROM node:24-bookworm-slim

ENV NODE_ENV=production
ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV FFPROBE_PATH=/usr/bin/ffprobe

# ffmpeg + curl + python (yt-dlp needs python3 at runtime for some sites)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp standalone binary (pinned-ish: latest stable at build time)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && yt-dlp --version

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .

# Runtime data (projects/jobs) + downloaded media live here; mount a volume in prod
RUN mkdir -p /app/data /app/media
VOLUME ["/app/data", "/app/media"]

EXPOSE 3000
CMD ["node", "server.js"]
