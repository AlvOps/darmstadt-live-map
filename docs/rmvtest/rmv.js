(function () {
  'use strict';

  const DEFAULT_BASE = 'https://talos.taild11d3b.ts.net';   // Tailscale Funnel auf dem VPS, haelt den Schluessel
  let base = window.DLM_RMV || DEFAULT_BASE;
  try {
    const query = new URLSearchParams(window.location && window.location.search || '');
    if (query.has('rmv')) base = query.get('rmv') || base;
  } catch (_) { /* use the configured default */ }
  base = String(base).replace(/\/+$/, '');
  let online = false;
  let checked = false;

  async function checkHealth() {
    if (checked) return online;
    checked = true;
    try {
      if (typeof window.fetch !== 'function') return false;
      const response = await window.fetch(base + '/health', { cache: 'no-store' });
      online = !!response.ok;
    } catch (_) { online = false; }
    return online;
  }

  const ready = checkHealth();
  async function get(path) {
    if (!(await ready) || !online) return null;
    try {
      const response = await window.fetch(base + path, { cache: 'no-store' });
      if (!response.ok) return null;
      return await response.json();
    } catch (_) { return null; }
  }

  window.DarmstadtRMV = {
    base,
    ready,
    enabled: () => online,
    resolve(name, lat, lon) {
      const coords = Number.isFinite(lat) && Number.isFinite(lon) ? '&lat=' + encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lon) : '';
      return get('/resolve?name=' + encodeURIComponent(name) + coords);
    },
    board(stop) { return get('/board?stop=' + encodeURIComponent(stop) + '&duration=60'); },
    notices(lineIds) {
      const ids = Array.from(new Set((lineIds || []).map(String).filter(Boolean)));
      return ids.length ? get('/notices?lineIds=' + encodeURIComponent(ids.join('|'))) : Promise.resolve(null);
    },
  };
})();
