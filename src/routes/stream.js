'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const sharp = require('sharp');
const { getDb } = require('../db');

const DATA_DIR = process.env.DATA_DIR || '/data';
const router = express.Router();

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
  const mimeType = mime.lookup(filePath) || 'video/mp4';
  const range = req.headers.range;

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

    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

module.exports = router;
