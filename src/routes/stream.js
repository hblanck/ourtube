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

const DATA_DIR = process.env.DATA_DIR || '/data';
const router = express.Router();

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

// GET /stream/:id/transcode - browser-compatible MP4 fallback stream
router.get('/:id/transcode', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
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
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
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
