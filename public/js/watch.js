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

  function initVideo(media) {
    const container = document.getElementById('player-container');
    if (!container) return;
    container.style.display = '';
    document.getElementById('photo-container').style.display = 'none';

    if (player) {
      player.src({ src: `/stream/${media.id}`, type: getMime(media.file_name) });
      return;
    }

    player = videojs('video-player', {
      controls: true,
      autoplay: false,
      preload: 'auto',
      fluid: true,
      playbackRates: [0.5, 1, 1.25, 1.5, 2],
    });

    player.src({ src: `/stream/${media.id}`, type: getMime(media.file_name) });
  }

  function getMime(filename) {
    const ext = (filename || '').split('.').pop().toLowerCase();
    const map = {
      mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm',
      avi: 'video/x-msvideo', mov: 'video/quicktime', m4v: 'video/mp4',
      flv: 'video/x-flv'
    };
    return map[ext] || 'video/mp4';
  }

  function initPhoto(media) {
    document.getElementById('player-container').style.display = 'none';
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

    const metaEl = document.getElementById('media-meta');
    const parts = [];
    if (media.duration) parts.push(`<span>⏱ ${fmtDur(media.duration)}</span>`);
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

    const editLink = document.getElementById('admin-edit-link');
    if (editLink) editLink.href = `/admin/?edit=${media.id}`;
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
        const thumb = `/thumbnail/${item.id}`;
        card.innerHTML = `
          <div class="related-thumb-wrap">
            <img class="related-thumb" src="${thumb}" alt="${escHtml(item.friendly_name || item.file_name)}"
                 loading="lazy" onerror="this.src='/img/no-thumb.svg'" />
            ${item.duration ? `<span class="related-duration">${fmtDur(item.duration)}</span>` : ''}
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
