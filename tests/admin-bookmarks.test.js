'use strict';

process.env.DATA_DIR = `/tmp/ourtube-admin-bookmarks-${process.pid}`;

const fs = require('fs');
const express = require('express');
const request = require('supertest');

const { initDb, getDb } = require('../src/db');
jest.mock('../src/scanner', () => ({
  scanLocation: jest.fn(),
  scanAllLocations: jest.fn(),
  getScanStatus: jest.fn(() => ({ running: false, currentLocation: null, startedAt: null })),
  killScan: jest.fn(() => false),
}));
const adminApiRouter = require('../src/routes/admin-api');

let app;

beforeAll(() => {
  initDb();
  const db = getDb();

  const locInsert = db.prepare(
    `INSERT INTO source_locations (name, path, type, enabled, visibility)
     VALUES ('Admin Bookmarks', '/tmp/admin-bookmarks', 'video', 1, 'all')`
  ).run();
  const sourceLocationId = Number(locInsert.lastInsertRowid);

  db.prepare(
    `INSERT INTO media (id, type, source_location_id, file_path, file_name, visibility, tags)
     VALUES ('admin-bookmark-video', 'video', ?, '/tmp/admin-bookmarks/video.mp4', 'video.mp4', 'all', '[]')`
  ).run(sourceLocationId);

  db.prepare(
    `INSERT INTO video_bookmarks (media_id, time_seconds, title, annotation, tags)
     VALUES ('admin-bookmark-video', 15.2, 'Needle title', 'Regular bookmark annotation', '["alpha"]')`
  ).run();

  db.prepare(
    `INSERT INTO virtual_video_bookmarks (media_id, time_seconds, title, annotation, tags)
     VALUES ('virtual_1_L3RtcC9hZG1pbi1ib29rbWFya3M', 32.8, 'Virtual mark', 'Virtual bookmark annotation', '["beta"]')`
  ).run();

  app = express();
  app.use(express.json());
  app.use('/api/admin', adminApiRouter);
});

afterAll(() => {
  try {
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe('admin bookmark management API', () => {
  test('GET /api/admin/bookmarks lists regular and virtual bookmarks', async () => {
    const res = await request(app).get('/api/admin/bookmarks');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.some(item => item.scope === 'regular')).toBe(true);
    expect(res.body.items.some(item => item.scope === 'virtual')).toBe(true);
  });

  test('GET /api/admin/bookmarks supports search filtering', async () => {
    const res = await request(app).get('/api/admin/bookmarks?q=Needle');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.every(item => (item.title || '').includes('Needle') || (item.media_name || '').includes('Needle'))).toBe(true);
  });

  test('DELETE /api/admin/bookmarks/:scope/:id deletes regular bookmark', async () => {
    const db = getDb();
    const row = db.prepare(`SELECT id FROM video_bookmarks WHERE media_id = 'admin-bookmark-video' LIMIT 1`).get();
    expect(row?.id).toBeDefined();

    const res = await request(app).delete(`/api/admin/bookmarks/regular/${row.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ success: true, scope: 'regular' }));

    const after = db.prepare('SELECT id FROM video_bookmarks WHERE id = ?').get(row.id);
    expect(after).toBeUndefined();
  });

  test('DELETE /api/admin/bookmarks/:scope/:id deletes virtual bookmark', async () => {
    const db = getDb();
    const row = db.prepare(`SELECT id FROM virtual_video_bookmarks LIMIT 1`).get();
    expect(row?.id).toBeDefined();

    const res = await request(app).delete(`/api/admin/bookmarks/virtual/${row.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ success: true, scope: 'virtual' }));

    const after = db.prepare('SELECT id FROM virtual_video_bookmarks WHERE id = ?').get(row.id);
    expect(after).toBeUndefined();
  });
});
