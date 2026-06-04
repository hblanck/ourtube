'use strict';

process.env.DATA_DIR = `/tmp/ourtube-downloadable-${process.pid}`;

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const { initDb, getDb } = require('../src/db');
const { buildVirtualMediaId } = require('../src/virtual-media');
const apiRouter = require('../src/routes/api');
const adminApiRouter = require('../src/routes/admin-api');

let app;
let sourceLocationId;
let virtualMediaId;

beforeAll(() => {
  initDb();
  const db = getDb();

  const sourcePath = path.join(process.env.DATA_DIR, 'media');
  const stitchedPath = path.join(sourcePath, 'stitched');
  fs.mkdirSync(stitchedPath, { recursive: true });

  const regularFile = path.join(sourcePath, 'regular.mp4');
  const seg1File = path.join(stitchedPath, 'clip1.mp4');
  const seg2File = path.join(stitchedPath, 'clip2.mp4');
  fs.writeFileSync(regularFile, 'regular-video-content');
  fs.writeFileSync(seg1File, 'segment-one-content');
  fs.writeFileSync(seg2File, 'segment-two-content');

  const locationInsert = db.prepare(
    `INSERT INTO source_locations (name, path, type, stitch_directories, enabled, visibility)
     VALUES ('Download Tests', ?, 'video', 1, 1, 'all')`
  ).run(sourcePath);
  sourceLocationId = Number(locationInsert.lastInsertRowid);

  db.prepare(
    `INSERT INTO source_location_entries (source_location_id, entry_path, entry_type)
     VALUES (?, ?, 'directory')`
  ).run(sourceLocationId, stitchedPath);

  db.prepare(
    `INSERT INTO media (id, source_location_id, type, file_path, file_name, size, visibility, downloadable)
     VALUES ('download-regular', ?, 'video', ?, 'regular.mp4', 2048, 'all', 0)`
  ).run(sourceLocationId, regularFile);

  db.prepare(
    `INSERT INTO media (id, source_location_id, type, file_path, file_name, size, visibility, downloadable)
     VALUES ('download-seg-1', ?, 'video', ?, 'clip1.mp4', 1024, 'all', 0)`
  ).run(sourceLocationId, seg1File);
  db.prepare(
    `INSERT INTO media (id, source_location_id, type, file_path, file_name, size, visibility, downloadable)
     VALUES ('download-seg-2', ?, 'video', ?, 'clip2.mp4', 1024, 'all', 0)`
  ).run(sourceLocationId, seg2File);

  virtualMediaId = buildVirtualMediaId(sourceLocationId, stitchedPath);

  app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  app.use('/api/admin', adminApiRouter);
});

afterAll(() => {
  try {
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  } catch {
    // best effort cleanup
  }
});

describe('downloadable video controls', () => {
  test('GET /api/media/:id/download blocks downloads when not enabled', async () => {
    const res = await request(app).get('/api/media/download-regular/download');
    expect(res.status).toBe(403);
    expect(res.body).toEqual(expect.objectContaining({ error: expect.any(String) }));
  });

  test('PUT /api/admin/media/:id can enable downloadable and download succeeds', async () => {
    const save = await request(app)
      .put('/api/admin/media/download-regular')
      .send({ downloadable: 1 });
    expect(save.status).toBe(200);
    expect(Number(save.body.downloadable)).toBe(1);

    const res = await request(app).get('/api/media/download-regular/download');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment;');
  });

  test('PUT /api/admin/media/:virtualId updates stitched segment downloadable state', async () => {
    const save = await request(app)
      .put(`/api/admin/media/${encodeURIComponent(virtualMediaId)}`)
      .send({ downloadable: 1 });
    expect(save.status).toBe(200);
    expect(save.body).toEqual(expect.objectContaining({ updated: 2 }));

    const virtual = await request(app).get(`/api/media/${encodeURIComponent(virtualMediaId)}`);
    expect(virtual.status).toBe(200);
    expect(Number(virtual.body.downloadable)).toBe(1);
    expect(Array.isArray(virtual.body.segments)).toBe(true);
    expect(virtual.body.segments.every(segment => Number(segment.downloadable) === 1)).toBe(true);
  });

  test('GET /api/media/:virtualId/download rejects virtual direct downloads', async () => {
    const res = await request(app).get(`/api/media/${encodeURIComponent(virtualMediaId)}/download`);
    expect(res.status).toBe(400);
  });
});
