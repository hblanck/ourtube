/* global app.js — used by index.html and photos.html */
'use strict';

(function () {
  const FORCE_TYPE = window.OURTUBE_FORCE_TYPE || null;
  const limit = 24;
  let page = 1;
  let loading = false;
  let hasMore = true;
  let currentFilters = { type: FORCE_TYPE || '', year: '', location: '', sort: 'indexed_at' };
  const sortLabels = {
    indexed_at: 'Date Added',
    created_at: 'Date Created',
    friendly_name: 'Name',
    view_count: 'Most Viewed',
    duration: 'Duration',
    size: 'Size'
  };

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

  function setRadioValue(name, value) {
    document.querySelectorAll(`input[name="${name}"]`).forEach(input => {
      input.checked = input.value === value;
    });
  }

  function syncFilterControls() {
    setRadioValue('type', currentFilters.type);
    setRadioValue('year', currentFilters.year);
    setRadioValue('location', currentFilters.location);

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
        sort: 'indexed_at'
      };
      syncFilterControls();
      renderActiveFilters();
      loadMedia(true);
    });
    bar.appendChild(clearBtn);
  }

  // ── Card Builder ─────────────────────────────────────────
  function buildCard(item) {
    const card = document.createElement('a');
    card.href = `/watch.html?id=${item.id}`;
    card.className = 'media-card';

    const thumb = `/thumbnail/${item.id}`;
    const isVideo = item.type === 'video';
    const name = escHtml(item.friendly_name || item.file_name);

    card.innerHTML = `
      <div class="card-thumb-wrap">
        <img class="card-thumb" src="${thumb}" alt="${name}" loading="lazy"
             onerror="this.src='/img/no-thumb.svg'" />
        ${isVideo && item.duration ? `<span class="card-duration">${fmtDur(item.duration)}</span>` : ''}
        <span class="card-type-badge">${isVideo ? '🎬' : '📷'}</span>
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
    if (!reset && !hasMore) return;

    loading = true;

    if (reset) {
      page = 1;
      hasMore = true;
      const grid = document.getElementById('media-grid');
      if (grid) grid.innerHTML = '';
    }

    const params = new URLSearchParams({
      page,
      limit,
      sort: currentFilters.sort,
      order: 'DESC'
    });

    if (currentFilters.type) params.set('type', currentFilters.type);
    if (currentFilters.year) params.set('year', currentFilters.year);
    if (currentFilters.location) params.set('location', currentFilters.location);

    try {
      const res = await fetch('/api/media?' + params.toString());
      const data = await res.json();

      const grid = document.getElementById('media-grid');
      data.items.forEach(item => grid && grid.appendChild(buildCard(item)));

      hasMore = page * limit < data.total;
      page++;

      const title = document.getElementById('grid-title');
      if (title && page === 2) {
        const typeLabel = FORCE_TYPE === 'photo' ? 'Photos' : FORCE_TYPE === 'video' ? 'Videos' : 'All Media';
        title.textContent = `${typeLabel} (${data.total})`;
      }

      const btn = document.getElementById('load-more-btn');
      const end = document.getElementById('end-message');
      if (btn) btn.style.display = hasMore ? 'block' : 'none';
      if (end) end.style.display = !hasMore && data.total > 0 ? 'block' : 'none';
    } catch (err) {
      console.error('[app] Failed to load media:', err);
    }

    loading = false;
  }

  // ── Featured ──────────────────────────────────────────────
  async function loadFeatured() {
    const grid = document.getElementById('featured-grid');
    if (!grid) return;

    try {
      const res = await fetch('/api/media/featured');
      const data = await res.json();

      (data.recent || []).slice(0, 8).forEach(item => grid.appendChild(buildCard(item)));

      const section = document.getElementById('featured-section');
      if (section && data.recent.length === 0) section.style.display = 'none';
    } catch (err) {
      console.error('[app] Failed to load featured:', err);
    }
  }

  // ── Stats Bar ─────────────────────────────────────────────
  async function loadStats() {
    const bar = document.getElementById('stats-bar');
    if (!bar) return;
    try {
      const res = await fetch('/api/stats');
      const s = await res.json();
      bar.textContent = `${s.total} items · ${s.videos} videos · ${s.photos} photos · ${fmtSize(s.totalSize)}`;
    } catch { /* ignore */ }
  }

  // ── Filters ───────────────────────────────────────────────
  async function loadYearFilter() {
    const container = document.getElementById('year-filter');
    if (!container) return;
    try {
      const res = await fetch('/api/years');
      const years = await res.json();
      years.forEach(({ year }) => {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'year';
        input.value = String(year);
        label.appendChild(input);
        label.appendChild(document.createTextNode(` ${year}`));
        container.appendChild(label);
      });
    } catch { /* ignore */ }
  }

  async function loadLocationFilter() {
    const container = document.getElementById('location-filter');
    if (!container) return;
    try {
      const res = await fetch('/api/locations');
      const locs = await res.json();
      locs.slice(0, 20).forEach(({ location }) => {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'location';
        input.value = String(location);
        label.appendChild(input);
        label.appendChild(document.createTextNode(` ${location}`));
        container.appendChild(label);
      });
    } catch { /* ignore */ }
  }

  function bindFilters() {
    document.querySelectorAll('input[name="type"]').forEach(el => {
      el.addEventListener('change', () => {
        currentFilters.type = FORCE_TYPE || el.value;
        renderActiveFilters();
        loadMedia(true);
      });
    });

    // Use event delegation for dynamically loaded year/location radios.
    document.addEventListener('change', e => {
      if (e.target.name === 'year') {
        currentFilters.year = e.target.value;
        renderActiveFilters();
        loadMedia(true);
      }
      if (e.target.name === 'location') {
        currentFilters.location = e.target.value;
        renderActiveFilters();
        loadMedia(true);
      }
    });

    const sortSel = document.getElementById('sort-select');
    if (sortSel) {
      sortSel.addEventListener('change', () => {
        currentFilters.sort = sortSel.value;
        renderActiveFilters();
        loadMedia(true);
      });
    }

    const btn = document.getElementById('load-more-btn');
    if (btn) btn.addEventListener('click', () => loadMedia(false));
  }

  // ── Init ──────────────────────────────────────────────────
  async function init() {
    bindFilters();
    await Promise.all([loadFeatured(), loadStats(), loadYearFilter(), loadLocationFilter()]);
    syncFilterControls();
    renderActiveFilters();
    await loadMedia(true);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
