'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || '/data';
const DB_PATH = path.join(DATA_DIR, 'ourtube.db');

let db;

function initDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS source_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'both',
      enabled INTEGER NOT NULL DEFAULT 1,
      scan_interval INTEGER NOT NULL DEFAULT 3600,
      last_scanned TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY,
      source_location_id INTEGER REFERENCES source_locations(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      file_path TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      friendly_name TEXT,
      description TEXT,
      duration REAL,
      width INTEGER,
      height INTEGER,
      size INTEGER,
      codec TEXT,
      format TEXT,
      created_at TEXT,
      modified_at TEXT,
      indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
      thumbnail_path TEXT,
      year INTEGER,
      location TEXT,
      latitude REAL,
      longitude REAL,
      tags TEXT DEFAULT '[]',
      faces_detected INTEGER DEFAULT 0,
      raw_metadata TEXT DEFAULT '{}',
      view_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS faces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
      person_name TEXT,
      confidence REAL,
      bounds TEXT DEFAULT '{}',
      face_thumbnail_path TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_media_type ON media(type);
    CREATE INDEX IF NOT EXISTS idx_media_year ON media(year);
    CREATE INDEX IF NOT EXISTS idx_media_location ON media(location);
    CREATE INDEX IF NOT EXISTS idx_media_indexed_at ON media(indexed_at);
    CREATE INDEX IF NOT EXISTS idx_faces_media_id ON faces(media_id);
    CREATE INDEX IF NOT EXISTS idx_faces_person_name ON faces(person_name);
  `);

  // Insert default settings if not present
  const insertSetting = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
  );
  insertSetting.run('face_detection_enabled', process.env.FACE_DETECTION_ENABLED || 'false');
  insertSetting.run('thumbnail_width', '400');
  insertSetting.run('thumbnail_height', '300');
  insertSetting.run('scan_on_startup', 'false');

  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

module.exports = { initDb, getDb };
