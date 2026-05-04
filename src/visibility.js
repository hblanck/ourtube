'use strict';

const { isAdminAuthenticated } = require('./admin-auth');

const VISIBILITY_ALL = 'all';
const VISIBILITY_ADMIN_ONLY = 'admin';
const VISIBILITY_NONE = 'none';

function normalizeVisibility(value, fallback = VISIBILITY_ALL) {
  const v = String(value || '').trim().toLowerCase();
  if (v === VISIBILITY_ALL || v === VISIBILITY_ADMIN_ONLY || v === VISIBILITY_NONE) return v;
  return fallback;
}

function getRequestVisibilityMode(req) {
  return isAdminAuthenticated(req) ? VISIBILITY_ADMIN_ONLY : VISIBILITY_ALL;
}

function mediaVisibilityCondition(mediaAlias = 'm', sourceAlias = 'sl', req) {
  const mode = getRequestVisibilityMode(req);
  if (mode === VISIBILITY_ADMIN_ONLY) {
    return `COALESCE(${mediaAlias}.visibility, '${VISIBILITY_ALL}') != '${VISIBILITY_NONE}'
      AND COALESCE(${sourceAlias}.visibility, '${VISIBILITY_ALL}') != '${VISIBILITY_NONE}'`;
  }

  return `COALESCE(${mediaAlias}.visibility, '${VISIBILITY_ALL}') = '${VISIBILITY_ALL}'
    AND COALESCE(${sourceAlias}.visibility, '${VISIBILITY_ALL}') = '${VISIBILITY_ALL}'`;
}

function sourceVisibilityCondition(sourceAlias = 'sl', req) {
  const mode = getRequestVisibilityMode(req);
  if (mode === VISIBILITY_ADMIN_ONLY) {
    return `COALESCE(${sourceAlias}.visibility, '${VISIBILITY_ALL}') != '${VISIBILITY_NONE}'`;
  }
  return `COALESCE(${sourceAlias}.visibility, '${VISIBILITY_ALL}') = '${VISIBILITY_ALL}'`;
}

function canAccessFromRow(row, req) {
  const mediaVisibility = normalizeVisibility(row.media_visibility ?? row.visibility, VISIBILITY_ALL);
  const sourceVisibility = normalizeVisibility(
    row.source_visibility ?? row.source_location_visibility,
    VISIBILITY_ALL
  );
  const admin = isAdminAuthenticated(req);

  if (mediaVisibility === VISIBILITY_NONE || sourceVisibility === VISIBILITY_NONE) return false;
  if (!admin && (mediaVisibility === VISIBILITY_ADMIN_ONLY || sourceVisibility === VISIBILITY_ADMIN_ONLY)) return false;
  return true;
}

module.exports = {
  VISIBILITY_ALL,
  VISIBILITY_ADMIN_ONLY,
  VISIBILITY_NONE,
  normalizeVisibility,
  mediaVisibilityCondition,
  sourceVisibilityCondition,
  canAccessFromRow,
};
