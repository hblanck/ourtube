'use strict';

const express = require('express');
const { getDb } = require('../db');
const {
  aggregateMediaRows,
  buildUserStitchedVideoId,
  buildUserStitchedVideoItem,
  buildVirtualMediaItem,
  getStitchGroupPath,
  isUserStitchedVideoId,
  parseUserStitchedVideoId,
  parseTags,
  parseVirtualMediaId,
  sortMediaItems,
} = require('../virtual-media');
const {
  mediaVisibilityCondition,
  sourceVisibilityCondition,
  canAccessFromRow,
  VISIBILITY_ADMIN_ONLY,
  VISIBILITY_NONE,
} = require('../visibility');
const { isAdminAuthenticated } = require('../admin-auth');

const router = express.Router();

function getSettingValue(db, key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value ?? fallback;
}

function isPhotosEnabled(db) {
  return getSettingValue(db, 'photos_enabled', 'true') !== 'false';
}

// GET /api/ui-settings
router.get('/ui-settings', (req, res) => {
  const db = getDb();
  res.json({
    photos_enabled: isPhotosEnabled(db)
  });
});

// GET /api/media
router.get('/media', (req, res) => {
  const db = getDb();
  const photosEnabled = isPhotosEnabled(db);
  const {
    type, page = 1, limit = 24, sort = 'indexed_at', order = 'DESC',
    year, location, search, source_location_id
  } = req.query;

  const allowed_sorts = ['indexed_at', 'created_at', 'friendly_name', 'duration', 'size', 'view_count', 'year'];
  const safeSort = allowed_sorts.includes(sort) ? sort : 'indexed_at';
  const safeOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const pageLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 24));
  const offset = (safePage - 1) * pageLimit;

  if (!photosEnabled && type === 'photo') {
    return res.json({ total: 0, page: safePage, limit: pageLimit, items: [] });
  }

  const conditions = [];
  const aliasedConditions = [];
  const params = [];
  const includeHidden = req.query.include_hidden === '1' && isAdminAuthenticated(req);
  if (!includeHidden) aliasedConditions.push(`(${mediaVisibilityCondition('m', 'sl', req)})`);
  if (!photosEnabled) {
    conditions.push("type = 'video'");
    aliasedConditions.push("m.type = 'video'");
  }

  const visibilityFilter = String(req.query.visibility || '').trim().toLowerCase();
  if (includeHidden && (visibilityFilter === VISIBILITY_ADMIN_ONLY || visibilityFilter === VISIBILITY_NONE)) {
    aliasedConditions.push('(m.visibility = ? OR sl.visibility = ?)');
    params.push(visibilityFilter, visibilityFilter);
  }

  if (type && (type === 'video' || type === 'photo')) {
    conditions.push('type = ?');
    aliasedConditions.push('m.type = ?');
    params.push(type);
  }
  if (year) {
    conditions.push('year = ?');
    aliasedConditions.push('m.year = ?');
    params.push(parseInt(year));
  }
  if (location) {
    conditions.push('location LIKE ?');
    aliasedConditions.push('m.location LIKE ?');
    params.push(`%${location}%`);
  }
  if (search) {
    conditions.push('(friendly_name LIKE ? OR description LIKE ? OR location LIKE ? OR tags LIKE ?)');
    aliasedConditions.push('(m.friendly_name LIKE ? OR m.description LIKE ? OR m.location LIKE ? OR m.tags LIKE ?)');
    const q = `%${search}%`;
    params.push(q, q, q, q);
  }
  if (source_location_id) {
    const sourceLocationId = parseInt(source_location_id, 10);
    if (!Number.isNaN(sourceLocationId)) {
      conditions.push('source_location_id = ?');
      aliasedConditions.push('m.source_location_id = ?');
      params.push(sourceLocationId);
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const aliasedWhere = aliasedConditions.length ? `WHERE ${aliasedConditions.join(' AND ')}` : '';

  const rows = db.prepare(
    `SELECT m.id, m.type, m.file_path, m.file_name, m.friendly_name, m.description, m.duration, m.width, m.height,
            m.size, m.thumbnail_path, m.year, m.location, m.tags, m.faces_detected, m.view_count,
          m.visibility,
            m.source_location_id, sl.name AS source_location_name, sl.path AS source_location_path,
          sl.visibility AS source_visibility,
            sl.stitch_directories,
            (
              SELECT sle.entry_path
              FROM source_location_entries sle
              WHERE sle.source_location_id = m.source_location_id
                AND (
                  (sle.entry_type = 'file' AND sle.entry_path = m.file_path)
                  OR (sle.entry_type = 'directory' AND (m.file_path = sle.entry_path OR m.file_path LIKE sle.entry_path || '/%'))
                )
              ORDER BY LENGTH(sle.entry_path) DESC
              LIMIT 1
            ) AS source_entry_path,
            (
              SELECT sle.entry_type
              FROM source_location_entries sle
              WHERE sle.source_location_id = m.source_location_id
                AND (
                  (sle.entry_type = 'file' AND sle.entry_path = m.file_path)
                  OR (sle.entry_type = 'directory' AND (m.file_path = sle.entry_path OR m.file_path LIKE sle.entry_path || '/%'))
                )
              ORDER BY LENGTH(sle.entry_path) DESC
              LIMIT 1
            ) AS source_entry_type,
            m.created_at, m.modified_at, m.indexed_at
     FROM media m
     LEFT JOIN source_locations sl ON sl.id = m.source_location_id
               ${aliasedWhere}`
  ).all(...params);

  const items = sortMediaItems(aggregateMediaRows(rows), safeSort, safeOrder);

  res.json({
    total: items.length,
    page: safePage,
    limit: pageLimit,
    items: items.slice(offset, offset + pageLimit)
  });
});

