'use strict';

process.env.DATA_DIR = `/tmp/ourtube-admin-db-mgmt-${process.pid}`;
process.env.NODE_ENV = 'test';

const fs = require('fs');
const express = require('express');
const request = require('supertest');

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
  initDb();
  const db = getDb();

  const locationId = Number(db.prepare(
    `INSERT INTO source_locations (name, path, type, enabled)
     VALUES ('Library', '/media/library', 'both', 1)`
  ).run().lastInsertRowid);

  db.prepare(
    `INSERT INTO media (source_location_id, type, file_path, file_name, friendly_name, visibility)
     VALUES (?, 'video', '/media/library/video-1.mp4', 'video-1.mp4', 'Video One', 'all')`
  ).run(locationId);

  app = express();
  app.use(express.json({ limit: '10mb' }));
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
    // best effort
  }
});

describe('admin database management API', () => {
  test('lists tables and browses table rows', async () => {
    const tablesRes = await request(app).get('/api/admin/database/tables');
    expect(tablesRes.status).toBe(200);
    expect(tablesRes.body.tables).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'media', rowCount: expect.any(Number) }),
    ]));

    const rowsRes = await request(app).get('/api/admin/database/tables/media/rows?limit=10&page=1');
    expect(rowsRes.status).toBe(200);
    expect(rowsRes.body.table).toBe('media');
    expect(rowsRes.body.columns).toEqual(expect.arrayContaining(['_rowid', 'friendly_name']));
    expect(rowsRes.body.rows.length).toBeGreaterThan(0);
    expect(rowsRes.body.rows[0]).toEqual(expect.objectContaining({
      _rowid: expect.any(Number),
      friendly_name: 'Video One',
    }));
  });

  test('updates a table row by rowid', async () => {
    const db = getDb();
    const row = db.prepare(`SELECT rowid AS _rowid FROM media LIMIT 1`).get();
    const updateRes = await request(app)
      .put(`/api/admin/database/tables/media/rows/${row._rowid}`)
      .send({ friendly_name: 'Updated Name' });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.row).toEqual(expect.objectContaining({
      _rowid: row._rowid,
      friendly_name: 'Updated Name',
    }));
  });

  test('exports table and selected records as sql', async () => {
    const tableExport = await request(app)
      .post('/api/admin/database/export')
      .send({ scope: 'table', table: 'media' });
    expect(tableExport.status).toBe(200);
    expect(tableExport.text).toContain('CREATE TABLE');
    expect(tableExport.text).toContain('INSERT INTO "media"');

    const db = getDb();
    const row = db.prepare(`SELECT rowid AS _rowid FROM media LIMIT 1`).get();
    const recordsExport = await request(app)
      .post('/api/admin/database/export')
      .send({ scope: 'records', table: 'media', rowids: [row._rowid] });
    expect(recordsExport.status).toBe(200);
    expect(recordsExport.text).toContain(`INSERT INTO "media"`);
  });

  test('imports sql dump payload', async () => {
    const importRes = await request(app)
      .post('/api/admin/database/import')
      .send({ sql: `INSERT INTO settings (key, value) VALUES ('db_test_key', 'ok');` });
    expect(importRes.status).toBe(200);
    expect(importRes.body).toEqual({ success: true });

    const db = getDb();
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'db_test_key'`).get();
    expect(row.value).toBe('ok');
  });
});
