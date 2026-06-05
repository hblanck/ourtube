'use strict';

process.env.DATA_DIR = `/tmp/ourtube-test-range-${process.pid}`;

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const { initDb, getDb } = require('../src/db');
const streamRouter = require('../src/routes/stream');
const { getActiveSessions } = require('../src/sessions');

let app;
const mediaId = 'range-test-video';
const fixturePath = path.join(process.env.DATA_DIR, 'fixtures', 'range-test.mp4');
const fixtureBytes = Buffer.from(Array.from({ length: 100 }, (_, idx) => idx));

beforeAll(() => {
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, fixtureBytes);

  initDb();
  const db = getDb();

  const locResult = db.prepare(
    `INSERT INTO source_locations (name, path, type, enabled)
     VALUES ('Range Test Location', '/test/media', 'both', 1)`
  ).run();
  const sourceLocationId = Number(locResult.lastInsertRowid);

  db.prepare(
    `INSERT INTO media (id, source_location_id, type, file_path, file_name, size, visibility)
     VALUES (?, ?, 'video', ?, 'range-test.mp4', ?, 'all')`
  ).run(mediaId, sourceLocationId, fixturePath, fixtureBytes.length);

  app = express();
  app.use('/stream', streamRouter);
});

afterAll(() => {
  try {
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe('GET /stream/:id range handling', () => {
  test('clamps oversized end offsets to file size', async () => {
    const res = await request(app)
      .get(`/stream/${mediaId}`)
      .set('Range', 'bytes=0-999999');

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-${fixtureBytes.length - 1}/${fixtureBytes.length}`);
    expect(res.headers['content-length']).toBe(String(fixtureBytes.length));
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.length).toBe(fixtureBytes.length);
  });

  test('supports suffix byte ranges', async () => {
    const res = await request(app)
      .get(`/stream/${mediaId}`)
      .set('Range', 'bytes=-10');

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 90-99/${fixtureBytes.length}`);
    expect(res.headers['content-length']).toBe('10');
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.length).toBe(10);
  });

  test('returns 416 for unsatisfiable ranges', async () => {
    const res = await request(app)
      .get(`/stream/${mediaId}`)
      .set('Range', 'bytes=100-200');

    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${fixtureBytes.length}`);
  });

  test('does not treat open-ended ranges as Safari probe on transcode endpoint', async () => {
    const res = await request(app)
      .get(`/stream/${mediaId}/transcode`)
      .set('Range', 'bytes=0-');

    // Regression guard: this used to incorrectly return a 2-byte 206 probe response.
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('video/mp4');
    expect(res.headers['transfer-encoding']).toBe('chunked');
  });

  test('uses forwarded client IP when creating stream sessions', async () => {
    await request(app)
      .get(`/stream/${mediaId}`)
      .set('Range', 'bytes=0-9')
      .set('X-Forwarded-For', '203.0.113.10, 10.0.0.2');

    const sessions = getActiveSessions();
    expect(sessions.some(s => s.ip === '203.0.113.10')).toBe(true);
  });

  test('prefers x-real-ip over x-forwarded-for when both are present', async () => {
    await request(app)
      .get(`/stream/${mediaId}`)
      .set('Range', 'bytes=10-19')
      .set('X-Real-IP', '198.51.100.24')
      .set('X-Forwarded-For', '203.0.113.88, 10.0.0.3');

    const sessions = getActiveSessions();
    expect(sessions.some(s => s.ip === '198.51.100.24')).toBe(true);
  });
});
