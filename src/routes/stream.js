'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const { PassThrough } = require('stream');
const { getDb } = require('../db');
const { upsertSession, touchSession, addBytes, isClientBlocked } = require('../sessions');
const { getStitchGroupPath, isVirtualMediaId, parseVirtualMediaId, sortSegmentRows } = require('../virtual-media');
const { canAccessFromRow } = require('../visibility');
const telemetry = require('../telemetry');

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

function getDirectVideoRow(db, mediaId, req) {
  if (isVirtualMediaId(mediaId)) return null;
  const row = db.prepare(
    `SELECT m.*, m.visibility AS media_visibility, sl.visibility AS source_visibility
       FROM media m
       LEFT JOIN source_locations sl ON sl.id = m.source_location_id
      WHERE m.id = ?`
  ).get(mediaId);
  if (!row) return null;
  if (!canAccessFromRow(row, req)) return null;
  if (row.type !== 'video') return null;
  if (!row.file_path || !fs.existsSync(row.file_path)) return null;
  return row;
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
    return 'video/quicktime';
  }

  return mime.lookup(filePath) || 'video/mp4';
}

function parseStartSeconds(value) {
  const seconds = Number.parseFloat(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return seconds;
}

function parseSafariProbeRange(rangeHeader) {
  if (!rangeHeader) return null;
  const rangeMatch = String(rangeHeader).trim().match(/^bytes=(\d+)-(\d*)$/i);
  if (!rangeMatch) return null;
  const start = parseInt(rangeMatch[1], 10);
  const requestedEndRaw = rangeMatch[2];
  // Open-ended ranges such as "bytes=0-" are normal playback requests in
  // Chromium browsers and must not be treated as tiny Safari probes.
  if (requestedEndRaw === '') return null;
  const end = requestedEndRaw === '' ? 1 : parseInt(requestedEndRaw, 10);
  const length = end - start + 1;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start !== 0 || end < start || length <= 0) return null;
  // Only treat tiny initial byte ranges as compatibility probes.
  if (length > 2) return null;
  return { start, end, length };
}

function parseSingleByteRange(rangeHeader, fileSize) {
  const rangeMatch = String(rangeHeader || '').trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!rangeMatch) return { invalid: true };

  const startRaw = rangeMatch[1];
  const endRaw = rangeMatch[2];

  if (startRaw === '' && endRaw === '') return { invalid: true };

  // Suffix range request, e.g. "bytes=-500".
  if (startRaw === '') {
    const suffixLength = parseInt(endRaw, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { invalid: true };
    if (fileSize <= 0) return { unsatisfiable: true };

    const start = Math.max(0, fileSize - suffixLength);
    const end = fileSize - 1;
    return { start, end, length: end - start + 1 };
  }

  const start = parseInt(startRaw, 10);
  if (!Number.isFinite(start) || start < 0) return { invalid: true };
  if (start >= fileSize) return { unsatisfiable: true };

  let end;
  if (endRaw === '') {
    end = fileSize - 1;
  } else {
    end = parseInt(endRaw, 10);
    if (!Number.isFinite(end) || end < 0) return { invalid: true };
    end = Math.min(end, fileSize - 1);
  }

  if (end < start) return { unsatisfiable: true };
  return { start, end, length: end - start + 1 };
}

function estimateVirtualTranscodeSizeBytes(segmentRows) {
  const totalDurationSeconds = (segmentRows || []).reduce((sum, row) => {
    const duration = Number.parseFloat(row?.duration);
    return Number.isFinite(duration) && duration > 0 ? sum + duration : sum;
  }, 0);

  // Approximate target bitrate for Safari probe headers only.
  // This does not need to be exact, but Safari expects a concrete total in 206 Content-Range.
  const estimatedBytesPerSecond = 320_000; // ~2.56 Mbps
  const estimated = Math.round(totalDurationSeconds * estimatedBytesPerSecond);
  return Math.max(estimated, 1_048_576);
}

