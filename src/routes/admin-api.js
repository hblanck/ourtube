'use strict';

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getDb } = require('../db');
const { scanLocation, scanAllLocations, getScanStatus, killScan } = require('../scanner');
const { getActiveSessions, killSession, isClientBlocked } = require('../sessions');
const { getRandomVideoTimemark, getThumbnailPath, generateVideoThumbnail, generatePhotoThumbnail } = require('../thumbnails');
const { normalizeVisibility } = require('../visibility');
const { parseVirtualMediaId, getStitchGroupPath } = require('../virtual-media');
const packageJson = require('../../package.json');

const router = express.Router();
const MEDIA_ROOT = path.resolve('/media');
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/data');
const DB_PATH = path.join(DATA_DIR, 'ourtube.db');
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

function canAccessPath(targetPath, mode) {
  try {
    fs.accessSync(targetPath, mode);
    return true;
  } catch {
    return false;
  }
}

function getStorageSummary(targetPath) {
  if (typeof fs.statfsSync !== 'function') return null;

  try {
    const stats = fs.statfsSync(targetPath);
    const blockSize = Number(stats.bsize || stats.frsize || 0);
    const totalBytes = blockSize * Number(stats.blocks || 0);
    const freeBytes = blockSize * Number(stats.bavail ?? stats.bfree ?? 0);
    const usedBytes = Math.max(0, totalBytes - freeBytes);

    return {
      totalBytes,
      usedBytes,
      freeBytes,
    };
  } catch {
    return null;
  }
}

function buildPathSummary(targetPath) {
  const resolvedPath = path.resolve(targetPath);
  const exists = fs.existsSync(resolvedPath);

  return {
    path: toPosixPath(resolvedPath),
    exists,
    readable: exists ? canAccessPath(resolvedPath, fs.constants.R_OK) : false,
    writable: exists ? canAccessPath(resolvedPath, fs.constants.W_OK) : false,
    storage: exists ? getStorageSummary(resolvedPath) : null,
  };
}