// GET /api/media/featured - must be before /api/media/:id
router.get('/media/featured', (req, res) => {
  const db = getDb();
  const photosEnabled = isPhotosEnabled(db);
  const visibilityWhere = mediaVisibilityCondition('m', 'sl', req);
  const typeWhere = photosEnabled ? '' : " AND m.type = 'video'";

  const rows = db.prepare(
    `SELECT m.id, m.type, m.file_path, m.file_name, m.friendly_name, m.description, m.duration, m.width, m.height,
            m.size, m.thumbnail_path, m.year, m.location, m.tags, m.faces_detected, m.view_count,
          m.visibility,
            m.source_location_id, sl.name AS source_location_name, sl.path AS source_location_path,
          sl.visibility AS source_visibility,
            sl.stitch_directories,
            (
              SELECT sle.entry_path
              FROM source_location_entries sle
              WHERE sle.source_location_id = m.source_location_id
                AND (
                  (sle.entry_type = 'file' AND sle.entry_path = m.file_path)
                  OR (sle.entry_type = 'directory' AND (m.file_path = sle.entry_path OR m.file_path LIKE sle.entry_path || '/%'))
                )
              ORDER BY LENGTH(sle.entry_path) DESC
              LIMIT 1
            ) AS source_entry_path,
            (
              SELECT sle.entry_type
              FROM source_location_entries sle
              WHERE sle.source_location_id = m.source_location_id
                AND (
                  (sle.entry_type = 'file' AND sle.entry_path = m.file_path)
                  OR (sle.entry_type = 'directory' AND (m.file_path = sle.entry_path OR m.file_path LIKE sle.entry_path || '/%'))
                )
              ORDER BY LENGTH(sle.entry_path) DESC
              LIMIT 1
            ) AS source_entry_type,
            m.created_at, m.modified_at, m.indexed_at
     FROM media m
      LEFT JOIN source_locations sl ON sl.id = m.source_location_id
      WHERE ${visibilityWhere}${typeWhere}`
  ).all();

  const items = aggregateMediaRows(rows);
  const recent = sortMediaItems(items, 'indexed_at', 'DESC').slice(0, 12);
  const popular = sortMediaItems(items.filter(item => (item.view_count || 0) > 0), 'view_count', 'DESC').slice(0, 6);

  res.json({ recent, popular });
});

