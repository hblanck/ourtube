# OurTube

A YouTube-like video and photo manager for NAS/SMB libraries, designed for home and family use.

## Features

- 🎬 **Video + Photo indexing** from NAS shares (SMB or any OS-mounted path)
- 📺 **YouTube-like UI** – video grid, search, filters by year/location
- 🎥 **Lightweight video player** (Video.js) with range-based streaming for smooth seeking
- 🔍 **Metadata extraction** – ffprobe (video duration, codec, resolution), EXIF/GPS (photo location & date)
- 👤 **Face detection** (optional) using face-api.js – identify people in photos/video thumbnails
- 🗂 **Admin interface** at `/admin/` – manage source locations, edit metadata, trigger scans
- 🐳 **Docker Compose** ready, image pushed to GHCR.io on every merge to `main`
- 🔒 **Read-only source files** – OurTube never writes to your media library

## Quick Start with Docker Compose

```yaml
# docker-compose.yml
version: '3.8'
services:
  ourtube:
    image: ghcr.io/hblanck/ourtube:latest
    ports:
      - "3000:3000"
    volumes:
      - ourtube-data:/data          # SQLite database + thumbnails
      - /mnt/nas/videos:/media:ro   # Mount your NAS share here (read-only!)
    environment:
      - PORT=3000
      - DATA_DIR=/data
      - FACE_DETECTION_ENABLED=false
    restart: unless-stopped
volumes:
  ourtube-data:
```

```bash
docker compose up -d
```

Then open **http://localhost:3000** in your browser and go to **Admin → Source Locations** to add `/media` (or any path you mounted).

## SMB / NAS Shares

Mount the NAS share on your host OS before starting the container:

```bash
# Linux – mount SMB share
sudo mount -t cifs //nas-server/videos /mnt/nas/videos \
  -o username=user,password=pass,uid=1000,gid=1000,ro

# Then bind-mount that path into docker-compose as shown above
```

## Admin Interface

Open **http://localhost:3000/admin/** to:

- **Source Locations** – Add/edit/delete NAS paths, trigger manual scans
- **Media Library** – Edit display names, descriptions, year, location, tags, and manually add face/person labels
- **Settings** – Configure scan interval, thumbnail size, face detection toggle
- **Dashboard** – View stats and trigger a full scan

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `/data` | Where to store the SQLite database and thumbnails |
| `FACE_DETECTION_ENABLED` | `false` | Enable face detection (requires models in `$DATA_DIR/models/`) |

## Face Detection (Optional)

Face detection uses [`@vladmandic/face-api`](https://github.com/vladmandic/face-api) and requires TensorFlow.js models.

To enable:
1. Download SSD MobileNet v1, Face Landmark 68, and Face Recognition models from the face-api.js model zoo and place them in `$DATA_DIR/models/`
2. Set `FACE_DETECTION_ENABLED=true` in your environment

## Development

```bash
npm install
DATA_DIR=/tmp/ourtube PORT=3000 npm start

# Or with auto-reload:
npm run dev
```

## CI / CD

On every push to `main`, GitHub Actions builds a multi-platform Docker image (`linux/amd64` + `linux/arm64`) and pushes it to `ghcr.io/hblanck/ourtube:latest`.