function estimateTranscodeSizeBytesFromDuration(durationSeconds) {
  const duration = Number.parseFloat(durationSeconds);
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  // Approximate target bitrate for Safari probe headers only.
  const estimatedBytesPerSecond = 320_000; // ~2.56 Mbps
  const estimated = Math.round(safeDuration * estimatedBytesPerSecond);
  return Math.max(estimated, 1_048_576);
}

function getCompatibilityTranscodeOptions() {
  return [
    // Ensure broad browser/iOS support and prevent x264 failures on odd dimensions.
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

function checkClientBlocked(req, res) {
  const ip = getClientIp(req);
  const block = isClientBlocked(ip);
  if (!block.blocked) return false;
  const retryAfter = block.unblock_at ? Math.max(0, Math.ceil((new Date(block.unblock_at).getTime() - Date.now()) / 1000)) : null;
  res.setHeader('X-Block-Reason', String(block.reason || 'Blocked by admin'));
  if (retryAfter !== null) res.setHeader('Retry-After', String(retryAfter));
  res.redirect(302, `/blocked.html?reason=${encodeURIComponent(block.reason || '')}&until=${encodeURIComponent(block.unblock_at || '')}`);
  return true;
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

function extractFirstHlsSegmentName(playlistText) {
  const lines = String(playlistText || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^seg-\d{6}\.ts$/.test(line)) return line;
  }
  return '';
}

function waitForHlsPlaylistReady(job, timeoutMs) {
  const startedAt = Date.now();
  return new Promise(resolve => {
    const timer = setInterval(() => {
      if (job.stopped) {
        clearInterval(timer);
        resolve(false);
        return;
      }

      if (fs.existsSync(job.playlistPath)) {
        try {
          const text = fs.readFileSync(job.playlistPath, 'utf8');
          const firstSegment = extractFirstHlsSegmentName(text);
          if (firstSegment) {
            const segmentPath = path.join(job.dir, firstSegment);
            if (fs.existsSync(segmentPath)) {
              clearInterval(timer);
              resolve(true);
              return;
            }
          }
        } catch {
          // Keep polling until timeout.
        }
      }

      if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 120);
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

  telemetry.finishTranscodeJob(job.telemetryStartedAt, {
    kind: 'hls',
    mode: 'virtual_hls',
    status: reason === 'ffmpeg-error' ? 'error' : 'ok',
  });

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
    telemetryStartedAt: telemetry.startTranscodeJob('hls'),
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

function ensureDirectHlsJob(mediaId, req) {
  const existing = activeHlsJobs.get(mediaId);
  if (existing) {
    touchHlsJob(existing);
    return existing;
  }

  const db = getDb();
  const row = getDirectVideoRow(db, mediaId, req);
  if (!row) return null;

  const hlsRoot = path.join(DATA_DIR, 'tmp', 'hls');
  fs.mkdirSync(hlsRoot, { recursive: true });

  const jobDir = path.join(hlsRoot, `${sanitizeForPath(mediaId)}-${Date.now().toString(36)}`);
  fs.mkdirSync(jobDir, { recursive: true });

  const playlistPath = path.join(jobDir, 'index.m3u8');
  const segmentPattern = path.join(jobDir, 'seg-%06d.ts');
  const diag = createFfmpegDiagnostics(`hls direct ${mediaId}`);

  const job = {
    mediaId,
    dir: jobDir,
    playlistPath,
    concatListPath: null,
    cmd: null,
    stopped: false,
    lastAccess: Date.now(),
    telemetryStartedAt: telemetry.startTranscodeJob('hls'),
  };

  const cmd = ffmpeg(row.file_path)
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
      console.error('[stream] Direct HLS transcode error:', err.message);
      disposeHlsJob(mediaId, 'ffmpeg-error');
    })
    .on('end', () => {
      console.info(`[stream] HLS encode complete id=${mediaId}`);
      touchHlsJob(job);
    });

  job.cmd = cmd;
  activeHlsJobs.set(mediaId, job);
  cmd.run();
  return job;
}

function getExistingVirtualHlsJob(mediaId) {
  return activeHlsJobs.get(mediaId) || null;
}

// GET /stream/:id/hls/index.m3u8 - iOS/Safari-friendly compatibility stream for virtual videos
router.get('/:id/hls/index.m3u8', async (req, res) => {
  if (checkClientBlocked(req, res)) return;
  telemetry.recordStreamRequest();
  const job = isVirtualMediaId(req.params.id)
    ? ensureVirtualHlsJob(req.params.id, req)
    : ensureDirectHlsJob(req.params.id, req);
  if (!job) return res.status(404).json({ error: 'Not found' });

  touchHlsJob(job);
  const playlistReady = await waitForHlsPlaylistReady(job, HLS_PLAYLIST_WAIT_MS);
  if (!playlistReady) {
    return res.status(503).json({ error: 'HLS stream is starting, please retry' });
  }

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(job.playlistPath).pipe(res);
});

// GET /stream/:id/hls/:segment - HLS segment files for virtual compatibility stream
router.get('/:id/hls/:segment', async (req, res) => {
  if (checkClientBlocked(req, res)) return;
  telemetry.recordStreamRequest();
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

  try {
    const stat = fs.statSync(segmentPath);
    telemetry.recordStreamBytes(stat.size || 0);
  } catch {
    // Ignore stat race; stream delivery is still attempted.
  }

  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'no-store');
  const requestStartedAt = Date.now();
  let recordedStartup = false;
  const segmentStream = fs.createReadStream(segmentPath);
  segmentStream.on('data', () => {
    if (recordedStartup) return;
    recordedStartup = true;
    telemetry.recordPlaybackStartup((Date.now() - requestStartedAt) / 1000, { mode: 'hls_segment' });
  });
  segmentStream.pipe(res);
});

// GET /stream/:id/transcode - browser-compatible MP4 fallback stream
router.get('/:id/transcode', (req, res) => {
  if (checkClientBlocked(req, res)) return;
  const db = getDb();
  const startSeconds = parseStartSeconds(req.query.start);
  const virtualSegments = getVirtualSegmentRows(db, req.params.id, req);
  const clientIp = getClientIp(req);
  const ua = req.headers['user-agent'] || '';
  console.info(
    `[stream] transcode request id=${req.params.id} virtual=${virtualSegments ? '1' : '0'} start=${startSeconds} range=${req.headers.range || 'none'} ip=${clientIp} ua=${ua}`
  );
  telemetry.recordStreamRequest();
  const requestStartedAt = Date.now();

  if (virtualSegments) {
    // Safety guard: virtual transcode requests from stale listing-page preview code
    // do not include watch-specific query params and can poison first playback on Safari.
    // Watch page requests always include _ts (or start on stitched seeking).
    const hasWatchTranscodeParams = req.query._ts != null || req.query.start != null;
    if (!hasWatchTranscodeParams) {
      res.status(204).end();
      return;
    }

    // Safari sends a Range: bytes=0-1 probe to check if the server supports byte ranges.
    // If we return 200 (ignoring the Range header), Safari closes the connection immediately.
    // For small range probes, respond with a minimal 206 immediately so Safari knows
    // ranges are supported and will proceed to make a full content request.
    const probeRange = parseSafariProbeRange(req.headers.range);
    if (probeRange) {
      const estimatedTotalBytes = Math.max(estimateVirtualTranscodeSizeBytes(virtualSegments), probeRange.end + 1);
      // Small probe — satisfy it immediately without starting ffmpeg
      res.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes ${probeRange.start}-${probeRange.end}/${estimatedTotalBytes}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': probeRange.length,
        'Cache-Control': 'no-store',
      });
      res.end(Buffer.alloc(probeRange.length));
      return;
    }

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
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'Transfer-Encoding': 'chunked'
    });

    let transcodeStopped = false;
    let cleanedUp = false;
    let bytesSent = 0;
    let finishedTelemetry = false;
    let recordedStartup = false;
    const transcodeStartedAt = telemetry.startTranscodeJob('transcode');
    const diag = createFfmpegDiagnostics(`virtual ${req.params.id}`);
    const finishTranscodeTelemetry = (status) => {
      if (finishedTelemetry) return;
      finishedTelemetry = true;
      telemetry.finishTranscodeJob(transcodeStartedAt, {
        kind: 'transcode',
        mode: 'virtual_transcode',
        status,
      });
    };
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
        finishTranscodeTelemetry('error');
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
      if (!recordedStartup) {
        recordedStartup = true;
        telemetry.recordPlaybackStartup((Date.now() - requestStartedAt) / 1000, { mode: 'virtual_transcode' });
      }
      bytesSent += chunk.length;
      addBytes(sessionId, chunk.length);
      telemetry.recordStreamBytes(chunk.length);
    });

    const stopTranscode = () => {
      if (transcodeStopped) return;
      transcodeStopped = true;
      finishTranscodeTelemetry('aborted');
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
      finishTranscodeTelemetry('ok');
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

  const probeRange = parseSafariProbeRange(req.headers.range);
  if (probeRange) {
    const estimatedTotalBytes = Math.max(estimateTranscodeSizeBytesFromDuration(row.duration), probeRange.end + 1);
    res.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Content-Range': `bytes ${probeRange.start}-${probeRange.end}/${estimatedTotalBytes}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': probeRange.length,
      'Cache-Control': 'no-store',
    });
    res.end(Buffer.alloc(probeRange.length));
    return;
  }

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
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'Transfer-Encoding': 'chunked'
  });

  let transcodeStopped = false;
  let bytesSent = 0;
  let finishedTelemetry = false;
  let recordedStartup = false;
  const transcodeStartedAt = telemetry.startTranscodeJob('transcode');
  const diag = createFfmpegDiagnostics(`media ${row.id}`);
  const finishTranscodeTelemetry = (status) => {
    if (finishedTelemetry) return;
    finishedTelemetry = true;
    telemetry.finishTranscodeJob(transcodeStartedAt, {
      kind: 'transcode',
      mode: 'direct_transcode',
      status,
    });
  };

  const cmd = ffmpeg(filePath)
    .videoCodec('libx264')
    .audioCodec('aac')
    .format('mp4')
    .outputOptions(getCompatibilityTranscodeOptions())
    .on('start', commandLine => diag.onStart(commandLine))
    .on('stderr', line => diag.onStderr(line))
    .on('error', err => {
      finishTranscodeTelemetry('error');
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
    if (!recordedStartup) {
      recordedStartup = true;
      telemetry.recordPlaybackStartup((Date.now() - requestStartedAt) / 1000, { mode: 'direct_transcode' });
    }
    bytesSent += chunk.length;
    addBytes(sessionId, chunk.length);
    telemetry.recordStreamBytes(chunk.length);
  });

  const stopTranscode = () => {
    if (transcodeStopped) return;
    transcodeStopped = true;
    finishTranscodeTelemetry('aborted');
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
    finishTranscodeTelemetry('ok');
    touchSession(sessionId);
    console.info(`[stream] transcode finish id=${row.id} bytes=${bytesSent}`);
  });

  cmd.pipe(pass, { end: true });
  pass.pipe(res, { end: true });
});