// GET /api/media/:id
router.get('/media/:id', (req, res) => {
  const db = getDb();
  const photosEnabled = isPhotosEnabled(db);
  const virtualRef = parseVirtualMediaId(req.params.id);
  const userStitchedId = parseUserStitchedVideoId(req.params.id);
  const includeHidden = req.query.include_hidden === '1' && isAdminAuthenticated(req);

  // Handle user-defined stitched videos
  if (userStitchedId !== null) {
    const video = db.prepare('SELECT * FROM stitched_videos WHERE id = ?').get(userStitchedId);
    if (!video) return res.status(404).json({ error: 'Not found' });

    const visibilityRank = { none: 2, admin: 1, all: 0 };
    if (!includeHidden) {
      const rank = visibilityRank[video.visibility] ?? 0;
      const isAdmin = isAdminAuthenticated(req);
      if (rank >= 2) return res.status(404).json({ error: 'Not found' });
      if (rank >= 1 && !isAdmin) return res.status(404).json({ error: 'Not found' });
    }

    const clips = db.prepare(
      `SELECT svc.id, svc.stitched_video_id, svc.media_id, svc.position, svc.enabled,
              m.file_path AS media_file_path, m.file_name AS media_file_name,
              m.friendly_name AS media_friendly_name, m.duration AS media_duration,
              m.width AS media_width, m.height AS media_height, m.size AS media_size,
              m.thumbnail_path AS media_thumbnail_path, m.type AS media_type
         FROM stitched_video_clips svc
         LEFT JOIN media m ON m.id = svc.media_id
        WHERE svc.stitched_video_id = ?
        ORDER BY svc.position ASC, svc.id ASC`
    ).all(userStitchedId);

    const item = buildUserStitchedVideoItem(video, clips, { includeSegments: true });
    return res.json(item);
  }

  if (virtualRef) {
    const rows = db.prepare(
            `SELECT m.id, m.type, m.file_path, m.file_name, m.friendly_name, m.description, m.duration, m.width, m.height,
              m.size, m.thumbnail_path, m.year, m.location, m.tags, m.faces_detected, m.view_count,
              m.visibility AS media_visibility, sl.visibility AS source_visibility,
              m.source_location_id, sl.name AS source_location_name, sl.path AS source_location_path,
              sl.stitch_directories,
              (
                SELECT sle.entry_path
                FROM source_location_entries sle
                WHERE sle.source_location_id = m.source_location_id
                  AND (
                    (sle.entry_type = 'file' AND sle.entry_path = m.file_path)
                    OR (sle.entry_type = 'directory' AND (m.file_path = sle.entry_path OR m.file_path LIKE sle.entry_path || '/%'))
                  )
                ORDER BY LENGTH(sle.entry_path) DESC
                LIMIT 1
              ) AS source_entry_path,
              (
                SELECT sle.entry_type
                FROM source_location_entries sle
                WHERE sle.source_location_id = m.source_location_id
                  AND (
                    (sle.entry_type = 'file' AND sle.entry_path = m.file_path)
                    OR (sle.entry_type = 'directory' AND (m.file_path = sle.entry_path OR m.file_path LIKE sle.entry_path || '/%'))
                  )
                ORDER BY LENGTH(sle.entry_path) DESC
                LIMIT 1
              ) AS source_entry_type,
              m.created_at, m.modified_at, m.indexed_at, m.raw_metadata
       FROM media m
       LEFT JOIN source_locations sl ON sl.id = m.source_location_id
       WHERE m.source_location_id = ? AND m.type = 'video'`
    ).all(virtualRef.sourceLocationId);

    // Normalize rows: if source_location_entries table is empty, infer entry data from file structure
    for (const row of rows) {
      if (!row.source_entry_path && row.stitch_directories && row.file_path && row.source_location_path) {
        // If file_path starts with source_location_path, use that as base
        const relativePath = row.file_path.startsWith(row.source_location_path)
          ? row.file_path.substring(row.source_location_path.length).replace(/^\//, '')
          : '';
        if (relativePath) {
          // Infer the first directory level as the stitch group
          const parts = relativePath.split('/');
          row.source_entry_path = row.source_location_path;
          row.source_entry_type = 'directory';
        }
      }
    }

    const segmentRows = rows
      .filter(row => includeHidden || canAccessFromRow(row, req))
      .filter(row => getStitchGroupPath(row) === virtualRef.groupPath);
    if (!segmentRows.length) return res.status(404).json({ error: 'Not found' });

    const row = buildVirtualMediaItem(segmentRows, { includeSegments: true });
    res.json(row);
    return;
  }

  const row = db.prepare(
    `SELECT m.*, m.visibility AS media_visibility, sl.visibility AS source_visibility
       FROM media m
       LEFT JOIN source_locations sl ON sl.id = m.source_location_id
      WHERE m.id = ?`
  ).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!photosEnabled && row.type === 'photo') return res.status(404).json({ error: 'Not found' });
  if (!includeHidden && !canAccessFromRow(row, req)) return res.status(404).json({ error: 'Not found' });

  row.tags = parseTags(row.tags);
  try { row.raw_metadata = JSON.parse(row.raw_metadata || '{}'); } catch { row.raw_metadata = {}; }

  db.prepare('UPDATE media SET view_count = view_count + 1 WHERE id = ?').run(req.params.id);

  const faces = db.prepare('SELECT * FROM faces WHERE media_id = ?').all(req.params.id);
  faces.forEach(f => { try { f.bounds = JSON.parse(f.bounds || '{}'); } catch { f.bounds = {}; } });

  row.faces = faces;
  res.json(row);
});

