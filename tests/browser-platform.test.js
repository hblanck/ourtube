'use strict';

// Must be set before any project modules are required so db.js picks up the temp path.
process.env.DATA_DIR = `/tmp/ourtube-test-${process.pid}`;

const express = require('express');
const request = require('supertest');

const { initDb, getDb } = require('../src/db');
const { buildVirtualMediaId } = require('../src/virtual-media');
const apiRouter = require('../src/routes/api');
const streamRouter = require('../src/routes/stream');

// ─── User-agent strings for common browsers and platforms ────────────────────

const USER_AGENTS = {
  'Chrome on Windows': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Chrome on macOS': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Chrome on Android': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.76 Mobile Safari/537.36',
  'Safari on macOS': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  'Safari on iOS': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1',
  'Firefox on Windows': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Firefox on macOS': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Firefox on Android': 'Mozilla/5.0 (Android 14; Mobile; rv:125.0) Gecko/125.0 Firefox/125.0',
};

const UA_ENTRIES = Object.entries(USER_AGENTS);

// ─── Test app setup ───────────────────────────────────────────────────────────

let app;
let virtualMediaId;
const directMediaId = 'direct-transcode-media';

beforeAll(() => {
  initDb();
  const db = getDb();

  // Seed: source location with stitch_directories enabled.
  const locResult = db.prepare(
    `INSERT INTO source_locations (name, path, type, stitch_directories, enabled)
     VALUES ('Test Location', '/test/media', 'both', 1, 1)`
  ).run();
  const sourceLocationId = Number(locResult.lastInsertRowid);

  // Seed: directory entry that groups segments together.
  const groupPath = `/test/media/group1`;
  db.prepare(
    `INSERT INTO source_location_entries (source_location_id, entry_path, entry_type)
     VALUES (?, ?, 'directory')`
  ).run(sourceLocationId, groupPath);

  // Seed: two video segments inside the directory entry.
  for (let i = 1; i <= 2; i++) {
    db.prepare(
      `INSERT INTO media (id, source_location_id, type, file_path, file_name, size, duration, visibility)
       VALUES (?, ?, 'video', ?, ?, 1000000, 60, 'all')`
    ).run(
      `test-segment-${i}`,
      sourceLocationId,
      `${groupPath}/segment${i}.mp4`,
      `segment${i}.mp4`
    );
  }

  db.prepare(
    `INSERT INTO media (id, source_location_id, type, file_path, file_name, size, duration, visibility)
     VALUES (?, ?, 'video', ?, ?, 1000000, 90, 'all')`
  ).run(
    directMediaId,
    sourceLocationId,
    '/test/media/direct/source.mov',
    'source.mov'
  );

  virtualMediaId = buildVirtualMediaId(sourceLocationId, groupPath);

  // Build a minimal express app using the real route handlers.
  app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use('/api', apiRouter);
  app.use('/stream', streamRouter);
});

afterAll(() => {
  const fs = require('fs');
  try {
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function get(endpoint, ua) {
  return request(app).get(endpoint).set('User-Agent', ua);
}

// ─── API endpoint tests ───────────────────────────────────────────────────────

describe('GET /api/ui-settings', () => {
  test.each(UA_ENTRIES)('%s — responds 200 with UI settings fields', async (_, ua) => {
    const res = await get('/api/ui-settings', ua);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('photos_enabled');
    expect(res.body).toHaveProperty('stitched_prefer_compatibility');
    expect(typeof res.body.stitched_prefer_compatibility).toBe('boolean');
  });
});

describe('GET /api/media', () => {
  test.each(UA_ENTRIES)('%s — responds 200 with items array', async (_, ua) => {
    const res = await get('/api/media', ua);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('items');
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body).toHaveProperty('total');
  });
});

describe('GET /api/media/featured', () => {
  test.each(UA_ENTRIES)('%s — responds 200 with recent and popular arrays', async (_, ua) => {
    const res = await get('/api/media/featured', ua);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.recent)).toBe(true);
    expect(Array.isArray(res.body.popular)).toBe(true);
  });
});

describe('GET /api/search', () => {
  test.each(UA_ENTRIES)('%s — responds 200 with items array', async (_, ua) => {
    const res = await get('/api/search?q=test', ua);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('items');
    expect(Array.isArray(res.body.items)).toBe(true);
  });
});

describe('GET /api/stats', () => {
  test.each(UA_ENTRIES)('%s — responds 200 with numeric counts', async (_, ua) => {
    const res = await get('/api/stats', ua);
    expect(res.status).toBe(200);
    expect(typeof res.body.total).toBe('number');
    expect(typeof res.body.videos).toBe('number');
    expect(typeof res.body.photos).toBe('number');
  });
});

