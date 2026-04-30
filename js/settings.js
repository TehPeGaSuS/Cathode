import { state, saveSettings, BLOCKED_PORTS } from './state.js';
import { applyPrefixWidth } from './chat.js';

const el = id => document.getElementById(id);

// ─── Theme ────────────────────────────────────────────────────────────────────
export function initTheme() {
  setTheme(localStorage.getItem('cathode_theme') || 'dark');
}

export function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('cathode_theme', t);
  el('theme-toggle').textContent = t === 'dark' ? '◐ LIGHT' : '◑ DARK';
}

export function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  setTheme(cur === 'dark' ? 'light' : 'dark');
  // Re-render dispatched via custom event so chat.js can respond without circular import
  window.dispatchEvent(new CustomEvent('cathode:themechange'));
}

// ─── Settings panel ───────────────────────────────────────────────────────────
export function openSettings() {
  const s = state.settings;
  el('s-upload-backend').value = s.uploadBackend || 'none';
  el('s-filehost-url').value   = s.filehostUrl   || '';
  el('s-imgur-key').value      = s.imgurClientId || '';
  el('s-prefix-max').value     = s.prefixAlignMax || state.prefixAlignMax;
  updateBackendVis();
  el('settings-overlay').style.display = '';
}

export function closeSettings() {
  el('settings-overlay').style.display = 'none';
}

export function saveSettingsPanel() {
  state.settings.uploadBackend  = el('s-upload-backend').value;
  state.settings.filehostUrl    = el('s-filehost-url').value.trim();
  state.settings.imgurClientId  = el('s-imgur-key').value.trim();
  const pm = parseInt(el('s-prefix-max').value, 10);
  if (pm >= 4 && pm <= 64) {
    state.settings.prefixAlignMax = pm;
    state.prefixAlignMax          = pm;
    applyPrefixWidth();
  }
  saveSettings();
  closeSettings();
}

export function updateBackendVis() {
  const v = el('s-upload-backend').value;
  el('s-filehost-opts').style.display = v === 'filehost' ? '' : 'none';
  el('s-imgur-opts').style.display    = v === 'imgur'    ? '' : 'none';
}

// ─── Port warning ─────────────────────────────────────────────────────────────
export function checkPort() {
  const port = parseInt(el('port').value, 10);
  const show = BLOCKED_PORTS.has(port);
  el('port-warning').textContent   = show
    ? `⚠ Port ${port} is blocked by browsers. Use a different port (e.g. 9000).` : '';
  el('port-warning').style.display = show ? 'block' : 'none';
}

// ─── Cert helper ──────────────────────────────────────────────────────────────
export function openCertPage() {
  const host = el('host').value.trim();
  const port = parseInt(el('port').value, 10);
  if (!host || !port) return alert('Enter host and port first.');
  window.open(`https://${host}:${port}/api/version`, '_blank');
}
