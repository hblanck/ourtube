'use strict';

const { getDb } = require('./db');

const SESSION_TTL_MS = 30_000;

// In-memory registry of active stream/transcode sessions.
const activeSessions = new Map(); // id -> session object
const sessionKeyToId = new Map(); // stable key -> id

let _nextId = 1;

function sessionKey(opts) {
  return [
    String(opts.type || 'direct'),
    String(opts.mediaId || ''),
    String(opts.ip || 'unknown'),
    String(opts.userAgent || ''),
  ].join('||');
}

/**
 * Persist a completed/expired session to the DB audit log.
 */
function persistSession(session) {
  try {
    const db = getDb();
    const durationSeconds = session.lastSeenAt && session.startedAt
      ? Math.round((session.lastSeenAt - session.startedAt) / 1000)
      : null;
    db.prepare(
      `INSERT INTO client_session_log
        (session_key, client_ip, user_agent, media_id, media_title, stream_type,
         started_at, last_seen_at, ended_at, duration_seconds, bytes_sent, request_count, kill_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?)`
    ).run(
      session.key || null,
      session.ip || null,
      session.userAgent || null,
      session.mediaId || null,
      session.title || null,
      session.type || null,
      session.startedAt ? new Date(session.startedAt).toISOString() : null,
      session.lastSeenAt ? new Date(session.lastSeenAt).toISOString() : null,
      durationSeconds,
      session.bytesSent || 0,
      session.requestCount || 1,
      session.killReason || null,
    );
  } catch (err) {
    console.warn('[sessions] Failed to persist session log:', err.message);
  }
}

function cleanupStaleSessions(now = Date.now()) {
  for (const [id, session] of activeSessions.entries()) {
    if (now - session.lastSeenAt > SESSION_TTL_MS) {
      persistSession(session);
      activeSessions.delete(id);
      if (session.key) sessionKeyToId.delete(session.key);
    }
  }
}

/**
 * Create or refresh an active session and return its id.
 * @param {object} opts
 * @param {string} opts.mediaId
 * @param {string} opts.title
 * @param {string} opts.type  'direct' | 'transcode'
 * @param {string} opts.ip
 * @param {string} opts.userAgent
 * @returns {string} sessionId
 */
function upsertSession(opts) {
  cleanupStaleSessions();

  const key = sessionKey(opts);
  const now = Date.now();
  const existingId = sessionKeyToId.get(key);
  if (existingId && activeSessions.has(existingId)) {
    const existing = activeSessions.get(existingId);
    existing.lastSeenAt = now;
    existing.requestCount += 1;
    if (opts.title) existing.title = opts.title;
    return existingId;
  }

  const id = String(_nextId++);
  activeSessions.set(id, {
    id,
    key,
    mediaId: opts.mediaId,
    title: opts.title || '',
    type: opts.type || 'direct',
    ip: opts.ip || 'unknown',
    userAgent: opts.userAgent || '',
    startedAt: now,
    lastSeenAt: now,
    bytesSent: 0,
    requestCount: 1,
    killed: false,
    killReason: null,
  });
  sessionKeyToId.set(key, id);
  return id;
}

/**
 * Mark activity for a session.
 */
function touchSession(sessionId) {
  const s = activeSessions.get(sessionId);
  if (!s) return;
  s.lastSeenAt = Date.now();
}

/**
 * Increment bytes sent for a session and mark activity.
 */
function addBytes(sessionId, bytes) {
  const s = activeSessions.get(sessionId);
  if (!s) return;
  s.bytesSent += bytes;
  s.lastSeenAt = Date.now();
}

/**
 * Return all active sessions as an array (newest first).
 */
function getActiveSessions() {
  cleanupStaleSessions();
  return Array.from(activeSessions.values())
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/**
 * Kill a session (optionally blocking the client IP for jailSeconds).
 * @param {string} sessionId
 * @param {object} opts
 * @param {string} [opts.reason]
 * @param {number} [opts.jailSeconds]  0 = no jail
 * @returns {boolean} true if session was found and killed
 */
function killSession(sessionId, opts = {}) {
  const session = activeSessions.get(String(sessionId));
  if (!session) return false;

  const reason = String(opts.reason || 'Killed by admin');
  session.killed = true;
  session.killReason = reason;
  session.lastSeenAt = Date.now();

  const jailSeconds = Number(opts.jailSeconds) || 0;
  if (jailSeconds > 0 && session.ip && session.ip !== 'unknown') {
    try {
      const db = getDb();
      const unblockAt = new Date(Date.now() + jailSeconds * 1000).toISOString();
      // Upsert: replace any existing block for this IP
      db.prepare(
        `INSERT OR REPLACE INTO blocked_clients (client_ip, blocked_at, unblock_at, reason, killed_session_key)
         VALUES (?, datetime('now'), ?, ?, ?)`
      ).run(session.ip, unblockAt, reason, session.key || null);
    } catch (err) {
      console.warn('[sessions] Failed to insert blocked_client:', err.message);
    }
  }

  persistSession(session);
  activeSessions.delete(sessionId);
  if (session.key) sessionKeyToId.delete(session.key);
  return true;
}

/**
 * Check whether a client IP is currently blocked.
 * @param {string} ip
 * @returns {{ blocked: boolean, unblock_at: string|null, reason: string|null, id: number|null }}
 */
function isClientBlocked(ip) {
  try {
    const db = getDb();
    const row = db.prepare(
      `SELECT id, unblock_at, reason FROM blocked_clients
       WHERE client_ip = ?
         AND (unblock_at IS NULL OR datetime(unblock_at) > datetime('now'))
       ORDER BY id DESC LIMIT 1`
    ).get(ip);
    if (row) {
      return { blocked: true, id: row.id, unblock_at: row.unblock_at, reason: row.reason };
    }
  } catch (err) {
    console.warn('[sessions] isClientBlocked check error:', err.message);
  }
  return { blocked: false, id: null, unblock_at: null, reason: null };
}

/**
 * Purge expired block records from the DB.
 */
function purgeExpiredBlocks() {
  try {
    const db = getDb();
    db.prepare(
      `DELETE FROM blocked_clients WHERE unblock_at IS NOT NULL AND datetime(unblock_at) <= datetime('now')`
    ).run();
  } catch (err) {
    console.warn('[sessions] purgeExpiredBlocks error:', err.message);
  }
}

/**
 * Purge old session log records past the retention window.
 */
function purgeOldSessionLog() {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'session_log_retention_days'").get();
    const days = Math.max(1, parseInt(row?.value || '30', 10) || 30);
    db.prepare(
      `DELETE FROM client_session_log WHERE created_at < datetime('now', ? || ' days')`
    ).run(`-${days}`);
  } catch (err) {
    console.warn('[sessions] purgeOldSessionLog error:', err.message);
  }
}

// Sweep expired blocks every 5 minutes
const _sweepTimer = setInterval(() => { purgeExpiredBlocks(); purgeOldSessionLog(); }, 5 * 60 * 1000);
if (_sweepTimer.unref) _sweepTimer.unref();

module.exports = {
  upsertSession,
  touchSession,
  addBytes,
  getActiveSessions,
  killSession,
  isClientBlocked,
  purgeExpiredBlocks,
  purgeOldSessionLog,
};