function getSettingsMap(db, keys) {
  const placeholders = keys.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`).all(...keys);
  const settings = {};
  for (const row of rows) settings[row.key] = row.value;
  return settings;
}

function parseSqliteDate(value) {
  if (!value) return null;
  const parsed = Date.parse(`${value}Z`);
  return Number.isNaN(parsed) ? null : parsed;
}

function getScanScheduleSummary(db) {
  const rows = db.prepare(
    `SELECT name, scan_interval, last_scanned
       FROM source_locations
      WHERE enabled = 1
      ORDER BY name ASC`
  ).all();

  const now = Date.now();
  let dueNow = 0;
  let neverScanned = 0;
  let nextDue = null;
  let minIntervalSeconds = null;
  let maxIntervalSeconds = null;

  for (const row of rows) {
    const intervalSeconds = Math.max(0, Number(row.scan_interval) || 0);
    const lastScannedMs = parseSqliteDate(row.last_scanned);
    const dueAtMs = lastScannedMs == null ? now : lastScannedMs + (intervalSeconds * 1000);

    if (row.last_scanned == null) neverScanned++;
    if (dueAtMs <= now) {
      dueNow++;
    } else if (!nextDue || dueAtMs < nextDue.atMs) {
      nextDue = { atMs: dueAtMs, name: row.name };
    }

    minIntervalSeconds = minIntervalSeconds == null ? intervalSeconds : Math.min(minIntervalSeconds, intervalSeconds);
    maxIntervalSeconds = maxIntervalSeconds == null ? intervalSeconds : Math.max(maxIntervalSeconds, intervalSeconds);
  }

  return {
    enabledLocations: rows.length,
    dueNow,
    neverScanned,
    minIntervalSeconds,
    maxIntervalSeconds,
    nextDueAt: nextDue ? new Date(nextDue.atMs).toISOString() : null,
    nextDueLocation: nextDue ? nextDue.name : null,
  };
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

function parseBookmarkTags(rawTags) {
  try {
    const parsed = JSON.parse(rawTags || '[]');
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function quoteSqlValue(value) {
  if (value == null) return 'NULL';
  if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function isSafeIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function listUserTables(db) {
  return db.prepare(
    `SELECT name
       FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name ASC`
  ).all().map(row => row.name);
}

function getValidatedTableName(db, inputName) {
  if (!isSafeIdentifier(inputName)) return null;
  const exists = db.prepare(
    `SELECT 1 AS ok FROM sqlite_master
      WHERE type = 'table'
        AND name = ?
        AND name NOT LIKE 'sqlite_%'`
  ).get(inputName);
  return exists ? inputName : null;
}

function getTableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all();
}

function buildInsertStatement(tableName, columns, row) {
  const columnSql = columns.map(col => quoteIdentifier(col)).join(', ');
  const valueSql = columns.map(col => quoteSqlValue(row[col])).join(', ');
  return `INSERT INTO ${quoteIdentifier(tableName)} (${columnSql}) VALUES (${valueSql});`;
}

function exportTableSql(db, tableName, rowFilter = null) {
  const schemaRow = db.prepare(
    `SELECT sql
       FROM sqlite_master
      WHERE type = 'table'
        AND name = ?`
  ).get(tableName);
  if (!schemaRow?.sql) return '';

  const columns = getTableColumns(db, tableName).map(col => col.name);
  if (!columns.length) return '';

  let rows;
  if (rowFilter && Array.isArray(rowFilter.rowids) && rowFilter.rowids.length) {
    const placeholders = rowFilter.rowids.map(() => '?').join(', ');
    rows = db.prepare(
      `SELECT ${columns.map(col => quoteIdentifier(col)).join(', ')}
         FROM ${quoteIdentifier(tableName)}
        WHERE rowid IN (${placeholders})
        ORDER BY rowid ASC`
    ).all(...rowFilter.rowids);
  } else {
    rows = db.prepare(
      `SELECT ${columns.map(col => quoteIdentifier(col)).join(', ')}
         FROM ${quoteIdentifier(tableName)}
        ORDER BY rowid ASC`
    ).all();
  }

  const lines = [];
  lines.push(`${schemaRow.sql};`);
  for (const row of rows) {
    lines.push(buildInsertStatement(tableName, columns, row));
  }

  const extras = db.prepare(
    `SELECT sql
       FROM sqlite_master
      WHERE tbl_name = ?
        AND type IN ('index', 'trigger', 'view')
        AND sql IS NOT NULL
      ORDER BY type ASC, name ASC`
  ).all(tableName);
  for (const item of extras) {
    lines.push(`${item.sql};`);
  }

  return lines.join('\n');
}

function exportDatabaseSql(db) {
  const tables = listUserTables(db);
  const chunks = ['BEGIN TRANSACTION;'];
  for (const tableName of tables) {
    const tableDump = exportTableSql(db, tableName);
    if (tableDump) chunks.push(tableDump);
  }
  chunks.push('COMMIT;');
  return `${chunks.join('\n\n')}\n`;
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

// GET /api/admin/bookmarks
router.get('/bookmarks', (req, res) => {
  const db = getDb();
  const { q = '', page = 1, limit = 25, scope = '' } = req.query;

  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const pageLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
  const offset = (safePage - 1) * pageLimit;
  const normalizedScope = scope === 'regular' || scope === 'virtual' ? scope : '';
  const search = String(q || '').trim();
  const searchLike = `%${search}%`;

  const whereSql = `
    WHERE (? = '' OR scope = ?)
      AND (
        ? = ''
        OR media_id LIKE ?
        OR COALESCE(title, '') LIKE ?
        OR COALESCE(annotation, '') LIKE ?
        OR COALESCE(tags, '') LIKE ?
        OR COALESCE(media_name, '') LIKE ?
        OR COALESCE(source_location_name, '') LIKE ?
      )`;

  const baseSql = `
    FROM (
      SELECT
        'regular' AS scope,
        b.id,
        b.media_id,
        b.time_seconds,
        b.title,
        b.annotation,
        b.tags,
        b.created_at,
        COALESCE(m.friendly_name, m.file_name, m.id) AS media_name,
        m.thumbnail_path,
        m.id AS thumbnail_media_id,
        sl.name AS source_location_name
      FROM video_bookmarks b
      LEFT JOIN media m ON m.id = b.media_id
      LEFT JOIN source_locations sl ON sl.id = m.source_location_id
      UNION ALL
      SELECT
        'virtual' AS scope,
        b.id,
        b.media_id,
        b.time_seconds,
        b.title,
        b.annotation,
        b.tags,
        b.created_at,
        NULL AS media_name,
        NULL AS thumbnail_path,
        NULL AS thumbnail_media_id,
        NULL AS source_location_name
      FROM virtual_video_bookmarks b
    ) merged`;

  const countRow = db.prepare(`SELECT COUNT(*) AS cnt ${baseSql} ${whereSql}`).get(
    normalizedScope,
    normalizedScope,
    search,
    searchLike,
    searchLike,
    searchLike,
    searchLike,
    searchLike,
    searchLike
  );

  const rows = db.prepare(
    `SELECT scope, id, media_id, time_seconds, title, annotation, tags, created_at, media_name, thumbnail_path, thumbnail_media_id, source_location_name
     ${baseSql}
     ${whereSql}
     ORDER BY datetime(created_at) DESC, id DESC
     LIMIT ? OFFSET ?`
  ).all(
    normalizedScope,
    normalizedScope,
    search,
    searchLike,
    searchLike,
    searchLike,
    searchLike,
    searchLike,
    searchLike,
    pageLimit,
    offset
  );

  const items = rows.map(row => ({
    scope: row.scope,
    id: row.id,
    media_id: row.media_id,
    time_seconds: Number(row.time_seconds) || 0,
    title: row.title || '',
    annotation: row.annotation || '',
    tags: parseBookmarkTags(row.tags),
    created_at: row.created_at,
    media_name: row.media_name || row.media_id,
    thumbnail_url: row.thumbnail_path
      ? `/thumbnail/${encodeURIComponent(row.thumbnail_media_id || row.media_id)}`
      : null,
    source_location_name: row.source_location_name || null,
  }));

  res.json({
    total: Number(countRow?.cnt) || 0,
    page: safePage,
    limit: pageLimit,
    items,
  });
});

// DELETE /api/admin/bookmarks/:scope/:id
router.delete('/bookmarks/:scope/:id', (req, res) => {
  const db = getDb();
  const scope = String(req.params.scope || '').trim().toLowerCase();
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  if (scope === 'regular') {
    const row = db.prepare('SELECT id, media_id FROM video_bookmarks WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM video_bookmarks WHERE id = ?').run(id);
    return res.json({ success: true, scope, id, media_id: row.media_id });
  }
  if (scope === 'virtual') {
    const row = db.prepare('SELECT id, media_id FROM virtual_video_bookmarks WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM virtual_video_bookmarks WHERE id = ?').run(id);
    return res.json({ success: true, scope, id, media_id: row.media_id });
  }
  return res.status(400).json({ error: 'Invalid scope' });
});

// GET /api/admin/system-info
router.get('/system-info', (req, res) => {
  const db = getDb();
  const settings = getSettingsMap(db, [
    'photos_enabled',
    'face_detection_enabled',
    'scan_on_startup',
    'thumbnail_width',
    'thumbnail_height',
  ]);
  const dbFileStats = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH) : null;
  const processMemory = process.memoryUsage();
  const library = db.prepare(
    `SELECT
        (SELECT COUNT(*) FROM source_locations) AS sourceLocations,
        (SELECT COUNT(*) FROM source_locations WHERE enabled = 1) AS enabledSourceLocations,
        (SELECT COUNT(*) FROM source_location_entries) AS sourceEntries,
        (SELECT COUNT(*) FROM media) AS mediaItems,
        (SELECT COUNT(*) FROM media WHERE type = 'video') AS videos,
        (SELECT COUNT(*) FROM media WHERE type = 'photo') AS photos,
        (SELECT COUNT(*) FROM faces) AS faces,
        (SELECT COUNT(*) FROM skipped_files) AS skippedFiles,
        (SELECT COUNT(*) FROM admin_keys WHERE revoked_at IS NULL) AS activeAdminKeys`
  ).get();

  const containerized = fs.existsSync('/.dockerenv') || Boolean(process.env.KUBERNETES_SERVICE_HOST);
  const scanStatus = getScanStatus();

  res.json({
    app: {
      name: packageJson.name,
      version: packageJson.version,
      description: packageJson.description || '',
    },
    runtime: {
      nodeVersion: process.version,
      environment: process.env.NODE_ENV || 'development',
      port: parseInt(process.env.PORT, 10) || 3000,
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      cwd: toPosixPath(process.cwd()),
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      cpuCount: Array.isArray(os.cpus()) ? os.cpus().length : null,
      osUptimeSeconds: Math.floor(os.uptime()),
      containerized,
      memoryUsage: {
        rssBytes: processMemory.rss,
        heapUsedBytes: processMemory.heapUsed,
        heapTotalBytes: processMemory.heapTotal,
        externalBytes: processMemory.external,
      },
    },
    paths: {
      dataDir: buildPathSummary(DATA_DIR),
      database: buildPathSummary(DB_PATH),
      mediaRoot: buildPathSummary(MEDIA_ROOT),
      databaseFileSizeBytes: dbFileStats ? dbFileStats.size : null,
    },
    features: {
      photosEnabled: settings.photos_enabled !== 'false',
      faceDetectionEnabled: settings.face_detection_enabled === 'true',
      scanOnStartup: settings.scan_on_startup === 'true',
      thumbnailWidth: parseInt(settings.thumbnail_width, 10) || null,
      thumbnailHeight: parseInt(settings.thumbnail_height, 10) || null,
    },
    library,
    scan: {
      ...scanStatus,
      schedule: getScanScheduleSummary(db),
    },
  });
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

// POST /api/admin/scan/kill
router.post('/scan/kill', (req, res) => {
  const killed = killScan();
  res.json({ success: true, killed, status: getScanStatus() });
});

// GET /api/admin/active-sessions
router.get('/active-sessions', (req, res) => {
  res.json(getActiveSessions());
});

// POST /api/admin/sessions/:id/kill
router.post('/sessions/:id/kill', (req, res) => {
  const db = getDb();
  const sessionId = String(req.params.id || '');
  const reason = String(req.body?.reason || 'Killed by admin');
  const jailSeconds = Math.max(0, parseInt(req.body?.jail_seconds, 10) || 0);

  const killed = killSession(sessionId, { reason, jailSeconds });
  if (!killed) return res.status(404).json({ error: 'Session not found' });

  logAdminAudit(db, req, 'session.kill', { sessionId, reason, jailSeconds });
  res.json({ success: true, sessionId, jailSeconds });
});

// GET /api/admin/blocked-clients
router.get('/blocked-clients', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, client_ip, blocked_at, unblock_at, reason, killed_session_key
     FROM blocked_clients
     WHERE unblock_at IS NULL OR datetime(unblock_at) > datetime('now')
     ORDER BY blocked_at DESC`
  ).all();
  res.json(rows);
});

