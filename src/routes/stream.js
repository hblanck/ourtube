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

// GET /stream/:id/transcode - browser-compatible MP4 fallback stream
router.get('/:id/transcode', (req, res) => {
  const db = getDb();
  const startSeconds = parseStartSeconds(req.query.start);
  const virtualSegments = getVirtualSegmentRows(db, req.params.id, req);

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

    const cmd = ffmpeg()
      .input(concatListPath)
      .inputOptions(['-f concat', '-safe 0'])
      .videoCodec('libx264')
      .audioCodec('aac')
      .format('mp4')
      .outputOptions([
        '-movflags frag_keyframe+empty_moov+faststart',
        '-preset veryfast',
        '-crf 23',
        '-max_muxing_queue_size 1024'
      ])
      .on('end', () => cleanupFile(concatListPath))
      .on('error', err => {
        cleanupFile(concatListPath);
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
    pass.on('data', chunk => addBytes(sessionId, chunk.length));

    req.on('close', () => {
      touchSession(sessionId);
      cleanupFile(concatListPath);
      try { cmd.kill('SIGKILL'); } catch { /* ignore */ }
    });

    res.on('finish', () => {
      touchSession(sessionId);
      cleanupFile(concatListPath);
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

  const cmd = ffmpeg(filePath)
    .videoCodec('libx264')
    .audioCodec('aac')
    .format('mp4')
    .outputOptions([
      '-movflags frag_keyframe+empty_moov+faststart',
      '-preset veryfast',
      '-crf 23',
      '-max_muxing_queue_size 1024'
    ])
    .on('error', err => {
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
  pass.on('data', chunk => addBytes(sessionId, chunk.length));

  req.on('close', () => {
    touchSession(sessionId);
    try { cmd.kill('SIGKILL'); } catch { /* ignore */ }
  });

  res.on('finish', () => touchSession(sessionId));

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
