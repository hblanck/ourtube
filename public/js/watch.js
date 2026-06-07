'use strict';

(function () {
  const params = new URLSearchParams(location.search);
  const mediaId = params.get('id');
  const bookmarkQueryId = Number.parseInt(params.get('bookmark') || '', 10);

  if (!mediaId) {
    document.querySelector('.watch-main').innerHTML =
      '<p style="padding:24px;color:#888">No media ID specified. <a href="/">← Back</a></p>';
    return;
  }

  let player = null;
  let transcodeFallbackTried = false;
  let compatibilityMode = false;
  let compatibilityTransport = 'none';
  let expectedDuration = 0;
  let stitchedPlayback = false;
  let isSeekingStitched = false;
  let stitchedSeekOffset = 0;
  let stitchedTranscodeTimeOrigin = null;
  let adminModeEnabled = false;
  let currentMedia = null;
  let stitchedSegmentTimeline = [];
  let clipWatermarkEnabled = true;
  let clipWatermarkMode = 'full';
  let hlsStartupRetryTimer = null;
  let hlsStartupRetryCount = 0;
  let hlsStartupFallbackTimer = null;
  let hlsStartupFallbackTried = false;
  let transcodeStartupFallbackTimer = null;
  let transcodeStartupFallbackTried = false;
  let concatDurationFallbackTimer = null;
  let pendingResumeSeconds = null;
  let hasAppliedResume = false;
  let lastProgressSavedAt = 0;
  let lastProgressSavedPosition = 0;
  let progressSaveInFlight = false;
  let latestProgressSavePromise = Promise.resolve();
  let externalBaseUrl = '';
  let preferStitchedCompatibility = false;
  let pendingBookmarkTimeSeconds = null;
  let transcodeSourceGeneration = 0;
  let forcedCompatibilityTransport = null;
  let adminPlaybackModePreference = 'auto';
  let diagnosticsInterval = null;
  let runtimeStats = {
    waitingCount: 0,
    stalledCount: 0,
    errorCount: 0,
    lastError: ''
  };

  const CLIP_WATERMARK_STORAGE_KEY = 'watch_stitched_clip_watermark';
  const CLIP_WATERMARK_MODE_STORAGE_KEY = 'watch_stitched_clip_watermark_mode';
  const PROGRESS_SAVE_INTERVAL_MS = 10000;
  const PROGRESS_MIN_POSITION_DELTA_SECONDS = 3;
  const PROGRESS_RESUME_MIN_SECONDS = 5;
  const PROGRESS_RESUME_END_THRESHOLD_SECONDS = 8;
  const ADMIN_DIAGNOSTICS_REFRESH_MS = 1000;

  function escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtDur(s) {
    if (!s) return '';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return h
      ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${m}:${String(sec).padStart(2, '0')}`;
  }

  function fmtSize(bytes) {
    if (!bytes) return '';
    const gb = bytes / 1e9;
    if (gb >= 1) return gb.toFixed(1) + ' GB';
    return (bytes / 1e6).toFixed(0) + ' MB';
  }

  function isDownloadable(media) {
    return Number(media?.downloadable) === 1;
  }

  function buildDownloadConfirmMessage(media, segmentsCount = 0) {
    const name = String(media?.friendly_name || media?.file_name || 'this video');
    const size = fmtSize(media?.size) || 'unknown size';
    if (media?.is_virtual) {
      return `Download "${name}"?\n\nApproximate total size: ${size}.\nThis stitched video will download ${segmentsCount} source file${segmentsCount === 1 ? '' : 's'}.`;
    }
    return `Download "${name}"?\n\nFile size: ${size}.`;
  }

  function triggerDownload(mediaId) {
    const a = document.createElement('a');
    a.href = `/api/media/${encodeURIComponent(mediaId)}/download`;
    a.download = '';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  async function loadMediaForDownload(targetMediaId) {
    const res = await fetch(`/api/media/${encodeURIComponent(targetMediaId)}`);
    if (!res.ok) throw new Error('Failed to load media');
    return res.json();
  }

  async function startMediaDownload(media, fallbackMediaId = null) {
    let targetMedia = media;
    const mediaIdToLoad = fallbackMediaId || media?.id || mediaId;

    if (!targetMedia || (targetMedia.is_virtual && !Array.isArray(targetMedia.segments))) {
      try {
        targetMedia = await loadMediaForDownload(mediaIdToLoad);
      } catch {
        showWatchActionMessage('Unable to load media for download');
        return;
      }
    }

    if (!isDownloadable(targetMedia)) {
      showWatchActionMessage('Downloads are disabled for this video');
      return;
    }

    if (!targetMedia.is_virtual) {
      if (!confirm(buildDownloadConfirmMessage(targetMedia))) return;
      triggerDownload(targetMedia.id || mediaIdToLoad);
      showWatchActionMessage('Starting download…');
      return;
    }

    const segments = Array.isArray(targetMedia.segments)
      ? targetMedia.segments.filter(segment => Number(segment.downloadable) === 1)
      : [];
    if (!segments.length) {
      showWatchActionMessage('No downloadable source files are available');
      return;
    }
    if (!confirm(buildDownloadConfirmMessage(targetMedia, segments.length))) return;

    segments.forEach((segment, idx) => {
      setTimeout(() => triggerDownload(segment.id), idx * 250);
    });
    showWatchActionMessage(`Starting ${segments.length} download${segments.length === 1 ? '' : 's'}…`);
  }

  function fmtDate(str) {
    if (!str) return '';
    try { return new Date(str).toLocaleDateString(); } catch { return str; }
  }

  function normalizeExternalBaseUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return '';
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    const normalizedPath = parsed.pathname.replace(/\/+$/g, '');
    return `${parsed.origin}${normalizedPath}${parsed.search}${parsed.hash}`;
  }

  async function loadUiSettings() {
    try {
      const res = await fetch('/api/ui-settings', { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      externalBaseUrl = normalizeExternalBaseUrl(data?.external_base_url);
      preferStitchedCompatibility = data?.stitched_prefer_compatibility === true;
    } catch {
      externalBaseUrl = '';
      preferStitchedCompatibility = false;
    }
  }

  function formatAppInfoTooltip(info) {
    if (!info || typeof info !== 'object') return '';
    const lines = [];
    const appName = String(info.app?.name || 'ourtube');
    const appVersion = String(info.app?.version || '').trim();
    const dockerImage = String(info.docker?.image || '').trim();
    const dockerCreatedAt = String(info.docker?.createdAt || '').trim();
    const dockerTags = Array.isArray(info.docker?.tags)
      ? info.docker.tags.map(tag => String(tag || '').trim()).filter(Boolean)
      : [];

    const imageCreatedDisplay = (() => {
      if (!dockerCreatedAt) return 'Unknown';
      const parsed = new Date(dockerCreatedAt);
      if (Number.isNaN(parsed.getTime())) return 'Unknown';
      return parsed.toLocaleString();
    })();

    lines.push(`${appName} ${appVersion}`.trim());
    if (dockerImage) lines.push(`Image: ${dockerImage}`);
    lines.push(`Image created: ${imageCreatedDisplay}`);
    if (dockerTags.length) lines.push(`Tags: ${dockerTags.join(', ')}`);
    if (info.runtime?.nodeVersion) lines.push(`Node: ${String(info.runtime.nodeVersion).trim()}`);
    if (info.runtime?.environment) lines.push(`Environment: ${String(info.runtime.environment).trim()}`);

    return lines.join('\n');
  }

  function formatFooterInfo(info) {
    const appVersion = String(info?.app?.version || '').trim();
    const parts = [];
    if (appVersion) parts.push(`OurTube ${appVersion}`);
    parts.push('Copyright (c) 2026, Howie Blanck');
    return parts.join(' · ');
  }

  function applyAppInfoTooltip(info) {
    const tooltip = formatAppInfoTooltip(info);
    document.querySelectorAll('.logo').forEach(logo => {
      if (!tooltip) {
        logo.classList.remove('has-app-tooltip');
        logo.removeAttribute('data-app-tooltip');
        logo.removeAttribute('title');
        return;
      }

      logo.classList.add('has-app-tooltip');
      // Use the custom CSS tooltip only to avoid native title overlap.
      logo.removeAttribute('title');
      logo.setAttribute('data-app-tooltip', tooltip);
    });

    const footer = document.getElementById('app-info-footer-text');
    if (footer) {
      const footerText = formatFooterInfo(info);
      if (footerText) footer.textContent = footerText;
    }
  }

  async function loadAppInfoTooltip() {
    try {
      const res = await fetch('/api/app-info');
      if (!res.ok) return;
      const info = await res.json();
      applyAppInfoTooltip(info);
    } catch {
      // ignore
    }
  }

  function buildWatchUrl(bookmarkId = null, targetMediaId = mediaId) {
    const origin = externalBaseUrl || window.location.origin;
    const qs = new URLSearchParams({ id: String(targetMediaId || mediaId) });
    if (Number.isInteger(bookmarkId) && bookmarkId > 0) qs.set('bookmark', String(bookmarkId));
    return `${origin}/watch.html?${qs.toString()}`;
  }

  async function copyTextToClipboard(text) {
    const content = String(text || '');
    if (!content) return false;

    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(content);
        return true;
      } catch {
        // Fallback below.
      }
    }

    try {
      const ta = document.createElement('textarea');
      ta.value = content;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch {
      return false;
    }
  }

  function showWatchActionMessage(text) {
    const msg = document.getElementById('share-video-msg');
    if (!msg) return;
    msg.textContent = text || '';
    if (!text) return;
    setTimeout(() => {
      if (msg.textContent === text) msg.textContent = '';
    }, 2500);
  }

  function seekToVideoTime(targetSeconds, { autoplay = true } = {}) {
    if (!player || !currentMedia || currentMedia.type !== 'video') return;
    const seekTarget = Math.max(0, Number(targetSeconds) || 0);

    if (stitchedPlayback && compatibilityMode && compatibilityTransport === 'transcode') {
      seekStitchedPlayback(seekTarget);
    } else {
      try {
        player.currentTime(seekTarget);
      } catch {
        player.one('loadedmetadata', () => {
          try { player.currentTime(seekTarget); } catch { /* ignore */ }
        });
      }
    }

    if (autoplay) player.play().catch(() => {});
  }

  function bindShareVideoButton() {
    const wrap = document.getElementById('watch-actions');
    const btn = document.getElementById('share-video-btn');
    const downloadBtn = document.getElementById('download-video-btn');
    if (!wrap || !btn || !downloadBtn) return;
    if (!currentMedia || currentMedia.type !== 'video') {
      wrap.style.display = 'none';
      return;
    }

    wrap.style.display = 'flex';
    downloadBtn.style.display = isDownloadable(currentMedia) ? '' : 'none';
    if (btn.dataset.bound !== '1') {
      btn.addEventListener('click', async () => {
        const ok = await copyTextToClipboard(buildWatchUrl());
        showWatchActionMessage(ok ? 'Video link copied to clipboard' : 'Unable to copy link');
      });
      btn.dataset.bound = '1';
    }

    if (downloadBtn.dataset.bound === '1') return;
    downloadBtn.addEventListener('click', async () => {
      await startMediaDownload(currentMedia, currentMedia?.id || mediaId);
    });
    downloadBtn.dataset.bound = '1';
  }

  function closeBookmarkDialog() {
    const modal = document.getElementById('bookmark-modal');
    if (modal) modal.classList.remove('open');
    pendingBookmarkTimeSeconds = null;
  }

  function openBookmarkDialog() {
    if (!currentMedia || currentMedia.type !== 'video') return;
    const modal = document.getElementById('bookmark-modal');
    const form = document.getElementById('bookmark-dialog-form');
    const currentTime = document.getElementById('bookmark-dialog-time');
    if (!modal || !form || !currentTime) return;

    pendingBookmarkTimeSeconds = Math.max(0, Number(getTimelineCurrentTime()) || 0);
    currentTime.textContent = fmtDur(pendingBookmarkTimeSeconds);
    modal.classList.add('open');
    const title = form.querySelector('[name="title"]');
    if (title) title.focus();
  }

  function getCurrentDurationSeconds() {
    if (!player) return 0;
    const fromPlayer = Number(player.duration());
    if (Number.isFinite(fromPlayer) && fromPlayer > 0) return fromPlayer;
    const fromExpected = Number(expectedDuration);
    return Number.isFinite(fromExpected) && fromExpected > 0 ? fromExpected : 0;
  }

  async function loadPlaybackProgress() {
    try {
      const res = await fetch(`/api/playback-progress/${encodeURIComponent(mediaId)}`);
      if (!res.ok) return 0;
      const data = await res.json();
      const seconds = Number(data?.position_seconds);
      return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    } catch {
      return 0;
    }
  }

  function shouldResumeAt(positionSeconds, durationSeconds) {
    if (!Number.isFinite(positionSeconds) || positionSeconds < PROGRESS_RESUME_MIN_SECONDS) return false;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return true;
    return positionSeconds < Math.max(0, durationSeconds - PROGRESS_RESUME_END_THRESHOLD_SECONDS);
  }

  function applyResumeIfReady() {
    if (!player || !currentMedia || currentMedia.type !== 'video') return;
    if (hasAppliedResume || !Number.isFinite(pendingResumeSeconds)) return;

    const duration = getCurrentDurationSeconds();
    if (!shouldResumeAt(pendingResumeSeconds, duration)) {
      hasAppliedResume = true;
      pendingResumeSeconds = null;
      return;
    }

    const target = Math.max(0, pendingResumeSeconds);
    if (stitchedPlayback && compatibilityMode && compatibilityTransport === 'transcode') {
      seekStitchedPlayback(target);
    } else {
      try {
        player.currentTime(target);
      } catch {
        return;
      }
    }

    hasAppliedResume = true;
    pendingResumeSeconds = null;
  }

  function buildProgressPayload(markCompleted) {
    if (!player || !currentMedia || currentMedia.type !== 'video') return null;

    const position = Math.max(0, Number(getTimelineCurrentTime()) || 0);
    const duration = Math.max(0, Number(getCurrentDurationSeconds()) || 0);
    if (!Number.isFinite(position)) return null;

    const nearEnd = duration > 0 && position >= Math.max(0, duration - PROGRESS_RESUME_END_THRESHOLD_SECONDS);
    return {
      position_seconds: position,
      duration_seconds: duration || null,
      completed: !!markCompleted || nearEnd,
    };
  }

  function savePlaybackProgress({ force = false, markCompleted = false } = {}) {
    const payload = buildProgressPayload(markCompleted);
    if (!payload) return Promise.resolve();

    const now = Date.now();
    const movedEnough = Math.abs(payload.position_seconds - lastProgressSavedPosition) >= PROGRESS_MIN_POSITION_DELTA_SECONDS;
    const intervalElapsed = (now - lastProgressSavedAt) >= PROGRESS_SAVE_INTERVAL_MS;
    if (!force && !(movedEnough && intervalElapsed)) return Promise.resolve();
    if (progressSaveInFlight) return latestProgressSavePromise;

    progressSaveInFlight = true;
    latestProgressSavePromise = fetch(`/api/playback-progress/${encodeURIComponent(mediaId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: force,
    }).catch(() => {
      // Ignore transient persistence failures.
    }).finally(() => {
      progressSaveInFlight = false;
      lastProgressSavedAt = Date.now();
      lastProgressSavedPosition = payload.position_seconds;
    });

    return latestProgressSavePromise;
  }

  function setTimeControlDisplay(el, value) {
    if (!el) return;
    const textNode = Array.from(el.childNodes).find(node => node.nodeType === Node.TEXT_NODE);
    if (textNode) {
      textNode.textContent = ` ${value}`;
      return;
    }
    el.appendChild(document.createTextNode(` ${value}`));
  }

  function getStitchedProgressElements() {
    return {
      container: document.getElementById('stitched-progress'),
      seek: document.getElementById('stitched-seek'),
      ticks: document.getElementById('stitched-seek-ticks'),
      current: document.getElementById('stitched-current'),
      total: document.getElementById('stitched-total'),
      notice: document.getElementById('stitched-notice')
    };
  }

  function getStitchedClipWatermarkElements() {
    return {
      overlay: document.getElementById('stitched-clip-watermark'),
      control: document.getElementById('stitched-clip-watermark-control'),
      toggle: document.getElementById('stitched-clip-watermark-toggle'),
      mode: document.getElementById('stitched-clip-watermark-mode')
    };
  }

  function readClipWatermarkPreference() {
    try {
      const raw = localStorage.getItem(CLIP_WATERMARK_STORAGE_KEY);
      if (raw === null) return true;
      return raw !== '0';
    } catch {
      return true;
    }
  }

  function persistClipWatermarkPreference(enabled) {
    try {
      localStorage.setItem(CLIP_WATERMARK_STORAGE_KEY, enabled ? '1' : '0');
    } catch {
      // Ignore storage failures (private mode, blocked storage, etc.)
    }
  }

  function readClipWatermarkModePreference() {
    try {
      const raw = localStorage.getItem(CLIP_WATERMARK_MODE_STORAGE_KEY);
      return raw === 'number' ? 'number' : 'full';
    } catch {
      return 'full';
    }
  }

  function persistClipWatermarkModePreference(mode) {
    try {
      localStorage.setItem(CLIP_WATERMARK_MODE_STORAGE_KEY, mode === 'number' ? 'number' : 'full');
    } catch {
      // Ignore storage failures (private mode, blocked storage, etc.)
    }
  }

  function bindClipWatermarkToggle() {
    const { toggle, mode } = getStitchedClipWatermarkElements();
    if (!toggle || toggle.dataset.bound === '1') return;

    toggle.addEventListener('change', () => {
      clipWatermarkEnabled = !!toggle.checked;
      persistClipWatermarkPreference(clipWatermarkEnabled);
      updateCurrentClipWatermark();
    });

    toggle.dataset.bound = '1';

    if (mode && mode.dataset.bound !== '1') {
      mode.addEventListener('change', () => {
        clipWatermarkMode = mode.value === 'number' ? 'number' : 'full';
        persistClipWatermarkModePreference(clipWatermarkMode);
        updateCurrentClipWatermark();
      });
      mode.dataset.bound = '1';
    }
  }

  function getTimelineCurrentTime() {
    if (!player) return 0;
    const rawCurrent = Number(player.currentTime());
    const safeCurrent = Number.isFinite(rawCurrent) && rawCurrent >= 0 ? rawCurrent : 0;

    if (stitchedPlayback && compatibilityMode && compatibilityTransport === 'transcode') {
      if (!Number.isFinite(stitchedTranscodeTimeOrigin)) {
        // Origin not yet latched — source still loading; show seek offset position.
        return stitchedSeekOffset;
      }
      const elapsedSinceSourceAttach = Math.max(0, safeCurrent - stitchedTranscodeTimeOrigin);
      return stitchedSeekOffset + elapsedSinceSourceAttach;
    }

    return safeCurrent;
  }

  function buildTranscodeUrl(media, startSeconds = 0) {
    const url = new URL(`/stream/${media.id}/transcode`, location.origin);
    if (startSeconds > 0) url.searchParams.set('start', String(startSeconds));
    // Ensure browsers do not reuse a stale transcode response when scrubbing.
    url.searchParams.set('_ts', String(Date.now()));
    return url.pathname + url.search;
  }

  function buildHlsUrl(media) {
    const url = new URL(`/stream/${media.id}/hls/index.m3u8`, location.origin);
    // Keep parity with transcode URL cache-busting behavior.
    url.searchParams.set('_ts', String(Date.now()));
    return url.pathname + url.search;
  }

  function buildConcatUrl(media) {
    return `/stream/${media.id}/concat`;
  }

  function getEffectivePlaybackTransport(media, useTranscode) {
    if (!useTranscode) return 'none';
    if (forcedCompatibilityTransport) return forcedCompatibilityTransport;
    return shouldUseHlsCompatibility(media) ? 'hls' : 'transcode';
  }

  function parsePlaybackModeSelection(media) {
    const mode = String(adminPlaybackModePreference || 'auto').toLowerCase();
    if (mode === 'direct') return { useTranscode: false, transport: 'none' };
    if (mode === 'transcode') return { useTranscode: true, transport: 'transcode' };
    if (mode === 'hls') return { useTranscode: true, transport: 'hls' };
    const useTranscode = shouldPreferTranscode(media);
    return { useTranscode, transport: getEffectivePlaybackTransport(media, useTranscode) };
  }

  function applyPreferredPlaybackMode(media, { preservePosition = false } = {}) {
    if (!player || !media || media.type !== 'video') return;

    const { useTranscode, transport } = parsePlaybackModeSelection(media);
    const shouldResume = preservePosition ? !player.paused() : null;
    const resumeAt = preservePosition ? Math.max(0, Number(getTimelineCurrentTime()) || 0) : 0;

    forcedCompatibilityTransport = adminPlaybackModePreference === 'auto' ? null : transport;
    if (stitchedPlayback && useTranscode && transport === 'transcode') {
      stitchedSeekOffset = resumeAt;
      stitchedTranscodeTimeOrigin = null;
    }

    setVideoSource(media, useTranscode);

    if (preservePosition && resumeAt > 0 && !(stitchedPlayback && useTranscode && transport === 'transcode')) {
      const seekOnce = () => {
        try {
          player.currentTime(resumeAt);
        } catch {
          // Ignore source race while changing playback transport.
        }
      };
      player.one('loadedmetadata', seekOnce);
      player.one('canplay', seekOnce);
    }

    if (shouldResume) player.play().catch(() => {});
    updateAdminDiagnostics();
  }

  function getVideoCodec(media) {
    return (media?.codec || media?.raw_metadata?.streams?.find(stream => stream.codec_type === 'video')?.codec_name || '').toLowerCase();
  }

  function parseFrameRate(rawRate) {
    const value = String(rawRate || '').trim();
    if (!value || value === '0/0') return '';
    if (!value.includes('/')) {
      const numeric = Number(value);
      return Number.isFinite(numeric) && numeric > 0 ? numeric.toFixed(2) : '';
    }
    const [numRaw, denRaw] = value.split('/');
    const num = Number(numRaw);
    const den = Number(denRaw);
    if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return '';
    const fps = num / den;
    return Number.isFinite(fps) && fps > 0 ? fps.toFixed(2) : '';
  }

  function getCurrentBufferAheadSeconds() {
    if (!player) return 0;
    const current = Math.max(0, Number(player.currentTime()) || 0);
    const buffered = player.buffered();
    if (!buffered || typeof buffered.length !== 'number') return 0;

    for (let i = 0; i < buffered.length; i += 1) {
      const start = Number(buffered.start(i));
      const end = Number(buffered.end(i));
      if (Number.isFinite(start) && Number.isFinite(end) && start <= current && current <= end) {
        return Math.max(0, end - current);
      }
    }
    return 0;
  }

  function getVideoFrameStats() {
    const videoEl = player?.el()?.querySelector('video');
    if (!videoEl) return { dropped: null, total: null };

    if (typeof videoEl.getVideoPlaybackQuality === 'function') {
      const quality = videoEl.getVideoPlaybackQuality();
      const dropped = Number(quality?.droppedVideoFrames);
      const total = Number(quality?.totalVideoFrames);
      return {
        dropped: Number.isFinite(dropped) ? dropped : null,
        total: Number.isFinite(total) ? total : null
      };
    }

    const dropped = Number(videoEl.webkitDroppedFrameCount);
    const total = Number(videoEl.webkitDecodedFrameCount);
    return {
      dropped: Number.isFinite(dropped) ? dropped : null,
      total: Number.isFinite(total) ? total : null
    };
  }

  function clearHlsStartupRetry() {
    if (!hlsStartupRetryTimer) return;
    clearTimeout(hlsStartupRetryTimer);
    hlsStartupRetryTimer = null;
  }

  function clearHlsStartupFallback() {
    if (!hlsStartupFallbackTimer) return;
    clearTimeout(hlsStartupFallbackTimer);
    hlsStartupFallbackTimer = null;
  }

  function clearTranscodeStartupFallback() {
    if (!transcodeStartupFallbackTimer) return;
    clearTimeout(transcodeStartupFallbackTimer);
    transcodeStartupFallbackTimer = null;
  }

  function clearConcatDurationFallback() {
    if (!concatDurationFallbackTimer) return;
    clearTimeout(concatDurationFallbackTimer);
    concatDurationFallbackTimer = null;
  }

  function hasInvalidConcatDuration() {
    if (!player) return true;

    const rawDuration = Number(player.duration());
    if (!Number.isFinite(rawDuration) || rawDuration <= 0) return true;

    const safeExpectedDuration = Math.max(0, Number(expectedDuration) || 0);
    if (safeExpectedDuration <= 0) return false;

    // Some fragmented concat outputs report a tiny/incorrect duration on certain ffmpeg builds.
    return rawDuration < (safeExpectedDuration * 0.8);
  }

  function scheduleConcatDurationFallback(media) {
    clearConcatDurationFallback();
    if (!player || !media?.is_virtual) return;

    concatDurationFallbackTimer = setTimeout(() => {
      if (!player || compatibilityMode || compatibilityTransport !== 'none') return;
      if (!hasInvalidConcatDuration()) return;

      const warning = document.getElementById('playback-warning');
      if (warning) {
        warning.textContent = 'Stitched timeline metadata is unavailable. Switching to compatibility playback...';
        warning.style.display = 'block';
      }

      setVideoSource(media, true);
      player.play().catch(() => {});
    }, 1600);
  }

  function scheduleHlsStartupRetry(media) {
    clearHlsStartupRetry();
    if (!player || !media) return;

    hlsStartupRetryTimer = setTimeout(() => {
      if (!player || compatibilityTransport !== 'hls') return;

      const readyState = typeof player.readyState === 'function' ? Number(player.readyState()) : 0;
      if (Number.isFinite(readyState) && readyState >= 2) return;
      if (hlsStartupRetryCount >= 1) return;
      hlsStartupRetryCount += 1;

      const shouldResume = !player.paused();
      const restartAt = Math.max(0, Number(player.currentTime()) || 0);
      player.src({ src: buildHlsUrl(media), type: 'application/x-mpegURL' });
      if (restartAt > 0) {
        try {
          player.currentTime(restartAt);
        } catch {
          // Ignore seek race while source is still attaching.
        }
      }
      if (shouldResume) {
        player.play().catch(() => {});
      }
    }, 1800);
  }

  function scheduleHlsStartupFallback(media) {
    clearHlsStartupFallback();
    if (!player || !media) return;
    if (compatibilityTransport !== 'hls') return;
    if (hlsStartupFallbackTried) return;

    hlsStartupFallbackTimer = setTimeout(() => {
      if (!player || compatibilityTransport !== 'hls') return;

      const readyState = typeof player.readyState === 'function' ? Number(player.readyState()) : 0;
      if (Number.isFinite(readyState) && readyState >= 2) return;

      hlsStartupFallbackTried = true;
      forcedCompatibilityTransport = 'transcode';
      compatibilityTransport = 'transcode';
      const shouldResume = !player.paused();

      const warning = document.getElementById('playback-warning');
      if (warning) {
        warning.textContent = 'HLS playback is still starting. Switching to MP4 compatibility mode...';
        warning.style.display = 'block';
      }

      setVideoSource(media, true);
      if (shouldResume) {
        const resumeOnce = () => {
          player.play().catch(() => {});
        };
        player.one('loadedmetadata', resumeOnce);
        player.one('canplay', resumeOnce);
        player.play().catch(() => {});
      }
    }, 6500);
  }

  function scheduleTranscodeStartupFallback(media) {
    clearTranscodeStartupFallback();
    if (!player || !media) return;
    if (!media.is_virtual) return;
    if (!isSafariOnMacOS()) return;
    if (compatibilityTransport !== 'transcode') return;
    if (transcodeStartupFallbackTried) return;

    transcodeStartupFallbackTimer = setTimeout(() => {
      if (!player || compatibilityTransport !== 'transcode') return;
      const readyState = typeof player.readyState === 'function' ? Number(player.readyState()) : 0;
      if (Number.isFinite(readyState) && readyState >= 2) return;

      transcodeStartupFallbackTried = true;
      compatibilityTransport = 'hls';
      hlsStartupRetryCount = 0;
      const shouldResume = !player.paused();
      const restartAt = Math.max(0, Number(player.currentTime()) || 0);

      const warning = document.getElementById('playback-warning');
      if (warning) {
        warning.textContent = 'Playback startup fallback: trying HLS...';
        warning.style.display = 'block';
      }

      player.src({ src: buildHlsUrl(media), type: 'application/x-mpegURL' });
      if (restartAt > 0) {
        try {
          player.currentTime(restartAt);
        } catch {
          // Ignore seek race while source is still attaching.
        }
      }
      scheduleHlsStartupRetry(media);
      if (shouldResume) {
        const resumeOnce = () => {
          player.play().catch(() => {});
        };
        player.one('loadedmetadata', resumeOnce);
        player.one('canplay', resumeOnce);
        player.play().catch(() => {});
      }
    }, 2200);
  }

  function isLikelyIOS() {
    const ua = navigator.userAgent || '';
    const iOS = /iPad|iPhone|iPod/.test(ua);
    const iPadOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
    return iOS || iPadOS;
  }

  function isSafariOnMacOS() {
    const ua = navigator.userAgent || '';
    // Check if it's Safari on macOS (not iOS/iPadOS)
    const isMac = /Macintosh/.test(ua);
    const notMobileOS = !/iPhone|iPad|iPod/.test(ua) && navigator.maxTouchPoints <= 1;
    const hasSafari = /Safari\//.test(ua) && !/Chrome|CriOS|Edg|FxiOS|OPR/.test(ua);
    return isMac && notMobileOS && hasSafari;
  }

  function shouldUseHlsCompatibility(media) {
    // Keep Safari on HLS for stitched/virtual media only; direct media already
    // has a Safari-safe MP4 transcode path and is more reliable there.
    return !!media?.is_virtual && (isLikelyIOS() || isSafariOnMacOS());
  }

  function seekStitchedPlayback(targetSeconds) {
    if (!player || !currentMedia) return;

    const clamped = Math.max(0, Math.min(targetSeconds, expectedDuration || targetSeconds));
    const wasPaused = player.paused();

    stitchedSeekOffset = clamped;
    stitchedTranscodeTimeOrigin = null;
    player.src({ src: buildTranscodeUrl(currentMedia, clamped), type: 'video/mp4' });
    const seekGen = ++transcodeSourceGeneration;
    player.one('loadeddata', () => {
      if (transcodeSourceGeneration !== seekGen) return;
      const t = Number(player.currentTime());
      stitchedTranscodeTimeOrigin = Number.isFinite(t) && t >= 0 ? t : 0;
      syncCompatibilityDurationUi();
    });
    syncCompatibilityDurationUi();

    if (!wasPaused) {
      player.play().catch(() => {});
    }
  }

  function updateStitchedProgress() {
    const { container, seek, current, total, notice } = getStitchedProgressElements();
    if (!container || !seek || !current || !total) return;

    const shouldShow = stitchedPlayback && compatibilityMode && compatibilityTransport === 'transcode' && expectedDuration > 0;
    container.style.display = shouldShow ? 'flex' : 'none';
    if (notice) notice.style.display = shouldShow ? 'block' : 'none';

    const playerRoot = player?.el();
    if (playerRoot) {
      playerRoot.classList.toggle('stitched-progress-mode', shouldShow);
    }

    if (!shouldShow || !player) return;

    const totalDuration = Math.max(0, Number(expectedDuration) || 0);
    const timelineCurrent = Number(getTimelineCurrentTime());
    const currentTime = Math.max(0, Math.min(Number.isFinite(timelineCurrent) ? timelineCurrent : 0, totalDuration));
    seek.max = String(totalDuration);
    if (!isSeekingStitched) seek.value = String(currentTime);
    current.textContent = fmtDur(currentTime);
    total.textContent = fmtDur(totalDuration);
  }

  function bindStitchedProgressEvents() {
    const { seek } = getStitchedProgressElements();
    if (!seek || seek.dataset.bound === '1') return;

    seek.addEventListener('pointerdown', () => {
      isSeekingStitched = true;
    });

    seek.addEventListener('input', () => {
      const { current } = getStitchedProgressElements();
      if (current) current.textContent = fmtDur(parseFloat(seek.value) || 0);
    });

    const commitSeek = () => {
      const seekValue = parseFloat(seek.value);
      if (player && Number.isFinite(seekValue)) {
        if (stitchedPlayback && compatibilityMode && compatibilityTransport === 'transcode') {
          seekStitchedPlayback(seekValue);
        } else {
          player.currentTime(seekValue);
        }
      }
      isSeekingStitched = false;
      updateStitchedProgress();
    };

    seek.addEventListener('change', commitSeek);
    seek.addEventListener('pointerup', commitSeek);
    seek.addEventListener('keyup', event => {
      if (event.key === 'Enter' || event.key === ' ') commitSeek();
    });

    seek.dataset.bound = '1';
  }

  function bindStitchedSegmentToggle() {
    const toggle = document.getElementById('stitched-segments-toggle');
    const list = document.getElementById('stitched-segments-list');
    if (!toggle || !list || toggle.dataset.bound === '1') return;

    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      const next = !expanded;
      toggle.setAttribute('aria-expanded', String(next));
      list.hidden = !next;
    });

    toggle.dataset.bound = '1';
  }

  function bindStitchedSegmentListActions() {
    const list = document.getElementById('stitched-segments-list');
    if (!list || list.dataset.bound === '1') return;

    list.addEventListener('click', event => {
      const trigger = event.target.closest('[data-segment-offset]');
      if (!trigger || !currentMedia || currentMedia.type !== 'video') return;

      const offset = parseFloat(trigger.getAttribute('data-segment-offset'));
      if (!Number.isFinite(offset) || !player) return;

      if (stitchedPlayback && compatibilityMode && compatibilityTransport === 'transcode') {
        seekStitchedPlayback(offset);
        player.play().catch(() => {});
        return;
      }

      player.currentTime(offset);
      player.play().catch(() => {});
    });

    list.dataset.bound = '1';
  }

  function syncCompatibilityDurationUi() {
    if (!player || !compatibilityMode || compatibilityTransport !== 'transcode' || !expectedDuration) return;

    try {
      if (!Number.isFinite(player.duration()) || Math.abs(player.duration() - expectedDuration) > 1) {
        player.duration(expectedDuration);
      }
    } catch { /* ignore */ }

    const totalDuration = Math.max(0, Number(expectedDuration) || 0);
    const timelineCurrent = Number(getTimelineCurrentTime());
    const current = Math.max(0, Math.min(Number.isFinite(timelineCurrent) ? timelineCurrent : 0, totalDuration));
    const root = player.el();
    if (!root) return;

    setTimeControlDisplay(root.querySelector('.vjs-current-time-display'), fmtDur(current));
    setTimeControlDisplay(root.querySelector('.vjs-duration-display'), fmtDur(totalDuration));
    setTimeControlDisplay(root.querySelector('.vjs-remaining-time-display'), `-${fmtDur(Math.max(totalDuration - current, 0))}`);
    updateStitchedProgress();
    updateCurrentClipWatermark();
  }

  function initVideo(media, resumeSeconds = 0) {
    const container = document.getElementById('player-container');
    if (!container) return;
    container.style.display = '';
    document.getElementById('photo-container').style.display = 'none';

    const warningEl = document.getElementById('playback-warning');
    if (warningEl) warningEl.style.display = 'none';
    const compatibilityBadge = document.getElementById('compatibility-badge');
    if (compatibilityBadge) compatibilityBadge.style.display = 'none';
    transcodeFallbackTried = false;
    hlsStartupFallbackTried = false;
    transcodeStartupFallbackTried = false;
    clearHlsStartupFallback();
    clearTranscodeStartupFallback();
    clearConcatDurationFallback();
    expectedDuration = media.duration || 0;
    stitchedPlayback = !!media.is_virtual;
    stitchedSeekOffset = 0;
    stitchedTranscodeTimeOrigin = null;
    pendingResumeSeconds = Number.isFinite(Number(resumeSeconds)) ? Number(resumeSeconds) : 0;
    hasAppliedResume = false;
    lastProgressSavedAt = 0;
    lastProgressSavedPosition = 0;
    runtimeStats = {
      waitingCount: 0,
      stalledCount: 0,
      errorCount: 0,
      lastError: ''
    };
    bindStitchedProgressEvents();
    updateStitchedProgress();
    updateCurrentClipWatermark();
    syncAdminDiagnosticsVisibility(media);

    if (player) {
      applyPreferredPlaybackMode(media);
      syncAdminDiagnosticsVisibility(media);
      return;
    }

    player = videojs('video-player', {
      controls: true,
      autoplay: false,
      preload: 'auto',
      fluid: true,
      playbackRates: [0.5, 1, 1.25, 1.5, 2],
    });

    player.on('loadedmetadata', syncCompatibilityDurationUi);
    player.on('loadedmetadata', applyResumeIfReady);
    player.on('durationchange', syncCompatibilityDurationUi);
    player.on('durationchange', applyResumeIfReady);
    player.on('timeupdate', syncCompatibilityDurationUi);
    player.on('timeupdate', () => {
      savePlaybackProgress();
      applyResumeIfReady();
    });
    player.on('loadeddata', syncCompatibilityDurationUi);
    player.on('loadeddata', applyResumeIfReady);
    player.on('seeked', () => {
      updateStitchedProgress();
      updateCurrentClipWatermark();
      savePlaybackProgress({ force: true });
    });
    player.on('pause', () => {
      updateStitchedProgress();
      updateCurrentClipWatermark();
      savePlaybackProgress({ force: true });
    });
    player.on('play', () => {
      updateStitchedProgress();
      updateCurrentClipWatermark();
      applyResumeIfReady();
      updateAdminDiagnostics();
    });
    player.on('ended', () => {
      savePlaybackProgress({ force: true, markCompleted: true });
      updateAdminDiagnostics();
    });
    player.on('waiting', () => {
      runtimeStats.waitingCount += 1;
      updateAdminDiagnostics();
    });
    player.on('stalled', () => {
      runtimeStats.stalledCount += 1;
      updateAdminDiagnostics();
    });
    player.on('loadedmetadata', updateAdminDiagnostics);
    player.on('durationchange', updateAdminDiagnostics);
    player.on('timeupdate', updateAdminDiagnostics);
    player.on('ratechange', updateAdminDiagnostics);
    player.on('volumechange', updateAdminDiagnostics);
    player.on('seeking', updateAdminDiagnostics);
    player.on('seeked', updateAdminDiagnostics);
    player.on('pause', updateAdminDiagnostics);

    player.on('error', () => {
      runtimeStats.errorCount += 1;
      const error = player.error?.();
      const errorText = error?.message || (error?.code ? `code ${error.code}` : '');
      runtimeStats.lastError = errorText ? String(errorText) : 'unknown playback error';
      updateAdminDiagnostics();

      if (!transcodeFallbackTried && compatibilityTransport === 'hls') {
        transcodeFallbackTried = true;
        forcedCompatibilityTransport = 'transcode';
        const warning = document.getElementById('playback-warning');
        if (warning) {
          warning.textContent = 'HLS playback failed. Trying MP4 compatibility mode...';
          warning.style.display = 'block';
        }
        setVideoSource(media, true);
        player.play().catch(() => {});
        return;
      }

      if (!transcodeFallbackTried && compatibilityTransport !== 'transcode') {
        transcodeFallbackTried = true;
        const warning = document.getElementById('playback-warning');
        if (warning) {
          warning.textContent = 'Direct playback failed. Trying compatibility mode...';
          warning.style.display = 'block';
        }
        setVideoSource(media, true);
        player.play().catch(() => {});
        return;
      }

      const warning = document.getElementById('playback-warning');
      if (warning) {
        warning.innerHTML = 'This file could not be played in your browser. You can try downloading it and playing locally.';
        warning.style.display = 'block';
      }
    });

    applyPreferredPlaybackMode(media);
  }

  function setVideoSource(media, useTranscode) {
    if (!player) return;
    clearHlsStartupRetry();
    clearHlsStartupFallback();
    clearTranscodeStartupFallback();
    clearConcatDurationFallback();
    compatibilityMode = useTranscode;
    compatibilityTransport = getEffectivePlaybackTransport(media, useTranscode);
    stitchedTranscodeTimeOrigin = null;
    const compatibilityBadge = document.getElementById('compatibility-badge');
    if (compatibilityBadge) compatibilityBadge.style.display = useTranscode ? 'block' : 'none';
    if (useTranscode) {
      if (compatibilityTransport === 'hls') {
        hlsStartupRetryCount = 0;
        const warning = document.getElementById('playback-warning');
        if (warning) warning.style.display = 'none';
        player.src({ src: buildHlsUrl(media), type: 'application/x-mpegURL' });
        scheduleHlsStartupRetry(media);
        scheduleHlsStartupFallback(media);
        updateStitchedProgress();
        updateCurrentClipWatermark();
        return;
      }

      const startSeconds = (stitchedPlayback && compatibilityMode && compatibilityTransport === 'transcode') ? stitchedSeekOffset : 0;
      player.src({ src: buildTranscodeUrl(media, startSeconds), type: 'video/mp4' });
      const transcodeGen = ++transcodeSourceGeneration;
      player.one('loadeddata', () => {
        if (transcodeSourceGeneration !== transcodeGen) return;
        const t = Number(player.currentTime());
        stitchedTranscodeTimeOrigin = Number.isFinite(t) && t >= 0 ? t : 0;
        syncCompatibilityDurationUi();
      });
      scheduleTranscodeStartupFallback(media);
      syncCompatibilityDurationUi();
      return;
    }
    const warning = document.getElementById('playback-warning');
    if (warning) warning.style.display = 'none';
    if (media.is_virtual) {
      // Use the low-CPU concat stream (ffmpeg copy, no re-encode).
      // On error the existing fallback handler will retry with full transcode.
      player.src({ src: buildConcatUrl(media), type: 'video/mp4' });
      scheduleConcatDurationFallback(media);
    } else {
      player.src({ src: `/stream/${media.id}`, type: getMime(media) });
    }
    updateStitchedProgress();
    updateCurrentClipWatermark();
  }

  function shouldPreferTranscode(media) {
    // Virtual/stitched media uses the low-CPU concat stream by default.
    // Incompatible codecs will trigger the error → transcode fallback automatically.
    if (media.is_virtual) return preferStitchedCompatibility;
    const ext = (media.file_name || '').split('.').pop().toLowerCase();
    if (['mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', '3gp'].includes(ext)) return true;
    return !canPlayDirectly(media);
  }

  function getAudioCodec(media) {
    const streams = Array.isArray(media.raw_metadata?.streams) ? media.raw_metadata.streams : [];
    const audioStream = streams.find(stream => stream.codec_type === 'audio');
    return (audioStream?.codec_name || '').toLowerCase();
  }

  function canPlayDirectly(media) {
    const ext = (media.file_name || '').split('.').pop().toLowerCase();
    const videoCodec = (media.codec || '').toLowerCase();
    const audioCodec = getAudioCodec(media);

    if (ext === 'webm') return true;
    if (['mp4', 'm4v'].includes(ext)) return true;

    if (ext === 'mov') {
      const videoOk = ['h264', 'avc1'].includes(videoCodec);
      const audioOk = !audioCodec || ['aac', 'mp3'].includes(audioCodec);
      return videoOk && audioOk;
    }

    return false;
  }

  function getMime(media) {
    const ext = (media.file_name || '').split('.').pop().toLowerCase();
    if (ext === 'webm') return 'video/webm';
    if (['mp4', 'm4v'].includes(ext)) return 'video/mp4';
    if (ext === 'mov' && canPlayDirectly(media)) return 'video/quicktime';
    if (ext === 'mov') return 'video/quicktime';
    return 'video/mp4';
  }

  function initPhoto(media) {
    document.getElementById('player-container').style.display = 'none';
    const warningEl = document.getElementById('playback-warning');
    if (warningEl) warningEl.style.display = 'none';
    const compatibilityBadge = document.getElementById('compatibility-badge');
    if (compatibilityBadge) compatibilityBadge.style.display = 'none';
    stitchedPlayback = false;
    stitchedSeekOffset = 0;
    stitchedSegmentTimeline = [];
    clearConcatDurationFallback();
    updateStitchedProgress();
    updateCurrentClipWatermark();
    syncAdminDiagnosticsVisibility(media);
    const photoContainer = document.getElementById('photo-container');
    photoContainer.style.display = '';
    const img = document.getElementById('photo-img');
    img.src = `/photo/${media.id}?width=1200`;
    img.alt = escHtml(media.friendly_name || media.file_name);
  }

  function getStitchedSegments(media) {
    const directSegments = Array.isArray(media.segments) ? media.segments : [];
    if (directSegments.length) return directSegments;
    const metadataSegments = Array.isArray(media.raw_metadata?.segments) ? media.raw_metadata.segments : [];
    return metadataSegments;
  }

  function renderStitchedSeekTicks(media) {
    const { ticks } = getStitchedProgressElements();
    if (!ticks) return;

    const segments = media?.is_virtual ? getStitchedSegments(media) : [];
    const totalDuration = Number(media?.duration) || 0;
    if (segments.length <= 1 || totalDuration <= 0) {
      ticks.innerHTML = '';
      return;
    }

    let elapsed = 0;
    const marks = [];
    for (let i = 0; i < segments.length - 1; i += 1) {
      elapsed += Math.max(0, Number(segments[i]?.duration) || 0);
      if (elapsed <= 0 || elapsed >= totalDuration) continue;
      const left = (elapsed / totalDuration) * 100;
      marks.push(`<span class="stitched-seek-tick" style="left:${left.toFixed(4)}%"></span>`);
    }

    ticks.innerHTML = marks.join('');
  }

  function buildStitchedSegmentTimeline(segments) {
    const timeline = [];
    let startSeconds = 0;

    segments.forEach((segment, index) => {
      const durationSeconds = Math.max(0, Number(segment?.duration) || 0);
      const label = segment.friendly_name || segment.file_name || segment.file_path || `Clip ${index + 1}`;
      timeline.push({
        index,
        start: startSeconds,
        end: startSeconds + durationSeconds,
        label
      });
      startSeconds += durationSeconds;
    });

    return timeline;
  }

  function getCurrentStitchedSegment(seconds) {
    if (!stitchedSegmentTimeline.length) return null;

    const t = Math.max(0, Number(seconds) || 0);
    for (let i = 0; i < stitchedSegmentTimeline.length; i += 1) {
      const segment = stitchedSegmentTimeline[i];
      const isLast = i === stitchedSegmentTimeline.length - 1;
      if (t < segment.end || isLast) {
        return segment;
      }
    }

    return stitchedSegmentTimeline[stitchedSegmentTimeline.length - 1] || null;
  }

  function updateCurrentClipWatermark() {
    const { overlay } = getStitchedClipWatermarkElements();
    if (!overlay) return;

    const shouldShow =
      clipWatermarkEnabled &&
      stitchedPlayback &&
      currentMedia?.type === 'video' &&
      stitchedSegmentTimeline.length > 0;

    if (!shouldShow) {
      overlay.style.display = 'none';
      overlay.textContent = '';
      return;
    }

    const segment = getCurrentStitchedSegment(getTimelineCurrentTime());
    if (!segment) {
      overlay.style.display = 'none';
      overlay.textContent = '';
      return;
    }

    overlay.textContent =
      clipWatermarkMode === 'number'
        ? `Clip ${segment.index + 1}`
        : `Clip ${segment.index + 1}: ${segment.label}`;
    overlay.style.display = 'block';
  }

  function renderClipWatermarkControl(showControl) {
    const { control, toggle, mode } = getStitchedClipWatermarkElements();
    if (!control || !toggle) return;

    control.style.display = showControl ? 'block' : 'none';
    toggle.checked = !!clipWatermarkEnabled;
    if (mode) mode.value = clipWatermarkMode;
  }

  function renderStitchedSegments(media) {
    const container = document.getElementById('stitched-segments');
    const toggle = document.getElementById('stitched-segments-toggle');
    const count = document.getElementById('stitched-segments-count');
    const list = document.getElementById('stitched-segments-list');
    if (!container || !toggle || !count || !list) return;

    const segments = media.is_virtual ? getStitchedSegments(media) : [];
    if (!segments.length) {
      container.style.display = 'none';
      stitchedSegmentTimeline = [];
      renderClipWatermarkControl(false);
      count.textContent = '';
      list.innerHTML = '';
      list.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      renderStitchedSeekTicks(null);
      updateCurrentClipWatermark();
      return;
    }

    container.style.display = 'block';
    stitchedSegmentTimeline = buildStitchedSegmentTimeline(segments);
    renderClipWatermarkControl(true);
    renderStitchedSeekTicks(media);
    count.textContent = `(${segments.length})`;
    list.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    let segmentOffset = 0;
    list.innerHTML = segments.map((segment, index) => {
      const label = segment.friendly_name || segment.file_name || segment.file_path || `Clip ${index + 1}`;
      const durationSeconds = Number(segment.duration) || 0;
      const duration = fmtDur(durationSeconds);
      const startLabel = fmtDur(segmentOffset);
      const item = `<li class="stitched-segment-item">
        <button class="stitched-segment-jump" type="button" data-segment-offset="${segmentOffset}">
          <span class="stitched-segment-index">${index + 1}.</span>
          <span class="stitched-segment-name" title="${escHtml(label)}">${escHtml(label)}</span>
          <span class="stitched-segment-start">${startLabel}</span>
          <span class="stitched-segment-duration">${duration}</span>
        </button>
      </li>`;
      segmentOffset += durationSeconds;
      return item;
    }).join('');

    updateCurrentClipWatermark();
  }

  function renderMeta(media) {
    document.title = `${media.friendly_name || media.file_name} – OurTube`;
    document.getElementById('media-title').textContent =
      media.friendly_name || media.file_name;

    const stitchedBadge = document.getElementById('stitched-badge');
    if (stitchedBadge) stitchedBadge.style.display = media.is_virtual ? 'inline-flex' : 'none';
    const downloadableBadge = document.getElementById('watch-downloadable-badge');
    if (downloadableBadge) downloadableBadge.style.display = isDownloadable(media) ? 'inline-flex' : 'none';
    const visibilityBadge = document.getElementById('watch-visibility-badge');
    const mediaIsAdminOnly = media.visibility === 'admin' || media.source_visibility === 'admin';
    if (visibilityBadge) visibilityBadge.style.display = adminModeEnabled && mediaIsAdminOnly ? 'inline-flex' : 'none';
    const editLink = document.getElementById('watch-admin-edit');
    if (editLink) {
      editLink.href = `/admin/?tab=library&edit=${encodeURIComponent(media.id)}`;
      editLink.style.display = adminModeEnabled ? 'inline-flex' : 'none';
    }

    const metaEl = document.getElementById('media-meta');
    const parts = [];
    if (media.duration) parts.push(`<span>⏱ ${fmtDur(media.duration)}</span>`);
    if (media.segment_count && media.segment_count > 1) parts.push(`<span>🎞 ${media.segment_count} stitched clips</span>`);
    if (media.year) parts.push(`<span>📅 ${media.year}</span>`);
    if (media.location) parts.push(`<span>📍 ${escHtml(media.location)}</span>`);
    if (media.width && media.height) parts.push(`<span>🖥 ${media.width}×${media.height}</span>`);
    if (media.size) parts.push(`<span>💾 ${fmtSize(media.size)}</span>`);
    if (media.created_at) parts.push(`<span>🗓 ${fmtDate(media.created_at)}</span>`);
    if (media.view_count) parts.push(`<span>👁 ${media.view_count} view${media.view_count !== 1 ? 's' : ''}</span>`);
    metaEl.innerHTML = parts.join('');

    const descEl = document.getElementById('media-desc');
    descEl.textContent = media.description || '';

    renderStitchedSegments(media);

    const tagsEl = document.getElementById('tags-container');
    const tags = Array.isArray(media.tags) ? media.tags : [];
    tagsEl.innerHTML = tags.map(t => `<span class="tag-pill">${escHtml(t)}</span>`).join('');

    const facesEl = document.getElementById('faces-container');
    const namedFaces = (media.faces || []).filter(f => f.person_name);
    if (namedFaces.length) {
      facesEl.innerHTML = `
        <div class="faces-title">👤 People</div>
        <div class="face-list">${namedFaces.map(f =>
          `<span class="face-chip">${escHtml(f.person_name)}${f.confidence ? ` (${(f.confidence * 100).toFixed(0)}%)` : ''}</span>`
        ).join('')}</div>`;
    }

    renderAdminPlaybackModeControl(media);
    bindShareVideoButton();
  }

  function getAvailablePlaybackModes(media) {
    if (!media || media.type !== 'video') return ['auto'];
    const modes = ['auto', 'direct', 'transcode', 'hls'];
    return modes;
  }

  function renderAdminPlaybackModeControl(media) {
    const wrap = document.getElementById('admin-playback-mode-control');
    const select = document.getElementById('admin-playback-mode-select');
    if (!wrap || !select) return;

    if (!adminModeEnabled || !media || media.type !== 'video') {
      wrap.style.display = 'none';
      return;
    }

    const allowedModes = getAvailablePlaybackModes(media);
    Array.from(select.options).forEach(option => {
      option.hidden = !allowedModes.includes(option.value);
    });

    if (!allowedModes.includes(adminPlaybackModePreference)) {
      adminPlaybackModePreference = 'auto';
    }
    select.value = adminPlaybackModePreference;
    wrap.style.display = 'inline-flex';
  }

  function updateAdminDiagnostics() {
    const diagnostics = document.getElementById('admin-player-diagnostics');
    const diagnosticsBody = document.getElementById('admin-player-diagnostics-body');
    if (!diagnostics || !diagnosticsBody) return;

    if (!adminModeEnabled || !currentMedia || currentMedia.type !== 'video' || !player) {
      diagnostics.style.display = 'none';
      return;
    }

    diagnostics.style.display = 'block';

    const formatInfo = currentMedia.raw_metadata?.format || {};
    const videoStream = Array.isArray(currentMedia.raw_metadata?.streams)
      ? currentMedia.raw_metadata.streams.find(stream => stream.codec_type === 'video')
      : null;
    const audioStream = Array.isArray(currentMedia.raw_metadata?.streams)
      ? currentMedia.raw_metadata.streams.find(stream => stream.codec_type === 'audio')
      : null;
    const frameRate = parseFrameRate(videoStream?.avg_frame_rate || videoStream?.r_frame_rate);
    const frameStats = getVideoFrameStats();
    const droppedFrames = frameStats.dropped != null && frameStats.total != null
      ? `${frameStats.dropped}/${frameStats.total}`
      : 'n/a';
    const source = player.currentSource?.() || {};
    const timelineCurrent = Math.max(0, Number(getTimelineCurrentTime()) || 0);
    const duration = Math.max(0, Number(expectedDuration || player.duration()) || 0);
    const bufferAhead = getCurrentBufferAheadSeconds();
    const selectedMode = adminPlaybackModePreference;
    const activeMode = compatibilityMode
      ? `compat:${compatibilityTransport}`
      : (stitchedPlayback ? 'direct:concat' : 'direct:file');
    const bitrate = Number(formatInfo.bit_rate || videoStream?.bit_rate || 0);

    const lines = [
      `Mode selected: ${selectedMode} | active: ${activeMode}`,
      `Media: ${currentMedia.id} | type: ${currentMedia.type}${currentMedia.is_virtual ? ` | segments: ${currentMedia.segment_count || 0}` : ''}`,
      `Video: ${getVideoCodec(currentMedia) || 'unknown'}${frameRate ? ` @ ${frameRate} fps` : ''} | Audio: ${(audioStream?.codec_name || 'unknown').toLowerCase()}`,
      `Container: ${(currentMedia.format || formatInfo.format_name || 'unknown')} | Resolution: ${currentMedia.width || '?'}x${currentMedia.height || '?'}`,
      `Bitrate: ${bitrate > 0 ? `${Math.round(bitrate / 1000)} kbps` : 'n/a'} | Duration: ${fmtDur(duration)} | Pos: ${fmtDur(timelineCurrent)}`,
      `Buffer ahead: ${bufferAhead.toFixed(2)}s | Rate: ${(Number(player.playbackRate()) || 1).toFixed(2)}x | Volume: ${Math.round((Number(player.volume()) || 0) * 100)}%`,
      `ReadyState: ${Number(player.readyState?.() || 0)} | NetworkState: ${Number(player.networkState?.() || 0)} | Paused: ${player.paused() ? 'yes' : 'no'}`,
      `Frames dropped/total: ${droppedFrames} | waiting: ${runtimeStats.waitingCount} | stalled: ${runtimeStats.stalledCount} | errors: ${runtimeStats.errorCount}`,
      `Source: ${source.type || 'n/a'} ${source.src || ''}`,
      runtimeStats.lastError ? `Last error: ${runtimeStats.lastError}` : 'Last error: none'
    ];

    diagnosticsBody.textContent = lines.join('\n');
  }

  function startAdminDiagnosticsLoop() {
    if (diagnosticsInterval) return;
    diagnosticsInterval = setInterval(updateAdminDiagnostics, ADMIN_DIAGNOSTICS_REFRESH_MS);
  }

  function stopAdminDiagnosticsLoop() {
    if (!diagnosticsInterval) return;
    clearInterval(diagnosticsInterval);
    diagnosticsInterval = null;
  }

  function syncAdminDiagnosticsVisibility(media = currentMedia) {
    renderAdminPlaybackModeControl(media);
    if (adminModeEnabled && media && media.type === 'video' && player) {
      startAdminDiagnosticsLoop();
      updateAdminDiagnostics();
      return;
    }
    stopAdminDiagnosticsLoop();
    updateAdminDiagnostics();
  }

  function bindAdminPlaybackModeControl() {
    const select = document.getElementById('admin-playback-mode-select');
    if (!select || select.dataset.bound === '1') return;

    select.addEventListener('change', () => {
      adminPlaybackModePreference = select.value || 'auto';
      if (currentMedia && currentMedia.type === 'video' && player) {
        applyPreferredPlaybackMode(currentMedia, { preservePosition: true });
      } else {
        syncAdminDiagnosticsVisibility(currentMedia);
      }
    });

    select.dataset.bound = '1';
  }

  function updateHeaderBookmarksDropdown(items, media) {
    const nav = document.getElementById('header-bookmarks-nav');
    const select = document.getElementById('header-bookmarks-select');
    if (!nav || !select) return;

    if (!items || !items.length) {
      nav.style.display = 'none';
      return;
    }

    nav.style.display = '';

    // Reset to placeholder only
    while (select.options.length > 1) select.remove(1);

    items.forEach(item => {
      const time = Math.max(0, Number(item.time_seconds) || 0);

      // For stitched videos, label with segment (clip) name
      let clipName = '';
      if (stitchedSegmentTimeline.length) {
        const seg = getCurrentStitchedSegment(time);
        if (seg) clipName = seg.label;
      }
      if (!clipName && media) {
        clipName = media.friendly_name || media.file_name || '';
      }

      const bookmarkLabel = item.title || fmtDur(time);
      const label = clipName ? `${clipName} \u2013 ${bookmarkLabel}` : bookmarkLabel;

      const opt = document.createElement('option');
      opt.value = String(item.id);
      opt.textContent = label;
      opt.dataset.timeSeconds = String(time);
      select.appendChild(opt);
    });

    if (select.dataset.bound !== '1') {
      select.addEventListener('change', () => {
        const opt = select.options[select.selectedIndex];
        if (!opt || !opt.value) return;
        const seconds = Number(opt.dataset.timeSeconds);
        if (Number.isFinite(seconds)) seekToVideoTime(seconds);
        // Reset to placeholder after navigation
        select.value = '';
      });
      select.dataset.bound = '1';
    }
  }

  function renderBookmarks(items = []) {
    const section = document.getElementById('bookmarks-section');
    const list = document.getElementById('bookmarks-list');
    if (!section || !list) return;

    if (!currentMedia || currentMedia.type !== 'video') {
      section.style.display = 'none';
      return;
    }

    section.style.display = '';
    if (!items.length) {
      list.innerHTML = '<p class="watch-social-empty">No bookmarks yet.</p>';
      return;
    }

    list.innerHTML = items.map(item => {
      const timeLabel = fmtDur(Math.max(0, Number(item.time_seconds) || 0));
      const title = item.title ? `<div class="watch-social-item-title">${escHtml(item.title)}</div>` : '';
      const annotation = item.annotation ? `<div class="watch-social-item-body">${escHtml(item.annotation)}</div>` : '';
      const tags = Array.isArray(item.tags) && item.tags.length
        ? `<div class="watch-social-tags">${item.tags.map(tag => `<span class="tag-pill">${escHtml(tag)}</span>`).join('')}</div>`
        : '';

      return `
        <article class="watch-social-item">
          <div class="watch-social-item-top">
            <button class="btn btn-secondary btn-small" type="button" data-bookmark-jump="${item.time_seconds}">⏯ ${timeLabel}</button>
            <div class="watch-social-item-actions">
              <button class="btn btn-secondary btn-small" type="button" data-bookmark-share="${item.id}">🔗 Share</button>
            </div>
          </div>
          ${title}
          ${annotation}
          ${tags}
        </article>`;
    }).join('');
  }

  async function loadBookmarks(media) {
    const section = document.getElementById('bookmarks-section');
    const list = document.getElementById('bookmarks-list');
    if (!section || !list) return [];

    if (!media || media.type !== 'video') {
      section.style.display = 'none';
      return [];
    }

    section.style.display = '';
    try {
      const res = await fetch(`/api/media/${encodeURIComponent(media.id)}/bookmarks`);
      if (!res.ok) throw new Error('Failed to load bookmarks');
      const data = await res.json();
      const items = Array.isArray(data.items) ? data.items : [];
      renderBookmarks(items);
      updateHeaderBookmarksDropdown(items, media);

      if (Number.isInteger(bookmarkQueryId) && bookmarkQueryId > 0) {
        const selected = items.find(item => Number(item.id) === bookmarkQueryId);
        if (selected) {
          seekToVideoTime(selected.time_seconds, { autoplay: false });
          showWatchActionMessage(`Navigated to bookmark at ${fmtDur(Math.max(0, Number(selected.time_seconds) || 0))}`);
        }
      }

      return items;
    } catch {
      list.innerHTML = '<p class="watch-social-empty">Unable to load bookmarks.</p>';
      return [];
    }
  }

  function bindBookmarkActions() {
    const list = document.getElementById('bookmarks-list');
    if (!list) return;

    if (list.dataset.bound !== '1') {
      list.addEventListener('click', async event => {
        const jumpTarget = event.target.closest('[data-bookmark-jump]');
        if (jumpTarget) {
          const seconds = Number(jumpTarget.getAttribute('data-bookmark-jump'));
          if (Number.isFinite(seconds)) seekToVideoTime(seconds);
          return;
        }

        const shareTarget = event.target.closest('[data-bookmark-share]');
        if (shareTarget) {
          const bookmarkId = Number.parseInt(shareTarget.getAttribute('data-bookmark-share') || '', 10);
          const ok = await copyTextToClipboard(buildWatchUrl(bookmarkId));
          showWatchActionMessage(ok ? 'Bookmark link copied to clipboard' : 'Unable to copy link');
        }
      });
      list.dataset.bound = '1';
    }
  }

  function bindBookmarkDialog() {
    const closeBtn = document.getElementById('bookmark-dialog-close');
    const cancelBtn = document.getElementById('bookmark-dialog-cancel');
    const modal = document.getElementById('bookmark-modal');
    const form = document.getElementById('bookmark-dialog-form');
    const openBtns = Array.from(document.querySelectorAll('[data-open-bookmark-dialog]'));
    if (!openBtns.length || !modal || !form) return;

    openBtns.forEach(btn => {
      if (btn.dataset.bound === '1') return;
      btn.addEventListener('click', openBookmarkDialog);
      btn.dataset.bound = '1';
    });

    if (closeBtn && closeBtn.dataset.bound !== '1') {
      closeBtn.addEventListener('click', closeBookmarkDialog);
      closeBtn.dataset.bound = '1';
    }

    if (cancelBtn && cancelBtn.dataset.bound !== '1') {
      cancelBtn.addEventListener('click', closeBookmarkDialog);
      cancelBtn.dataset.bound = '1';
    }

    if (modal.dataset.bound !== '1') {
      modal.addEventListener('click', event => {
        if (event.target === modal) closeBookmarkDialog();
      });
      modal.dataset.bound = '1';
    }

    if (form.dataset.bound === '1') return;
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!currentMedia || currentMedia.type !== 'video') return;

      const formData = new FormData(form);
      const title = String(formData.get('title') || '').trim();
      const annotation = String(formData.get('annotation') || '').trim();
      const tags = String(formData.get('tags') || '')
        .split(',')
        .map(tag => tag.trim())
        .filter(Boolean);

      const timeSeconds = Math.max(
        0,
        Number.isFinite(Number(pendingBookmarkTimeSeconds))
          ? Number(pendingBookmarkTimeSeconds)
          : Number(getTimelineCurrentTime()) || 0
      );
      const res = await fetch(`/api/media/${encodeURIComponent(currentMedia.id)}/bookmarks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          time_seconds: timeSeconds,
          title,
          annotation,
          tags,
        }),
      });

      if (!res.ok) {
        showWatchActionMessage('Failed to save bookmark');
        return;
      }

      form.reset();
      closeBookmarkDialog();
      showWatchActionMessage('Bookmark saved');
      await loadBookmarks(currentMedia);
    });
    form.dataset.bound = '1';
  }

  function renderComments(items = []) {
    const section = document.getElementById('comments-section');
    const list = document.getElementById('comments-list');
    if (!section || !list) return;

    if (!currentMedia || currentMedia.type !== 'video') {
      section.style.display = 'none';
      return;
    }

    section.style.display = '';
    if (!items.length) {
      list.innerHTML = '<p class="watch-social-empty">No comments yet.</p>';
      return;
    }

    list.innerHTML = items.map(item => `
      <article class="watch-social-item">
        <div class="watch-social-item-meta">
          <strong>${escHtml(item.author_name || 'Anonymous')}</strong>
          <span>${fmtDate(item.created_at)}</span>
        </div>
        <div class="watch-social-item-body">${escHtml(item.comment_text || '')}</div>
      </article>
    `).join('');
  }

  async function loadComments(media) {
    const section = document.getElementById('comments-section');
    const list = document.getElementById('comments-list');
    if (!section || !list) return;

    if (!media || media.type !== 'video') {
      section.style.display = 'none';
      return;
    }

    section.style.display = '';
    try {
      const res = await fetch(`/api/media/${encodeURIComponent(media.id)}/comments`);
      if (!res.ok) throw new Error('Failed to load comments');
      const data = await res.json();
      renderComments(Array.isArray(data.items) ? data.items : []);
    } catch {
      list.innerHTML = '<p class="watch-social-empty">Unable to load comments.</p>';
    }
  }

  function bindCommentForm() {
    const form = document.getElementById('comment-form');
    if (!form || form.dataset.bound === '1') return;

    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!currentMedia || currentMedia.type !== 'video') return;

      const formData = new FormData(form);
      const authorName = String(formData.get('author_name') || '').trim();
      const commentText = String(formData.get('comment_text') || '').trim();
      if (!commentText) return;

      const res = await fetch(`/api/media/${encodeURIComponent(currentMedia.id)}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          author_name: authorName,
          comment_text: commentText,
        }),
      });
      if (!res.ok) {
        showWatchActionMessage('Failed to post comment');
        return;
      }

      form.reset();
      showWatchActionMessage('Comment posted');
      await loadComments(currentMedia);
    });

    form.dataset.bound = '1';
  }

  async function loadRelated(media) {
    const grid = document.getElementById('related-grid');
    if (!grid) return;
    grid.innerHTML = '';

    if (grid.dataset.shareBound !== '1') {
      grid.addEventListener('click', async event => {
        const shareItem = event.target.closest('[data-related-share-id]');
        if (shareItem) {
          event.preventDefault();
          event.stopPropagation();
          const targetId = String(shareItem.getAttribute('data-related-share-id') || '').trim();
          if (!targetId) return;
          const ok = await copyTextToClipboard(buildWatchUrl(null, targetId));
          showWatchActionMessage(ok ? 'Video link copied to clipboard' : 'Unable to copy link');
          return;
        }

        const downloadItem = event.target.closest('[data-related-download-id]');
        if (downloadItem) {
          event.preventDefault();
          event.stopPropagation();
          const targetId = String(downloadItem.getAttribute('data-related-download-id') || '').trim();
          if (!targetId) return;
          const relatedMedia = {
            id: targetId,
            is_virtual: downloadItem.getAttribute('data-related-virtual') === '1' ? 1 : 0,
            downloadable: downloadItem.getAttribute('data-related-downloadable') === '1' ? 1 : 0,
            size: Number(downloadItem.getAttribute('data-related-size') || 0) || 0,
            friendly_name: downloadItem.getAttribute('data-related-name') || '',
            file_name: downloadItem.getAttribute('data-related-file-name') || '',
          };
          await startMediaDownload(relatedMedia, targetId);
          return;
        }

        const linkCard = event.target.closest('.related-card[data-related-href]');
        if (linkCard) {
          window.location.href = linkCard.dataset.relatedHref || linkCard.getAttribute('data-related-href') || '';
          return;
        }
      });
      grid.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const linkCard = event.target.closest('.related-card[data-related-href]');
        if (!linkCard) return;
        event.preventDefault();
        window.location.href = linkCard.dataset.relatedHref || linkCard.getAttribute('data-related-href') || '';
      });
      grid.dataset.shareBound = '1';
    }

    try {
      const params = new URLSearchParams({ limit: 12, sort: 'indexed_at', order: 'DESC', type: media.type });
      const res = await fetch('/api/media?' + params.toString());
      const data = await res.json();

      const others = data.items.filter(m => m.id !== mediaId).slice(0, 8);
      others.forEach(item => {
        const cardHref = `/watch.html?id=${item.id}`;
        const card = document.createElement('div');
        card.className = 'related-card';
        card.dataset.relatedHref = cardHref;
        card.tabIndex = 0;
        card.setAttribute('role', 'link');
        const thumb = `/thumbnail/${item.thumbnail_media_id || item.id}`;
        card.innerHTML = `
          <div class="related-thumb-wrap">
             <img class="related-thumb" src="${thumb}" alt="${escHtml(item.friendly_name || item.file_name)}"
                  loading="lazy" onerror="this.src='/img/no-thumb.svg'" />
             ${item.duration ? `<span class="related-duration">${fmtDur(item.duration)}</span>` : ''}
             ${item.is_virtual ? '<span class="related-badge">Stitched</span>' : ''}
            ${isDownloadable(item) ? '<span class="related-badge related-badge-downloadable">Downloadable</span>' : ''}
            ${adminModeEnabled && (item.visibility === 'admin' || item.source_visibility === 'admin') ? '<span class="related-badge related-badge-admin-only">Admin Only</span>' : ''}
           </div>
           <div class="related-info">
             <button class="related-share-btn" type="button" data-related-share-id="${escHtml(item.id)}" aria-label="Share video link">🔗</button>
             ${isDownloadable(item) ? `<button class="related-download-btn" type="button" data-related-download-id="${escHtml(item.id)}" data-related-virtual="${item.is_virtual ? '1' : '0'}" data-related-downloadable="${isDownloadable(item) ? '1' : '0'}" data-related-size="${escHtml(String(Number(item.size) || 0))}" data-related-name="${escHtml(item.friendly_name || '')}" data-related-file-name="${escHtml(item.file_name || '')}" aria-label="Download video">⬇</button>` : ''}
             <div class="related-title">${escHtml(item.friendly_name || item.file_name)}</div>
            <div class="related-meta">${item.year || ''} ${item.location ? '· ' + escHtml(item.location) : ''}</div>
          </div>`;
        grid.appendChild(card);
      });
    } catch (err) {
      console.error('[watch] Failed to load related:', err);
    }
  }

  // ── Blocked-client detection ──────────────────────────────────────────────────

  let blockedPollTimer = null;
  let blockedCountdownTimer = null;

  function fmtCountdown(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  function showBlockedOverlay(reason, unblockAt) {
    const overlay = document.getElementById('blocked-overlay');
    if (!overlay) return;

    // Hide the normal watch content
    const playerContainer = document.getElementById('player-container');
    const photoContainer = document.getElementById('photo-container');
    if (playerContainer) playerContainer.style.display = 'none';
    if (photoContainer) photoContainer.style.display = 'none';

    // Stop any active player
    if (player) {
      try { player.pause(); } catch (err) { console.warn('[watch] Could not pause player:', err.message); }
    }

    // Fill in overlay content
    const reasonEl = document.getElementById('blocked-overlay-reason');
    const countdownSection = document.getElementById('blocked-overlay-countdown-section');
    const countdownEl = document.getElementById('blocked-overlay-countdown');
    const permanentEl = document.getElementById('blocked-overlay-permanent');

    if (reasonEl) reasonEl.textContent = reason || 'Your access has been restricted by the administrator.';

    const unblockMs = unblockAt ? Date.parse(unblockAt) : null;

    if (unblockMs && !Number.isNaN(unblockMs) && unblockMs > Date.now()) {
      if (countdownSection) countdownSection.style.display = '';
      if (permanentEl) permanentEl.style.display = 'none';

      // Clear any old timer
      if (blockedCountdownTimer) clearInterval(blockedCountdownTimer);

      function tickCountdown() {
        if (!countdownEl) return;
        const remaining = (unblockMs - Date.now()) / 1000;
        if (remaining <= 0) {
          countdownEl.textContent = '0:00';
          clearInterval(blockedCountdownTimer);
          // Access restored — reload the page
          setTimeout(() => { location.reload(); }, 1500);
          return;
        }
        countdownEl.textContent = fmtCountdown(remaining);
      }
      tickCountdown();
      blockedCountdownTimer = setInterval(tickCountdown, 1000);
    } else {
      if (countdownSection) countdownSection.style.display = 'none';
      if (permanentEl) permanentEl.style.display = '';
    }

    overlay.style.display = '';
  }

  async function checkBlockedStatus() {
    try {
      const res = await fetch('/api/blocked-status');
      if (!res.ok) return false;
      const data = await res.json();
      if (data.blocked) {
        showBlockedOverlay(data.reason, data.unblock_at);
        // Stop periodic poll - countdown timer handles the reload
        if (blockedPollTimer) { clearInterval(blockedPollTimer); blockedPollTimer = null; }
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  function startBlockedStatusPoll() {
    if (blockedPollTimer) return;
    blockedPollTimer = setInterval(checkBlockedStatus, 30_000);
  }

  async function init() {
    clipWatermarkEnabled = readClipWatermarkPreference();
    clipWatermarkMode = readClipWatermarkModePreference();
    await loadUiSettings();
    await loadAppInfoTooltip();
    bindStitchedSegmentToggle();
    bindStitchedSegmentListActions();
    bindClipWatermarkToggle();
    bindBookmarkActions();
    bindBookmarkDialog();
    bindCommentForm();
    bindAdminPlaybackModeControl();

    const adminStatus = window.OurTubeAdminMode?.status?.();
    adminModeEnabled = !!adminStatus?.authenticated;

    window.addEventListener('ourtube-admin-mode-changed', event => {
      adminModeEnabled = !!event.detail?.authenticated;
      if (currentMedia) {
        renderMeta(currentMedia);
        const grid = document.getElementById('related-grid');
        if (grid) grid.innerHTML = '';
        loadRelated(currentMedia);
      }
      syncAdminDiagnosticsVisibility(currentMedia);
    });

    // Check blocked status before attempting to load/play media
    const isBlocked = await checkBlockedStatus();
    if (isBlocked) return;

    // Start periodic polling so a mid-session jail shows the overlay promptly
    startBlockedStatusPoll();

    try {
      const res = await fetch(`/api/media/${mediaId}`);
      if (!res.ok) throw new Error('Not found');
      const media = await res.json();
      currentMedia = media;

      renderMeta(media);

      if (media.type === 'video') {
        // When a specific bookmark is requested, jump to that marker instead of auto-resuming playback progress.
        const resumeSeconds = Number.isInteger(bookmarkQueryId) && bookmarkQueryId > 0
          ? 0
          : await loadPlaybackProgress();
        initVideo(media, resumeSeconds);
        await loadBookmarks(media);
        await loadComments(media);
      } else {
        initPhoto(media);
      }

      loadRelated(media);
    } catch (err) {
      console.error('[watch] Error loading media:', err);
      document.getElementById('media-title').textContent = 'Media not found';
    }
  }

  window.addEventListener('pagehide', () => {
    stopAdminDiagnosticsLoop();
    savePlaybackProgress({ force: true });
  });

  window.addEventListener('beforeunload', () => {
    savePlaybackProgress({ force: true });
  });

  document.addEventListener('DOMContentLoaded', init);
})();