// GET /api/search
router.get('/search', (req, res) => {
  const db = getDb();
  const photosEnabled = isPhotosEnabled(db);
  const { q = '', page = 1, limit = 24 } = req.query;
  if (!q.trim()) return res.json({ total: 0, items: [] });

  const search = `%${q}%`;
  const offset = (Math.max(1, parseInt(page)) - 1) * Math.min(100, parseInt(limit));
  const pageLimit = Math.min(100, parseInt(limit));

  const visibilityWhere = mediaVisibilityCondition('m', 'sl', req);
  const typeWhere = photosEnabled ? '' : " AND m.type = 'video'";

  const total = db.prepare(
    `SELECT COUNT(*) as cnt
       FROM media m
       LEFT JOIN source_locations sl ON sl.id = m.source_location_id
      WHERE (${visibilityWhere})
        ${typeWhere}
        AND (m.friendly_name LIKE ? OR m.description LIKE ? OR m.location LIKE ? OR m.tags LIKE ? OR m.file_name LIKE ?)`
  ).get(search, search, search, search, search).cnt;

  const items = db.prepare(
    `SELECT m.id, m.type, m.file_name, m.friendly_name, m.duration, m.thumbnail_path, m.year, m.location, m.view_count, m.indexed_at
       FROM media m
       LEFT JOIN source_locations sl ON sl.id = m.source_location_id
      WHERE (${visibilityWhere})
        ${typeWhere}
        AND (m.friendly_name LIKE ? OR m.description LIKE ? OR m.location LIKE ? OR m.tags LIKE ? OR m.file_name LIKE ?)
      ORDER BY m.indexed_at DESC LIMIT ? OFFSET ?`
  ).all(search, search, search, search, search, pageLimit, offset);

  items.forEach(item => {
    item.tags = parseTags(item.tags);
  });

  res.json({ total, page: parseInt(page), limit: pageLimit, items });
});

// GET /api/tags
router.get('/tags', (req, res) => {
  const db = getDb();
  const visibilityWhere = mediaVisibilityCondition('m', 'sl', req);
  const rows = db.prepare(
    `SELECT m.tags
       FROM media m
       LEFT JOIN source_locations sl ON sl.id = m.source_location_id
      WHERE (${visibilityWhere})
        AND m.tags IS NOT NULL AND m.tags != '[]'`
  ).all();
  const tagSet = new Set();
  for (const row of rows) {
    try {
      const arr = JSON.parse(row.tags);
      if (Array.isArray(arr)) arr.forEach(t => t && tagSet.add(t.trim()));
    } catch { /* ignore */ }
  }
  res.json([...tagSet].sort());
});

// GET /api/years
router.get('/years', (req, res) => {
  const db = getDb();
  const photosEnabled = isPhotosEnabled(db);
  const type = String(req.query.type || '').trim().toLowerCase();
  if (!photosEnabled && type === 'photo') return res.json([]);
  const visibilityWhere = mediaVisibilityCondition('m', 'sl', req);
  const hasRequestedType = type === 'video' || type === 'photo';
  const typeCondition = hasRequestedType
    ? ' AND m.type = ?'
    : (!photosEnabled ? " AND m.type = 'video'" : '');
  const params = hasRequestedType ? [type] : [];
  const rows = db.prepare(
    `SELECT m.year, COUNT(*) as count
       FROM media m
       LEFT JOIN source_locations sl ON sl.id = m.source_location_id
      WHERE (${visibilityWhere})
        AND m.year IS NOT NULL${typeCondition}
      GROUP BY m.year
      ORDER BY m.year DESC`
  ).all(...params);
  res.json(rows);
});

