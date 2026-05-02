'use strict';

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('./db');
const { getMediaType, extractVideoMetadata, extractPhotoMetadata } = require('./metadata');
const { getThumbnailPath, generateVideoThumbnail, generatePhotoThumbnail } = require('./thumbnails');

const VIDEO_EXTENSIONS = new Set([
  'mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm',
  'm4v', 'mpg', 'mpeg', '3gp'
]);

const PHOTO_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'tif',
  'heic', 'webp', 'raw', 'arw', 'cr2', 'nef'
]);

let scanStatus = {
  inProgress: false,
  lastRun: null,
  filesFound: 0,
  filesIndexed: 0,
  errors: 0,
  currentFile: null
};

function getScanStatus() {
  return { ...scanStatus };
}

function isMediaFile(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  return VIDEO_EXTENSIONS.has(ext) || PHOTO_EXTENSIONS.has(ext);
}

function walkDir(dirPath) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    console.warn(`[scanner] Cannot read dir ${dirPath}: ${err.message}`);
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath));
    } else if (entry.isFile() && isMediaFile(fullPath)) {
      results.push(fullPath);
    }
  }
  return results;
}

async function indexFile(filePath, locationId) {
  const db = getDb();
  const type = getMediaType(filePath);
  if (!type) return null;

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }

  // Check if already indexed and unchanged
  const existing = db.prepare('SELECT id, modified_at FROM media WHERE file_path = ?').get(filePath);
  if (existing && existing.modified_at === stat.mtime.toISOString()) {
    return existing.id;
  }

  const mediaId = existing ? existing.id : uuidv4();
  const thumbPath = getThumbnailPath(mediaId);
  scanStatus.currentFile = filePath;

  let meta = {};
  let thumbnailGenerated = false;

  try {
    if (type === 'video') {
      meta = await extractVideoMetadata(filePath);
    } else {
      meta = await extractPhotoMetadata(filePath);
    }
  } catch (err) {
    console.warn(`[scanner] Metadata error for ${filePath}: ${err.message}`);
  }

  try {
    if (type === 'video') {
      await generateVideoThumbnail(filePath, thumbPath);
    } else {
      await generatePhotoThumbnail(filePath, thumbPath);
    }
    thumbnailGenerated = true;
  } catch (err) {
    console.warn(`[scanner] Thumbnail error for ${filePath}: ${err.message}`);
  }

  const year = meta.created_at
    ? new Date(meta.created_at).getFullYear() || null
    : null;

  const record = {
    id: mediaId,
    source_location_id: locationId,
    type,
    file_path: filePath,
    file_name: path.basename(filePath),
    friendly_name: path.basename(filePath, path.extname(filePath)).replace(/[_.-]/g, ' '),
    duration: meta.duration || null,
    width: meta.width || null,
    height: meta.height || null,
    size: meta.size || stat.size,
    codec: meta.codec || null,
    format: meta.format || null,
    created_at: meta.created_at || null,
    modified_at: stat.mtime.toISOString(),
    thumbnail_path: thumbnailGenerated ? thumbPath : null,
    year: year && year > 1900 && year <= new Date().getFullYear() + 1 ? year : null,
    location: meta.location || null,
    latitude: meta.latitude || null,
    longitude: meta.longitude || null,
    raw_metadata: JSON.stringify(meta.raw || {})
  };

  if (existing) {
    db.prepare(`
      UPDATE media SET
        source_location_id = @source_location_id,
        type = @type,
        file_name = @file_name,
        duration = @duration,
        width = @width,
        height = @height,
        size = @size,
        codec = @codec,
        format = @format,
        created_at = @created_at,
        modified_at = @modified_at,
        indexed_at = datetime('now'),
        thumbnail_path = @thumbnail_path,
        year = @year,
        location = @location,
        latitude = @latitude,
        longitude = @longitude,
        raw_metadata = @raw_metadata
      WHERE id = @id
    `).run(record);
  } else {
    db.prepare(`
      INSERT INTO media (
        id, source_location_id, type, file_path, file_name, friendly_name,
        duration, width, height, size, codec, format,
        created_at, modified_at, indexed_at, thumbnail_path,
        year, location, latitude, longitude, raw_metadata
      ) VALUES (
        @id, @source_location_id, @type, @file_path, @file_name, @friendly_name,
        @duration, @width, @height, @size, @codec, @format,
        @created_at, @modified_at, datetime('now'), @thumbnail_path,
        @year, @location, @latitude, @longitude, @raw_metadata
      )
    `).run(record);
  }

  return mediaId;
}

async function scanLocation(location) {
  console.log(`[scanner] Scanning location: ${location.name} (${location.path})`);

  if (!fs.existsSync(location.path)) {
    console.warn(`[scanner] Path does not exist: ${location.path}`);
    return { found: 0, indexed: 0, errors: 0 };
  }

  const files = walkDir(location.path);
  console.log(`[scanner] Found ${files.length} media files in ${location.path}`);

  let indexed = 0;
  let errors = 0;

  for (const filePath of files) {
    scanStatus.filesFound++;
    try {
      await indexFile(filePath, location.id);
      indexed++;
      scanStatus.filesIndexed++;
    } catch (err) {
      errors++;
      scanStatus.errors++;
      console.error(`[scanner] Error indexing ${filePath}: ${err.message}`);
    }
  }

  // Update last_scanned
  getDb()
    .prepare('UPDATE source_locations SET last_scanned = datetime(\'now\') WHERE id = ?')
    .run(location.id);

  return { found: files.length, indexed, errors };
}

async function scanAllLocations() {
  if (scanStatus.inProgress) {
    console.log('[scanner] Scan already in progress, skipping.');
    return;
  }

  scanStatus = {
    inProgress: true,
    lastRun: new Date().toISOString(),
    filesFound: 0,
    filesIndexed: 0,
    errors: 0,
    currentFile: null
  };

  const db = getDb();
  const locations = db.prepare('SELECT * FROM source_locations WHERE enabled = 1').all();

  console.log(`[scanner] Starting scan of ${locations.length} location(s)`);

  for (const loc of locations) {
    await scanLocation(loc);
  }

  scanStatus.inProgress = false;
  scanStatus.currentFile = null;
  console.log(`[scanner] Scan complete. Found: ${scanStatus.filesFound}, Indexed: ${scanStatus.filesIndexed}, Errors: ${scanStatus.errors}`);
}

module.exports = { scanAllLocations, scanLocation, indexFile, getScanStatus };
