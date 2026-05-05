'use strict';

process.env.DATA_DIR = `/tmp/ourtube-admin-system-info-${process.pid}`;
process.env.NODE_ENV = 'test';
process.env.PORT = '4321';

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
}));

const adminApiRouter = require('../src/routes/admin-api');

let app;

beforeAll(() => {
  initDb();

  const db = getDb();
  const locationId = Number(db.prepare(
    `INSERT INTO source_locations (name, path, type, enabled)
     VALUES ('NAS', '/media/library', 'both', 1)`
  ).run().lastInsertRowid);

  db.prepare(
    `INSERT INTO source_location_entries (source_location_id, entry_path, entry_type)
     VALUES (?, '/media/library', 'directory')`
  ).run(locationId);

  db.prepare(
    `INSERT INTO media (id, source_location_id, type, file_path, file_name, size, visibility)
     VALUES ('video-1', ?, 'video', '/media/library/video-1.mp4', 'video-1.mp4', 1024, 'all')`
  ).run(locationId);

  db.prepare(
    `INSERT INTO skipped_files (file_path, source_location_id, reason)
     VALUES ('/media/library/skipped.tmp', ?, 'unsupported')`
  ).run(locationId);

  app = express();
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
});

describe('GET /api/admin/system-info', () => {
  test('returns runtime, path, feature, and library summaries', async () => {
    const res = await request(app).get('/api/admin/system-info');

    expect(res.status).toBe(200);
    expect(res.body.app).toEqual(expect.objectContaining({
      name: 'ourtube',
      version: expect.any(String),
    }));
    expect(res.body.runtime).toEqual(expect.objectContaining({
      nodeVersion: process.version,
      environment: 'test',
      port: 4321,
      pid: expect.any(Number),
      hostname: expect.any(String),
      cwd: expect.any(String),
      cpuCount: expect.any(Number),
      memoryUsage: expect.objectContaining({
        rssBytes: expect.any(Number),
        heapUsedBytes: expect.any(Number),
      }),
    }));
    expect(res.body.paths.dataDir).toEqual(expect.objectContaining({
      path: expect.stringContaining('/tmp/ourtube-admin-system-info-'),
      exists: true,
      readable: true,
    }));
    expect(res.body.paths.database).toEqual(expect.objectContaining({
      path: expect.stringContaining('ourtube.db'),
      exists: true,
    }));
    expect(res.body.paths.databaseFileSizeBytes).toEqual(expect.any(Number));
    expect(res.body.features).toEqual(expect.objectContaining({
      photosEnabled: true,
      faceDetectionEnabled: false,
      scanOnStartup: false,
    }));
    expect(res.body.library).toEqual(expect.objectContaining({
      sourceLocations: 1,
      enabledSourceLocations: 1,
      sourceEntries: 1,
      mediaItems: 1,
      videos: 1,
      photos: 0,
      skippedFiles: 1,
    }));
    expect(res.body.scan).toEqual(expect.objectContaining({
      inProgress: expect.any(Boolean),
      filesFound: expect.any(Number),
      filesIndexed: expect.any(Number),
      errors: expect.any(Number),
      schedule: expect.objectContaining({
        enabledLocations: 1,
        dueNow: 1,
        neverScanned: 1,
      }),
    }));
  });
});