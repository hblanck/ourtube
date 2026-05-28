'use strict';

const express = require('express');
const telemetry = require('../telemetry');
const {
  getAdminAuthStatus,
  tryAuthenticateAdminKey,
  loginAdmin,
  logoutAdmin,
  requireAdminAuth,
  listAdminKeys,
  revokeAdminKey,
  renameAdminKey,
  createAdminKeyRecord,
  generateAdminKey,
} = require('../admin-auth');

const router = express.Router();

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function logAuthFailure(req, reason, statusCode) {
  const ua = String(req.get('user-agent') || 'unknown').slice(0, 200);
  console.warn(
    `[admin-auth] Login failed reason=${reason} status=${statusCode} ip=${getClientIp(req)} ua=${ua}`
  );
}

// GET /api/admin/auth/status
router.get('/status', (req, res) => {
  res.json(getAdminAuthStatus(req));
});

// POST /api/admin/auth/login
router.post('/login', (req, res) => {
  const key = String(req.body?.key || '').trim();
  if (!key) {
    telemetry.recordAdminLoginAttempt('failure', { reason: 'missing_key' });
    logAuthFailure(req, 'missing_key', 400);
    return res.status(400).json({
      errorCode: 'MISSING_KEY',
      error: 'Admin key is required.',
    });
  }

  const keyId = tryAuthenticateAdminKey(key);
  if (!keyId) {
    telemetry.recordAdminLoginAttempt('failure', { reason: 'invalid_key' });
    logAuthFailure(req, 'invalid_key', 401);
    return res.status(401).json({
      errorCode: 'INVALID_KEY',
      error: 'Invalid admin key.',
    });
  }

  telemetry.recordAdminLoginAttempt('success');
  const session = loginAdmin(res, keyId);
  res.json({
    configured: true,
    authenticated: true,
    expiresAt: session.expiresAt,
    sessionTtlMinutes: session.sessionTtlMinutes,
  });
});

// POST /api/admin/auth/logout
router.post('/logout', (req, res) => {
  logoutAdmin(req, res);
  res.json({ success: true });
});

// GET /api/admin/auth/keys
router.get('/keys', requireAdminAuth, (req, res) => {
  res.json(listAdminKeys());
});

// POST /api/admin/auth/keys
router.post('/keys', requireAdminAuth, (req, res) => {
  const name = String(req.body?.name || '').trim() || 'Admin Key';
  const key = generateAdminKey();
  const keyId = createAdminKeyRecord(name, key);
  res.status(201).json({ id: keyId, name, key });
});

// PUT /api/admin/auth/keys/:id
router.put('/keys/:id', requireAdminAuth, (req, res) => {
  const keyId = parseInt(req.params.id, 10);
  if (!Number.isInteger(keyId)) return res.status(400).json({ error: 'Invalid id' });

  const result = renameAdminKey(keyId, req.body?.name);
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  res.json({ success: true });
});

// DELETE /api/admin/auth/keys/:id
router.delete('/keys/:id', requireAdminAuth, (req, res) => {
  const keyId = parseInt(req.params.id, 10);
  if (!Number.isInteger(keyId)) return res.status(400).json({ error: 'Invalid id' });

  const result = revokeAdminKey(keyId);
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  res.json({ success: true });
});

module.exports = router;