// DELETE /api/admin/blocked-clients/:id
router.delete('/blocked-clients/:id', (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });

  const row = db.prepare('SELECT id, client_ip FROM blocked_clients WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  db.prepare('DELETE FROM blocked_clients WHERE id = ?').run(id);
  logAdminAudit(db, req, 'session.unblock', { blockedClientId: id, ip: row.client_ip });
  res.json({ success: true });
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

// POST /api/admin/media/:id/thumbnail
router.post('/media/:id/thumbnail', async (req, res) => {
  const db = getDb();
  const virtualRef = parseVirtualMediaId(req.params.id);

  try {
    if (virtualRef) {
      const segmentRows = db.prepare(
        `SELECT m.id, m.type, m.file_path, m.duration, m.thumbnail_path,
                sl.stitch_directories, sl.path AS source_location_path,
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

      const targetRow = matchingSegments[0];
      const sourceRow = matchingSegments[Math.floor(Math.random() * matchingSegments.length)];
      const outputPath = targetRow.thumbnail_path || getThumbnailPath(targetRow.id);
      const timemark = getRandomVideoTimemark(sourceRow.duration);

      await generateVideoThumbnail(sourceRow.file_path, outputPath, timemark);

      db.prepare('UPDATE media SET thumbnail_path = ? WHERE id = ?').run(outputPath, targetRow.id);

      logAdminAudit(db, req, 'media.thumbnail.regenerate', {
        mediaId: req.params.id,
        isVirtual: true,
        targetMediaId: targetRow.id,
        sourceMediaId: sourceRow.id,
        timemark,
      });

      return res.json({
        success: true,
        thumbnail_media_id: targetRow.id,
        thumbnail_url: `/thumbnail/${targetRow.id}`,
      });
    }

    const row = db.prepare('SELECT id, type, file_path, duration, thumbnail_path FROM media WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const outputPath = row.thumbnail_path || getThumbnailPath(row.id);
    if (row.type === 'video') {
      const timemark = getRandomVideoTimemark(row.duration);
      await generateVideoThumbnail(row.file_path, outputPath, timemark);
      db.prepare('UPDATE media SET thumbnail_path = ? WHERE id = ?').run(outputPath, row.id);

      logAdminAudit(db, req, 'media.thumbnail.regenerate', {
        mediaId: req.params.id,
        isVirtual: false,
        timemark,
      });

      return res.json({
        success: true,
        thumbnail_media_id: row.id,
        thumbnail_url: `/thumbnail/${row.id}`,
      });
    }

    await generatePhotoThumbnail(row.file_path, outputPath);
    db.prepare('UPDATE media SET thumbnail_path = ? WHERE id = ?').run(outputPath, row.id);

    logAdminAudit(db, req, 'media.thumbnail.regenerate', {
      mediaId: req.params.id,
      isVirtual: false,
      type: row.type,
    });

    return res.json({
      success: true,
      thumbnail_media_id: row.id,
      thumbnail_url: `/thumbnail/${row.id}`,
    });
  } catch (err) {
    console.error('[admin] Thumbnail regeneration error:', err);
    return res.status(500).json({ error: 'Thumbnail generation failed' });
  }
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

// GET /api/admin/database/tables
router.get('/database/tables', (req, res) => {
  const db = getDb();
  const tables = listUserTables(db).map(name => {
    const count = db.prepare(`SELECT COUNT(*) AS cnt FROM ${quoteIdentifier(name)}`).get().cnt;
    return { name, rowCount: Number(count || 0) };
  });
  res.json({ tables });
});

// GET /api/admin/database/tables/:table/rows
router.get('/database/tables/:table/rows', (req, res) => {
  const db = getDb();
  const tableName = getValidatedTableName(db, req.params.table);
  if (!tableName) return res.status(400).json({ error: 'Invalid table name' });

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;

  const columns = getTableColumns(db, tableName).map(col => col.name);
  if (!columns.length) return res.json({ table: tableName, columns: [], rows: [], total: 0, page, limit });

  const total = db.prepare(`SELECT COUNT(*) AS cnt FROM ${quoteIdentifier(tableName)}`).get().cnt;
  const rows = db.prepare(
    `SELECT rowid AS _rowid, ${columns.map(col => quoteIdentifier(col)).join(', ')}
       FROM ${quoteIdentifier(tableName)}
      ORDER BY rowid DESC
      LIMIT ? OFFSET ?`
  ).all(limit, offset);

  res.json({
    table: tableName,
    columns: ['_rowid', ...columns],
    rows,
    total: Number(total || 0),
    page,
    limit,
  });
});

// PUT /api/admin/database/tables/:table/rows/:rowid
router.put('/database/tables/:table/rows/:rowid', (req, res) => {
  const db = getDb();
  const tableName = getValidatedTableName(db, req.params.table);
  if (!tableName) return res.status(400).json({ error: 'Invalid table name' });

  const rowid = Number(req.params.rowid);
  if (!Number.isInteger(rowid) || rowid <= 0) return res.status(400).json({ error: 'Invalid row id' });

  const payload = req.body;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const tableColumns = new Set(getTableColumns(db, tableName).map(col => col.name));
  const updates = Object.entries(payload).filter(([key]) => key !== '_rowid' && tableColumns.has(key));
  if (!updates.length) return res.status(400).json({ error: 'No valid columns provided' });

  const setClause = updates.map(([key]) => `${quoteIdentifier(key)} = ?`).join(', ');
  const values = updates.map(([, value]) => value);
  const updateResult = db.prepare(
    `UPDATE ${quoteIdentifier(tableName)}
        SET ${setClause}
      WHERE rowid = ?`
  ).run(...values, rowid);
  if (!updateResult.changes) return res.status(404).json({ error: 'Row not found' });

  const row = db.prepare(
    `SELECT rowid AS _rowid, *
       FROM ${quoteIdentifier(tableName)}
      WHERE rowid = ?`
  ).get(rowid);
  res.json({ row });
});

// POST /api/admin/database/export
router.post('/database/export', (req, res) => {
  const db = getDb();
  const { scope = 'database', table, rowids } = req.body || {};

  let sql = '';
  let filename = `ourtube-db-${new Date().toISOString().slice(0, 10)}.sql`;

  if (scope === 'database') {
    sql = exportDatabaseSql(db);
  } else if (scope === 'table') {
    const tableName = getValidatedTableName(db, table);
    if (!tableName) return res.status(400).json({ error: 'Invalid table name' });
    sql = exportTableSql(db, tableName);
    filename = `ourtube-table-${tableName}-${new Date().toISOString().slice(0, 10)}.sql`;
  } else if (scope === 'records') {
    const tableName = getValidatedTableName(db, table);
    if (!tableName) return res.status(400).json({ error: 'Invalid table name' });
    const safeRowids = Array.isArray(rowids)
      ? rowids.map(v => Number(v)).filter(v => Number.isInteger(v) && v > 0)
      : [];
    if (!safeRowids.length) return res.status(400).json({ error: 'rowids must be a non-empty array of positive integers' });
    sql = exportTableSql(db, tableName, { rowids: safeRowids });
    filename = `ourtube-records-${tableName}-${new Date().toISOString().slice(0, 10)}.sql`;
  } else {
    return res.status(400).json({ error: 'Invalid export scope' });
  }

  res.setHeader('Content-Type', 'application/sql; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(sql);
});

// POST /api/admin/database/import
router.post('/database/import', (req, res) => {
  const db = getDb();
  const sql = String(req.body?.sql || '');
  if (!sql.trim()) return res.status(400).json({ error: 'sql is required' });
  if (sql.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'sql payload is too large' });
  if (/\b(attach|detach|load_extension)\b/i.test(sql)) {
    return res.status(400).json({ error: 'Forbidden SQL statement in import payload' });
  }

  try {
    db.prepare('PRAGMA foreign_keys = OFF').run();
    db.exec(sql);
    db.prepare('PRAGMA foreign_keys = ON').run();
    res.json({ success: true });
  } catch (err) {
    try { db.prepare('PRAGMA foreign_keys = ON').run(); } catch {}
    res.status(400).json({ error: `Import failed: ${err.message}` });
  }
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

// ── Client Session Log ────────────────────────────────────────────────────────

function buildSessionLogWhere(query) {
  const conditions = [];
  const params = [];
  const { ip, media_id, date_from, date_to } = query;
  if (ip) { conditions.push('sl.client_ip LIKE ?'); params.push(`%${String(ip)}%`); }
  if (media_id) { conditions.push('sl.media_id = ?'); params.push(String(media_id)); }
  if (date_from) { conditions.push('sl.created_at >= ?'); params.push(String(date_from)); }
  if (date_to) {
    const dateTo = String(date_to);
    const end = dateTo.length === 10 ? dateTo + 'T23:59:59.999Z' : dateTo;
    conditions.push('sl.created_at <= ?'); params.push(end);
  }
  return { where: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '', params };
}

// GET /api/admin/session-log
router.get('/session-log', (req, res) => {
  const db = getDb();
  const { page = 1, limit = 25 } = req.query;
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const pageLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
  const offset = (safePage - 1) * pageLimit;
  const { where, params } = buildSessionLogWhere(req.query);

  const total = db.prepare(`SELECT COUNT(*) AS cnt FROM client_session_log sl ${where}`).get(...params).cnt;
  const items = db.prepare(
    `SELECT sl.id, sl.session_key, sl.client_ip, sl.user_agent, sl.media_id, sl.media_title,
            sl.stream_type, sl.started_at, sl.last_seen_at, sl.ended_at, sl.duration_seconds,
            sl.bytes_sent, sl.request_count, sl.kill_reason, sl.created_at
       FROM client_session_log sl
       ${where}
      ORDER BY sl.created_at DESC, sl.id DESC
      LIMIT ? OFFSET ?`
  ).all(...params, pageLimit, offset);

  res.json({ total, page: safePage, limit: pageLimit, items });
});

// GET /api/admin/session-log/export — must be registered before /:id
router.get('/session-log/export', (req, res) => {
  const db = getDb();
  const { where, params } = buildSessionLogWhere(req.query);
  const rows = db.prepare(
    `SELECT sl.id, sl.client_ip, sl.user_agent, sl.media_id, sl.media_title, sl.stream_type,
            sl.started_at, sl.ended_at, sl.duration_seconds, sl.bytes_sent, sl.request_count,
            sl.kill_reason, sl.created_at
       FROM client_session_log sl
       ${where}
      ORDER BY sl.created_at DESC, sl.id DESC`
  ).all(...params);

  const escapeCsv = v => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['id','created_at','client_ip','user_agent','media_title','stream_type','started_at','ended_at','duration_seconds','bytes_sent','request_count','kill_reason'].map(escapeCsv).join(',');
  const lines = rows.map(r => [r.id,r.created_at,r.client_ip,r.user_agent,r.media_title,r.stream_type,r.started_at,r.ended_at,r.duration_seconds,r.bytes_sent,r.request_count,r.kill_reason].map(escapeCsv).join(','));
  const csv = [header, ...lines].join('\r\n');
  const filename = `session-log-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

// GET /api/admin/session-log/:id
router.get('/session-log/:id', (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const row = db.prepare('SELECT * FROM client_session_log WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// DELETE /api/admin/session-log — purge records older than cutoff_days (default: all)
router.delete('/session-log', (req, res) => {
  const db = getDb();
  const cutoffDays = parseInt(req.query.older_than_days, 10);
  let result;
  if (Number.isInteger(cutoffDays) && cutoffDays > 0) {
    result = db.prepare(
      `DELETE FROM client_session_log WHERE created_at < datetime('now', ? || ' days')`
    ).run(`-${cutoffDays}`);
  } else {
    result = db.prepare('DELETE FROM client_session_log').run();
  }
  logAdminAudit(db, req, 'session_log.purge', { deleted: result.changes, cutoffDays: cutoffDays || 'all' });
  res.json({ success: true, deleted: result.changes });
});

// GET /api/admin/telemetry - OpenTelemetry stats
router.get('/telemetry', (req, res) => {
  const { getStats } = require('../telemetry');
  res.json(getStats());
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

// ── Metrics & Analytics ────────────────────────────────────────────────────────

// GET /api/admin/metrics/top-videos — top 10 most viewed videos
router.get('/metrics/top-videos', (req, res) => {
  const db = getDb();
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
  
  const rows = db.prepare(
    `SELECT id, friendly_name, file_name, type, view_count, duration, size, year, location
       FROM media
      WHERE view_count > 0
      ORDER BY view_count DESC
      LIMIT ?`
  ).all(limit);
  
  res.json({ items: rows });
});

// GET /api/admin/metrics/top-users — most active users by unique IP
router.get('/metrics/top-users', (req, res) => {
  const db = getDb();
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
  
  const rows = db.prepare(
    `SELECT client_ip, COUNT(*) as session_count, SUM(bytes_sent) as total_bytes_sent,
            SUM(duration_seconds) as total_duration_seconds, COUNT(DISTINCT media_id) as media_count,
            MIN(started_at) as first_session_at, MAX(ended_at) as last_session_at
       FROM client_session_log
      WHERE client_ip IS NOT NULL
      GROUP BY client_ip
      ORDER BY session_count DESC
      LIMIT ?`
  ).all(limit);
  
  res.json({ items: rows });
});

// GET /api/admin/metrics/session-stats — average session duration and view counts
router.get('/metrics/session-stats', (req, res) => {
  const db = getDb();
  
  const stats = db.prepare(
    `SELECT
        COUNT(*) as total_sessions,
        COUNT(DISTINCT client_ip) as unique_ips,
        COUNT(DISTINCT media_id) as media_viewed,
        AVG(COALESCE(duration_seconds, 0)) as avg_duration_seconds,
        SUM(COALESCE(duration_seconds, 0)) as total_duration_seconds,
        SUM(bytes_sent) as total_bytes_sent,
        SUM(request_count) as total_requests,
        MIN(started_at) as earliest_session,
        MAX(ended_at) as latest_session
     FROM client_session_log`
  ).get();
  
  res.json(stats || {});
});

// GET /api/admin/metrics/library-stats — total views and engagement
router.get('/metrics/library-stats', (req, res) => {
  const db = getDb();
  
  const stats = db.prepare(
    `SELECT
        (SELECT COUNT(*) FROM media) as total_items,
        (SELECT COUNT(*) FROM media WHERE type = 'video') as videos,
        (SELECT COUNT(*) FROM media WHERE type = 'photo') as photos,
        (SELECT SUM(view_count) FROM media) as total_views,
        (SELECT AVG(view_count) FROM media WHERE view_count > 0) as avg_views_per_viewed_item,
        (SELECT COUNT(*) FROM media WHERE view_count > 0) as items_with_views,
        (SELECT COUNT(*) FROM media WHERE type = 'video' AND view_count > 0) as videos_viewed,
        (SELECT COUNT(*) FROM media WHERE type = 'photo' AND view_count > 0) as photos_viewed`
  ).get();
  
  res.json(stats || {});
});

module.exports = router;
