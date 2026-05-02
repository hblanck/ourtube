'use strict';

const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || '/data';
const THUMB_DIR = path.join(DATA_DIR, 'thumbnails');

function ensureThumbDir() {
  fs.mkdirSync(THUMB_DIR, { recursive: true });
}

function getThumbnailPath(mediaId) {
  return path.join(THUMB_DIR, `${mediaId}.jpg`);
}

function generateVideoThumbnail(videoPath, outputPath, timemark = '10%') {
  return new Promise((resolve, reject) => {
    ensureThumbDir();
    const dir = path.dirname(outputPath);
    const filename = path.basename(outputPath);

    ffmpeg(videoPath)
      .on('end', () => resolve(outputPath))
      .on('error', reject)
      .screenshots({
        timestamps: [timemark],
        filename,
        folder: dir,
        size: '400x300'
      });
  });
}

async function generatePhotoThumbnail(photoPath, outputPath) {
  ensureThumbDir();
  await sharp(photoPath)
    .rotate()
    .resize(400, 300, { fit: 'cover', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toFile(outputPath);
  return outputPath;
}

module.exports = { getThumbnailPath, generateVideoThumbnail, generatePhotoThumbnail };