// GET /api/locations
router.get('/locations', (req, res) => {
  const db = getDb();
  const photosEnabled = isPhotosEnabled(db);
  const type = String(req.query.type || '').trim().toLowerCase();
  if (!photosEnabled && type === 'photo') return res.json([]);
  const visibilityWhere = mediaVisibilityCondition('m', 'sl', req);
  const hasRequestedType = type === 'video' || type === 'photo';
  const typeCondition = hasRequestedType
    ? ' AND m.type = ?'
    : (!photosEnabled ? " AND m.type = 'video'" : '');
  const params = hasRequestedType ? [type] : [];
  const rows = db.prepare(
    `SELECT m.location, COUNT(*) as count
       FROM media m
       LEFT JOIN source_locations sl ON sl.id = m.source_location_id
      WHERE (${visibilityWhere})
        AND m.location IS NOT NULL AND m.location != ''${typeCondition}
      GROUP BY m.location
      ORDER BY count DESC`
  ).all(...params);
  res.json(rows);
});

// GET /api/source-locations
router.get('/source-locations', (req, res) => {
  const db = getDb();
  const photosEnabled = isPhotosEnabled(db);
  const type = String(req.query.type || '').trim().toLowerCase();
  if (!photosEnabled && type === 'photo') return res.json([]);
  const sourceVisibilityWhere = sourceVisibilityCondition('sl', req);
  const mediaVisibilityWhere = mediaVisibilityCondition('m', 'sl', req);

  const typeCondition = (type === 'video' || type === 'photo')
    ? ' AND m.type = ?'
    : (!photosEnabled ? " AND m.type = 'video'" : '');
  const params = [];
  if (type === 'video' || type === 'photo') params.push(type);

  const rows = db.prepare(
    `SELECT sl.id, sl.name, COUNT(m.id) as count
     FROM source_locations sl
     LEFT JOIN media m ON m.source_location_id = sl.id AND (${mediaVisibilityWhere})${typeCondition}
     WHERE sl.enabled = 1 AND (${sourceVisibilityWhere})
     GROUP BY sl.id, sl.name
     HAVING COUNT(m.id) > 0
     ORDER BY sl.name ASC`
  ).all(...params);
  res.json(rows);
});

// GET /api/faces/people
router.get('/faces/people', (req, res) => {
  const db = getDb();
  const visibilityWhere = mediaVisibilityCondition('m', 'sl', req);
  const rows = db.prepare(
    `SELECT f.person_name, COUNT(*) as count
       FROM faces f
       JOIN media m ON m.id = f.media_id
       LEFT JOIN source_locations sl ON sl.id = m.source_location_id
      WHERE (${visibilityWhere})
        AND f.person_name IS NOT NULL AND f.person_name != ''
      GROUP BY f.person_name
      ORDER BY count DESC`
  ).all();
  res.json(rows);
});

// GET /api/stats
router.get('/stats', (req, res) => {
  const db = getDb();
  const photosEnabled = isPhotosEnabled(db);
  const visibilityWhere = mediaVisibilityCondition('m', 'sl', req);
  const typeWhere = photosEnabled ? '' : " AND m.type = 'video'";
  const total = db.prepare(
    `SELECT COUNT(*) as cnt
       FROM media m
       LEFT JOIN source_locations sl ON sl.id = m.source_location_id
      WHERE (${visibilityWhere})${typeWhere}`
  ).get().cnt;
  const videos = db.prepare(
    `SELECT COUNT(*) as cnt
       FROM media m
       LEFT JOIN source_locations sl ON sl.id = m.source_location_id
      WHERE (${visibilityWhere}) AND m.type = 'video'`
  ).get().cnt;
  const photos = photosEnabled
    ? db.prepare(
      `SELECT COUNT(*) as cnt
         FROM media m
         LEFT JOIN source_locations sl ON sl.id = m.source_location_id
        WHERE (${visibilityWhere}) AND m.type = 'photo'`
    ).get().cnt
    : 0;
  const totalSize = db.prepare(
    `SELECT SUM(m.size) as s
       FROM media m
       LEFT JOIN source_locations sl ON sl.id = m.source_location_id
      WHERE (${visibilityWhere})${typeWhere}`
  ).get().s || 0;
  const locations = db.prepare(
    `SELECT COUNT(DISTINCT m.location) as cnt
       FROM media m
       LEFT JOIN source_locations sl ON sl.id = m.source_location_id
      WHERE (${visibilityWhere})
        ${typeWhere}
        AND m.location IS NOT NULL AND m.location != ''`
  ).get().cnt;
  const faces = db.prepare(
    `SELECT COUNT(*) as cnt
       FROM faces f
       JOIN media m ON m.id = f.media_id
       LEFT JOIN source_locations sl ON sl.id = m.source_location_id
      WHERE (${visibilityWhere})${typeWhere}`
  ).get().cnt;

  res.json({ total, videos, photos, totalSize, locations, faces });
});

module.exports = router;
