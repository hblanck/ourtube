'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const { PassThrough } = require('stream');
const { getDb } = require('../db');
const { upsertSession, touchSession, addBytes } = require('../sessions');
const { getStitchGroupPath, isVirtualMediaId, parseVirtualMediaId, sortSegmentRows } = require('../virtual-media');
const { canAccessFromRow } = require('../visibility');

const DATA_DIR = process.env.DATA_DIR || '/data';
const router = express.Router();
const activeHlsJobs = new Map();
const HLS_JOB_TTL_MS = 30 * 60 * 1000;
const HLS_PLAYLIST_WAIT_MS = 12_000;
const HLS_SEGMENT_WAIT_MS = 6_000;

function escapeConcatPath(filePath) {
  return `'${String(filePath).replace(/'/g, `'\\''`)}'`;
}

function createConcatListFile(filePaths) {
  const tempDir = path.join(DATA_DIR, 'tmp');
  fs.mkdirSync(tempDir, { recursive: true });

  const listPath = path.join(tempDir, `virtual-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  const content = filePaths.map(filePath => `file ${escapeConcatPath(filePath)}`).join('\n');
  fs.writeFileSync(listPath, content, 'utf8');
  return listPath;
}

function cleanupFile(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.warn('[stream] Failed to remove temp file:', filePath, err.message);
  }
}

function getVirtualSegmentRows(db, mediaId, req) {
  const virtualRef = parseVirtualMediaId(mediaId);
  if (!virtualRef) return null;

  const rows = db.prepare(
        `SELECT m.id, m.type, m.file_path, m.file_name, m.duration, m.created_at, m.modified_at,
          m.visibility AS media_visibility, sl.visibility AS source_visibility,
            m.source_location_id, sl.stitch_directories,
            (
              SELECT sle.entry_path
              FROM source_location_entries sle
              WHERE sle.source_location_id = m.source_location_id
                AND (
                  (sle.entry_type = 'file' AND sle.entry_path = m.file_path)
                  OR (sle.entry_type = 'directory' AND (m.file_path = sle.entry_path OR m.file_path LIKE sle.entry_path || '/%'))
                )
              ORDER BY LENGTH(sle.entry_path) DESC
              LIMIT 1
            ) AS source_entry_path,
            (
              SELECT sle.entry_type
              FROM source_location_entries sle
              WHERE sle.source_location_id = m.source_location_id
                AND (
                  (sle.entry_type = 'file' AND sle.entry_path = m.file_path)
                  OR (sle.entry_type = 'directory' AND (m.file_path = sle.entry_path OR m.file_path LIKE sle.entry_path || '/%'))
                )
              ORDER BY LENGTH(sle.entry_path) DESC
              LIMIT 1
            ) AS source_entry_type
     FROM media m
     LEFT JOIN source_locations sl ON sl.id = m.source_location_id
     WHERE m.source_location_id = ? AND m.type = 'video'`
  ).all(virtualRef.sourceLocationId);

  const segmentRows = rows
    .filter(row => canAccessFromRow(row, req))
    .filter(row => getStitchGroupPath(row) === virtualRef.groupPath);
  if (!segmentRows.length) return null;
  return sortSegmentRows(segmentRows);
}

function getAudioCodec(row) {
  try {
    const raw = JSON.parse(row.raw_metadata || '{}');
    const streams = Array.isArray(raw.streams) ? raw.streams : [];
    const audioStream = streams.find(stream => stream.codec_type === 'audio');
    return (audioStream?.codec_name || '').toLowerCase();
  } catch {
    return '';
  }
}

function getStreamMimeType(row, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const videoCodec = String(row.codec || '').toLowerCase();
  const audioCodec = getAudioCodec(row);

  if (ext === '.webm') return 'video/webm';
  if (ext === '.mp4' || ext === '.m4v') return 'video/mp4';
  if (ext === '.mov') {
    const videoOk = ['h264', 'avc1'].includes(videoCodec);
    const audioOk = !audioCodec || ['aac', 'mp3'].includes(audioCodec);
    return videoOk && audioOk ? 'video/mp4' : 'video/quicktime';
  }

  return mime.lookup(filePath) || 'video/mp4';
}