// GET /stream/:id/concat  - low-CPU stream for virtual/stitched videos using stream copy (no re-encode)
// ffmpeg concatenates segments and remuxes to fragmented MP4. Near-zero CPU vs. full transcode.
// Falls back to /transcode automatically via client-side error handler if codecs are incompatible.
router.get('/:id/concat', (req, res) => {
  if (checkClientBlocked(req, res)) return;
  telemetry.recordStreamRequest();
  const requestStartedAt = Date.now();

  if (!isVirtualMediaId(req.params.id)) {
    return res.status(400).json({ error: 'Concat stream is available for virtual videos only' });
  }

  const db = getDb();
  const virtualSegments = getVirtualSegmentRows(db, req.params.id, req);
  if (!virtualSegments) return res.status(404).json({ error: 'Not found' });

  const concatListPath = createConcatListFile(virtualSegments.map(row => row.file_path));

  const sessionId = upsertSession({
    mediaId: req.params.id,
    title: path.basename(path.dirname(virtualSegments[0].file_path) || virtualSegments[0].file_name),
    type: 'direct',
    ip: req.ip || req.socket?.remoteAddress || 'unknown',
    userAgent: req.headers['user-agent'] || '',
  });

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'Transfer-Encoding': 'chunked',
  });

  let stopped = false;
  let cleanedUp = false;
  let bytesSent = 0;
  let recordedStartup = false;
  const diag = createFfmpegDiagnostics(`concat ${req.params.id}`);

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    cleanupFile(concatListPath);
  };

  const cmd = ffmpeg()
    .input(concatListPath)
    .inputOptions(['-f concat', '-safe 0'])
    .outputOptions([
      '-c copy',
      '-movflags frag_keyframe+empty_moov+default_base_moof',
      '-frag_duration 1000000',
    ])
    .format('mp4')
    .on('start', commandLine => diag.onStart(commandLine))
    .on('stderr', line => diag.onStderr(line))
    .on('end', () => {
      cleanup();
      touchSession(sessionId);
      console.info(`[stream] concat finish id=${req.params.id} bytes=${bytesSent}`);
    })
    .on('error', err => {
      cleanup();
      if (stopped && isIntentionalKillError(err)) return;
      diag.logErrorContext(err);
      console.error('[stream] Concat stream error:', err.message);
      if (!res.writableEnded) res.end();
    });

  const stopCmd = () => {
    if (stopped) return;
    stopped = true;
    touchSession(sessionId);
    cleanup();
    try { cmd.kill('SIGKILL'); } catch { /* ignore */ }
  };

  req.on('aborted', stopCmd);
  res.on('close', () => {
    if (!res.writableEnded) stopCmd();
    else { touchSession(sessionId); cleanup(); }
  });
  res.on('finish', () => { touchSession(sessionId); cleanup(); });

  const pass = new PassThrough();
  pass.on('data', chunk => {
    if (!recordedStartup) {
      recordedStartup = true;
      telemetry.recordPlaybackStartup((Date.now() - requestStartedAt) / 1000, { mode: 'virtual_concat' });
    }
    bytesSent += chunk.length;
    addBytes(sessionId, chunk.length);
    telemetry.recordStreamBytes(chunk.length);
  });

  cmd.pipe(pass, { end: true });
  pass.pipe(res, { end: true });
});

