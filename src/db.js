'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || '/data';
const DB_PATH = path.join(DATA_DIR, 'ourtube.db');

let db;

function ensureColumn(tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (columns.some(column => column.name === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

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
      visibility TEXT NOT NULL DEFAULT 'all',
      stitch_directories INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      scan_interval INTEGER NOT NULL DEFAULT 3600,
      last_scanned TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS source_location_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_location_id INTEGER NOT NULL REFERENCES source_locations(id) ON DELETE CASCADE,
      entry_path TEXT NOT NULL,
      entry_type TEXT NOT NULL CHECK(entry_type IN ('directory', 'file')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source_location_id, entry_path)
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
      visibility TEXT NOT NULL DEFAULT 'all',
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

    CREATE TABLE IF NOT EXISTS admin_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      key_salt TEXT NOT NULL,
      key_prefix TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      actor_key_id INTEGER REFERENCES admin_keys(id) ON DELETE SET NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS skipped_files (
      file_path TEXT PRIMARY KEY,
      source_location_id INTEGER REFERENCES source_locations(id) ON DELETE SET NULL,
      reason TEXT NOT NULL,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      skip_count INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS blocked_clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_ip TEXT NOT NULL UNIQUE,
      blocked_at TEXT NOT NULL DEFAULT (datetime('now')),
      unblock_at TEXT,
      reason TEXT,
      killed_session_key TEXT
    );

    CREATE TABLE IF NOT EXISTS client_session_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT,
      client_ip TEXT,
      user_agent TEXT,
      media_id TEXT,
      media_title TEXT,
      stream_type TEXT,
      started_at TEXT,
      last_seen_at TEXT,
      ended_at TEXT NOT NULL DEFAULT (datetime('now')),
      duration_seconds REAL,
      bytes_sent INTEGER DEFAULT 0,
      request_count INTEGER DEFAULT 1,
      kill_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS playback_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playback_session_id TEXT NOT NULL,
      media_id TEXT NOT NULL,
      position_seconds REAL NOT NULL DEFAULT 0,
      duration_seconds REAL,
      completed INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(playback_session_id, media_id)
    );

    CREATE INDEX IF NOT EXISTS idx_blocked_clients_ip ON blocked_clients(client_ip);
    CREATE INDEX IF NOT EXISTS idx_blocked_clients_unblock_at ON blocked_clients(unblock_at);
    CREATE INDEX IF NOT EXISTS idx_client_session_log_created ON client_session_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_client_session_log_ip ON client_session_log(client_ip);
    CREATE INDEX IF NOT EXISTS idx_playback_progress_updated_at ON playback_progress(updated_at);
    CREATE INDEX IF NOT EXISTS idx_media_year ON media(year);
    CREATE INDEX IF NOT EXISTS idx_media_location ON media(location);
    CREATE INDEX IF NOT EXISTS idx_media_indexed_at ON media(indexed_at);
    CREATE INDEX IF NOT EXISTS idx_faces_media_id ON faces(media_id);
    CREATE INDEX IF NOT EXISTS idx_faces_person_name ON faces(person_name);
    CREATE INDEX IF NOT EXISTS idx_skipped_files_last_seen ON skipped_files(last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_location_entries_location_id ON source_location_entries(source_location_id);
    CREATE INDEX IF NOT EXISTS idx_admin_keys_revoked_at ON admin_keys(revoked_at);
    CREATE INDEX IF NOT EXISTS idx_admin_audit_created_at ON admin_audit_log(created_at);
  `);

  ensureColumn('source_locations', 'stitch_directories', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('source_locations', 'visibility', "TEXT NOT NULL DEFAULT 'all'");
  ensureColumn('media', 'visibility', "TEXT NOT NULL DEFAULT 'all'");

  // Insert default settings if not present
  const insertSetting = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
  );
  insertSetting.run('face_detection_enabled', process.env.FACE_DETECTION_ENABLED || 'false');
  insertSetting.run('thumbnail_width', '400');
  insertSetting.run('thumbnail_height', '300');
  insertSetting.run('scan_on_startup', 'false');
  insertSetting.run('photos_enabled', 'true');
  insertSetting.run('session_log_retention_days', '30');
  insertSetting.run('playback_progress_retention_days', '180');

  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

module.exports = { initDb, getDb };
