'use strict';

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

function cleanupStaleSessions(now = Date.now()) {
  for (const [id, session] of activeSessions.entries()) {
    if (now - session.lastSeenAt > SESSION_TTL_MS) {
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

module.exports = { upsertSession, touchSession, addBytes, getActiveSessions };
