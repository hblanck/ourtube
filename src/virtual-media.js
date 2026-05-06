'use strict';

const path = require('path');

function buildVirtualMediaId(sourceLocationId, groupPath) {
  return `virtual_${sourceLocationId}_${Buffer.from(groupPath).toString('base64url')}`;
}

function parseVirtualMediaId(mediaId) {
  const match = /^virtual_(\d+)_(.+)$/.exec(String(mediaId || ''));
  if (!match) return null;

  try {
    return {
      sourceLocationId: parseInt(match[1], 10),
      groupPath: Buffer.from(match[2], 'base64url').toString('utf8')
    };
  } catch {
    return null;
  }
}

function isVirtualMediaId(mediaId) {
  return Boolean(parseVirtualMediaId(mediaId));
}

function parseTags(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function getUnifiedTextValue(rows, fieldName) {
  const values = new Set();
  for (const row of rows) {
    const raw = String(row?.[fieldName] || '').trim();
    if (!raw) continue;
    values.add(raw);
    if (values.size > 1) return '';
  }
  return values.size === 1 ? [...values][0] : '';
}

function getTimestamp(value, fallback) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

function getComparableValue(item, sort) {
  if (sort === 'friendly_name' || sort === 'location') {
    return String(item[sort] || '').toLowerCase();
  }

  if (sort === 'indexed_at' || sort === 'created_at' || sort === 'modified_at') {
    return getTimestamp(item[sort], 0);
  }

  return item[sort] ?? 0;
}

function sortMediaItems(items, sort, order) {
  const direction = order === 'ASC' ? 1 : -1;

  return [...items].sort((left, right) => {
    const leftValue = getComparableValue(left, sort);
    const rightValue = getComparableValue(right, sort);

    if (leftValue < rightValue) return -1 * direction;
    if (leftValue > rightValue) return 1 * direction;

    const leftName = String(left.friendly_name || left.file_name || left.id || '').toLowerCase();
    const rightName = String(right.friendly_name || right.file_name || right.id || '').toLowerCase();
    return leftName.localeCompare(rightName);
  });
}

function sortSegmentRows(rows) {
  return [...rows].sort((left, right) => {
    const leftCreated = getTimestamp(left.created_at, Number.MAX_SAFE_INTEGER);
    const rightCreated = getTimestamp(right.created_at, Number.MAX_SAFE_INTEGER);
    if (leftCreated !== rightCreated) return leftCreated - rightCreated;

    const leftModified = getTimestamp(left.modified_at, Number.MAX_SAFE_INTEGER);
    const rightModified = getTimestamp(right.modified_at, Number.MAX_SAFE_INTEGER);
    if (leftModified !== rightModified) return leftModified - rightModified;

    return String(left.file_path || left.file_name || '').localeCompare(String(right.file_path || right.file_name || ''));
  });
}

function getStitchGroupPath(row) {
  if (!row || !row.stitch_directories || row.type !== 'video') return null;
  if (row.source_entry_type !== 'directory' || !row.source_entry_path || !row.file_path) return null;

  const relativePath = path.relative(row.source_entry_path, row.file_path);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return row.source_entry_path;
  }

  const segments = relativePath.split(path.sep).filter(Boolean);
  if (segments.length <= 1) return row.source_entry_path;

  return path.join(row.source_entry_path, segments[0]);
}

function buildStandaloneItem(row) {
  return {
    ...row,
    is_virtual: 0,
    thumbnail_media_id: row.id,
    segment_count: 1,
    tags: parseTags(row.tags)
  };
}

function buildVirtualMediaItem(rows, options = {}) {
  const orderedRows = sortSegmentRows(rows);
  const firstRow = orderedRows[0];
  const groupPath = getStitchGroupPath(firstRow);
  const tagSet = new Set();

  for (const row of orderedRows) {
    for (const tag of parseTags(row.tags)) tagSet.add(tag);
  }

  const nameBase = path.basename(groupPath || firstRow.source_entry_path || firstRow.file_name || 'stitched-video');
  const firstCreatedAt = orderedRows.find(row => row.created_at)?.created_at || null;
  const latestIndexedAt = orderedRows.reduce((latest, row) => {
    if (!latest) return row.indexed_at || null;
    return getTimestamp(row.indexed_at, 0) > getTimestamp(latest, 0) ? row.indexed_at : latest;
  }, null);
  const unifiedFriendlyName = getUnifiedTextValue(orderedRows, 'friendly_name');
  const unifiedDescription = getUnifiedTextValue(orderedRows, 'description');
  const mergedLocation = orderedRows.find(row => row.location)?.location || null;
  const mergedYear = orderedRows.find(row => row.year)?.year || null;

  // Visibility: use the most restrictive visibility across all segments
  // none > admin > all
  const VISIBILITY_RANK = { none: 2, admin: 1, all: 0 };
  const mergedVisibility = orderedRows.reduce((worst, row) => {
    const v = String(row.visibility || row.media_visibility || 'all').toLowerCase();
    return (VISIBILITY_RANK[v] ?? 0) > (VISIBILITY_RANK[worst] ?? 0) ? v : worst;
  }, 'all');
  // Source visibility is shared across all segments (same source location)
  const mergedSourceVisibility = String(
    firstRow.source_visibility || firstRow.source_location_visibility || 'all'
  ).toLowerCase();

  const item = {
    id: buildVirtualMediaId(firstRow.source_location_id, groupPath),
    type: 'video',
    file_name: `${nameBase}.mp4`,
    friendly_name: unifiedFriendlyName || nameBase.replace(/[_.-]/g, ' '),
    description: unifiedDescription || `${orderedRows.length} stitched clip${orderedRows.length === 1 ? '' : 's'}`,
    duration: orderedRows.reduce((total, row) => total + (Number(row.duration) || 0), 0),
    width: firstRow.width || null,
    height: firstRow.height || null,
    size: orderedRows.reduce((total, row) => total + (Number(row.size) || 0), 0),
    codec: 'virtual',
    format: 'virtual',
    thumbnail_path: firstRow.thumbnail_path || null,
    thumbnail_media_id: firstRow.id,
    year: mergedYear,
    location: mergedLocation,
    tags: [...tagSet],
    faces_detected: orderedRows.reduce((total, row) => total + (Number(row.faces_detected) || 0), 0),
    view_count: orderedRows.reduce((total, row) => total + (Number(row.view_count) || 0), 0),
    source_location_id: firstRow.source_location_id,
    source_location_name: firstRow.source_location_name,
    source_location_path: firstRow.source_location_path,
    source_entry_path: firstRow.source_entry_path,
    source_entry_type: 'directory',
    stitch_directories: 1,
    created_at: firstCreatedAt,
    modified_at: orderedRows[orderedRows.length - 1]?.modified_at || null,
    indexed_at: latestIndexedAt,
    is_virtual: 1,
    segment_count: orderedRows.length,
    faces: [],
    visibility: mergedVisibility,
    source_visibility: mergedSourceVisibility
  };

  if (options.includeSegments) {
    item.segments = orderedRows.map(row => ({
      id: row.id,
      file_path: row.file_path,
      file_name: row.file_name,
      friendly_name: row.friendly_name,
      duration: row.duration,
      created_at: row.created_at,
      modified_at: row.modified_at,
      thumbnail_path: row.thumbnail_path
    }));
    item.raw_metadata = {
      stitched: true,
      segment_count: orderedRows.length,
      segments: item.segments
    };
  }

  return item;
}

