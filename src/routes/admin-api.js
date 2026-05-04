'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { getDb } = require('../db');
const { scanLocation, scanAllLocations, getScanStatus } = require('../scanner');
const { getActiveSessions } = require('../sessions');
const { normalizeVisibility } = require('../visibility');
const { parseVirtualMediaId, getStitchGroupPath } = require('../virtual-media');

const router = express.Router();
const MEDIA_ROOT = path.resolve('/media');
const MEDIA_FILE_EXTENSIONS = new Set([
  'mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp',
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'tif', 'heic', 'webp', 'raw', 'arw', 'cr2', 'nef'
]);

function logAdminAudit(db, req, action, metadata) {
  try {
    db.prepare(
      'INSERT INTO admin_audit_log (action, actor_key_id, metadata) VALUES (?, ?, ?)'
    ).run(
      action,
      req.adminSession?.keyId || null,
      JSON.stringify(metadata || {})
    );
  } catch (err) {
    console.warn('[admin] Failed to write audit log:', err.message);
  }
}

function toPosixPath(p) {
  return p.replace(/\\/g, '/');
}

function isWithinMediaRoot(targetPath) {
  const rel = path.relative(MEDIA_ROOT, targetPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isMediaFilePath(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  return MEDIA_FILE_EXTENSIONS.has(ext);
}

function normalizeEntriesInput(entries, fallbackPath) {
  const raw = Array.isArray(entries)
    ? entries
    : (typeof fallbackPath === 'string' && fallbackPath.trim()
      ? [{ path: fallbackPath.trim(), type: 'directory' }]
      : []);

  const seen = new Set();
  const normalized = [];

  for (const entry of raw) {
    const entryPath = String(entry?.path || '').trim();
    if (!entryPath) continue;

    const key = entryPath.toLowerCase();
    if (seen.has(key)) continue;

    const requestedType = String(entry?.type || '').toLowerCase();
    let entryType = requestedType === 'file' || requestedType === 'directory' ? requestedType : 'directory';

    try {
      const stat = fs.statSync(entryPath);
      entryType = stat.isFile() ? 'file' : 'directory';
    } catch {
      // Keep requested type for paths that are currently unavailable.
    }

    seen.add(key);
    normalized.push({ path: entryPath, type: entryType });
  }

  return normalized;
}

function getLocationsWithEntries(db) {
  const locations = db.prepare('SELECT * FROM source_locations ORDER BY created_at DESC').all();
  const entryRows = db.prepare(
    `SELECT source_location_id, entry_path, entry_type
     FROM source_location_entries
     ORDER BY id ASC`
  ).all();

  const byLocation = new Map();
  for (const row of entryRows) {
    const list = byLocation.get(row.source_location_id) || [];
    list.push({ path: row.entry_path, type: row.entry_type });
    byLocation.set(row.source_location_id, list);
  }

  return locations.map(location => {
    const entries = byLocation.get(location.id) || [];
    if (!entries.length && location.path) {
      entries.push({ path: location.path, type: 'directory' });
    }
    return { ...location, entries };
  });
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

    const files = fs.readdirSync(absolutePath, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => {
        const filePath = path.join(absolutePath, entry.name);
        return { name: entry.name, path: toPosixPath(filePath) };
      })
      .filter(file => isMediaFilePath(file.path))
      .sort((a, b) => a.name.localeCompare(b.name));

    const parentPath = absolutePath === MEDIA_ROOT ? null : path.dirname(absolutePath);

    res.json({
      root: toPosixPath(MEDIA_ROOT),
      current: toPosixPath(absolutePath),
      parent: parentPath && isWithinMediaRoot(parentPath) ? toPosixPath(parentPath) : null,
      directories,
      files
    });
  } catch (err) {
    console.error('[admin] Failed to browse media root:', err);
    res.status(500).json({ error: 'Failed to read directory' });
  }
});