// GET /stream/:id  - HTTP range-supporting video stream (read-only)
router.get('/:id', (req, res) => {
  if (checkClientBlocked(req, res)) return;
  telemetry.recordStreamRequest();
  const requestStartedAt = Date.now();
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
    const parsedRange = parseSingleByteRange(range, fileSize);
    if (parsedRange.invalid || parsedRange.unsatisfiable) {
      res.writeHead(416, {
        'Content-Range': `bytes */${fileSize}`,
        'Accept-Ranges': 'bytes',
      });
      return res.end();
    }

    const { start, end, length: chunkSize } = parsedRange;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': mimeType,
      'Cache-Control': 'no-store',
    });

    let recordedStartup = false;
    const fileStream = fs.createReadStream(filePath, { start, end });
    fileStream.on('data', chunk => {
      if (!recordedStartup) {
        recordedStartup = true;
        telemetry.recordPlaybackStartup((Date.now() - requestStartedAt) / 1000, { mode: 'direct_range' });
      }
      addBytes(sessionId, chunk.length);
      telemetry.recordStreamBytes(chunk.length);
    });
    fileStream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    let recordedStartup = false;
    const fileStream = fs.createReadStream(filePath);
    fileStream.on('data', chunk => {
      if (!recordedStartup) {
        recordedStartup = true;
        telemetry.recordPlaybackStartup((Date.now() - requestStartedAt) / 1000, { mode: 'direct_full' });
      }
      addBytes(sessionId, chunk.length);
      telemetry.recordStreamBytes(chunk.length);
    });
    fileStream.pipe(res);
  }

  req.on('close', () => touchSession(sessionId));
  res.on('finish', () => touchSession(sessionId));
});

module.exports = router;
