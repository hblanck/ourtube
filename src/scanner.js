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
  filesSkipped: 0,
  errors: 0,
  currentFile: null,
  recentOutput: []
};

function getScanStatus() {
  return { ...scanStatus, recentOutput: [...scanStatus.recentOutput] };
}

function appendScanOutput(line) {
  const timestamp = new Date().toISOString();
  scanStatus.recentOutput.push(`[${timestamp}] ${line}`);
  if (scanStatus.recentOutput.length > 300) {
    scanStatus.recentOutput = scanStatus.recentOutput.slice(-300);
  }
}

function scanInfo(message) {
  console.log(message);
  appendScanOutput(message);
}

function scanWarn(message) {
  console.warn(message);
  appendScanOutput(message);
}

function scanError(message) {
  console.error(message);
  appendScanOutput(message);
}

function getSkipReason(entryName, isDirectory) {
  if (!entryName) return 'invalid directory entry';

  // macOS sidecar/resource files and common desktop metadata files
  if (entryName.startsWith('._')) return 'macOS AppleDouble sidecar file';
  if (entryName === '.DS_Store') return 'macOS Finder metadata file';
  if (entryName === 'Thumbs.db') return 'Windows thumbnail cache file';
  if (entryName === 'desktop.ini') return 'Windows desktop metadata file';

  // Skip hidden/system folders that should not be scanned as media roots
  if (isDirectory) {
    if (entryName.startsWith('.')) return 'hidden system directory';
    if (entryName === '$RECYCLE.BIN') return 'Windows recycle bin directory';
    if (entryName === '__MACOSX') return 'macOS archive metadata directory';
  }

  return null;
}

function recordSkippedFile(filePath, reason, locationId) {
  const db = getDb();
  db.prepare(
    `INSERT INTO skipped_files (file_path, source_location_id, reason, first_seen_at, last_seen_at, skip_count)
     VALUES (?, ?, ?, datetime('now'), datetime('now'), 1)
     ON CONFLICT(file_path) DO UPDATE SET
       source_location_id = excluded.source_location_id,
       reason = excluded.reason,
       last_seen_at = datetime('now'),
       skip_count = skipped_files.skip_count + 1`
  ).run(filePath, locationId ?? null, reason);
}

function isMediaFile(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  return VIDEO_EXTENSIONS.has(ext) || PHOTO_EXTENSIONS.has(ext);
}

function getLocationEntries(location) {
  const db = getDb();
  const entries = db.prepare(
    `SELECT entry_path, entry_type
     FROM source_location_entries
     WHERE source_location_id = ?
     ORDER BY id ASC`
  ).all(location.id);

  if (entries.length) {
    return entries.map(entry => ({ path: entry.entry_path, type: entry.entry_type }));
  }

  // Backward compatibility for locations created before multi-entry support.
  if (location.path) {
    return [{ path: location.path, type: 'directory' }];
  }

  return [];
}

function walkDir(dirPath, locationId) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    scanWarn(`[scanner] Cannot read dir ${dirPath}: ${err.message}`);
    return results;
  }

  for (const entry of entries) {
    const skipReason = getSkipReason(entry.name, entry.isDirectory());
    if (skipReason) {
      if (entry.isFile()) {
        const skippedPath = path.join(dirPath, entry.name);
        scanStatus.filesSkipped++;
        recordSkippedFile(skippedPath, skipReason, locationId);
      }
      continue;
    }

    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath, locationId));
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
  } catch (err) {
    scanWarn(`[scanner] Cannot stat file ${filePath}: ${err.message}`);
    recordSkippedFile(filePath, `inaccessible file: ${err.message}`, locationId);
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
      scanWarn(`[scanner] Metadata error for ${filePath}: ${err.message}`);
  }

  try {
    if (type === 'video') {
      await generateVideoThumbnail(filePath, thumbPath);
    } else {
      await generatePhotoThumbnail(filePath, thumbPath);
    }
    thumbnailGenerated = true;
  } catch (err) {
      scanWarn(`[scanner] Thumbnail error for ${filePath}: ${err.message}`);
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
  const entries = getLocationEntries(location);
  scanInfo(`[scanner] Scanning location: ${location.name} (${entries.length} path entries)`);

  const fileSet = new Set();
  for (const entry of entries) {
    if (!entry.path) continue;

    if (!fs.existsSync(entry.path)) {
      scanWarn(`[scanner] Path does not exist: ${entry.path}`);
      continue;
    }

    let stat;
    try {
      stat = fs.statSync(entry.path);
    } catch (err) {
      scanWarn(`[scanner] Cannot stat path ${entry.path}: ${err.message}`);
      scanStatus.filesSkipped++;
      recordSkippedFile(entry.path, `cannot stat path: ${err.message}`, location.id);
      continue;
    }

    const entryType = entry.type || (stat.isFile() ? 'file' : 'directory');
    if (entryType === 'file' || stat.isFile()) {
      const skipReason = getSkipReason(path.basename(entry.path), false);
      if (skipReason) {
        scanStatus.filesSkipped++;
        recordSkippedFile(entry.path, skipReason, location.id);
        continue;
      }
      if (isMediaFile(entry.path)) {
        fileSet.add(entry.path);
      } else {
        scanStatus.filesSkipped++;
        recordSkippedFile(entry.path, 'unsupported media file extension', location.id);
      }
      continue;
    }

    const foundFiles = walkDir(entry.path, location.id);
    for (const filePath of foundFiles) fileSet.add(filePath);
  }

  const files = Array.from(fileSet);
  scanInfo(`[scanner] Found ${files.length} media files in ${location.name}`);

  let indexed = 0;
  let errors = 0;

  for (const filePath of files) {
    scanStatus.filesFound++;
    try {
      const mediaId = await indexFile(filePath, location.id);
      if (mediaId) {
        indexed++;
        scanStatus.filesIndexed++;
      } else {
        scanStatus.filesSkipped++;
      }
    } catch (err) {
      errors++;
      scanStatus.errors++;
      scanError(`[scanner] Error indexing ${filePath}: ${err.message}`);
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
    scanInfo('[scanner] Scan already in progress, skipping.');
    return;
  }

  scanStatus = {
    inProgress: true,
    lastRun: new Date().toISOString(),
    filesFound: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    errors: 0,
    currentFile: null,
    recentOutput: []
  };

  const db = getDb();
  const locations = db.prepare('SELECT * FROM source_locations WHERE enabled = 1').all();

  scanInfo(`[scanner] Starting scan of ${locations.length} location(s)`);

  for (const loc of locations) {
    await scanLocation(loc);
  }

  scanStatus.inProgress = false;
  scanStatus.currentFile = null;
  scanInfo(
    `[scanner] Scan complete. Found: ${scanStatus.filesFound}, Indexed: ${scanStatus.filesIndexed}, Skipped: ${scanStatus.filesSkipped}, Errors: ${scanStatus.errors}`
  );
}

module.exports = { scanAllLocations, scanLocation, indexFile, getScanStatus };
