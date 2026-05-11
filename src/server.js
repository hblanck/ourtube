'use strict';

const telemetry = require('./telemetry');
telemetry.init();

const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const morgan = require('morgan');
const schedule = require('node-schedule');
const mime = require('mime-types');
const sharp = require('sharp');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const { initDb, getDb } = require('./db');
const apiRouter = require('./routes/api');
const adminAuthRouter = require('./routes/admin-auth');
const adminApiRouter = require('./routes/admin-api');
const streamRouter = require('./routes/stream');
const { requireAdminAuth } = require('./admin-auth');
const { canAccessFromRow } = require('./visibility');

const PORT = parseInt(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || '/data';

const app = express();
const PLAYBACK_SESSION_COOKIE = 'ourtube_playback_session';

function parseCookies(req) {
  if (req._parsedCookies) return req._parsedCookies;

  const raw = req.headers.cookie || '';
  const out = {};

  raw.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx <= 0) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    out[key] = decodeURIComponent(value);
  });

  req._parsedCookies = out;
  return out;
}

function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.path) parts.push(`Path=${opts.path}`);
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }

  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function getMediaRateLimitKey(req) {
  const cookies = parseCookies(req);
  const adminSession = cookies.ourtube_admin_session || '';
  const playbackSession = req.playbackSessionId || cookies[PLAYBACK_SESSION_COOKIE] || '';
  const sessionPart = adminSession || playbackSession;
  const ip = getClientIp(req);

  // Include route bucket so bursty thumbnail loads do not consume stream budget.
  const routeBucket = req.path.startsWith('/thumbnail/') ? 'thumb' : req.path.startsWith('/photo/') ? 'photo' : 'stream';

  if (sessionPart) return `${routeBucket}|sid:${sessionPart}`;
  return `${routeBucket}|ip:${ip}`;
}

function ensurePlaybackSession(req, res, next) {
  const cookies = parseCookies(req);
  let sessionId = cookies[PLAYBACK_SESSION_COOKIE];

  if (!sessionId) {
    sessionId = crypto.randomBytes(12).toString('base64url');
    res.append('Set-Cookie', serializeCookie(PLAYBACK_SESSION_COOKIE, sessionId, {
      maxAge: 60 * 60 * 24 * 30,
      path: '/',
      sameSite: 'Lax',
      secure: process.env.NODE_ENV === 'production',
    }));
  }

  req.playbackSessionId = sessionId;
  next();
}

function isPhotosFeatureEnabled() {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'photos_enabled'").get();
  return row?.value !== 'false';
}

app.use(cors());
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(ensurePlaybackSession);
app.use((req, _res, next) => { telemetry.recordHttpRequest({ method: req.method }); next(); });

app.use((req, res, next) => {
  if (req.path !== '/photos' && req.path !== '/photos.html') return next();
  if (isPhotosFeatureEnabled()) return next();
  return res.redirect('/');
});

// Rate limiting — generous limits for private home-network use
const apiLimiter = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false });
// Media playback can burst many requests quickly (Safari + 4K range fetches, thumbnail grids).
const streamLimiter = rateLimit({ windowMs: 60_000, limit: 2000, standardHeaders: true, legacyHeaders: false, keyGenerator: getMediaRateLimitKey });
const thumbnailLimiter = rateLimit({ windowMs: 60_000, limit: 1000, standardHeaders: true, legacyHeaders: false, keyGenerator: getMediaRateLimitKey });
const photoLimiter = rateLimit({ windowMs: 60_000, limit: 1000, standardHeaders: true, legacyHeaders: false, keyGenerator: getMediaRateLimitKey });
const adminLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// API routes
app.use('/api', apiLimiter, apiRouter);
app.use('/api/admin/auth', adminLimiter, adminAuthRouter);
app.use('/api/admin', adminLimiter, requireAdminAuth, adminApiRouter);

// Stream route (video streaming with range support)
app.use('/stream', streamLimiter, streamRouter);

