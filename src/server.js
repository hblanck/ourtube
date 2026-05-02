'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const morgan = require('morgan');
const schedule = require('node-schedule');
const mime = require('mime-types');
const sharp = require('sharp');
const rateLimit = require('express-rate-limit');

const { initDb, getDb } = require('./db');
const apiRouter = require('./routes/api');
const adminApiRouter = require('./routes/admin-api');
const streamRouter = require('./routes/stream');

const PORT = parseInt(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || '/data';

const app = express();

app.use(cors());
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Rate limiting — generous limits for private home-network use
const apiLimiter = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false });
const streamLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });
const adminLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// API routes
app.use('/api', apiLimiter, apiRouter);
app.use('/api/admin', adminLimiter, adminApiRouter);

// Stream route (video streaming with range support)
app.use('/stream', streamLimiter, streamRouter);

// Thumbnail serving
app.get('/thumbnail/:id', streamLimiter, (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT thumbnail_path FROM media WHERE id = ?').get(req.params.id);
  if (!row || !row.thumbnail_path) {
    return res.status(404).sendFile(path.join(__dirname, '..', 'public', 'img', 'no-thumb.jpg'), err => {
      if (err) res.status(404).end();
    });
  }
  if (!fs.existsSync(row.thumbnail_path)) return res.status(404).end();
  res.sendFile(row.thumbnail_path);
});

// Photo serving (with optional resize)
app.get('/photo/:id', streamLimiter, async (req, res) => {
  const db = getDb();
  const row = db.prepare("SELECT file_path FROM media WHERE id = ? AND type = 'photo'").get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
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
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html'));
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