describe('GET /api/years', () => {
  test.each(UA_ENTRIES)('%s — responds 200 with an array', async (_, ua) => {
    const res = await get('/api/years', ua);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('GET /api/locations', () => {
  test.each(UA_ENTRIES)('%s — responds 200 with an array', async (_, ua) => {
    const res = await get('/api/locations', ua);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('GET /api/tags', () => {
  test.each(UA_ENTRIES)('%s — responds 200 with an array', async (_, ua) => {
    const res = await get('/api/tags', ua);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ─── Stream: 404 for unknown media (all browsers) ────────────────────────────

describe('GET /stream/:id — unknown media returns 404', () => {
  test.each(UA_ENTRIES)('%s — returns 404', async (_, ua) => {
    const res = await get('/stream/nonexistent-media-id', ua);
    expect(res.status).toBe(404);
  });
});

describe('GET /stream/:id/transcode — unknown media returns 404', () => {
  test.each(UA_ENTRIES)('%s — returns 404', async (_, ua) => {
    const res = await get('/stream/nonexistent-media-id/transcode?_ts=1', ua);
    expect(res.status).toBe(404);
  });
});

// ─── Stream: Safari range probe returns 206 for virtual transcode ─────────────

describe('GET /stream/:virtualId/transcode — Safari byte-range probe', () => {
  const SAFARI_UAS = [
    ['Safari on macOS', USER_AGENTS['Safari on macOS']],
    ['Safari on iOS', USER_AGENTS['Safari on iOS']],
  ];

  test.each(SAFARI_UAS)(
    '%s — Range: bytes=0-1 with watch params returns 206',
    async (_, ua) => {
      const res = await request(app)
        .get(`/stream/${virtualMediaId}/transcode?_ts=1`)
        .set('User-Agent', ua)
        .set('Range', 'bytes=0-1');

      expect(res.status).toBe(206);
      expect(res.headers['content-range']).toMatch(/^bytes 0-1\//);
      expect(res.headers['accept-ranges']).toBe('bytes');
    }
  );

  test.each(SAFARI_UAS)(
    '%s — Range: bytes=0- with watch params returns 206',
    async (_, ua) => {
      const res = await request(app)
        .get(`/stream/${virtualMediaId}/transcode?_ts=1`)
        .set('User-Agent', ua)
        .set('Range', 'bytes=0-');

      expect(res.status).toBe(206);
      expect(res.headers['content-range']).toMatch(/^bytes 0-1\//);
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['content-length']).toBe('2');
    }
  );

  // Without watch params the server short-circuits with 204 (stale request guard).
  test.each(SAFARI_UAS)(
    '%s — Range: bytes=0-1 without watch params returns 204',
    async (_, ua) => {
      const res = await request(app)
        .get(`/stream/${virtualMediaId}/transcode`)
        .set('User-Agent', ua)
        .set('Range', 'bytes=0-1');

      expect(res.status).toBe(204);
    }
  );
});

describe('GET /stream/:id/transcode — direct video Safari byte-range probe', () => {
  const SAFARI_UAS = [
    ['Safari on macOS', USER_AGENTS['Safari on macOS']],
    ['Safari on iOS', USER_AGENTS['Safari on iOS']],
  ];

  test.each(SAFARI_UAS)(
    '%s — Range: bytes=0-1 returns 206 before transcode starts',
    async (_, ua) => {
      const res = await request(app)
        .get(`/stream/${directMediaId}/transcode`)
        .set('User-Agent', ua)
        .set('Range', 'bytes=0-1');

      expect(res.status).toBe(206);
      expect(res.headers['content-range']).toMatch(/^bytes 0-1\//);
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['content-type']).toMatch(/^video\/mp4/);
      expect(res.headers['content-length']).toBe('2');
    }
  );

  test.each(SAFARI_UAS)(
    '%s — Range: bytes=0- returns 206 before transcode starts',
    async (_, ua) => {
      const res = await request(app)
        .get(`/stream/${directMediaId}/transcode`)
        .set('User-Agent', ua)
        .set('Range', 'bytes=0-');

      expect(res.status).toBe(206);
      expect(res.headers['content-range']).toMatch(/^bytes 0-1\//);
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['content-type']).toMatch(/^video\/mp4/);
      expect(res.headers['content-length']).toBe('2');
    }
  );
});

// ─── Stream: Non-Safari browsers — transcode without range header ─────────────

describe('GET /stream/:virtualId/transcode — non-Safari browsers without Range header', () => {
  const NON_SAFARI_UAS = UA_ENTRIES.filter(
    ([name]) => !name.startsWith('Safari')
  );

  // Virtual transcode requests without watch params are rejected with 204 for all browsers.
  test.each(NON_SAFARI_UAS)(
    '%s — request without watch params returns 204',
    async (_, ua) => {
      const res = await request(app)
        .get(`/stream/${virtualMediaId}/transcode`)
        .set('User-Agent', ua);

      expect(res.status).toBe(204);
    }
  );
});

// ─── Stream: virtual media ID rejected on direct /stream/:id ──────────────────

describe('GET /stream/:virtualId — virtual ID on direct stream endpoint', () => {
  test.each(UA_ENTRIES)(
    '%s — returns 400 (virtual videos require compatibility streaming)',
    async (_, ua) => {
      const res = await get(`/stream/${virtualMediaId}`, ua);
      expect(res.status).toBe(400);
    }
  );
});
