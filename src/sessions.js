'use strict';

// In-memory registry of active stream/transcode connections
const activeSessions = new Map(); // id -> session object

let _nextId = 1;

/**
 * Register a new active session. Returns an id used to remove it later.
 * @param {object} opts
 * @param {string} opts.mediaId
 * @param {string} opts.title
 * @param {string} opts.type  'direct' | 'transcode'
 * @param {string} opts.ip
 * @param {string} opts.userAgent
 * @returns {string} sessionId
 */
function registerSession(opts) {
  const id = String(_nextId++);
  activeSessions.set(id, {
    id,
    mediaId: opts.mediaId,
    title: opts.title || '',
    type: opts.type || 'direct',
    ip: opts.ip || 'unknown',
    userAgent: opts.userAgent || '',
    startedAt: Date.now(),
    bytesSent: 0,
  });
  return id;
}

/**
 * Increment bytes sent for a session.
 */
function addBytes(sessionId, bytes) {
  const s = activeSessions.get(sessionId);
  if (s) s.bytesSent += bytes;
}

/**
 * Remove a session from the registry.
 */
function removeSession(sessionId) {
  activeSessions.delete(sessionId);
}

/**
 * Return all active sessions as an array (newest first).
 */
function getActiveSessions() {
  return Array.from(activeSessions.values())
    .sort((a, b) => b.startedAt - a.startedAt);
}

module.exports = { registerSession, addBytes, removeSession, getActiveSessions };
