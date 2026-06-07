'use strict';

const fs = require('fs');
const path = require('path');

const IMAGE_CREATED_AT_PATHS = [
  String(process.env.OURTUBE_IMAGE_CREATED_AT_FILE || '').trim(),
  path.resolve(__dirname, '..', '.image-created-at'),
  '/app/.image-created-at',
].filter(Boolean);

let cachedDockerImageCreatedAt;

function parseIsoTimestamp(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return null;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function getDockerImageCreatedAt() {
  if (cachedDockerImageCreatedAt !== undefined) return cachedDockerImageCreatedAt;

  for (const candidatePath of IMAGE_CREATED_AT_PATHS) {
    try {
      if (!fs.existsSync(candidatePath)) continue;
      const rawValue = fs.readFileSync(candidatePath, 'utf8');
      const normalized = parseIsoTimestamp(rawValue);
      if (normalized) {
        cachedDockerImageCreatedAt = normalized;
        return cachedDockerImageCreatedAt;
      }
    } catch {
      // Try next candidate.
    }
  }

  cachedDockerImageCreatedAt = null;
  return cachedDockerImageCreatedAt;
}

module.exports = {
  getDockerImageCreatedAt,
};
