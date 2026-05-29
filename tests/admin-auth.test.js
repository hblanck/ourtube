'use strict';

process.env.DATA_DIR = `/tmp/ourtube-admin-auth-${process.pid}`;
process.env.NODE_ENV = 'test';

const fs = require('fs');

const { initDb, getDb } = require('../src/db');
const {
  createAdminKeyRecord,
  getAdminAuthStatus,
  tryAuthenticateAdminKey,
  loginAdmin,
  logoutAdmin,
  isAdminAuthenticated,
  requireAdminAuth,
  listAdminKeys,
  revokeAdminKey,
  renameAdminKey,
} = require('../src/admin-auth');

function createMockRes() {
  const headers = {};
  return {
    headers,
    setHeader(name, value) {
      headers[name] = value;
    },
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

function cookieFromRes(res) {
  const raw = res.headers['Set-Cookie'] || '';
  return String(raw).split(';')[0];
}

beforeAll(() => {
  initDb();
});

afterAll(() => {
  try {
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe('admin-auth', () => {
  test('createAdminKeyRecord stores normalized name and prefix', () => {
    const keyId = createAdminKeyRecord('   ', 'abcdef1234567890');
    const row = getDb().prepare('SELECT id, name, key_prefix FROM admin_keys WHERE id = ?').get(keyId);

    expect(row.name).toBe('Admin Key');
    expect(row.key_prefix).toBe('abcdef');
  });

  test('getAdminAuthStatus reflects configured keys and session auth state', () => {
    const noSessionReq = { headers: {} };
    const status = getAdminAuthStatus(noSessionReq);

    expect(status.configured).toBe(true);
    expect(status.authenticated).toBe(false);
    expect(status.expiresAt).toBeNull();
    expect(status.sessionTtlMinutes).toBeGreaterThanOrEqual(5);
  });

  test('tryAuthenticateAdminKey succeeds for correct key and fails for incorrect key', () => {
    const keyId = createAdminKeyRecord('Test Key', 'secret-123');

    expect(tryAuthenticateAdminKey('wrong')).toBeNull();
    expect(tryAuthenticateAdminKey('secret-123')).toBe(keyId);

    const row = getDb().prepare('SELECT last_used_at FROM admin_keys WHERE id = ?').get(keyId);
    expect(row.last_used_at).toEqual(expect.any(String));
  });

  test('loginAdmin sets cookie, enables auth, and logout clears auth', () => {
    const keyId = createAdminKeyRecord('Session Key', 'session-secret');
    const authKeyId = tryAuthenticateAdminKey('session-secret');
    expect(authKeyId).toBe(keyId);

    const loginReq = { headers: {} };
    const res = createMockRes();
    const loginInfo = loginAdmin(loginReq, res, keyId);
    const cookie = cookieFromRes(res);

    expect(cookie).toContain('ourtube_admin_session=');
    expect(loginInfo).toEqual(expect.objectContaining({
      expiresAt: expect.any(Number),
      sessionTtlMinutes: expect.any(Number),
    }));

    const authedReq = { headers: { cookie } };
    expect(isAdminAuthenticated(authedReq)).toBe(true);

    const logoutRes = createMockRes();
    logoutAdmin(authedReq, logoutRes);
    expect(isAdminAuthenticated(authedReq)).toBe(false);
    expect(logoutRes.headers['Set-Cookie']).toContain('Max-Age=0');
  });

  test('requireAdminAuth rejects missing session', () => {
    const req = { headers: {} };
    const res = createMockRes();
    const next = jest.fn();

    requireAdminAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Admin authentication required' });
    expect(next).not.toHaveBeenCalled();
  });

  test('requireAdminAuth accepts valid session and sets req.adminSession', () => {
    const keyId = createAdminKeyRecord('Auth Key', 'auth-secret');
    const res = createMockRes();
    loginAdmin({ headers: {} }, res, keyId);

    const req = { headers: { cookie: cookieFromRes(res) } };
    const guardRes = createMockRes();
    const next = jest.fn();

    requireAdminAuth(req, guardRes, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.adminSession).toEqual(expect.objectContaining({
      keyId,
      token: expect.any(String),
    }));
  });

  test('renameAdminKey validates required name and updates existing key', () => {
    const keyId = createAdminKeyRecord('Original Name', 'rename-secret');

    expect(renameAdminKey(keyId, '   ')).toEqual({ error: 'name is required', status: 400 });
    expect(renameAdminKey(999999, 'Renamed')).toEqual({ error: 'Not found', status: 404 });
    expect(renameAdminKey(keyId, '  Renamed Key  ')).toEqual({ ok: true });

    const row = getDb().prepare('SELECT name FROM admin_keys WHERE id = ?').get(keyId);
    expect(row.name).toBe('Renamed Key');
  });

  test('revokeAdminKey enforces last-key constraint and invalidates matching sessions', () => {
    const keyA = createAdminKeyRecord('A', 'a-secret');
    const keyB = createAdminKeyRecord('B', 'b-secret');
    getDb().prepare(
      "UPDATE admin_keys SET revoked_at = datetime('now') WHERE revoked_at IS NULL AND id NOT IN (?, ?)"
    ).run(keyA, keyB);

    const loginRes = createMockRes();
    loginAdmin({ headers: {} }, loginRes, keyA);
    const reqWithKeyA = { headers: { cookie: cookieFromRes(loginRes) } };
    expect(isAdminAuthenticated(reqWithKeyA)).toBe(true);

    expect(revokeAdminKey(keyA)).toEqual({ ok: true });
    expect(isAdminAuthenticated(reqWithKeyA)).toBe(false);

    expect(revokeAdminKey(keyB)).toEqual({ error: 'Cannot revoke the last active key', status: 400 });
  });

  test('listAdminKeys returns rows with expected fields', () => {
    const rows = listAdminKeys();

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toEqual(expect.objectContaining({
      id: expect.any(Number),
      name: expect.any(String),
      key_prefix: expect.any(String),
    }));
  });

  test('admin session cookie is not Secure on plain HTTP by default', () => {
    const keyId = createAdminKeyRecord('Cookie HTTP', 'cookie-http-secret');
    const res = createMockRes();

    loginAdmin({ headers: {} }, res, keyId);

    expect(String(res.headers['Set-Cookie'] || '')).not.toContain('Secure');
  });

  test('admin session cookie is Secure when x-forwarded-proto is https', () => {
    const keyId = createAdminKeyRecord('Cookie HTTPS', 'cookie-https-secret');
    const res = createMockRes();

    loginAdmin({ headers: { 'x-forwarded-proto': 'https' } }, res, keyId);

    expect(String(res.headers['Set-Cookie'] || '')).toContain('Secure');
  });
});