// Thumbnail serving
app.get('/thumbnail/:id', thumbnailLimiter, (req, res) => {
  const db = getDb();
  const row = db.prepare(
    `SELECT m.thumbnail_path, m.visibility AS media_visibility, sl.visibility AS source_visibility
       FROM media m
       LEFT JOIN source_locations sl ON sl.id = m.source_location_id
      WHERE m.id = ?`
  ).get(req.params.id);
  if (!row || !row.thumbnail_path) {
    return res.status(404).sendFile(path.join(__dirname, '..', 'public', 'img', 'no-thumb.svg'), err => {
      if (err) res.status(404).end();
    });
  }
  if (!canAccessFromRow(row, req)) return res.status(404).end();
  if (!fs.existsSync(row.thumbnail_path)) return res.status(404).end();
  res.sendFile(row.thumbnail_path);
});

// Photo serving (with optional resize)
app.get('/photo/:id', photoLimiter, async (req, res) => {
  if (!isPhotosFeatureEnabled()) return res.status(404).json({ error: 'Not found' });
  const db = getDb();
  const row = db.prepare(
    `SELECT m.file_path, m.visibility AS media_visibility, sl.visibility AS source_visibility
       FROM media m
       LEFT JOIN source_locations sl ON sl.id = m.source_location_id
      WHERE m.id = ? AND m.type = 'photo'`
  ).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!canAccessFromRow(row, req)) return res.status(404).json({ error: 'Not found' });
  if (!fs.existsSync(row.file_path)) return res.status(404).json({ error: 'File not found' });

  const widthParam = parseInt(req.query.width);

  if (widthParam && widthParam > 0 && widthParam <= 4096) {
    res.setHeader('Content-Type', 'image/jpeg');
    try {
      const buf = await sharp(row.file_path)
        .rotate()
        .resize(widthParam)
        .jpeg({ quality: 85 })
        .toBuffer();
      res.send(buf);
    } catch {
      res.status(500).end();
    }
  } else {
    const mimeType = mime.lookup(row.file_path) || 'image/jpeg';
    res.setHeader('Content-Type', mimeType);
    fs.createReadStream(row.file_path).pipe(res);
  }
});

// SPA fallback for admin
app.get('/admin', adminLimiter, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html'));
});

// Blocked-client status check (used by blocked.html countdown page)
app.get('/api/blocked-status', (req, res) => {
  const { isClientBlocked } = require('./sessions');
  const ip = getClientIp(req);
  const block = isClientBlocked(ip);
  if (!block.blocked) {
    return res.json({ blocked: false });
  }
  return res.json({ blocked: true, unblock_at: block.unblock_at, reason: block.reason });
});

// Initialize database and start server
initDb();

const db = getDb();
const scanOnStartup = db.prepare("SELECT value FROM settings WHERE key = 'scan_on_startup'").get();

if (scanOnStartup && scanOnStartup.value === 'true') {
  const { scanAllLocations } = require('./scanner');
  console.log('[server] Running startup scan...');
  scanAllLocations().catch(err => console.error('[server] Startup scan error:', err));
}

// Schedule periodic scans based on each location's scan_interval
// Check every minute if any location is due for a scan
schedule.scheduleJob('* * * * *', async () => {
  const locations = db.prepare(
    `SELECT * FROM source_locations WHERE enabled = 1
     AND (last_scanned IS NULL OR
          datetime(last_scanned, '+' || scan_interval || ' seconds') <= datetime('now'))`
  ).all();

  if (locations.length === 0) return;

  const { scanLocation } = require('./scanner');
  for (const loc of locations) {
    scanLocation(loc).catch(err => console.error(`[scheduler] Scan error for ${loc.name}:`, err));
  }
});

app.listen(PORT, () => {
  console.log(`[server] OurTube running on http://0.0.0.0:${PORT}`);
  console.log(`[server] Data directory: ${DATA_DIR}`);
});

module.exports = app;
