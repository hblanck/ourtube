'use strict';

process.env.DATA_DIR = `/tmp/ourtube-social-${process.pid}`;

const fs = require('fs');
const express = require('express');
const request = require('supertest');

const { initDb, getDb } = require('../src/db');
const { buildVirtualMediaId } = require('../src/virtual-media');
const apiRouter = require('../src/routes/api');

let app;
let sourceLocationId;
let virtualMediaId;

beforeAll(() => {
  initDb();
  const db = getDb();

  const locationInsert = db.prepare(
    `INSERT INTO source_locations (name, path, type, enabled, visibility)
     VALUES ('Social Test', '/tmp/social', 'video', 1, 'all')`
  ).run();
  sourceLocationId = Number(locationInsert.lastInsertRowid);

  db.prepare(
    `INSERT INTO media (id, type, source_location_id, file_path, file_name, visibility, tags)
     VALUES ('video-social-1', 'video', ?, '/tmp/social/video.mp4', 'video.mp4', 'all', '[]')`
  ).run(sourceLocationId);

  db.prepare(`UPDATE source_locations SET stitch_directories = 1 WHERE id = ?`).run(sourceLocationId);
  db.prepare(
    `INSERT INTO source_location_entries (source_location_id, entry_path, entry_type)
     VALUES (?, '/tmp/social/groupA', 'directory')`
  ).run(sourceLocationId);
  db.prepare(
    `INSERT INTO media (id, type, source_location_id, file_path, file_name, visibility, tags)
     VALUES ('video-social-v1', 'video', ?, '/tmp/social/groupA/clip1.mp4', 'clip1.mp4', 'all', '[]')`
  ).run(sourceLocationId);
  db.prepare(
    `INSERT INTO media (id, type, source_location_id, file_path, file_name, visibility, tags)
     VALUES ('video-social-v2', 'video', ?, '/tmp/social/groupA/clip2.mp4', 'clip2.mp4', 'all', '[]')`
  ).run(sourceLocationId);
  virtualMediaId = buildVirtualMediaId(sourceLocationId, '/tmp/social/groupA');

  app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
});

afterAll(() => {
  try {
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  } catch {
    // best effort cleanup
  }
});

describe('social API features', () => {
  test('GET /api/ui-settings includes external_base_url', async () => {
    const db = getDb();
    db.prepare(`UPDATE settings SET value = 'https://public.example.com/' WHERE key = 'external_base_url'`).run();

    const res = await request(app).get('/api/ui-settings');
    expect(res.status).toBe(200);
    expect(res.body.external_base_url).toBe('https://public.example.com');
    expect(res.body).toHaveProperty('stitched_prefer_compatibility');
    expect(typeof res.body.stitched_prefer_compatibility).toBe('boolean');
  });

  test('POST/GET bookmarks on a video', async () => {
    const create = await request(app)
      .post('/api/media/video-social-1/bookmarks')
      .send({
        time_seconds: 42.5,
        title: 'Important moment',
        annotation: 'Look at this sequence',
        tags: ['highlight', 'intro'],
      });

    expect(create.status).toBe(201);
    expect(create.body).toEqual(expect.objectContaining({
      media_id: 'video-social-1',
      title: 'Important moment',
      annotation: 'Look at this sequence',
    }));
    expect(Array.isArray(create.body.tags)).toBe(true);

    const list = await request(app).get('/api/media/video-social-1/bookmarks');
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.items)).toBe(true);
    expect(list.body.items.length).toBeGreaterThanOrEqual(1);
    expect(list.body.items[0]).toEqual(expect.objectContaining({
      media_id: 'video-social-1',
    }));
  });

  test('POST bookmarks validates invalid time', async () => {
    const res = await request(app)
      .post('/api/media/video-social-1/bookmarks')
      .send({ time_seconds: -1, annotation: 'bad' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({
      error: expect.any(String),
    }));
  });

  test('POST/GET comments on a video', async () => {
    const create = await request(app)
      .post('/api/media/video-social-1/comments')
      .send({ author_name: 'Viewer', comment_text: 'Great clip!' });

    expect(create.status).toBe(201);
    expect(create.body).toEqual(expect.objectContaining({
      media_id: 'video-social-1',
      author_name: 'Viewer',
      comment_text: 'Great clip!',
    }));

    const list = await request(app).get('/api/media/video-social-1/comments');
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.items)).toBe(true);
    expect(list.body.items[0]).toEqual(expect.objectContaining({
      media_id: 'video-social-1',
      comment_text: 'Great clip!',
    }));
  });

  test('POST comments requires text', async () => {
    const res = await request(app)
      .post('/api/media/video-social-1/comments')
      .send({ author_name: 'Viewer', comment_text: '   ' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({
      error: expect.any(String),
    }));
  });

  test('POST/GET bookmarks and comments on a virtual video', async () => {
    const createBookmark = await request(app)
      .post(`/api/media/${encodeURIComponent(virtualMediaId)}/bookmarks`)
      .send({
        time_seconds: 12,
        title: 'Virtual marker',
        annotation: 'Works on stitched videos too',
        tags: ['stitched'],
      });
    expect(createBookmark.status).toBe(201);
    expect(createBookmark.body.media_id).toBe(virtualMediaId);

    const listBookmarks = await request(app).get(`/api/media/${encodeURIComponent(virtualMediaId)}/bookmarks`);
    expect(listBookmarks.status).toBe(200);
    expect(Array.isArray(listBookmarks.body.items)).toBe(true);
    expect(listBookmarks.body.items[0]).toEqual(expect.objectContaining({
      media_id: virtualMediaId,
      title: 'Virtual marker',
    }));

    const createComment = await request(app)
      .post(`/api/media/${encodeURIComponent(virtualMediaId)}/comments`)
      .send({ author_name: 'Viewer', comment_text: 'Virtual comment works' });
    expect(createComment.status).toBe(201);
    expect(createComment.body).toEqual(expect.objectContaining({
      media_id: virtualMediaId,
      comment_text: 'Virtual comment works',
    }));

    const listComments = await request(app).get(`/api/media/${encodeURIComponent(virtualMediaId)}/comments`);
    expect(listComments.status).toBe(200);
    expect(Array.isArray(listComments.body.items)).toBe(true);
    expect(listComments.body.items[0]).toEqual(expect.objectContaining({
      media_id: virtualMediaId,
      comment_text: 'Virtual comment works',
    }));
  });
});
