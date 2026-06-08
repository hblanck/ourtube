'use strict';

process.env.DATA_DIR = `/tmp/ourtube-admin-source-locations-${process.pid}`;
process.env.NODE_ENV = 'test';
process.env.SOURCE_LOCATION_ROOTS = [
  `/tmp/ourtube-source-root-a-${process.pid}`,
  `/tmp/ourtube-source-root-b-${process.pid}`,
].join(',');

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const rootA = process.env.SOURCE_LOCATION_ROOTS.split(',')[0];
const rootB = process.env.SOURCE_LOCATION_ROOTS.split(',')[1];

const { initDb, getDb } = require('../src/db');

jest.mock('../src/scanner', () => ({
  scanLocation: jest.fn(),
  scanAllLocations: jest.fn(),
  getScanStatus: () => ({
    inProgress: false,
    lastRun: null,
    filesFound: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    errors: 0,
    currentFile: null,
    recentOutput: [],
  }),
  killScan: jest.fn(),
}));

const adminApiRouter = require('../src/routes/admin-api');

let app;

beforeAll(() => {
  fs.mkdirSync(path.join(rootA, 'library-a'), { recursive: true });
  fs.mkdirSync(path.join(rootB, 'library-b'), { recursive: true });

  initDb();
  const db = getDb();
  const existingLocationId = Number(db.prepare(
    `INSERT INTO source_locations (name, path, type, enabled)
     VALUES ('Existing Library', ?, 'both', 1)`
  ).run(path.join(rootA, 'library-a')).lastInsertRowid);

  db.prepare(
    `INSERT INTO source_location_entries (source_location_id, entry_path, entry_type)
     VALUES (?, ?, 'directory')`
  ).run(existingLocationId, path.join(rootA, 'library-a'));

  app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    req.adminSession = { keyId: 1 };
    next();
  });
  app.use('/api/admin', adminApiRouter);
});

afterAll(() => {
  try {
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
  try {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe('admin source location roots and dedupe', () => {
  test('browses configured roots and lists all roots in response', async () => {
    const res = await request(app)
      .get('/api/admin/media-root/browse')
      .query({ path: rootB });

    expect(res.status).toBe(200);
    expect(res.body.current).toBe(rootB);
    expect(res.body.root).toBe(rootB);
    expect(res.body.roots).toEqual(expect.arrayContaining([rootA, rootB]));
    expect(res.body.directories).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'library-b' }),
    ]));
  });

  test('rejects adding entries outside configured source roots', async () => {
    const res = await request(app)
      .post('/api/admin/locations')
      .send({
        name: 'Outside Root',
        entries: [{ path: '/etc', type: 'directory' }],
        type: 'both',
        visibility: 'all',
        scan_interval: 3600,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('configured source roots');
  });

  test('rejects duplicate entries already used by another source location', async () => {
    const duplicatePath = path.join(rootA, 'library-a');
    const res = await request(app)
      .post('/api/admin/locations')
      .send({
        name: 'Duplicate Location',
        entries: [{ path: duplicatePath, type: 'directory' }],
        type: 'both',
        visibility: 'all',
        scan_interval: 3600,
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('already used');
    expect(res.body.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: duplicatePath, locationName: 'Existing Library' }),
    ]));
  });
});
