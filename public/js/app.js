/* global app.js — used by index.html and photos.html */
'use strict';

(function () {
  const FORCE_TYPE = window.OURTUBE_FORCE_TYPE || null;
  const API_PAGE_LIMIT = 100;
  let loading = false;
  let adminModeEnabled = false;
  let uiSettings = { photosEnabled: true };
  let currentFilters = { type: FORCE_TYPE || '', year: '', location: '', source_location_id: '', sort: 'indexed_at' };
  const SIDEBAR_STATE_KEY = 'ourtube.sidebar.collapsed';
  const FEATURED_SECTION_VISIBLE_KEY = 'ourtube.home.featured.visible';
  let featuredSectionVisible = true;
  let yearFilterLoadVersion = 0;
  let locationFilterLoadVersion = 0;
  let sourceLocationFilterLoadVersion = 0;
  const sourceLocationLabels = {};
  const sortLabels = {
    indexed_at: 'Date Added',
    created_at: 'Date Created',
    friendly_name: 'Name',
    view_count: 'Most Viewed',
    duration: 'Duration',
    size: 'Size'
  };

  let mediaTooltipEl = null;
  let activeTooltipCard = null;
  let tooltipShowTimer = null;
  let pendingTooltipCard = null;
  let pendingTooltipPoint = null;
  const TOOLTIP_HOVER_DELAY_MS = 180;

  let previewStartTimer = null;
  let pendingPreviewCard = null;
  let activePreviewCard = null;
  let activePreviewStopTimer = null;
  const VIDEO_PREVIEW_HOVER_DELAY_MS = 220;
  const VIDEO_PREVIEW_DURATION_MS = 7000;
  const VIDEO_PREVIEW_START_SECONDS = 1.5;

  // ── Utility ──────────────────────────────────────────────
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
    const mb = bytes / 1e6;
    return mb.toFixed(0) + ' MB';
  }

  function buildCardTooltip(item, isVideo, collectionName) {
    const lines = [];
    const displayName = String(item.friendly_name || item.file_name || 'Untitled');
    const description = String(item.description || '').trim();
    const tags = Array.isArray(item.tags) ? item.tags.filter(Boolean).map(String) : [];

    lines.push(displayName);

    if (item.is_virtual) {
      lines.push(`Stitched: ${item.segment_count || 0} clips combined`);
      lines.push('Sequence may vary during playback.');
    }

    if (description) lines.push(`About: ${description}`);

    const details = [];
    details.push(isVideo ? 'Video' : 'Photo');
    if (item.year) details.push(String(item.year));
    if (item.location) details.push(String(item.location));
    if (item.width && item.height) details.push(`${item.width}x${item.height}`);
    if (item.duration && isVideo) details.push(fmtDur(item.duration));
    if (item.size) details.push(fmtSize(item.size));
    if (collectionName) details.push(`Collection: ${collectionName}`);
    if (tags.length) details.push(`Tags: ${tags.join(', ')}`);
    if (details.length) lines.push(`Details: ${details.join(' · ')}`);

    return lines.join('\n');
  }

  async function loadUiSettings() {
    try {
      const res = await fetch('/api/ui-settings');
      if (!res.ok) return;
      const data = await res.json();
      uiSettings = { photosEnabled: data.photos_enabled !== false };
    } catch {
      uiSettings = { photosEnabled: true };
    }
  }

  function applyUiSettings() {
    if (uiSettings.photosEnabled) return true;

    if (FORCE_TYPE === 'photo') {
      window.location.replace('/');
      return false;
    }

    if (currentFilters.type === 'photo') currentFilters.type = '';

    document.querySelectorAll('input[name="type"][value="photo"]').forEach(input => {
      const label = input.closest('label');
      if (label) label.remove();
      else input.remove();
    });

    return true;
  }

  function ensureMediaTooltip() {
    if (mediaTooltipEl) return mediaTooltipEl;
    const el = document.createElement('div');
    el.id = 'media-hover-tooltip';
    el.className = 'media-hover-tooltip';
    el.setAttribute('role', 'tooltip');
    document.body.appendChild(el);
    mediaTooltipEl = el;
    return mediaTooltipEl;
  }

  function hideMediaTooltip() {
    if (tooltipShowTimer) {
      clearTimeout(tooltipShowTimer);
      tooltipShowTimer = null;
    }
    pendingTooltipCard = null;
    pendingTooltipPoint = null;
    if (!mediaTooltipEl) return;
    mediaTooltipEl.classList.remove('visible');
    mediaTooltipEl.textContent = '';
    activeTooltipCard = null;
  }

  function positionTooltipNearPointer(event) {
    if (!mediaTooltipEl) return;
    const pad = 12;
    const offset = 14;
    const rect = mediaTooltipEl.getBoundingClientRect();
    const maxX = Math.max(pad, window.innerWidth - rect.width - pad);
    const maxY = Math.max(pad, window.innerHeight - rect.height - pad);
    const x = Math.min(maxX, Math.max(pad, event.clientX + offset));
    const y = Math.min(maxY, Math.max(pad, event.clientY + offset));
    mediaTooltipEl.style.left = `${x}px`;
    mediaTooltipEl.style.top = `${y}px`;
  }

  function positionTooltipNearCard(card) {
    if (!mediaTooltipEl || !card) return;
    const pad = 12;
    const rect = card.getBoundingClientRect();
    const tipRect = mediaTooltipEl.getBoundingClientRect();
    const centeredX = rect.left + (rect.width / 2) - (tipRect.width / 2);
    const aboveY = rect.top - tipRect.height - 10;
    const maxX = Math.max(pad, window.innerWidth - tipRect.width - pad);
    const maxY = Math.max(pad, window.innerHeight - tipRect.height - pad);
    const x = Math.min(maxX, Math.max(pad, centeredX));
    const y = Math.min(maxY, Math.max(pad, aboveY));
    mediaTooltipEl.style.left = `${x}px`;
    mediaTooltipEl.style.top = `${y}px`;
  }

  function showMediaTooltip(card, event) {
    if (!card) return;
    const tooltipText = card.dataset.tooltip;
    if (!tooltipText) return;

    const el = ensureMediaTooltip();
    activeTooltipCard = card;
    el.textContent = tooltipText;
    el.classList.add('visible');
    if (event && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
      positionTooltipNearPointer(event);
    } else {
      positionTooltipNearCard(card);
    }
  }

  function initMediaCardTooltips() {
    ensureMediaTooltip();

    document.addEventListener('mouseover', event => {
      const card = event.target.closest('.media-card');
      if (!card) return;
      const from = event.relatedTarget;
      if (from && card.contains(from)) return;

      if (tooltipShowTimer) clearTimeout(tooltipShowTimer);
      pendingTooltipCard = card;
      pendingTooltipPoint = { clientX: event.clientX, clientY: event.clientY };
      tooltipShowTimer = setTimeout(() => {
        tooltipShowTimer = null;
        if (!pendingTooltipCard) return;
        showMediaTooltip(pendingTooltipCard, pendingTooltipPoint);
        pendingTooltipCard = null;
        pendingTooltipPoint = null;
      }, TOOLTIP_HOVER_DELAY_MS);
    });

    document.addEventListener('mousemove', event => {
      if (pendingTooltipCard) {
        pendingTooltipPoint = { clientX: event.clientX, clientY: event.clientY };
      }
      if (!activeTooltipCard || !mediaTooltipEl || !mediaTooltipEl.classList.contains('visible')) return;
      positionTooltipNearPointer(event);
    });

    document.addEventListener('mouseout', event => {
      if (pendingTooltipCard) {
        const leavingPendingCard = event.target && pendingTooltipCard.contains(event.target);
        const enteringPendingCard = event.relatedTarget && pendingTooltipCard.contains(event.relatedTarget);
        if (leavingPendingCard && !enteringPendingCard) {
          if (tooltipShowTimer) clearTimeout(tooltipShowTimer);
          tooltipShowTimer = null;
          pendingTooltipCard = null;
          pendingTooltipPoint = null;
        }
      }

      if (!activeTooltipCard) return;
      const next = event.relatedTarget;
      if (next && activeTooltipCard.contains(next)) return;
      hideMediaTooltip();
    });

    document.addEventListener('focusin', event => {
      const card = event.target.closest('.media-card');
      if (!card) return;
      if (tooltipShowTimer) clearTimeout(tooltipShowTimer);
      tooltipShowTimer = null;
      pendingTooltipCard = null;
      pendingTooltipPoint = null;
      showMediaTooltip(card);
    });

    document.addEventListener('focusout', event => {
      if (!activeTooltipCard) return;
      const next = event.relatedTarget;
      if (next && activeTooltipCard.contains(next)) return;
      hideMediaTooltip();
    });

    window.addEventListener('scroll', () => {
      if (!activeTooltipCard) return;
      positionTooltipNearCard(activeTooltipCard);
    }, { passive: true });

    window.addEventListener('resize', () => {
      if (!activeTooltipCard) return;
      positionTooltipNearCard(activeTooltipCard);
    });
  }

  function clearPreviewStartTimer() {
    if (previewStartTimer) {
      clearTimeout(previewStartTimer);
      previewStartTimer = null;
    }
  }

  function clearActivePreviewStopTimer() {
    if (activePreviewStopTimer) {
      clearTimeout(activePreviewStopTimer);
      activePreviewStopTimer = null;
    }
  }

  function stopActivePreview() {
    clearActivePreviewStopTimer();
    if (!activePreviewCard) return;

    const video = activePreviewCard.querySelector('.card-preview-video');
    if (video) {
      try {
        video.pause();
        video.currentTime = 0;
      } catch { /* ignore */ }
    }

    activePreviewCard.classList.remove('is-previewing');
    activePreviewCard.classList.remove('is-preview-loading');
    activePreviewCard = null;
  }

  function getPreviewUrl(item) {
    const encodedId = encodeURIComponent(item.id);
    // Avoid stitched virtual preview streams on listing pages.
    // Safari can issue startup transcode probes here, which interferes with
    // first-watch playback flow right after a fresh server restart.
    if (item.is_virtual) return '';
    return `/stream/${encodedId}`;
  }

  function ensureCardPreviewVideo(card) {
    if (!card) return null;
    const previewUrl = card.dataset.previewUrl;
    if (!previewUrl) return null;

    const video = card.querySelector('.card-preview-video');
    if (!video) return null;

    if (!video.src) {
      video.src = previewUrl;
      video.load();
    }

    return video;
  }

  async function startCardPreview(card) {
    if (!card || !card.dataset.previewUrl) return;

    if (activePreviewCard && activePreviewCard !== card) {
      stopActivePreview();
    }

    const video = ensureCardPreviewVideo(card);
    if (!video) return;

    activePreviewCard = card;
    card.classList.add('is-preview-loading');

    try {
      const setStartOffset = () => {
        if (video.duration && Number.isFinite(video.duration) && video.duration > VIDEO_PREVIEW_START_SECONDS + 0.3) {
          try { video.currentTime = VIDEO_PREVIEW_START_SECONDS; } catch { /* ignore */ }
        }
      };

      if (video.readyState >= 1) {
        setStartOffset();
      } else {
        video.addEventListener('loadedmetadata', setStartOffset, { once: true });
      }

      await video.play();
      card.classList.remove('is-preview-loading');
      card.classList.add('is-previewing');

      clearActivePreviewStopTimer();
      activePreviewStopTimer = setTimeout(() => {
        if (activePreviewCard === card) stopActivePreview();
      }, VIDEO_PREVIEW_DURATION_MS);
    } catch {
      card.classList.remove('is-preview-loading');
      if (activePreviewCard === card) activePreviewCard = null;
    }
  }

  function initMediaCardPreviews() {
    document.addEventListener('mouseover', event => {
      const card = event.target.closest('.media-card');
      if (!card || !card.dataset.previewUrl) return;
      const from = event.relatedTarget;
      if (from && card.contains(from)) return;

      clearPreviewStartTimer();
      pendingPreviewCard = card;
      previewStartTimer = setTimeout(() => {
        previewStartTimer = null;
        if (!pendingPreviewCard) return;
        const nextCard = pendingPreviewCard;
        pendingPreviewCard = null;
        startCardPreview(nextCard);
      }, VIDEO_PREVIEW_HOVER_DELAY_MS);
    });

    document.addEventListener('mouseout', event => {
      const card = event.target.closest('.media-card');
      if (!card || !card.dataset.previewUrl) return;
      const next = event.relatedTarget;
      if (next && card.contains(next)) return;

      if (pendingPreviewCard === card) {
        pendingPreviewCard = null;
        clearPreviewStartTimer();
      }
      if (activePreviewCard === card) stopActivePreview();
    });

    document.addEventListener('click', () => {
      pendingPreviewCard = null;
      clearPreviewStartTimer();
      stopActivePreview();
    });

    window.addEventListener('scroll', () => {
      pendingPreviewCard = null;
      clearPreviewStartTimer();
      stopActivePreview();
    }, { passive: true });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        pendingPreviewCard = null;
        clearPreviewStartTimer();
        stopActivePreview();
      }
    });
  }

  function setRadioValue(name, value) {
    document.querySelectorAll(`input[name="${name}"]`).forEach(input => {
      input.checked = input.value === value;
    });
  }

  function syncFilterControls() {
    setRadioValue('type', currentFilters.type);
    setRadioValue('source_location_id', currentFilters.source_location_id);

    const yearSel = document.getElementById('year-filter');
    if (yearSel && yearSel.tagName === 'SELECT') yearSel.value = currentFilters.year;
    else setRadioValue('year', currentFilters.year);

    const locSel = document.getElementById('location-filter');
    if (locSel && locSel.tagName === 'SELECT') locSel.value = currentFilters.location;
    else setRadioValue('location', currentFilters.location);

    const sortSel = document.getElementById('sort-select');
    if (sortSel) sortSel.value = currentFilters.sort;
  }

  function renderActiveFilters() {
    const bar = document.getElementById('active-filters');
    if (!bar) return;

    const chips = [];
    if (!FORCE_TYPE && currentFilters.type) {
      chips.push({ key: 'type', label: `Type: ${currentFilters.type === 'video' ? 'Videos' : 'Photos'}` });
    }
    if (currentFilters.year) chips.push({ key: 'year', label: `Year: ${currentFilters.year}` });
    if (currentFilters.location) chips.push({ key: 'location', label: `Location: ${currentFilters.location}` });
    if (currentFilters.source_location_id) {
      const sourceLabel = sourceLocationLabels[currentFilters.source_location_id] || currentFilters.source_location_id;
      chips.push({ key: 'source_location_id', label: `Source: ${sourceLabel}` });
    }
    if (currentFilters.sort && currentFilters.sort !== 'indexed_at') {
      chips.push({ key: 'sort', label: `Sort: ${sortLabels[currentFilters.sort] || currentFilters.sort}` });
    }

    if (chips.length === 0) {
      bar.style.display = 'none';
      bar.innerHTML = '';
      return;
    }

    bar.style.display = 'flex';
    bar.innerHTML = '';

    const label = document.createElement('span');
    label.className = 'active-filters-label';
    label.textContent = 'Active filters:';
    bar.appendChild(label);

    chips.forEach(chip => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'filter-chip';
      btn.textContent = `${chip.label} ×`;
      btn.addEventListener('click', () => {
        if (chip.key === 'sort') {
          currentFilters.sort = 'indexed_at';
        } else {
          currentFilters[chip.key] = '';
        }
        syncFilterControls();
        renderActiveFilters();
        loadMedia(true);
      });
      bar.appendChild(btn);
    });

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'filter-chip filter-chip--clear';
    clearBtn.textContent = 'Clear all';
    clearBtn.addEventListener('click', () => {
      currentFilters = {
        type: FORCE_TYPE || '',
        year: '',
        location: '',
        source_location_id: '',
        sort: 'indexed_at'
      };
      syncFilterControls();
      renderActiveFilters();
      loadMedia(true);
    });
    bar.appendChild(clearBtn);
  }

  function initSidebarToggle() {
    const layout = document.querySelector('.page-layout');
    const btn = document.getElementById('sidebar-toggle-btn');
    if (!layout || !btn) return;

    const isMobile = () => window.matchMedia('(max-width: 768px)').matches;
    const applyState = collapsed => {
      if (isMobile()) {
        layout.classList.remove('sidebar-collapsed');
        layout.classList.toggle('sidebar-expanded-mobile', !collapsed);
      } else {
        layout.classList.remove('sidebar-expanded-mobile');
        layout.classList.toggle('sidebar-collapsed', collapsed);
      }
      const label = collapsed ? 'Show filters' : 'Hide filters';
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    };

    let collapsed = false;
    let hasStoredPreference = false;
    try {
      const stored = localStorage.getItem(SIDEBAR_STATE_KEY);
      hasStoredPreference = stored !== null;
      collapsed = stored === 'true';
    } catch { /* ignore */ }
    if (!hasStoredPreference && isMobile()) collapsed = true;
    applyState(collapsed);

    btn.addEventListener('click', () => {
      collapsed = !collapsed;
      try {
        localStorage.setItem(SIDEBAR_STATE_KEY, String(collapsed));
      } catch { /* ignore */ }
      applyState(collapsed);
    });

    window.addEventListener('resize', () => applyState(collapsed));
  }

  function readFeaturedSectionPreference() {
    try {
      const stored = localStorage.getItem(FEATURED_SECTION_VISIBLE_KEY);
      return stored !== '0';
    } catch {
      return true;
    }
  }

  function persistFeaturedSectionPreference(visible) {
    try {
      localStorage.setItem(FEATURED_SECTION_VISIBLE_KEY, visible ? '1' : '0');
    } catch {
      // Ignore storage failures.
    }
  }

  function applyFeaturedSectionVisibility() {
    const section = document.getElementById('featured-section');
    const grid = document.getElementById('featured-grid');
    const toggle = document.getElementById('featured-section-toggle');
    if (!section || !grid || !toggle) return;

    const hasItems = grid.childElementCount > 0;
    section.style.display = featuredSectionVisible && hasItems ? '' : 'none';
    grid.hidden = !featuredSectionVisible || !hasItems;
    toggle.checked = featuredSectionVisible;
    toggle.setAttribute('aria-checked', featuredSectionVisible ? 'true' : 'false');
  }

  function bindFeaturedSectionToggle() {
    const toggle = document.getElementById('featured-section-toggle');
    if (!toggle || toggle.dataset.bound === '1') return;

    toggle.addEventListener('change', async () => {
      featuredSectionVisible = !!toggle.checked;
      persistFeaturedSectionPreference(featuredSectionVisible);

      if (featuredSectionVisible) {
        await loadFeatured();
        return;
      }

      applyFeaturedSectionVisibility();
    });

    toggle.dataset.bound = '1';
  }

  // ── Card Builder ─────────────────────────────────────────
  function buildCard(item) {
    const card = document.createElement('a');
    card.href = `/watch.html?id=${item.id}`;
    card.className = 'media-card';

    const thumb = `/thumbnail/${item.thumbnail_media_id || item.id}`;
    const isVideo = item.type === 'video';
    const previewUrl = isVideo ? getPreviewUrl(item) : '';
    const name = escHtml(item.friendly_name || item.file_name);

    const collectionName = !currentFilters.source_location_id && item.source_location_id
      ? (sourceLocationLabels[String(item.source_location_id)] || null)
      : null;
    const tooltipText = buildCardTooltip(item, isVideo, collectionName);
    card.dataset.tooltip = tooltipText;
    card.setAttribute('aria-label', tooltipText);
    if (previewUrl) card.dataset.previewUrl = previewUrl;
    const isAdminOnlyVisible = adminModeEnabled && (item.visibility === 'admin' || item.source_visibility === 'admin');
    const leftBadges = [];
    const rightBadges = [];
    if (isAdminOnlyVisible) leftBadges.push('<span class="card-visibility-badge">Admin Only</span>');
    if (item.is_virtual) leftBadges.push('<span class="card-collection-badge card-collection-badge--stitch">Stitched Video</span>');
    if (adminModeEnabled) {
      rightBadges.push(`<a class="card-admin-link" href="/admin/?tab=library&edit=${encodeURIComponent(item.id)}" title="Edit in admin">Edit</a>`);
    }
    if (item.is_virtual) rightBadges.push(`<span class="card-collection-badge">${item.segment_count} clips</span>`);
    if (collectionName) rightBadges.push(`<span class="card-collection-badge">${escHtml(collectionName)}</span>`);

    card.innerHTML = `
      <div class="card-thumb-wrap">
        <img class="card-thumb" src="${thumb}" alt="${name}" loading="lazy"
             onerror="this.src='/img/no-thumb.svg'" />
        ${isVideo ? '<video class="card-preview-video" muted playsinline preload="metadata" aria-hidden="true"></video>' : ''}
        ${isVideo && item.duration ? `<span class="card-duration">${fmtDur(item.duration)}</span>` : ''}
        <span class="card-type-badge">${isVideo ? '🎬' : '📷'}</span>
        ${leftBadges.length ? `<div class="card-left-badges">${leftBadges.join('')}</div>` : ''}
        ${rightBadges.length ? `<div class="card-right-badges">${rightBadges.join('')}</div>` : ''}
      </div>
      <div class="card-info">
        <div class="card-title">${name}</div>
        <div class="card-meta">
          ${item.year ? item.year : ''}
          ${item.location ? `· ${escHtml(item.location)}` : ''}
        </div>
      </div>`;
    return card;
  }

  // ── Fetch & Render ────────────────────────────────────────
  async function loadMedia(reset = false) {
    if (loading) return;

    loading = true;
    const grid = document.getElementById('media-grid');
    if (!grid) {
      loading = false;
      return;
    }

    if (reset) {
      grid.innerHTML = '';
    }

    try {
      let nextPage = reset ? 1 : 1;
      let fetched = 0;
      let total = 0;

      while (true) {
        const params = new URLSearchParams({
          page: nextPage,
          limit: API_PAGE_LIMIT,
          sort: currentFilters.sort,
          order: 'DESC'
        });

        if (currentFilters.type) params.set('type', currentFilters.type);
        if (currentFilters.year) params.set('year', currentFilters.year);
        if (currentFilters.location) params.set('location', currentFilters.location);
        if (currentFilters.source_location_id) params.set('source_location_id', currentFilters.source_location_id);

        const res = await fetch('/api/media?' + params.toString());
        const data = await res.json();
        const items = Array.isArray(data.items) ? data.items : [];

        items.forEach(item => grid.appendChild(buildCard(item)));

        total = Number(data.total) || 0;
        fetched += items.length;

        if (nextPage === 1) {
          const title = document.getElementById('grid-title');
          if (title) {
            const typeLabel = FORCE_TYPE === 'photo'
              ? 'Photos'
              : FORCE_TYPE === 'video'
                ? 'Videos'
                : (uiSettings.photosEnabled ? 'All Media' : 'All Videos');
            title.textContent = `${typeLabel} (${total})`;
          }
        }

        if (items.length === 0 || fetched >= total) break;
        nextPage++;
      }

      const btn = document.getElementById('load-more-btn');
      const end = document.getElementById('end-message');
      if (btn) btn.style.display = 'none';
      if (end) end.style.display = 'none';
    } catch (err) {
      console.error('[app] Failed to load media:', err);
    }

    loading = false;
  }

  // ── Featured ──────────────────────────────────────────────
  async function loadFeatured() {
    const grid = document.getElementById('featured-grid');
    if (!grid) return;

    if (!featuredSectionVisible) {
      applyFeaturedSectionVisibility();
      return;
    }

    try {
      const params = new URLSearchParams({
        page: 1,
        limit: 8,
        sort: 'indexed_at',
        order: 'DESC'
      });

      if (currentFilters.type) params.set('type', currentFilters.type);
      if (currentFilters.year) params.set('year', currentFilters.year);
      if (currentFilters.location) params.set('location', currentFilters.location);
      if (currentFilters.source_location_id) params.set('source_location_id', currentFilters.source_location_id);

      const res = await fetch('/api/media?' + params.toString());
      const data = await res.json();

      grid.innerHTML = '';
      (data.items || []).forEach(item => grid.appendChild(buildCard(item)));
      applyFeaturedSectionVisibility();
    } catch (err) {
      console.error('[app] Failed to load featured:', err);
      applyFeaturedSectionVisibility();
    }
  }

  // ── Stats Bar ─────────────────────────────────────────────
  async function loadStats() {
    const bar = document.getElementById('stats-bar');
    if (!bar) return;
    try {
      const res = await fetch('/api/stats');
      const s = await res.json();
      const photoPart = uiSettings.photosEnabled ? ` · ${s.photos} photos` : '';
      bar.textContent = `${s.total} items · ${s.videos} videos${photoPart} · ${fmtSize(s.totalSize)}`;
    } catch { /* ignore */ }
  }

  // ── Filters ───────────────────────────────────────────────
  async function loadYearFilter() {
    const sel = document.getElementById('year-filter');
    if (!sel || sel.tagName !== 'SELECT') return false;
    const loadVersion = ++yearFilterLoadVersion;

    const previousSelection = String(currentFilters.year || '');
    const options = ['<option value="">All Years</option>'];

    const typeForFilter = FORCE_TYPE || currentFilters.type;
    const params = new URLSearchParams();
    if (typeForFilter) params.set('type', typeForFilter);

    let stillAvailable = !previousSelection;
    try {
      const url = '/api/years' + (params.toString() ? `?${params.toString()}` : '');
      const res = await fetch(url);
      const years = await res.json();
      years.forEach(({ year }) => {
        const val = String(year);
        if (val === previousSelection) stillAvailable = true;
        options.push(`<option value="${escHtml(val)}">${escHtml(year)}</option>`);
      });
    } catch { /* ignore */ }

    if (loadVersion !== yearFilterLoadVersion) return false;

    sel.innerHTML = options.join('');

    if (!stillAvailable) currentFilters.year = '';
    sel.value = currentFilters.year;
    return !stillAvailable;
  }

  async function loadLocationFilter() {
    const sel = document.getElementById('location-filter');
    if (!sel || sel.tagName !== 'SELECT') return false;
    const loadVersion = ++locationFilterLoadVersion;

    const previousSelection = String(currentFilters.location || '');
    const options = ['<option value="">All Locations</option>'];

    const typeForFilter = FORCE_TYPE || currentFilters.type;
    const params = new URLSearchParams();
    if (typeForFilter) params.set('type', typeForFilter);

    let stillAvailable = !previousSelection;
    try {
      const url = '/api/locations' + (params.toString() ? `?${params.toString()}` : '');
      const res = await fetch(url);
      const locs = await res.json();
      locs.slice(0, 50).forEach(({ location }) => {
        if (location === previousSelection) stillAvailable = true;
        options.push(`<option value="${escHtml(location)}">${escHtml(location)}</option>`);
      });
    } catch { /* ignore */ }

    if (loadVersion !== locationFilterLoadVersion) return false;

    sel.innerHTML = options.join('');

    if (!stillAvailable) currentFilters.location = '';
    sel.value = currentFilters.location;
    return !stillAvailable;
  }

  async function loadSourceLocationFilter() {
    const container = document.getElementById('source-location-filter');
    if (!container) return false;
    const loadVersion = ++sourceLocationFilterLoadVersion;

    const previousSelection = String(currentFilters.source_location_id || '');

    const typeForFilter = FORCE_TYPE || currentFilters.type;
    const params = new URLSearchParams();
    if (typeForFilter) params.set('type', typeForFilter);

    let stillAvailable = !previousSelection;
    let rows = [];
    try {
      const url = '/api/source-locations' + (params.toString() ? `?${params.toString()}` : '');
      const res = await fetch(url);
      rows = await res.json();
    } catch { /* ignore */ }

    if (loadVersion !== sourceLocationFilterLoadVersion) return false;

    const seenSourceIds = new Set();
    const labelsById = {};
    const fragment = document.createDocumentFragment();

    const allLabel = document.createElement('label');
    const allInput = document.createElement('input');
    allInput.type = 'radio';
    allInput.name = 'source_location_id';
    allInput.value = '';
    allInput.checked = true;
    allLabel.appendChild(allInput);
    allLabel.appendChild(document.createTextNode(' All Collections'));
    fragment.appendChild(allLabel);

    rows.forEach(({ id, name }) => {
      const idStr = String(id);
      if (seenSourceIds.has(idStr)) return;
      seenSourceIds.add(idStr);
      labelsById[idStr] = name;
      if (idStr === previousSelection) stillAvailable = true;
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'source_location_id';
      input.value = idStr;
      label.appendChild(input);
      label.appendChild(document.createTextNode(` ${name}`));
      fragment.appendChild(label);
    });

    container.replaceChildren(fragment);
    Object.keys(sourceLocationLabels).forEach(key => delete sourceLocationLabels[key]);
    Object.assign(sourceLocationLabels, labelsById);

    if (!stillAvailable) {
      currentFilters.source_location_id = '';
    }
    syncFilterControls();
    return !stillAvailable;
  }

  function bindFilters() {
    document.querySelectorAll('input[name="type"]').forEach(el => {
      el.addEventListener('change', async () => {
        currentFilters.type = FORCE_TYPE || el.value;
        await Promise.all([loadYearFilter(), loadLocationFilter(), loadSourceLocationFilter()]);
        renderActiveFilters();
        loadFeatured();
        loadMedia(true);
      });
    });

    // Use event delegation for dynamically loaded collection radios.
    document.addEventListener('change', e => {
      if (e.target.name === 'source_location_id') {
        currentFilters.source_location_id = e.target.value;
        renderActiveFilters();
        loadFeatured();
        loadMedia(true);
      }
    });

    const yearSel = document.getElementById('year-filter');
    if (yearSel) {
      yearSel.addEventListener('change', () => {
        currentFilters.year = yearSel.value;
        renderActiveFilters();
        loadFeatured();
        loadMedia(true);
      });
    }

    const locSel = document.getElementById('location-filter');
    if (locSel) {
      locSel.addEventListener('change', () => {
        currentFilters.location = locSel.value;
        renderActiveFilters();
        loadFeatured();
        loadMedia(true);
      });
    }

    const sortSel = document.getElementById('sort-select');
    if (sortSel) {
      sortSel.addEventListener('change', () => {
        currentFilters.sort = sortSel.value;
        renderActiveFilters();
        loadFeatured();
        loadMedia(true);
      });
    }

  }

  // ── Init ──────────────────────────────────────────────────
  async function init() {
    await loadUiSettings();
    if (!applyUiSettings()) return;
    featuredSectionVisible = readFeaturedSectionPreference();

    const adminStatus = window.OurTubeAdminMode?.status?.();
    adminModeEnabled = !!adminStatus?.authenticated;

    window.addEventListener('ourtube-ui-settings-changed', async event => {
      const photosEnabled = event.detail?.photosEnabled !== false;
      if (photosEnabled === uiSettings.photosEnabled) return;
      if (photosEnabled) {
        window.location.reload();
        return;
      }
      uiSettings.photosEnabled = photosEnabled;
      if (!applyUiSettings()) return;
      await Promise.all([loadYearFilter(), loadLocationFilter(), loadSourceLocationFilter()]);
      syncFilterControls();
      renderActiveFilters();
      await loadStats();
      loadFeatured();
      loadMedia(true);
    });

    window.addEventListener('ourtube-admin-mode-changed', async event => {
      const nextEnabled = !!event.detail?.authenticated;
      if (nextEnabled === adminModeEnabled) return;
      adminModeEnabled = nextEnabled;
      await Promise.all([loadYearFilter(), loadLocationFilter(), loadSourceLocationFilter()]);
      loadMedia(true);
      loadFeatured();
    });

    initSidebarToggle();
  bindFeaturedSectionToggle();
    bindFilters();
    initMediaCardTooltips();
    initMediaCardPreviews();
    await Promise.all([loadFeatured(), loadStats(), loadYearFilter(), loadLocationFilter(), loadSourceLocationFilter()]);
    syncFilterControls();
    renderActiveFilters();
    await loadMedia(true);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
