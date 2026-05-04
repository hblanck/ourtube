/* global admin mode helpers */
'use strict';

(function () {
  let status = {
    configured: false,
    authenticated: false,
    expiresAt: null,
    sessionTtlMinutes: null,
  };

  let uiReady = false;

  function escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async function fetchStatus() {
    const res = await fetch('/api/admin/auth/status', { credentials: 'same-origin' });
    if (!res.ok) throw new Error('Failed to load admin status');
    status = await res.json();
    return status;
  }

  function dispatchStatusChanged() {
    window.dispatchEvent(new CustomEvent('ourtube-admin-mode-changed', {
      detail: { ...status }
    }));
  }

  function ensureModal() {
    if (document.getElementById('admin-auth-modal')) return;

    const overlay = document.createElement('div');
    overlay.id = 'admin-auth-modal';
    overlay.className = 'admin-auth-modal';
    overlay.innerHTML = `
      <div class="admin-auth-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-auth-title">
        <h3 id="admin-auth-title">Enable Admin Mode</h3>
        <p>Enter your admin key to unlock administrative features in this UI.</p>
        <input id="admin-auth-key" type="password" class="admin-auth-input" placeholder="Paste admin key" autocomplete="off" />
        <div id="admin-auth-error" class="admin-auth-error" style="display:none"></div>
        <div class="admin-auth-actions">
          <button id="admin-auth-cancel" class="btn btn-secondary" type="button">Cancel</button>
          <button id="admin-auth-submit" class="btn btn-primary" type="button">Unlock</button>
        </div>
      </div>`;

    overlay.addEventListener('click', event => {
      if (event.target === overlay) closeModal();
    });

    document.body.appendChild(overlay);

    const input = document.getElementById('admin-auth-key');
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') loginFromModal();
      if (event.key === 'Escape') closeModal();
    });

    document.getElementById('admin-auth-cancel').addEventListener('click', closeModal);
    document.getElementById('admin-auth-submit').addEventListener('click', loginFromModal);
  }

  function openModal() {
    ensureModal();
    const overlay = document.getElementById('admin-auth-modal');
    const input = document.getElementById('admin-auth-key');
    const error = document.getElementById('admin-auth-error');
    if (!overlay || !input || !error) return;

    error.style.display = 'none';
    error.textContent = '';
    input.value = '';
    overlay.classList.add('open');
    input.focus();
  }

  function closeModal() {
    const overlay = document.getElementById('admin-auth-modal');
    if (overlay) overlay.classList.remove('open');
  }

  async function loginFromModal() {
    const input = document.getElementById('admin-auth-key');
    const error = document.getElementById('admin-auth-error');
    if (!input || !error) return;

    const key = input.value.trim();
    if (!key) {
      error.textContent = 'Enter an admin key.';
      error.style.display = 'block';
      return;
    }

    try {
      const res = await fetch('/api/admin/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      status = data;
      closeModal();
      renderHeaderControls();
      dispatchStatusChanged();
    } catch (err) {
      error.textContent = escHtml(err.message || 'Login failed');
      error.style.display = 'block';
    }
  }

  async function logout() {
    await fetch('/api/admin/auth/logout', {
      method: 'POST',
      credentials: 'same-origin'
    });
    await fetchStatus();
    renderHeaderControls();
    dispatchStatusChanged();
  }

  function getNavContainer() {
    return document.querySelector('.header-nav');
  }

  function isAdminPage() {
    return window.location.pathname === '/admin' || window.location.pathname === '/admin/' || window.location.pathname.startsWith('/admin/');
  }

  function clearAdminLinkHandler(link) {
    if (!link || !link.__adminModeClickHandler) return;
    link.removeEventListener('click', link.__adminModeClickHandler);
    link.__adminModeClickHandler = null;
  }

  function renderAdminBadge(isUnlocked) {
    return `<span class="admin-lock-badge ${isUnlocked ? 'admin-lock-badge-unlocked' : 'admin-lock-badge-locked'}" aria-hidden="true"><span class="admin-lock-icon ${isUnlocked ? 'admin-lock-icon-unlocked' : 'admin-lock-icon-locked'}"></span></span>`;
  }

  function renderExistingAdminNavLink(nav) {
    const existingAdminLink = nav.querySelector('a.nav-link[href="/admin/"]');
    if (!existingAdminLink) return false;

    let wrap = document.getElementById('admin-mode-controls');
    if (wrap) wrap.remove();

    clearAdminLinkHandler(existingAdminLink);
    existingAdminLink.classList.add('nav-link-admin-mode');

    if (!status.configured) {
      existingAdminLink.innerHTML = '⚙️ Admin';
      existingAdminLink.title = 'Admin not configured';
      existingAdminLink.setAttribute('aria-label', 'Admin (not configured)');
      existingAdminLink.setAttribute('href', '/admin/');
      return true;
    }

    if (status.authenticated) {
      existingAdminLink.innerHTML = `⚙️ Admin ${renderAdminBadge(true)}`;
      existingAdminLink.title = 'Admin unlocked';
      existingAdminLink.setAttribute('aria-label', 'Admin (unlocked)');
      existingAdminLink.setAttribute('href', '/admin/');
      return true;
    }

    existingAdminLink.innerHTML = `⚙️ Admin ${renderAdminBadge(false)}`;
    existingAdminLink.title = 'Admin locked';
    existingAdminLink.setAttribute('aria-label', 'Admin (locked)');
    existingAdminLink.setAttribute('href', '/admin/');
    existingAdminLink.__adminModeClickHandler = event => {
      event.preventDefault();
      openModal();
    };
    existingAdminLink.addEventListener('click', existingAdminLink.__adminModeClickHandler);
    return true;
  }

  function renderHeaderControls() {
    const nav = getNavContainer();
    if (!nav) return;

    if (isAdminPage() && renderExistingAdminNavLink(nav)) return;

    let wrap = document.getElementById('admin-mode-controls');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'admin-mode-controls';
      wrap.className = 'admin-mode-controls';
      nav.appendChild(wrap);
    }

    if (!status.configured) {
      wrap.innerHTML = '<span class="nav-link" style="opacity:.75" title="Run npm run admin:key:create (or docker exec) to create your first key">Admin not configured</span>';
      return;
    }

    if (status.authenticated) {
      wrap.innerHTML = `
        <a href="/admin/" class="nav-link nav-link-admin-mode" aria-label="Admin (unlocked)" title="Admin unlocked">
          ⚙️ Admin
          <span class="admin-lock-badge admin-lock-badge-unlocked" aria-hidden="true">
            <span class="admin-lock-icon admin-lock-icon-unlocked"></span>
          </span>
        </a>`;
      return;
    }

    wrap.innerHTML = `
      <button id="admin-mode-login" type="button" class="nav-link nav-link-button nav-link-admin-mode" aria-label="Admin (locked)" title="Admin locked">
        ⚙️ Admin
        <span class="admin-lock-badge admin-lock-badge-locked" aria-hidden="true">
          <span class="admin-lock-icon admin-lock-icon-locked"></span>
        </span>
      </button>`;
    const loginBtn = document.getElementById('admin-mode-login');
    if (loginBtn) loginBtn.addEventListener('click', openModal);
  }

  async function init() {
    if (uiReady) return;
    uiReady = true;
    try {
      await fetchStatus();
    } catch {
      status = { configured: false, authenticated: false, expiresAt: null, sessionTtlMinutes: null };
    }
    renderHeaderControls();
    dispatchStatusChanged();
  }

  window.OurTubeAdminMode = {
    init,
    refresh: async () => {
      await fetchStatus();
      renderHeaderControls();
      dispatchStatusChanged();
      return { ...status };
    },
    status: () => ({ ...status }),
    isAuthenticated: () => !!status.authenticated,
    loginPrompt: openModal,
    logout,
  };

  document.addEventListener('DOMContentLoaded', () => {
    init().catch(() => {});
  });
})();