// GET /api/admin/locations
router.get('/locations', (req, res) => {
  const db = getDb();
  res.json(getLocationsWithEntries(db));
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
  const {
    name,
    path: locPath,
    entries,
    type = 'both',
    visibility = 'all',
    scan_interval = 3600,
    stitch_directories = 0,
  } = req.body;
  const normalizedEntries = normalizeEntriesInput(entries, locPath);
  if (!name || !normalizedEntries.length) {
    return res.status(400).json({ error: 'name and at least one path entry are required' });
  }

  const createTx = db.transaction(() => {
    const firstPath = normalizedEntries[0].path;
    const result = db.prepare(
      'INSERT INTO source_locations (name, path, type, visibility, scan_interval, stitch_directories) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(name, firstPath, type, normalizeVisibility(visibility), scan_interval, stitch_directories ? 1 : 0);

    const locationId = Number(result.lastInsertRowid);
    const insertEntry = db.prepare(
      'INSERT INTO source_location_entries (source_location_id, entry_path, entry_type) VALUES (?, ?, ?)'
    );

    for (const entry of normalizedEntries) {
      insertEntry.run(locationId, entry.path, entry.type);
    }

    return locationId;
  });

  const locationId = createTx();
  const location = getLocationsWithEntries(db).find(row => row.id === locationId);
  res.status(201).json(location);
});

// PUT /api/admin/locations/:id
router.put('/locations/:id', (req, res) => {
  const db = getDb();
  const { name, path: locPath, entries, type, visibility, scan_interval, enabled, stitch_directories } = req.body;
  const loc = db.prepare('SELECT * FROM source_locations WHERE id = ?').get(req.params.id);
  if (!loc) return res.status(404).json({ error: 'Not found' });

  const hasEntriesPayload = Array.isArray(entries) || (typeof locPath === 'string' && locPath.trim());
  const normalizedEntries = hasEntriesPayload ? normalizeEntriesInput(entries, locPath) : null;
  if (hasEntriesPayload && !normalizedEntries.length) {
    return res.status(400).json({ error: 'at least one path entry is required' });
  }

  const updateTx = db.transaction(() => {
    const nextPath = normalizedEntries?.[0]?.path || loc.path;
    db.prepare(
      `UPDATE source_locations SET
        name = COALESCE(?, name),
        path = ?,
        type = COALESCE(?, type),
        visibility = COALESCE(?, visibility),
        scan_interval = COALESCE(?, scan_interval),
        stitch_directories = COALESCE(?, stitch_directories),
        enabled = COALESCE(?, enabled)
      WHERE id = ?`
    ).run(
      name ?? null,
      nextPath,
      type ?? null,
      visibility !== undefined ? normalizeVisibility(visibility) : null,
      scan_interval ?? null,
      stitch_directories ?? null,
      enabled ?? null,
      req.params.id
    );

    if (normalizedEntries) {
      db.prepare('DELETE FROM source_location_entries WHERE source_location_id = ?').run(req.params.id);
      const insertEntry = db.prepare(
        'INSERT INTO source_location_entries (source_location_id, entry_path, entry_type) VALUES (?, ?, ?)'
      );
      for (const entry of normalizedEntries) {
        insertEntry.run(req.params.id, entry.path, entry.type);
      }
    }
  });

  updateTx();
  const location = getLocationsWithEntries(db).find(row => row.id === Number(req.params.id));
  res.json(location);
});

// DELETE /api/admin/locations/:id
router.delete('/locations/:id', (req, res) => {
  const db = getDb();
  const locationId = parseInt(req.params.id, 10);
  if (!Number.isInteger(locationId)) return res.status(400).json({ error: 'Invalid id' });

  const loc = db.prepare('SELECT id FROM source_locations WHERE id = ?').get(locationId);
  if (!loc) return res.status(404).json({ error: 'Not found' });

  const mediaRows = db.prepare(
    'SELECT id, thumbnail_path FROM media WHERE source_location_id = ?'
  ).all(locationId);

  const faceRows = db.prepare(
    `SELECT f.face_thumbnail_path
       FROM faces f
       JOIN media m ON m.id = f.media_id
      WHERE m.source_location_id = ?`
  ).all(locationId);

  const deleteTx = db.transaction(() => {
    db.prepare('DELETE FROM media WHERE source_location_id = ?').run(locationId);
    db.prepare('DELETE FROM skipped_files WHERE source_location_id = ?').run(locationId);
    db.prepare('DELETE FROM source_locations WHERE id = ?').run(locationId);
  });

  deleteTx();

  // Best-effort cleanup for generated assets stored on disk.
  const filesToDelete = [
    ...mediaRows.map(r => r.thumbnail_path),
    ...faceRows.map(r => r.face_thumbnail_path),
  ].filter(Boolean);

  for (const filePath of filesToDelete) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
      console.warn('[admin] Failed to delete derived asset:', filePath, err.message);
    }
  }

  res.json({
    success: true,
    removedMedia: mediaRows.length,
    removedDerivedFiles: filesToDelete.length,
  });
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

// GET /api/admin/active-sessions
router.get('/active-sessions', (req, res) => {
  res.json(getActiveSessions());
});

// PUT /api/admin/media/:id
router.put('/media/:id', (req, res) => {
  const db = getDb();

  const { friendly_name, description, location, year, tags, visibility } = req.body;

  // Handle virtual (stitched) media IDs — update all constituent segment rows
  const virtualRef = parseVirtualMediaId(req.params.id);
  if (virtualRef) {
    const segmentRows = db.prepare(
      `SELECT m.*, sl.stitch_directories, sl.path AS source_location_path,
              (SELECT sle.entry_path FROM source_location_entries sle
                WHERE sle.source_location_id = m.source_location_id
                  AND sle.entry_type = 'directory'
                  AND (m.file_path = sle.entry_path OR m.file_path LIKE sle.entry_path || '/%')
                ORDER BY LENGTH(sle.entry_path) DESC LIMIT 1) AS source_entry_path,
              (SELECT sle.entry_type FROM source_location_entries sle
                WHERE sle.source_location_id = m.source_location_id
                  AND sle.entry_type = 'directory'
                  AND (m.file_path = sle.entry_path OR m.file_path LIKE sle.entry_path || '/%')
                ORDER BY LENGTH(sle.entry_path) DESC LIMIT 1) AS source_entry_type
         FROM media m
         LEFT JOIN source_locations sl ON sl.id = m.source_location_id
        WHERE m.source_location_id = ? AND m.type = 'video'`
    ).all(virtualRef.sourceLocationId);

    const matchingSegments = segmentRows.filter(
      row => getStitchGroupPath(row) === virtualRef.groupPath
    );
    if (!matchingSegments.length) return res.status(404).json({ error: 'Not found' });

    const tagsJson = tags !== undefined
      ? JSON.stringify(Array.isArray(tags) ? tags : [])
      : null;
    const normVisibility = visibility !== undefined ? normalizeVisibility(visibility) : null;

    const update = db.prepare(
      `UPDATE media SET
        friendly_name = COALESCE(?, friendly_name),
        description = COALESCE(?, description),
        location = COALESCE(?, location),
        year = COALESCE(?, year),
        tags = COALESCE(?, tags),
        visibility = COALESCE(?, visibility)
      WHERE id = ?`
    );
    const updateAll = db.transaction(segments => {
      for (const seg of segments) {
        update.run(
          friendly_name ?? null,
          description ?? null,
          location !== undefined ? location : null,
          year !== undefined ? year : null,
          tagsJson,
          normVisibility,
          seg.id
        );
      }
    });
    updateAll(matchingSegments);

    return res.json({ id: req.params.id, updated: matchingSegments.length });
  }

  // Regular (non-virtual) media
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  db.prepare(
    `UPDATE media SET
      friendly_name = COALESCE(?, friendly_name),
      description = COALESCE(?, description),
      location = ?,
      year = ?,
      tags = COALESCE(?, tags),
      visibility = COALESCE(?, visibility)
    WHERE id = ?`
  ).run(
    friendly_name ?? null,
    description ?? null,
    location !== undefined ? location : row.location,
    year !== undefined ? year : row.year,
    tags !== undefined ? JSON.stringify(Array.isArray(tags) ? tags : []) : null,
    visibility !== undefined ? normalizeVisibility(visibility) : null,
    req.params.id
  );

  res.json(db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id));
});