function parseStartSeconds(value) {
  const seconds = Number.parseFloat(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return seconds;
}

function getCompatibilityTranscodeOptions() {
  return [
<<<<<<< HEAD
=======
    // Ensure broad browser/iOS support and prevent x264 failures on odd dimensions.
>>>>>>> f1de24dc6c5bfde6c56ce455907ed0a427cb69e6
    '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
    '-profile:v baseline',
    '-level 3.1',
    '-movflags frag_keyframe+empty_moov+default_base_moof+faststart',
    '-frag_duration 1000000',
    '-preset veryfast',
    '-tune zerolatency',
    '-crf 23',
    '-ac 2',
    '-ar 48000',
    '-b:a 128k',
    '-max_muxing_queue_size 1024'
  ];
}

function isIntentionalKillError(err) {
  const message = String(err?.message || '');
  return /killed with signal SIGKILL/i.test(message);
}

function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function createFfmpegDiagnostics(label) {
  const stderrTail = [];
  return {
    onStart(commandLine) {
      console.info(`[stream] ${label} ffmpeg start: ${commandLine}`);
    },
    onStderr(line) {
      const text = String(line || '').trim();
      if (!text) return;
      stderrTail.push(text);
      if (stderrTail.length > 40) stderrTail.shift();
    },
    logErrorContext(err) {
      const tail = stderrTail.length ? stderrTail.join(' | ') : 'no stderr captured';
      console.error(`[stream] ${label} ffmpeg error detail: ${tail}`);
      if (err?.message) {
        console.error(`[stream] ${label} ffmpeg error: ${err.message}`);
      }
    }
  };
}

function getHlsCompatibilityOptions(segmentPattern) {
  return [
    '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
    '-profile:v baseline',
    '-level 3.1',
    '-preset veryfast',
    '-tune zerolatency',
    '-crf 23',
    '-ac 2',
    '-ar 48000',
    '-b:a 128k',
    '-hls_time 4',
    '-hls_list_size 0',
    '-hls_playlist_type event',
    '-hls_flags independent_segments+append_list+temp_file',
    '-hls_segment_filename',
    segmentPattern,
    '-max_muxing_queue_size 1024'
  ];
}

function sanitizeForPath(value) {
  return String(value || 'media').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function waitForFile(filePath, timeoutMs) {
  const startedAt = Date.now();
  return new Promise(resolve => {
    const timer = setInterval(() => {
      if (fs.existsSync(filePath)) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 100);
    timer.unref?.();
  });
}

function disposeHlsJob(mediaId, reason) {
  const job = activeHlsJobs.get(mediaId);
  if (!job) return;

  activeHlsJobs.delete(mediaId);
  job.stopped = true;
  try {
    if (job.cmd) job.cmd.kill('SIGKILL');
  } catch {
    // Ignore shutdown race.
  }

  cleanupFile(job.concatListPath);
  try {
    if (job.dir && fs.existsSync(job.dir)) {
      fs.rmSync(job.dir, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn('[stream] Failed cleaning HLS temp dir:', job.dir, err.message);
  }

  console.info(`[stream] HLS job disposed id=${mediaId} reason=${reason}`);
}

function touchHlsJob(job) {
  if (!job) return;
  job.lastAccess = Date.now();
}

function sweepExpiredHlsJobs() {
  const now = Date.now();
  for (const [mediaId, job] of activeHlsJobs.entries()) {
    if (now - job.lastAccess > HLS_JOB_TTL_MS) {
      disposeHlsJob(mediaId, 'ttl-expired');
    }
  }
}

setInterval(sweepExpiredHlsJobs, 60_000).unref?.();

function ensureVirtualHlsJob(mediaId, req) {
  const existing = activeHlsJobs.get(mediaId);
  if (existing) {
    touchHlsJob(existing);
    return existing;
  }

  const db = getDb();
  const virtualSegments = getVirtualSegmentRows(db, mediaId, req);
  if (!virtualSegments) return null;

  const hlsRoot = path.join(DATA_DIR, 'tmp', 'hls');
  fs.mkdirSync(hlsRoot, { recursive: true });

  const jobDir = path.join(hlsRoot, `${sanitizeForPath(mediaId)}-${Date.now().toString(36)}`);
  fs.mkdirSync(jobDir, { recursive: true });

  const playlistPath = path.join(jobDir, 'index.m3u8');
  const segmentPattern = path.join(jobDir, 'seg-%06d.ts');
  const concatListPath = createConcatListFile(virtualSegments.map(row => row.file_path));
  const diag = createFfmpegDiagnostics(`hls virtual ${mediaId}`);

  const job = {
    mediaId,
    dir: jobDir,
    playlistPath,
    concatListPath,
    cmd: null,
    stopped: false,
    lastAccess: Date.now(),
  };

  const cmd = ffmpeg()
    .input(concatListPath)
    .inputOptions(['-f concat', '-safe 0'])
    .videoCodec('libx264')
    .audioCodec('aac')
    .format('hls')
    .outputOptions(getHlsCompatibilityOptions(segmentPattern))
    .output(playlistPath)
    .on('start', commandLine => diag.onStart(commandLine))
    .on('stderr', line => diag.onStderr(line))
    .on('error', err => {
      if (job.stopped && isIntentionalKillError(err)) return;
      diag.logErrorContext(err);
      console.error('[stream] Virtual HLS transcode error:', err.message);
      disposeHlsJob(mediaId, 'ffmpeg-error');
    })
    .on('end', () => {
      console.info(`[stream] HLS encode complete id=${mediaId}`);
      touchHlsJob(job);
      cleanupFile(concatListPath);
    });

  job.cmd = cmd;
  activeHlsJobs.set(mediaId, job);
  cmd.run();
  return job;
}

function getExistingVirtualHlsJob(mediaId) {
  return activeHlsJobs.get(mediaId) || null;
}

<<<<<<< HEAD
=======
// GET /stream/:id/hls/index.m3u8 - iOS/Safari-friendly compatibility stream for virtual videos
>>>>>>> f1de24dc6c5bfde6c56ce455907ed0a427cb69e6
router.get('/:id/hls/index.m3u8', async (req, res) => {
  if (!isVirtualMediaId(req.params.id)) {
    return res.status(400).json({ error: 'HLS compatibility is available for virtual videos only' });
  }

  const job = ensureVirtualHlsJob(req.params.id, req);
  if (!job) return res.status(404).json({ error: 'Not found' });

  touchHlsJob(job);
  const playlistReady = await waitForFile(job.playlistPath, HLS_PLAYLIST_WAIT_MS);
  if (!playlistReady) {
    return res.status(503).json({ error: 'HLS stream is starting, please retry' });
  }

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(job.playlistPath).pipe(res);
});

<<<<<<< HEAD
=======
// GET /stream/:id/hls/:segment - HLS segment files for virtual compatibility stream
>>>>>>> f1de24dc6c5bfde6c56ce455907ed0a427cb69e6
router.get('/:id/hls/:segment', async (req, res) => {
  if (!isVirtualMediaId(req.params.id)) {
    return res.status(400).json({ error: 'HLS compatibility is available for virtual videos only' });
  }

  const segmentName = String(req.params.segment || '');
  if (!/^seg-\d{6}\.ts$/.test(segmentName)) {
    return res.status(404).json({ error: 'Not found' });
  }

  const job = getExistingVirtualHlsJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });

  touchHlsJob(job);
  const segmentPath = path.join(job.dir, segmentName);
  const ready = await waitForFile(segmentPath, HLS_SEGMENT_WAIT_MS);
  if (!ready || !fs.existsSync(segmentPath)) {
    return res.status(404).json({ error: 'Segment not available yet' });
  }

  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(segmentPath).pipe(res);
});

// GET /stream/:id/transcode - browser-compatible MP4 fallback stream
router.get('/:id/transcode', (req, res) => {
  const db = getDb();
  const startSeconds = parseStartSeconds(req.query.start);
  const virtualSegments = getVirtualSegmentRows(db, req.params.id, req);
  const clientIp = getClientIp(req);
  const ua = req.headers['user-agent'] || '';
  console.info(
    `[stream] transcode request id=${req.params.id} virtual=${virtualSegments ? '1' : '0'} start=${startSeconds} range=${req.headers.range || 'none'} ip=${clientIp} ua=${ua}`
  );

  if (virtualSegments) {
    const concatListPath = createConcatListFile(virtualSegments.map(row => row.file_path));
    const sessionId = upsertSession({
      mediaId: req.params.id,
      title: path.basename(path.dirname(virtualSegments[0].file_path) || virtualSegments[0].file_name),
      type: 'transcode',
      ip: req.ip || req.socket?.remoteAddress || 'unknown',
      userAgent: req.headers['user-agent'] || '',
    });

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'Transfer-Encoding': 'chunked'
    });

    let transcodeStopped = false;
    let cleanedUp = false;
    let bytesSent = 0;
    const diag = createFfmpegDiagnostics(`virtual ${req.params.id}`);
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      cleanupFile(concatListPath);
    };

    const cmd = ffmpeg()
      .input(concatListPath)
      .inputOptions(['-f concat', '-safe 0'])
      .videoCodec('libx264')
      .audioCodec('aac')
      .format('mp4')
      .outputOptions(getCompatibilityTranscodeOptions())
      .on('start', commandLine => diag.onStart(commandLine))
      .on('stderr', line => diag.onStderr(line))
      .on('end', () => cleanup())
      .on('error', err => {
        cleanup();
        if (transcodeStopped && isIntentionalKillError(err)) return;
        diag.logErrorContext(err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Virtual transcode failed' });
        } else {
          res.end();
        }
        console.error('[stream] Virtual transcode error:', err.message);
      });

    if (startSeconds > 0) {
      cmd.seekInput(startSeconds);
    }

    const pass = new PassThrough();
    pass.on('data', chunk => {
      bytesSent += chunk.length;
      addBytes(sessionId, chunk.length);
    });

    const stopTranscode = () => {
      if (transcodeStopped) return;
      transcodeStopped = true;
      touchSession(sessionId);
      cleanup();
      try { cmd.kill('SIGKILL'); } catch { /* ignore */ }
    };

    req.on('aborted', stopTranscode);
    res.on('close', () => {
      if (!res.writableEnded) {
        stopTranscode();
      } else {
        touchSession(sessionId);
        cleanup();
      }
    });

    res.on('finish', () => {
      touchSession(sessionId);
      cleanup();
      console.info(`[stream] virtual transcode finish id=${req.params.id} bytes=${bytesSent}`);
    });

    cmd.pipe(pass, { end: true });
    pass.pipe(res, { end: true });
    return;
  }

  const row = db.prepare(
    `SELECT m.*, m.visibility AS media_visibility, sl.visibility AS source_visibility
       FROM media m
       LEFT JOIN source_locations sl ON sl.id = m.source_location_id
      WHERE m.id = ?`
  ).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!canAccessFromRow(row, req)) return res.status(404).json({ error: 'Not found' });
  if (row.type !== 'video') return res.status(400).json({ error: 'Not a video' });

  const filePath = row.file_path;
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });

  const sessionId = upsertSession({
    mediaId: row.id,
    title: row.title || path.basename(filePath),
    type: 'transcode',
    ip: req.ip || req.socket?.remoteAddress || 'unknown',
    userAgent: req.headers['user-agent'] || '',
  });

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'Transfer-Encoding': 'chunked'
  });

  let transcodeStopped = false;
  let bytesSent = 0;
  const diag = createFfmpegDiagnostics(`media ${row.id}`);

  const cmd = ffmpeg(filePath)
    .videoCodec('libx264')
    .audioCodec('aac')
    .format('mp4')
    .outputOptions(getCompatibilityTranscodeOptions())
    .on('start', commandLine => diag.onStart(commandLine))
    .on('stderr', line => diag.onStderr(line))
    .on('error', err => {
      if (transcodeStopped && isIntentionalKillError(err)) return;
      diag.logErrorContext(err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Transcode failed' });
      } else {
        res.end();
      }
      console.error('[stream] Transcode error:', err.message);
    });

  if (startSeconds > 0) {
    cmd.seekInput(startSeconds);
  }

  const pass = new PassThrough();
  pass.on('data', chunk => {
    bytesSent += chunk.length;
    addBytes(sessionId, chunk.length);
  });

  const stopTranscode = () => {
    if (transcodeStopped) return;
    transcodeStopped = true;
    touchSession(sessionId);
    try { cmd.kill('SIGKILL'); } catch { /* ignore */ }
  };

  req.on('aborted', stopTranscode);
  res.on('close', () => {
    if (!res.writableEnded) {
      stopTranscode();
    } else {
      touchSession(sessionId);
    }
  });

  res.on('finish', () => {
    touchSession(sessionId);
    console.info(`[stream] transcode finish id=${row.id} bytes=${bytesSent}`);
  });

  cmd.pipe(pass, { end: true });
  pass.pipe(res, { end: true });
});

