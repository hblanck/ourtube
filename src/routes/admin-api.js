'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { getDb } = require('../db');
const { scanLocation, scanAllLocations, getScanStatus } = require('../scanner');

const router = express.Router();
const MEDIA_ROOT = path.resolve('/media');

function toPosixPath(p) {
  return p.replace(/\\/g, '/');
}

function isWithinMediaRoot(targetPath) {
  const rel = path.relative(MEDIA_ROOT, targetPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// GET /api/admin/media-root/browse?path=/media/subdir
router.get('/media-root/browse', (req, res) => {
  const requestedPath = typeof req.query.path === 'string' && req.query.path.trim()
    ? req.query.path.trim()
    : MEDIA_ROOT;

  const absolutePath = path.resolve(requestedPath);
  if (!isWithinMediaRoot(absolutePath)) {
    return res.status(400).json({ error: 'Path must be within /media' });
  }

  if (!fs.existsSync(absolutePath)) {
    return res.status(404).json({ error: 'Directory not found' });
  }

  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }

    const directories = fs.readdirSync(absolutePath, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => {
        const dirPath = path.join(absolutePath, entry.name);
        return { name: entry.name, path: toPosixPath(dirPath) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const parentPath = absolutePath === MEDIA_ROOT ? null : path.dirname(absolutePath);

    res.json({
      root: toPosixPath(MEDIA_ROOT),
      current: toPosixPath(absolutePath),
      parent: parentPath && isWithinMediaRoot(parentPath) ? toPosixPath(parentPath) : null,
      directories
    });
  } catch (err) {
    console.error('[admin] Failed to browse media root:', err);
    res.status(500).json({ error: 'Failed to read directory' });
  }
});

// GET /api/admin/locations
router.get('/locations', (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM source_locations ORDER BY created_at DESC').all());
});

// GET /api/admin/skipped-files
router.get('/skipped-files', (req, res) => {
  const db = getDb();
  const { q = '', page = 1, limit = 25 } = req.query;

  const safePage = Math.max(1, parseInt(page) || 1);
  const pageLimit = Math.min(100, Math.max(1, parseInt(limit) || 25));
  const offset = (safePage - 1) * pageLimit;
  const search = `%${String(q).trim()}%`;

  const total = db.prepare(
    `SELECT COUNT(*) as cnt
     FROM skipped_files sf
     LEFT JOIN source_locations sl ON sl.id = sf.source_location_id
     WHERE sf.file_path LIKE ? OR sf.reason LIKE ? OR COALESCE(sl.name, '') LIKE ?`
  ).get(search, search, search).cnt;

  const items = db.prepare(
    `SELECT sf.file_path, sf.reason, sf.first_seen_at, sf.last_seen_at, sf.skip_count,
            sf.source_location_id, sl.name as source_location_name
     FROM skipped_files sf
     LEFT JOIN source_locations sl ON sl.id = sf.source_location_id
     WHERE sf.file_path LIKE ? OR sf.reason LIKE ? OR COALESCE(sl.name, '') LIKE ?
     ORDER BY sf.last_seen_at DESC
     LIMIT ? OFFSET ?`
  ).all(search, search, search, pageLimit, offset);

  res.json({ total, page: safePage, limit: pageLimit, items });
});

// POST /api/admin/locations
router.post('/locations', (req, res) => {
  const db = getDb();
  const { name, path: locPath, type = 'both', scan_interval = 3600 } = req.body;
  if (!name || !locPath) return res.status(400).json({ error: 'name and path are required' });

  const result = db.prepare(
    'INSERT INTO source_locations (name, path, type, scan_interval) VALUES (?, ?, ?, ?)'
  ).run(name, locPath, type, scan_interval);

  res.status(201).json(db.prepare('SELECT * FROM source_locations WHERE id = ?').get(result.lastInsertRowid));
});

// PUT /api/admin/locations/:id
router.put('/locations/:id', (req, res) => {
  const db = getDb();
  const { name, path: locPath, type, scan_interval, enabled } = req.body;
  const loc = db.prepare('SELECT * FROM source_locations WHERE id = ?').get(req.params.id);
  if (!loc) return res.status(404).json({ error: 'Not found' });

  db.prepare(
    `UPDATE source_locations SET
      name = COALESCE(?, name),
      path = COALESCE(?, path),
      type = COALESCE(?, type),
      scan_interval = COALESCE(?, scan_interval),
      enabled = COALESCE(?, enabled)
    WHERE id = ?`
  ).run(name ?? null, locPath ?? null, type ?? null, scan_interval ?? null, enabled ?? null, req.params.id);

  res.json(db.prepare('SELECT * FROM source_locations WHERE id = ?').get(req.params.id));
});

// DELETE /api/admin/locations/:id
router.delete('/locations/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM source_locations WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

// POST /api/admin/locations/:id/scan
router.post('/locations/:id/scan', async (req, res) => {
  const db = getDb();
  const loc = db.prepare('SELECT * FROM source_locations WHERE id = ?').get(req.params.id);
  if (!loc) return res.status(404).json({ error: 'Not found' });

  res.json({ message: 'Scan started', location: loc.name });
  scanLocation(loc).catch(err => console.error('[admin] Scan error:', err));
});

// POST /api/admin/scan/all
router.post('/scan/all', async (req, res) => {
  res.json({ message: 'Full scan started' });
  scanAllLocations().catch(err => console.error('[admin] Full scan error:', err));
});

// GET /api/admin/scan/status
router.get('/scan/status', (req, res) => {
  res.json(getScanStatus());
});

// PUT /api/admin/media/:id
router.put('/media/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const { friendly_name, description, location, year, tags } = req.body;

  db.prepare(
    `UPDATE media SET
      friendly_name = COALESCE(?, friendly_name),
      description = COALESCE(?, description),
      location = ?,
      year = ?,
      tags = COALESCE(?, tags)
    WHERE id = ?`
  ).run(
    friendly_name ?? null,
    description ?? null,
    location !== undefined ? location : row.location,
    year !== undefined ? year : row.year,
    tags !== undefined ? JSON.stringify(Array.isArray(tags) ? tags : []) : null,
    req.params.id
  );

  res.json(db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id));
});

// DELETE /api/admin/media/:id  (removes from index only, does NOT delete source)
router.delete('/media/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM media WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

// POST /api/admin/media/:id/faces
router.post('/media/:id/faces', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT id FROM media WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const { person_name, confidence, bounds } = req.body;
  const result = db.prepare(
    'INSERT INTO faces (media_id, person_name, confidence, bounds) VALUES (?, ?, ?, ?)'
  ).run(req.params.id, person_name || null, confidence || null, JSON.stringify(bounds || {}));

  db.prepare('UPDATE media SET faces_detected = (SELECT COUNT(*) FROM faces WHERE media_id = ?) WHERE id = ?')
    .run(req.params.id, req.params.id);

  res.status(201).json(db.prepare('SELECT * FROM faces WHERE id = ?').get(result.lastInsertRowid));
});

// DELETE /api/admin/faces/:id
router.delete('/faces/:id', (req, res) => {
  const db = getDb();
  const face = db.prepare('SELECT * FROM faces WHERE id = ?').get(req.params.id);
  if (!face) return res.status(404).json({ error: 'Not found' });

  db.prepare('DELETE FROM faces WHERE id = ?').run(req.params.id);
  db.prepare('UPDATE media SET faces_detected = (SELECT COUNT(*) FROM faces WHERE media_id = ?) WHERE id = ?')
    .run(face.media_id, face.media_id);

  res.json({ success: true });
});

// GET /api/admin/settings
router.get('/settings', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json(settings);
});

// PUT /api/admin/settings
router.put('/settings', (req, res) => {
  const db = getDb();
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const insertMany = db.transaction(obj => {
    for (const [key, value] of Object.entries(obj)) {
      upsert.run(key, String(value));
    }
  });
  insertMany(req.body);
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json(settings);
});

// POST /api/admin/media/:id/reindex
router.post('/media/:id/reindex', async (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  res.json({ message: 'Reindex started' });

  const { indexFile } = require('../scanner');
  indexFile(row.file_path, row.source_location_id).catch(err =>
    console.error('[admin] Reindex error:', err)
  );
});

module.exports = router;