// POST /api/admin/media/bulk-visibility
router.post('/media/bulk-visibility', (req, res) => {
  const db = getDb();
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(id => String(id || '').trim()).filter(Boolean) : [];
  const visibility = normalizeVisibility(req.body?.visibility);

  if (!ids.length) return res.status(400).json({ error: 'ids is required' });

  const placeholders = ids.map(() => '?').join(', ');
  const result = db.prepare(
    `UPDATE media
        SET visibility = ?
      WHERE id IN (${placeholders})`
  ).run(visibility, ...ids);

  logAdminAudit(db, req, 'media.bulk_visibility', {
    visibility,
    requestedIds: ids.length,
    updated: result.changes,
    sampleIds: ids.slice(0, 10),
  });

  res.json({ success: true, updated: result.changes, visibility });
});

// POST /api/admin/locations/:id/media-visibility
router.post('/locations/:id/media-visibility', (req, res) => {
  const db = getDb();
  const locationId = parseInt(req.params.id, 10);
  if (!Number.isInteger(locationId)) return res.status(400).json({ error: 'Invalid id' });

  const loc = db.prepare('SELECT id FROM source_locations WHERE id = ?').get(locationId);
  if (!loc) return res.status(404).json({ error: 'Not found' });

  const visibility = normalizeVisibility(req.body?.visibility);
  const updateSource = req.body?.update_source_visibility === true || req.body?.update_source_visibility === 1;

  const tx = db.transaction(() => {
    const mediaResult = db.prepare(
      'UPDATE media SET visibility = ? WHERE source_location_id = ?'
    ).run(visibility, locationId);

    if (updateSource) {
      db.prepare('UPDATE source_locations SET visibility = ? WHERE id = ?').run(visibility, locationId);
    }

    return mediaResult.changes;
  });

  const updated = tx();

  logAdminAudit(db, req, 'location.bulk_media_visibility', {
    sourceLocationId: locationId,
    visibility,
    sourceUpdated: updateSource,
    updated,
  });

  res.json({ success: true, updated, visibility, sourceUpdated: updateSource });
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

// Shared helper: build audit-log WHERE clause from query params
function buildAuditLogWhere(query) {
  const conditions = [];
  const params = [];
  const { action, date_from, date_to } = query;

  if (action) {
    conditions.push('al.action = ?');
    params.push(action);
  }
  if (date_from) {
    conditions.push("al.created_at >= ?");
    params.push(date_from);
  }
  if (date_to) {
    // include the full day by going to end of day
    const endOfDay = date_to.length === 10 ? date_to + 'T23:59:59.999Z' : date_to;
    conditions.push("al.created_at <= ?");
    params.push(endOfDay);
  }

  return {
    where: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '',
    params,
  };
}

function parseAuditLogRow(row) {
  let metadata = {};
  try { metadata = JSON.parse(row.metadata || '{}'); } catch { metadata = {}; }
  return {
    id: row.id,
    action: row.action,
    actor_key_id: row.actor_key_id,
    actor_key_name: row.actor_key_name,
    metadata,
    created_at: row.created_at,
  };
}

// GET /api/admin/audit-log
router.get('/audit-log', (req, res) => {
  const db = getDb();
  const { page = 1, limit = 25 } = req.query;

  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const pageLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
  const offset = (safePage - 1) * pageLimit;

  const { where, params } = buildAuditLogWhere(req.query);

  const total = db.prepare(`SELECT COUNT(*) AS cnt FROM admin_audit_log al ${where}`).get(...params).cnt;

  const rows = db.prepare(
    `SELECT al.id, al.action, al.actor_key_id, al.metadata, al.created_at,
            ak.name AS actor_key_name
       FROM admin_audit_log al
       LEFT JOIN admin_keys ak ON ak.id = al.actor_key_id
       ${where}
      ORDER BY al.created_at DESC, al.id DESC
      LIMIT ? OFFSET ?`
  ).all(...params, pageLimit, offset);

  res.json({ total, page: safePage, limit: pageLimit, items: rows.map(parseAuditLogRow) });
});

// GET /api/admin/audit-log/export  — returns CSV download
router.get('/audit-log/export', (req, res) => {
  const db = getDb();
  const { where, params } = buildAuditLogWhere(req.query);

  const rows = db.prepare(
    `SELECT al.id, al.action, al.actor_key_id, al.metadata, al.created_at,
            ak.name AS actor_key_name
       FROM admin_audit_log al
       LEFT JOIN admin_keys ak ON ak.id = al.actor_key_id
       ${where}
      ORDER BY al.created_at DESC, al.id DESC`
  ).all(...params);

  const escape = v => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const header = ['id', 'created_at', 'action', 'actor_key_name', 'metadata'].map(escape).join(',');
  const lines = rows.map(row => {
    const item = parseAuditLogRow(row);
    return [
      item.id,
      item.created_at,
      item.action,
      item.actor_key_name || '',
      JSON.stringify(item.metadata),
    ].map(escape).join(',');
  });

  const csv = [header, ...lines].join('\r\n');
  const filename = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
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
