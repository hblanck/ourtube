'use strict';

const express = require('express');
const { getDb } = require('../db');
const {
  aggregateMediaRows,
  buildVirtualMediaItem,
  getStitchGroupPath,
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
const telemetry = require('../telemetry');

const router = express.Router();

function getSettingValue(db, key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value ?? fallback;
}

function isPhotosEnabled(db) {
  return getSettingValue(db, 'photos_enabled', 'true') !== 'false';
}

function parseBooleanEnv(value) {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function shouldPreferStitchedCompatibilityPlayback() {
  const override = parseBooleanEnv(process.env.STITCHED_PREFER_COMPATIBILITY);
  if (override !== null) return override;

  // On Raspberry Pi and other ARM hosts, concat stream metadata is more likely to be unreliable.
  return process.arch === 'arm' || process.arch === 'arm64';
}

function normalizeExternalBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return '';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  const normalizedPath = parsed.pathname.replace(/\/+$/g, '');
  return `${parsed.origin}${normalizedPath}${parsed.search}${parsed.hash}`;
}

function normalizeBookmarkTags(rawTags) {
  const tags = Array.isArray(rawTags) ? rawTags : [];
  const seen = new Set();
  const normalized = [];

  for (const tag of tags) {
    const safe = String(tag || '').trim().slice(0, 40);
    if (!safe) continue;
    const key = safe.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(safe);
    if (normalized.length >= 20) break;
  }

  return normalized;
}

function getAccessibleVideoForSocialFeatures(db, mediaId, req) {
  const virtualRef = parseVirtualMediaId(mediaId);
  if (virtualRef) {
    const rows = db.prepare(
      `SELECT m.id, m.type, m.file_path, m.file_name, m.visibility AS media_visibility, sl.visibility AS source_visibility,
              m.source_location_id, sl.path AS source_location_path, sl.stitch_directories,
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
              ) AS source_entry_type
         FROM media m
         LEFT JOIN source_locations sl ON sl.id = m.source_location_id
        WHERE m.source_location_id = ? AND m.type = 'video'`
    ).all(virtualRef.sourceLocationId);

    const segmentRows = rows
      .filter(row => canAccessFromRow(row, req))
      .filter(row => getStitchGroupPath(row) === virtualRef.groupPath);
    if (!segmentRows.length) return null;

    return { id: mediaId, type: 'video', isVirtual: true };
  }

  const row = db.prepare(
    `SELECT m.id, m.type, m.visibility AS media_visibility, sl.visibility AS source_visibility
       FROM media m
       LEFT JOIN source_locations sl ON sl.id = m.source_location_id
      WHERE m.id = ?`
  ).get(mediaId);

  if (!row) return null;
  if (row.type !== 'video') return null;
  if (!canAccessFromRow(row, req)) return null;
  return row;
}

function attachPlaybackProgress(items, req, db) {
  if (!Array.isArray(items) || !items.length) return items;

  const playbackSessionId = req.playbackSessionId;
  if (!playbackSessionId) return items;

  const videoItems = items.filter(item => item && item.type === 'video' && item.id);
  if (!videoItems.length) return items;

  const mediaIds = [...new Set(videoItems.map(item => String(item.id)))];
  if (!mediaIds.length) return items;

  const placeholders = mediaIds.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT media_id, position_seconds, duration_seconds, completed
       FROM playback_progress
      WHERE playback_session_id = ?
        AND media_id IN (${placeholders})`
  ).all(playbackSessionId, ...mediaIds);

  const byId = new Map(rows.map(row => [String(row.media_id), row]));

  for (const item of videoItems) {
    const progress = byId.get(String(item.id));
    if (!progress) {
      item.watch_progress_percent = 0;
      item.watch_completed = false;
      item.watch_position_seconds = 0;
      continue;
    }

    const positionSeconds = Math.max(0, Number(progress.position_seconds) || 0);
    const completed = !!progress.completed;
    const itemDuration = Math.max(0, Number(item.duration) || 0);
    const fallbackDuration = Math.max(0, Number(progress.duration_seconds) || 0);
    const durationSeconds = itemDuration || fallbackDuration;

    let percent = 0;
    if (completed) {
      percent = 100;
    } else if (durationSeconds > 0) {
      percent = Math.round((positionSeconds / durationSeconds) * 100);
      percent = Math.max(0, Math.min(100, percent));
    }

    item.watch_progress_percent = percent;
    item.watch_completed = completed || percent >= 100;
    item.watch_position_seconds = positionSeconds;
  }

  return items;
}

function milestonesForPercent(percent, completed) {
  const out = [];
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  if (safePercent >= 25) out.push('25');
  if (safePercent >= 50) out.push('50');
  if (safePercent >= 75) out.push('75');
  if (safePercent >= 95 || completed) out.push('95');
  if (completed) out.push('completed');
  return out;
}

// GET /api/ui-settings
router.get('/ui-settings', (req, res) => {
  const db = getDb();
  res.json({
    photos_enabled: isPhotosEnabled(db),
    external_base_url: normalizeExternalBaseUrl(getSettingValue(db, 'external_base_url', '')),
    stitched_prefer_compatibility: shouldPreferStitchedCompatibilityPlayback(),
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
  attachPlaybackProgress(items, req, db);

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
  const includeHidden = req.query.include_hidden === '1' && isAdminAuthenticated(req);

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

// GET /api/media/:id/bookmarks
router.get('/media/:id/bookmarks', (req, res) => {
  const db = getDb();
  const mediaRef = getAccessibleVideoForSocialFeatures(db, req.params.id, req);
  if (!mediaRef) {
    return res.status(404).json({ error: 'Not found' });
  }

  const rows = mediaRef.isVirtual
    ? db.prepare(
      `SELECT id, media_id, time_seconds, title, annotation, tags, created_at
         FROM virtual_video_bookmarks
        WHERE media_id = ?
        ORDER BY time_seconds ASC, id ASC`
    ).all(req.params.id)
    : db.prepare(
      `SELECT id, media_id, time_seconds, title, annotation, tags, created_at
         FROM video_bookmarks
        WHERE media_id = ?
        ORDER BY time_seconds ASC, id ASC`
    ).all(req.params.id);

  const items = rows.map(row => {
    let tags = [];
    try {
      const parsed = JSON.parse(row.tags || '[]');
      if (Array.isArray(parsed)) tags = parsed.map(String).filter(Boolean);
    } catch {
      tags = [];
    }

    return {
      id: row.id,
      media_id: row.media_id,
      time_seconds: Math.max(0, Number(row.time_seconds) || 0),
      title: row.title || '',
      annotation: row.annotation || '',
      tags,
      created_at: row.created_at,
    };
  });

  res.json({ items });
});

// POST /api/media/:id/bookmarks
router.post('/media/:id/bookmarks', (req, res) => {
  const db = getDb();
  const mediaRef = getAccessibleVideoForSocialFeatures(db, req.params.id, req);
  if (!mediaRef) {
    return res.status(404).json({ error: 'Not found' });
  }

  const timeSeconds = Number(req.body?.time_seconds);
  if (!Number.isFinite(timeSeconds) || timeSeconds < 0) {
    return res.status(400).json({ error: 'Invalid time_seconds' });
  }

  const title = String(req.body?.title || '').trim().slice(0, 120);
  const annotation = String(req.body?.annotation || '').trim().slice(0, 1000);
  const tags = normalizeBookmarkTags(req.body?.tags);

  if (!title && !annotation && !tags.length) {
    return res.status(400).json({ error: 'Provide a title, annotation, or at least one tag' });
  }

  const result = mediaRef.isVirtual
    ? db.prepare(
      `INSERT INTO virtual_video_bookmarks (media_id, time_seconds, title, annotation, tags)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      req.params.id,
      Math.max(0, timeSeconds),
      title,
      annotation,
      JSON.stringify(tags)
    )
    : db.prepare(
      `INSERT INTO video_bookmarks (media_id, time_seconds, title, annotation, tags)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      req.params.id,
      Math.max(0, timeSeconds),
      title,
      annotation,
      JSON.stringify(tags)
    );

  const row = mediaRef.isVirtual
    ? db.prepare(
      `SELECT id, media_id, time_seconds, title, annotation, tags, created_at
         FROM virtual_video_bookmarks
        WHERE id = ?`
    ).get(result.lastInsertRowid)
    : db.prepare(
      `SELECT id, media_id, time_seconds, title, annotation, tags, created_at
         FROM video_bookmarks
        WHERE id = ?`
    ).get(result.lastInsertRowid);

  res.status(201).json({
    id: row.id,
    media_id: row.media_id,
    time_seconds: Math.max(0, Number(row.time_seconds) || 0),
    title: row.title || '',
    annotation: row.annotation || '',
    tags,
    created_at: row.created_at,
  });
});

// GET /api/media/:id/comments
router.get('/media/:id/comments', (req, res) => {
  const db = getDb();
  const mediaRef = getAccessibleVideoForSocialFeatures(db, req.params.id, req);
  if (!mediaRef) {
    return res.status(404).json({ error: 'Not found' });
  }

  const items = mediaRef.isVirtual
    ? db.prepare(
      `SELECT id, media_id, author_name, comment_text, created_at
         FROM virtual_video_comments
        WHERE media_id = ?
        ORDER BY created_at DESC, id DESC`
    ).all(req.params.id)
    : db.prepare(
      `SELECT id, media_id, author_name, comment_text, created_at
         FROM video_comments
        WHERE media_id = ?
        ORDER BY created_at DESC, id DESC`
    ).all(req.params.id);

  res.json({ items });
});

// POST /api/media/:id/comments
router.post('/media/:id/comments', (req, res) => {
  const db = getDb();
  const mediaRef = getAccessibleVideoForSocialFeatures(db, req.params.id, req);
  if (!mediaRef) {
    return res.status(404).json({ error: 'Not found' });
  }

  const authorName = String(req.body?.author_name || '').trim().slice(0, 60) || 'Anonymous';
  const commentText = String(req.body?.comment_text || '').trim().slice(0, 2000);
  if (!commentText) {
    return res.status(400).json({ error: 'comment_text is required' });
  }

  const result = mediaRef.isVirtual
    ? db.prepare(
      `INSERT INTO virtual_video_comments (media_id, author_name, comment_text)
       VALUES (?, ?, ?)`
    ).run(req.params.id, authorName, commentText)
    : db.prepare(
      `INSERT INTO video_comments (media_id, author_name, comment_text)
       VALUES (?, ?, ?)`
    ).run(req.params.id, authorName, commentText);

  const row = mediaRef.isVirtual
    ? db.prepare(
      `SELECT id, media_id, author_name, comment_text, created_at
         FROM virtual_video_comments
        WHERE id = ?`
    ).get(result.lastInsertRowid)
    : db.prepare(
      `SELECT id, media_id, author_name, comment_text, created_at
         FROM video_comments
        WHERE id = ?`
    ).get(result.lastInsertRowid);

  res.status(201).json(row);
});

// GET /api/playback-progress/:id
router.get('/playback-progress/:id', (req, res) => {
  const db = getDb();
  const playbackSessionId = req.playbackSessionId;
  if (!playbackSessionId) return res.status(400).json({ error: 'Missing playback session' });

  const row = db.prepare(
    `SELECT position_seconds, duration_seconds, completed, updated_at
       FROM playback_progress
      WHERE playback_session_id = ? AND media_id = ?`
  ).get(playbackSessionId, req.params.id);

  if (!row) {
    return res.json({ media_id: req.params.id, position_seconds: 0, duration_seconds: null, completed: false, updated_at: null });
  }

  res.json({
    media_id: req.params.id,
    position_seconds: Number(row.position_seconds) || 0,
    duration_seconds: Number.isFinite(Number(row.duration_seconds)) ? Number(row.duration_seconds) : null,
    completed: !!row.completed,
    updated_at: row.updated_at || null,
  });
});

// PUT /api/playback-progress/:id
router.put('/playback-progress/:id', (req, res) => {
  const db = getDb();
  const playbackSessionId = req.playbackSessionId;
  if (!playbackSessionId) return res.status(400).json({ error: 'Missing playback session' });

  const rawPosition = Number(req.body?.position_seconds);
  const rawDuration = Number(req.body?.duration_seconds);
  const completed = req.body?.completed ? 1 : 0;

  if (!Number.isFinite(rawPosition) || rawPosition < 0) {
    return res.status(400).json({ error: 'Invalid position_seconds' });
  }

  const positionSeconds = Math.max(0, rawPosition);
  const durationSeconds = Number.isFinite(rawDuration) && rawDuration >= 0 ? rawDuration : null;

  const prev = db.prepare(
    `SELECT position_seconds, duration_seconds, completed
       FROM playback_progress
      WHERE playback_session_id = ? AND media_id = ?`
  ).get(playbackSessionId, req.params.id);

  db.prepare(
    `INSERT INTO playback_progress
      (playback_session_id, media_id, position_seconds, duration_seconds, completed, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(playback_session_id, media_id)
     DO UPDATE SET
       position_seconds = excluded.position_seconds,
       duration_seconds = excluded.duration_seconds,
       completed = excluded.completed,
       updated_at = datetime('now')`
  ).run(playbackSessionId, req.params.id, positionSeconds, durationSeconds, completed);

  const prevDuration = Number(prev?.duration_seconds);
  const prevEffectiveDuration = Number.isFinite(prevDuration) && prevDuration > 0
    ? prevDuration
    : (durationSeconds || 0);
  const prevPercent = prev?.completed
    ? 100
    : (prevEffectiveDuration > 0 ? ((Number(prev?.position_seconds) || 0) / prevEffectiveDuration) * 100 : 0);
  const nextEffectiveDuration = durationSeconds || prevEffectiveDuration;
  const nextPercent = completed
    ? 100
    : (nextEffectiveDuration > 0 ? (positionSeconds / nextEffectiveDuration) * 100 : 0);

  const prevMilestones = new Set(milestonesForPercent(prevPercent, !!prev?.completed));
  const nextMilestones = milestonesForPercent(nextPercent, !!completed);
  for (const milestone of nextMilestones) {
    if (prevMilestones.has(milestone)) continue;
    telemetry.recordPlaybackMilestone(milestone, {
      media_type: String(req.body?.media_type || 'video'),
      source: 'playback_progress',
    });
  }

  res.json({ ok: true });
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
  attachPlaybackProgress(items, req, db);

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