function aggregateMediaRows(rows) {
  const items = [];
  const groupedRows = new Map();

  for (const row of rows) {
    const groupPath = getStitchGroupPath(row);
    if (!groupPath) {
      items.push(buildStandaloneItem(row));
      continue;
    }

    const groupId = `${row.source_location_id}:${groupPath}`;
    const list = groupedRows.get(groupId) || [];
    list.push(row);
    groupedRows.set(groupId, list);
  }

  for (const rowsInGroup of groupedRows.values()) {
    items.push(buildVirtualMediaItem(rowsInGroup));
  }

  return items;
}

// ── User-defined stitched video IDs ───────────────────────────────────────────
// Format: "stitch_<integer>"

function buildUserStitchedVideoId(id) {
  return `stitch_${id}`;
}

function parseUserStitchedVideoId(mediaId) {
  const match = /^stitch_(\d+)$/.exec(String(mediaId || ''));
  if (!match) return null;
  return parseInt(match[1], 10);
}

function isUserStitchedVideoId(mediaId) {
  return parseUserStitchedVideoId(mediaId) !== null;
}

function buildUserStitchedVideoItem(video, clips, options = {}) {
  const enabledClips = clips.filter(c => c.enabled !== 0);
  const totalDuration = enabledClips.reduce((sum, c) => sum + (Number(c.media_duration) || 0), 0);
  const totalSize = enabledClips.reduce((sum, c) => sum + (Number(c.media_size) || 0), 0);
  const firstClip = enabledClips[0] || clips[0];

  const item = {
    id: buildUserStitchedVideoId(video.id),
    type: 'video',
    file_name: `${String(video.name || 'stitched').replace(/[^a-zA-Z0-9_.-]/g, '_')}.mp4`,
    friendly_name: video.name,
    description: video.description || `${enabledClips.length} clip${enabledClips.length === 1 ? '' : 's'} stitched`,
    duration: totalDuration,
    size: totalSize,
    width: firstClip?.media_width || null,
    height: firstClip?.media_height || null,
    codec: 'virtual',
    format: 'virtual',
    thumbnail_path: firstClip?.media_thumbnail_path || null,
    thumbnail_media_id: firstClip?.media_id || null,
    year: null,
    location: null,
    tags: [],
    faces_detected: 0,
    view_count: 0,
    is_virtual: 1,
    is_user_stitched: 1,
    segment_count: enabledClips.length,
    visibility: video.visibility || 'all',
    created_at: video.created_at,
    modified_at: video.updated_at,
    indexed_at: video.updated_at,
    faces: [],
  };

  if (options.includeSegments) {
    // For admin mode, include all clips (enabled and disabled).
    // For public view, include only enabled clips for playback.
    const segmentsToInclude = options.adminMode ? clips : enabledClips;
    item.segments = segmentsToInclude.map(c => ({
      id: c.media_id,
      clip_id: c.id,
      file_path: c.media_file_path,
      file_name: c.media_file_name,
      friendly_name: c.media_friendly_name,
      duration: c.media_duration,
      thumbnail_path: c.media_thumbnail_path,
      position: c.position,
      enabled: c.enabled !== 0,
    }));
  }

  return item;
}

module.exports = {
  aggregateMediaRows,
  buildUserStitchedVideoId,
  buildUserStitchedVideoItem,
  buildVirtualMediaId,
  buildVirtualMediaItem,
  getStitchGroupPath,
  isUserStitchedVideoId,
  isVirtualMediaId,
  parseUserStitchedVideoId,
  parseVirtualMediaId,
  parseTags,
  sortMediaItems,
  sortSegmentRows
};