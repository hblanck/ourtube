'use strict';

const crypto = require('crypto');
const { getDb } = require('./db');

const ADMIN_SESSION_COOKIE = 'ourtube_admin_session';
const SESSION_TTL_MINUTES = Math.max(5, parseInt(process.env.ADMIN_SESSION_TTL_MINUTES || '720', 10) || 720);
const SESSION_TTL_MS = SESSION_TTL_MINUTES * 60 * 1000;
const ACTIVE_SESSIONS = new Map();

function randomToken(size = 32) {
  return crypto.randomBytes(size).toString('base64url');
}

function hashAdminKey(key, saltHex) {
  const salt = Buffer.from(saltHex, 'hex');
  return crypto.scryptSync(String(key), salt, 64).toString('hex');
}

function createAdminKeyRecord(name, key) {
  const db = getDb();
  const cleanName = String(name || '').trim() || 'Admin Key';
  const saltHex = crypto.randomBytes(16).toString('hex');
  const hashHex = hashAdminKey(key, saltHex);
  const prefix = String(key).slice(0, 6);

  const result = db.prepare(
    'INSERT INTO admin_keys (name, key_hash, key_salt, key_prefix) VALUES (?, ?, ?, ?)'
  ).run(cleanName, hashHex, saltHex, prefix);

  return Number(result.lastInsertRowid);
}

function generateAdminKey() {
  return randomToken(24);
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};

  raw.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx <= 0) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    out[key] = decodeURIComponent(value);
  });

  return out;
}

function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.path) parts.push(`Path=${opts.path}`);
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

function purgeExpiredSessions(now = Date.now()) {
  for (const [token, session] of ACTIVE_SESSIONS.entries()) {
    if (session.expiresAt <= now) ACTIVE_SESSIONS.delete(token);
  }
}

function getSessionFromRequest(req) {
  purgeExpiredSessions();
  const token = parseCookies(req)[ADMIN_SESSION_COOKIE];
  if (!token) return null;

  const session = ACTIVE_SESSIONS.get(token);
  if (!session) return null;

  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return { token, ...session };
}

function isAdminAuthenticated(req) {
  return !!getSessionFromRequest(req);
}

function setAdminCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production';
  res.setHeader('Set-Cookie', serializeCookie(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    maxAge: SESSION_TTL_MS / 1000,
    path: '/',
    sameSite: 'Lax',
    secure,
  }));
}

function clearAdminCookie(res) {
  const secure = process.env.NODE_ENV === 'production';
  res.setHeader('Set-Cookie', serializeCookie(ADMIN_SESSION_COOKIE, '', {
    httpOnly: true,
    maxAge: 0,
    path: '/',
    sameSite: 'Lax',
    secure,
  }));
}

function getConfiguredAdminKeyCount() {
  const db = getDb();
  return db.prepare('SELECT COUNT(*) AS cnt FROM admin_keys WHERE revoked_at IS NULL').get().cnt;
}

function getAdminAuthStatus(req) {
  const session = getSessionFromRequest(req);
  return {
    configured: getConfiguredAdminKeyCount() > 0,
    authenticated: !!session,
    expiresAt: session ? session.expiresAt : null,
    sessionTtlMinutes: SESSION_TTL_MINUTES,
  };
}

function tryAuthenticateAdminKey(candidateKey) {
  const db = getDb();
  const keys = db.prepare(
    'SELECT id, key_hash, key_salt FROM admin_keys WHERE revoked_at IS NULL ORDER BY id ASC'
  ).all();

  for (const keyRow of keys) {
    const candidateHash = hashAdminKey(candidateKey, keyRow.key_salt);
    const expected = Buffer.from(keyRow.key_hash, 'hex');
    const actual = Buffer.from(candidateHash, 'hex');
    if (expected.length !== actual.length) continue;
    if (crypto.timingSafeEqual(expected, actual)) {
      db.prepare('UPDATE admin_keys SET last_used_at = datetime(\'now\') WHERE id = ?').run(keyRow.id);
      return keyRow.id;
    }
  }

  return null;
}

function loginAdmin(res, keyId) {
  const token = randomToken(24);
  const expiresAt = Date.now() + SESSION_TTL_MS;
  ACTIVE_SESSIONS.set(token, {
    keyId: Number(keyId),
    createdAt: Date.now(),
    expiresAt,
  });
  setAdminCookie(res, token);
  return { expiresAt, sessionTtlMinutes: SESSION_TTL_MINUTES };
}

function logoutAdmin(req, res) {
  const token = parseCookies(req)[ADMIN_SESSION_COOKIE];
  if (token) ACTIVE_SESSIONS.delete(token);
  clearAdminCookie(res);
}

function requireAdminAuth(req, res, next) {
  const session = getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Admin authentication required' });
  req.adminSession = session;
  next();
}

function listAdminKeys() {
  const db = getDb();
  return db.prepare(
    `SELECT id, name, key_prefix, created_at, last_used_at, revoked_at
       FROM admin_keys
      ORDER BY created_at DESC`
  ).all();
}

function revokeAdminKey(keyId) {
  const db = getDb();
  const activeCount = getConfiguredAdminKeyCount();
  const row = db.prepare('SELECT id, revoked_at FROM admin_keys WHERE id = ?').get(keyId);
  if (!row) return { error: 'Not found', status: 404 };
  if (row.revoked_at) return { ok: true };
  if (activeCount <= 1) return { error: 'Cannot revoke the last active key', status: 400 };

  db.prepare('UPDATE admin_keys SET revoked_at = datetime(\'now\') WHERE id = ?').run(keyId);

  for (const [token, session] of ACTIVE_SESSIONS.entries()) {
    if (session.keyId === Number(keyId)) ACTIVE_SESSIONS.delete(token);
  }

  return { ok: true };
}

function renameAdminKey(keyId, name) {
  const db = getDb();
  const cleanName = String(name || '').trim();
  if (!cleanName) return { error: 'name is required', status: 400 };

  const result = db.prepare('UPDATE admin_keys SET name = ? WHERE id = ?').run(cleanName, keyId);
  if (!result.changes) return { error: 'Not found', status: 404 };
  return { ok: true };
}

module.exports = {
  generateAdminKey,
  createAdminKeyRecord,
  getConfiguredAdminKeyCount,
  getAdminAuthStatus,
  tryAuthenticateAdminKey,
  loginAdmin,
  logoutAdmin,
  isAdminAuthenticated,
  requireAdminAuth,
  listAdminKeys,
  revokeAdminKey,
  renameAdminKey,
};
