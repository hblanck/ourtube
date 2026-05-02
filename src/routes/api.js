'use strict';

const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

// GET /api/media
router.get('/media', (req, res) => {
  const db = getDb();
  const {
    type, page = 1, limit = 24, sort = 'indexed_at', order = 'DESC',
    year, location, search
  } = req.query;

  const allowed_sorts = ['indexed_at', 'created_at', 'friendly_name', 'duration', 'size', 'view_count', 'year'];
  const safeSort = allowed_sorts.includes(sort) ? sort : 'indexed_at';
  const safeOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const offset = (Math.max(1, parseInt(page)) - 1) * Math.min(100, parseInt(limit));
  const pageLimit = Math.min(100, parseInt(limit));

  const conditions = [];
  const params = [];

  if (type && (type === 'video' || type === 'photo')) {
    conditions.push('type = ?');
    params.push(type);
  }
  if (year) {
    conditions.push('year = ?');
    params.push(parseInt(year));
  }
  if (location) {
    conditions.push('location LIKE ?');
    params.push(`%${location}%`);
  }
  if (search) {
    conditions.push('(friendly_name LIKE ? OR description LIKE ? OR location LIKE ? OR tags LIKE ?)');
    const q = `%${search}%`;
    params.push(q, q, q, q);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM media ${where}`).get(...params).cnt;
  const rows = db.prepare(
    `SELECT id, type, file_name, friendly_name, description, duration, width, height,
            size, thumbnail_path, year, location, tags, faces_detected, view_count,
            created_at, indexed_at
     FROM media ${where}
     ORDER BY ${safeSort} ${safeOrder}
     LIMIT ? OFFSET ?`
  ).all(...params, pageLimit, offset);

  rows.forEach(r => {
    try { r.tags = JSON.parse(r.tags || '[]'); } catch { r.tags = []; }
  });

  res.json({ total, page: parseInt(page), limit: pageLimit, items: rows });
});

// GET /api/media/featured - must be before /api/media/:id
router.get('/media/featured', (req, res) => {
  const db = getDb();

  const recent = db.prepare(
    `SELECT id, type, file_name, friendly_name, duration, thumbnail_path, year, view_count, indexed_at
     FROM media ORDER BY indexed_at DESC LIMIT 12`
  ).all();

  const popular = db.prepare(
    `SELECT id, type, file_name, friendly_name, duration, thumbnail_path, year, view_count, indexed_at
     FROM media WHERE view_count > 0 ORDER BY view_count DESC LIMIT 6`
  ).all();

  res.json({ recent, popular });
});

// GET /api/media/:id
router.get('/media/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  try { row.tags = JSON.parse(row.tags || '[]'); } catch { row.tags = []; }
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
  const { q = '', page = 1, limit = 24 } = req.query;
  if (!q.trim()) return res.json({ total: 0, items: [] });

  const search = `%${q}%`;
  const offset = (Math.max(1, parseInt(page)) - 1) * Math.min(100, parseInt(limit));
  const pageLimit = Math.min(100, parseInt(limit));

  const total = db.prepare(
    `SELECT COUNT(*) as cnt FROM media
     WHERE friendly_name LIKE ? OR description LIKE ? OR location LIKE ? OR tags LIKE ? OR file_name LIKE ?`
  ).get(search, search, search, search, search).cnt;

  const items = db.prepare(
    `SELECT id, type, file_name, friendly_name, duration, thumbnail_path, year, location, view_count, indexed_at
     FROM media
     WHERE friendly_name LIKE ? OR description LIKE ? OR location LIKE ? OR tags LIKE ? OR file_name LIKE ?
     ORDER BY indexed_at DESC LIMIT ? OFFSET ?`
  ).all(search, search, search, search, search, pageLimit, offset);

  res.json({ total, page: parseInt(page), limit: pageLimit, items });
});

// GET /api/tags
router.get('/tags', (req, res) => {
  const db = getDb();
  const rows = db.prepare("SELECT tags FROM media WHERE tags IS NOT NULL AND tags != '[]'").all();
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
  const rows = db.prepare(
    'SELECT year, COUNT(*) as count FROM media WHERE year IS NOT NULL GROUP BY year ORDER BY year DESC'
  ).all();
  res.json(rows);
});

// GET /api/locations
router.get('/locations', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    "SELECT location, COUNT(*) as count FROM media WHERE location IS NOT NULL AND location != '' GROUP BY location ORDER BY count DESC"
  ).all();
  res.json(rows);
});

// GET /api/faces/people
router.get('/faces/people', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    "SELECT person_name, COUNT(*) as count FROM faces WHERE person_name IS NOT NULL AND person_name != '' GROUP BY person_name ORDER BY count DESC"
  ).all();
  res.json(rows);
});

// GET /api/stats
router.get('/stats', (req, res) => {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as cnt FROM media').get().cnt;
  const videos = db.prepare("SELECT COUNT(*) as cnt FROM media WHERE type = 'video'").get().cnt;
  const photos = db.prepare("SELECT COUNT(*) as cnt FROM media WHERE type = 'photo'").get().cnt;
  const totalSize = db.prepare('SELECT SUM(size) as s FROM media').get().s || 0;
  const locations = db.prepare("SELECT COUNT(DISTINCT location) as cnt FROM media WHERE location IS NOT NULL AND location != ''").get().cnt;
  const faces = db.prepare('SELECT COUNT(*) as cnt FROM faces').get().cnt;

  res.json({ total, videos, photos, totalSize, locations, faces });
});

module.exports = router;
