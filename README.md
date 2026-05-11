# OurTube

A YouTube-like video and photo manager for NAS/SMB libraries, designed for home and family use.

## Features

- 🎬 **Video + Photo indexing** from NAS shares (SMB or any OS-mounted path)
- 📺 **YouTube-like UI** – video grid, search, filters by year/location
- 🎥 **Lightweight video player** (Video.js) with range-based streaming for smooth seeking
- 🔍 **Metadata extraction** – ffprobe (video duration, codec, resolution), EXIF/GPS (photo location & date)
- 👤 **Face detection** (optional) using face-api.js – identify people in photos/video thumbnails
- 🎞 **Stitch video clips** – automatically group video clips from the same directory as a single playable item.  Great for raw dumps of clips from devices like camcorders.
- 📊 **Engagement metrics** – track views, identify popular items, and monitor library usage in the admin dashboard
- 🗂 **Admin interface** at `/admin/` – manage source locations, edit metadata, trigger scans, view audit logs
- 🔐 **Key-based admin mode** – end users stay unauthenticated while admin tasks require unlocking with an admin key
- 👁️ **Role-based visibility controls** – restrict selected videos to admin-only view, hide from public browsing
- 🚫 **Block/disable client connections** – manage problematic clients by IP, with optional temporary or permanent blocks
- 📝 **Admin audit logs** – track all administrative actions (visibility changes, client blocks, etc.) for accountability
- 📡 **OpenTelemetry support** (optional) – export traces and metrics to any OTLP-compatible collector for monitoring
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

Open **http://localhost:3000/admin/** to manage your library:

### Admin Dashboard

- **Dashboard** – View library stats, engagement metrics (total views, average views, viewed items), and trigger a full scan
- **System Info** – Monitor server health, uptime, and resource usage

### Media Management

- **Source Locations** – Add/edit/delete NAS paths, trigger manual scans, manage batch visibility for entire collections
- **Media Library** – Edit display names, descriptions, year, location, tags, and manually add face/person labels
- **Settings** – Configure scan interval, thumbnail size, face detection toggle, and manage admin API keys

### Visibility & Access Control

Control who can see your media with role-based visibility:
- `all` – visible to everyone (public)
- `admin` – visible only when admin mode is unlocked (restricted to admins)
- `none` – hidden from normal browsing/playback (still manageable by admins in the Admin UI)

Use **Media Library** to set visibility on individual items, or **Source Locations** to apply visibility to all indexed media in a collection.

Admin bulk tools:
- Media Library supports multi-select + bulk visibility updates for selected rows, plus quick visibility filters (All/Admin only/None)
- Source Locations supports applying a visibility value to all indexed media in a collection, with an option to also update the collection visibility itself

### Session & Client Management

- **Active Sessions** – Monitor playback sessions, see client IPs and last activity
- **Blocked Clients** – View and manage blocked client IPs; blocks can be permanent or temporary (with optional auto-unblock time); optionally log the reason for blocking
- **Recent Activity** – Audit log showing all administrative actions (visibility changes, client blocks, key management, etc.) with timestamps and the admin key that performed the action

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
| `OTEL_COLLECTOR_OTLP_GRPC_HOST_PORT` | `4317` | Host port published for OpenTelemetry OTLP gRPC |
| `OTEL_COLLECTOR_OTLP_HTTP_HOST_PORT` | `4318` | Host port published for OpenTelemetry OTLP HTTP |
| `OTEL_COLLECTOR_PROMETHEUS_EXPORTER_HOST_PORT` | `9464` | Host port published for OpenTelemetry Prometheus exporter |
| `JAEGER_UI_HOST_PORT` | `16686` | Host port published for Jaeger UI |
| `PROMETHEUS_HOST_PORT` | `9090` | Host port published for Prometheus UI |
| `GRAFANA_HOST_PORT` | `3001` | Host port published for Grafana UI |

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

## Engagement Metrics

OurTube tracks view counts for all media items, allowing you to understand what's being watched in your library. Access engagement metrics in the **Admin → Dashboard** to see:

- **Total views** – aggregate view count across the entire library
- **Items with views** – how many videos/photos have been watched at least once
- **Average views per viewed item** – mean engagement for items that have been viewed
- **Videos/photos viewed** – breakdown by media type

View counts are automatically incremented each time media is played. This data helps identify popular content and monitor library usage over time.

## Face Detection (Optional)

Face detection uses [`@vladmandic/face-api`](https://github.com/vladmandic/face-api) and requires TensorFlow.js models.

To enable:
1. Download SSD MobileNet v1, Face Landmark 68, and Face Recognition models from the face-api.js model zoo and place them in `$DATA_DIR/models/`
2. Set `FACE_DETECTION_ENABLED=true` in your environment

## Stitch Video Clips

OurTube can automatically group related video clips into a single playable item. When you organize video clips in subdirectories within a source location, the **Stitch** feature treats all clips in that group as chapters of one logical video.

**How it works:**
- Enable stitching for a source location when adding/editing it in **Admin → Source Locations**
- Place related video clips in subdirectories (e.g., `/media/events/wedding/clip1.mp4`, `/media/events/wedding/clip2.mp4`)
- The system automatically groups clips by their parent directory and creates a virtual stitched item
- Users can play through all clips sequentially as one video with chapter transitions

This is useful for:
- Events split across multiple recording files (weddings, conferences, sports events)
- Series of short clips that should be presented as a single episode
- Any scenario where related clips should be viewed together

The stitched item retains metadata from the first clip and supports all standard playback features including subtitles and streaming.

## Admin Audit Logs

All administrative actions in OurTube are logged to the audit trail for security and accountability. From **Admin → Recent Activity**, you can view:

- **Timestamp** – When the action was performed
- **Action** – What was done (e.g., `media.visibility.change`, `session.block`, `key.create`, etc.)
- **Admin key** – Which API key/admin performed the action
- **Metadata** – Details about the action (affected media IDs, IP addresses, etc.)

Audit logs help you:
- Track who made visibility changes and when
- Monitor client blocks and their reasons
- Verify administrative compliance and security changes
- Investigate suspicious activity or changes

Logs are stored persistently in the database and are not automatically pruned.

## Development

```bash
npm install
DATA_DIR=/tmp/ourtube PORT=3000 npm start

# Or with auto-reload:
npm run dev
```

## CI / CD

On every push to `main`, GitHub Actions builds a multi-platform Docker image (`linux/amd64` + `linux/arm64`) and pushes it to `ghcr.io/hblanck/ourtube:latest`.
