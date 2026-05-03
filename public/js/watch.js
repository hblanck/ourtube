'use strict';

(function () {
  const params = new URLSearchParams(location.search);
  const mediaId = params.get('id');

  if (!mediaId) {
    document.querySelector('.watch-main').innerHTML =
      '<p style="padding:24px;color:#888">No media ID specified. <a href="/">← Back</a></p>';
    return;
  }

  let player = null;
  let transcodeFallbackTried = false;
  let compatibilityMode = false;
  let expectedDuration = 0;
  let stitchedPlayback = false;
  let isSeekingStitched = false;

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

  function fmtDate(str) {
    if (!str) return '';
    try { return new Date(str).toLocaleDateString(); } catch { return str; }
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
      current: document.getElementById('stitched-current'),
      total: document.getElementById('stitched-total')
    };
  }

  function updateStitchedProgress() {
    const { container, seek, current, total } = getStitchedProgressElements();
    if (!container || !seek || !current || !total) return;

    const shouldShow = stitchedPlayback && compatibilityMode && expectedDuration > 0;
    container.style.display = shouldShow ? 'flex' : 'none';

    const playerRoot = player?.el();
    if (playerRoot) {
      playerRoot.classList.toggle('stitched-progress-mode', shouldShow);
    }

    if (!shouldShow || !player) return;

    const currentTime = Math.max(0, Math.min(player.currentTime() || 0, expectedDuration));
    seek.max = String(expectedDuration);
    if (!isSeekingStitched) seek.value = String(currentTime);
    current.textContent = fmtDur(currentTime);
    total.textContent = fmtDur(expectedDuration);
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
      if (player && Number.isFinite(parseFloat(seek.value))) {
        player.currentTime(parseFloat(seek.value));
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

  function syncCompatibilityDurationUi() {
    if (!player || !compatibilityMode || !expectedDuration) return;

    try {
      if (!Number.isFinite(player.duration()) || Math.abs(player.duration() - expectedDuration) > 1) {
        player.duration(expectedDuration);
      }
    } catch { /* ignore */ }

    const current = Math.min(player.currentTime() || 0, expectedDuration);
    const root = player.el();
    if (!root) return;

    setTimeControlDisplay(root.querySelector('.vjs-current-time-display'), fmtDur(current));
    setTimeControlDisplay(root.querySelector('.vjs-duration-display'), fmtDur(expectedDuration));
    setTimeControlDisplay(root.querySelector('.vjs-remaining-time-display'), `-${fmtDur(Math.max(expectedDuration - current, 0))}`);
    updateStitchedProgress();
  }

  function initVideo(media) {
    const container = document.getElementById('player-container');
    if (!container) return;
    container.style.display = '';
    document.getElementById('photo-container').style.display = 'none';

    const warningEl = document.getElementById('playback-warning');
    if (warningEl) warningEl.style.display = 'none';
    const compatibilityBadge = document.getElementById('compatibility-badge');
    if (compatibilityBadge) compatibilityBadge.style.display = 'none';
    transcodeFallbackTried = false;
    expectedDuration = media.duration || 0;
    stitchedPlayback = !!media.is_virtual;
    bindStitchedProgressEvents();
    updateStitchedProgress();

    if (player) {
      setVideoSource(media, shouldPreferTranscode(media));
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
    player.on('durationchange', syncCompatibilityDurationUi);
    player.on('timeupdate', syncCompatibilityDurationUi);
    player.on('loadeddata', syncCompatibilityDurationUi);
    player.on('seeked', updateStitchedProgress);
    player.on('pause', updateStitchedProgress);
    player.on('play', updateStitchedProgress);

    player.on('error', () => {
      if (!transcodeFallbackTried) {
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

    setVideoSource(media, shouldPreferTranscode(media));
  }

  function setVideoSource(media, useTranscode) {
    if (!player) return;
    compatibilityMode = useTranscode;
    const compatibilityBadge = document.getElementById('compatibility-badge');
    if (compatibilityBadge) compatibilityBadge.style.display = useTranscode ? 'block' : 'none';
    if (useTranscode) {
      player.src({ src: `/stream/${media.id}/transcode`, type: 'video/mp4' });
      syncCompatibilityDurationUi();
      return;
    }
    const warning = document.getElementById('playback-warning');
    if (warning) warning.style.display = 'none';
    player.src({ src: `/stream/${media.id}`, type: getMime(media) });
    updateStitchedProgress();
  }

  function shouldPreferTranscode(media) {
    if (media.is_virtual) return true;
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
    if (ext === 'mov' && canPlayDirectly(media)) return 'video/mp4';
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
    updateStitchedProgress();
    const photoContainer = document.getElementById('photo-container');
    photoContainer.style.display = '';
    const img = document.getElementById('photo-img');
    img.src = `/photo/${media.id}?width=1200`;
    img.alt = escHtml(media.friendly_name || media.file_name);
  }

  function renderMeta(media) {
    document.title = `${media.friendly_name || media.file_name} – OurTube`;
    document.getElementById('media-title').textContent =
      media.friendly_name || media.file_name;

    const stitchedBadge = document.getElementById('stitched-badge');
    if (stitchedBadge) stitchedBadge.style.display = media.is_virtual ? 'inline-flex' : 'none';

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

  }

  async function loadRelated(media) {
    const grid = document.getElementById('related-grid');
    if (!grid) return;

    try {
      const params = new URLSearchParams({ limit: 12, sort: 'indexed_at', order: 'DESC', type: media.type });
      const res = await fetch('/api/media?' + params.toString());
      const data = await res.json();

      const others = data.items.filter(m => m.id !== mediaId).slice(0, 8);
      others.forEach(item => {
        const card = document.createElement('a');
        card.href = `/watch.html?id=${item.id}`;
        card.className = 'related-card';
        const thumb = `/thumbnail/${item.thumbnail_media_id || item.id}`;
        card.innerHTML = `
          <div class="related-thumb-wrap">
            <img class="related-thumb" src="${thumb}" alt="${escHtml(item.friendly_name || item.file_name)}"
                 loading="lazy" onerror="this.src='/img/no-thumb.svg'" />
            ${item.duration ? `<span class="related-duration">${fmtDur(item.duration)}</span>` : ''}
            ${item.is_virtual ? '<span class="related-badge">Stitched</span>' : ''}
          </div>
          <div class="related-info">
            <div class="related-title">${escHtml(item.friendly_name || item.file_name)}</div>
            <div class="related-meta">${item.year || ''} ${item.location ? '· ' + escHtml(item.location) : ''}</div>
          </div>`;
        grid.appendChild(card);
      });
    } catch (err) {
      console.error('[watch] Failed to load related:', err);
    }
  }

  async function init() {
    try {
      const res = await fetch(`/api/media/${mediaId}`);
      if (!res.ok) throw new Error('Not found');
      const media = await res.json();

      renderMeta(media);

      if (media.type === 'video') {
        initVideo(media);
      } else {
        initPhoto(media);
      }

      loadRelated(media);
    } catch (err) {
      console.error('[watch] Error loading media:', err);
      document.getElementById('media-title').textContent = 'Media not found';
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