// GET /stream/:id  - HTTP range-supporting video stream (read-only)
router.get('/:id', (req, res) => {
  const db = getDb();
  if (isVirtualMediaId(req.params.id)) {
    return res.status(400).json({ error: 'Virtual videos require compatibility streaming' });
  }

  const row = db.prepare(
    `SELECT m.*, m.visibility AS media_visibility, sl.visibility AS source_visibility
       FROM media m
       LEFT JOIN source_locations sl ON sl.id = m.source_location_id
      WHERE m.id = ?`
  ).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!canAccessFromRow(row, req)) return res.status(404).json({ error: 'Not found' });
  if (row.type !== 'video') return res.status(400).json({ error: 'Not a video' });

  const filePath = row.file_path;
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const mimeType = getStreamMimeType(row, filePath);
  const range = req.headers.range;

  const sessionId = upsertSession({
    mediaId: row.id,
    title: row.title || path.basename(filePath),
    type: 'direct',
    ip: req.ip || req.socket?.remoteAddress || 'unknown',
    userAgent: req.headers['user-agent'] || '',
  });

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': mimeType
    });

    const fileStream = fs.createReadStream(filePath, { start, end });
    fileStream.on('data', chunk => addBytes(sessionId, chunk.length));
    fileStream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes'
    });
    const fileStream = fs.createReadStream(filePath);
    fileStream.on('data', chunk => addBytes(sessionId, chunk.length));
    fileStream.pipe(res);
  }

  req.on('close', () => touchSession(sessionId));
  res.on('finish', () => touchSession(sessionId));
});

module.exports = router;
