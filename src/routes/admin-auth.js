'use strict';

const express = require('express');
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

// GET /api/admin/auth/status
router.get('/status', (req, res) => {
  res.json(getAdminAuthStatus(req));
});

// POST /api/admin/auth/login
router.post('/login', (req, res) => {
  const key = String(req.body?.key || '').trim();
  if (!key) return res.status(400).json({ error: 'key is required' });

  const keyId = tryAuthenticateAdminKey(key);
  if (!keyId) return res.status(401).json({ error: 'Invalid admin key' });

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
