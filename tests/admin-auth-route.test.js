'use strict';

process.env.DATA_DIR = `/tmp/ourtube-admin-auth-route-${process.pid}`;
process.env.NODE_ENV = 'test';

const fs = require('fs');
const express = require('express');
const request = require('supertest');

jest.mock('../src/telemetry', () => ({
  recordAdminLoginAttempt: jest.fn(),
}));

const { initDb } = require('../src/db');
const { createAdminKeyRecord } = require('../src/admin-auth');
const telemetry = require('../src/telemetry');
const adminAuthRouter = require('../src/routes/admin-auth');

let app;
let bootstrapKey;

beforeAll(() => {
  initDb();

  bootstrapKey = 'route-login-secret';
  createAdminKeyRecord('Bootstrap Key', bootstrapKey);

  app = express();
  app.use(express.json());
  app.use('/api/admin/auth', adminAuthRouter);
});

afterAll(() => {
  try {
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe('POST /api/admin/auth/login', () => {
  beforeEach(() => {
    telemetry.recordAdminLoginAttempt.mockClear();
  });

  test('returns MISSING_KEY when key is not provided', async () => {
    const res = await request(app)
      .post('/api/admin/auth/login')
      .send({});

    expect(res.status).toBe(400);
    expect(String(res.headers['cache-control'] || '')).toContain('no-store');
    expect(res.body).toEqual(expect.objectContaining({
      errorCode: 'MISSING_KEY',
      error: expect.any(String),
    }));
    expect(telemetry.recordAdminLoginAttempt).toHaveBeenCalledWith('failure', { reason: 'missing_key' });
  });

  test('returns INVALID_KEY when key is wrong', async () => {
    const res = await request(app)
      .post('/api/admin/auth/login')
      .send({ key: 'definitely-wrong' });

    expect(res.status).toBe(401);
    expect(String(res.headers['cache-control'] || '')).toContain('no-store');
    expect(res.body).toEqual(expect.objectContaining({
      errorCode: 'INVALID_KEY',
      error: expect.any(String),
    }));
    expect(telemetry.recordAdminLoginAttempt).toHaveBeenCalledWith('failure', { reason: 'invalid_key' });
  });

  test('accepts keys with leading/trailing whitespace', async () => {
    const res = await request(app)
      .post('/api/admin/auth/login')
      .send({ key: `  ${bootstrapKey}\n` });

    expect(res.status).toBe(200);
    expect(String(res.headers['cache-control'] || '')).toContain('no-store');
    expect(String(res.headers['set-cookie'] || '')).not.toContain('Secure');
    expect(res.body).toEqual(expect.objectContaining({
      configured: true,
      authenticated: true,
      expiresAt: expect.any(Number),
      sessionTtlMinutes: expect.any(Number),
    }));
    expect(telemetry.recordAdminLoginAttempt).toHaveBeenCalledWith('success');
  });

  test('status endpoint is not cacheable', async () => {
    const res = await request(app).get('/api/admin/auth/status');

    expect(res.status).toBe(200);
    expect(String(res.headers['cache-control'] || '')).toContain('no-store');
    expect(res.body).toEqual(expect.objectContaining({
      configured: expect.any(Boolean),
      authenticated: expect.any(Boolean),
    }));
  });

  test('marks session cookie Secure when login request is https-forwarded', async () => {
    const res = await request(app)
      .post('/api/admin/auth/login')
      .set('x-forwarded-proto', 'https')
      .send({ key: bootstrapKey });

    expect(res.status).toBe(200);
    expect(String(res.headers['set-cookie'] || '')).toContain('Secure');
  });
});
