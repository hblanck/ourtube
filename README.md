# OurTube

A YouTube-like video and photo manager for NAS/SMB libraries, designed for home and family use.

## Features

- 🎬 **Video + Photo indexing** from NAS shares (SMB or any OS-mounted path)
- 📺 **YouTube-like UI** – video grid, search, filters by year/location
- 🎥 **Lightweight video player** (Video.js) with range-based streaming for smooth seeking
- 🔍 **Metadata extraction** – ffprobe (video duration, codec, resolution), EXIF/GPS (photo location & date)
- 👤 **Face detection** (optional) using face-api.js – identify people in photos/video thumbnails
- 🗂 **Admin interface** at `/admin/` – manage source locations, edit metadata, trigger scans
- 🔐 **Key-based admin mode** – end users stay unauthenticated while admin tasks require unlocking with an admin key
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
      - ${NAS_SHARE_PATH:-/mnt/nas/videos}:/media:ro   # Mount your NAS share here (read-only!)
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

For development with automatic image rebuild/restart when app files change:

```bash
docker compose up --watch
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

Visibility controls are available for both media items and source locations:
- `all` – visible to everyone
- `admin` – visible only when admin mode is unlocked
- `none` – hidden from normal browsing/playback (still manageable by admins in the Admin UI)

Admin bulk tools:
- Media Library supports multi-select + bulk visibility updates for selected rows, plus quick visibility filters (All/Admin only/None).
- Source Locations supports applying a visibility value to all indexed media in a collection, with an option to also update the collection visibility itself.
- Settings includes a Recent Admin Activity table showing audit-log entries for bulk visibility actions.

### Admin Key Bootstrap

Admin APIs are protected by key-based authentication. End-user browsing and playback stay open.

Create the first key from CLI:

```bash
npm run admin:key:create
```

When running in Docker:

```bash
docker compose exec ourtube npm run admin:key:create
```

The command prints a key once. Use the **🔐 Admin** button in the main UI header to unlock admin mode.

After unlocking, manage keys in **Admin → Settings → Admin Keys** (create, rename, revoke).

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `/data` | Where to store the SQLite database and thumbnails |
| `NAS_SHARE_PATH` | `/mnt/nas/videos` | Host path to your mounted NAS/media share |
| `FACE_DETECTION_ENABLED` | `false` | Enable face detection (requires models in `$DATA_DIR/models/`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | _(unset)_ | Base URL of your OTLP/HTTP collector – setting this enables OpenTelemetry |
| `OTEL_SERVICE_NAME` | `ourtube` | Service name reported to the collector |
| `OTEL_SDK_DISABLED` | `false` | Set to `true` to explicitly disable the SDK even if an endpoint is set |
| `OTEL_LOG_LEVEL` | _(unset)_ | Set to `debug` to enable verbose OpenTelemetry SDK logging |

## OpenTelemetry (Observability)

OurTube includes built-in [OpenTelemetry](https://opentelemetry.io/) support for traces and metrics. It is **disabled by default** and only activates when `OTEL_EXPORTER_OTLP_ENDPOINT` is set to a non-empty value.

**To enable**, point it at any OTLP/HTTP-compatible collector (OpenTelemetry Collector, Grafana Alloy, Jaeger, etc.):

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 DATA_DIR=/data node src/server.js
```

Or in Docker Compose:

```yaml
environment:
  - OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
  - OTEL_SERVICE_NAME=ourtube
```

The SDK automatically appends `/v1/traces` and `/v1/metrics` to the base URL, so **do not include a path** in the endpoint value.

**Custom metrics exported:**

| Metric | Description |
|---|---|
| `ourtube.http.requests.total` | Total HTTP requests handled |
| `ourtube.scans.total` | Total library scans completed |
| `ourtube.stream.requests.total` | Total video/photo stream requests |
| `ourtube.stream.bytes_sent` | Total bytes sent via streaming |

Metrics are pushed to the collector every 60 seconds. Traces use Node.js auto-instrumentation (HTTP, Express, SQLite, etc.).

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
