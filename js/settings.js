import { state, saveSettings, BLOCKED_PORTS } from './state.js';
import { applyPrefixWidth } from './chat.js';
import { updateUploadButtonVisibility } from './upload.js';
import { overlayOpened, overlayClosed } from './layout.js';
import { updateWakeLock, wakeLockSupported } from './wakelock.js';

const el = id => document.getElementById(id);

// ─── Theme ────────────────────────────────────────────────────────────────────
// Stored choice is 'system', 'dark' or 'light'; 'system' follows the OS and
// is the default, like weechat-android.
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function themeChoice() {
  try { return localStorage.getItem('cathode_theme') || 'system'; } catch { return 'system'; }
}

function resolveTheme(choice) {
  return choice === 'system' ? (darkQuery.matches ? 'dark' : 'light') : choice;
}

export function initTheme() {
  setTheme(themeChoice());
  darkQuery.addEventListener('change', () => {
    if (themeChoice() !== 'system') return;
    setTheme('system');
    window.dispatchEvent(new CustomEvent('cathode:themechange'));
  });
}

export function setTheme(choice) {
  try { localStorage.setItem('cathode_theme', choice); } catch {}
  const t = resolveTheme(choice);
  document.documentElement.setAttribute('data-theme', t);
  const dark = t === 'dark';
  el('theme-icon').textContent  = dark ? '◐' : '◑';
  el('theme-label').textContent = dark ? ' LIGHT' : ' DARK';
  // Keeps the OS/browser chrome (status bar, PWA title bar, etc.) matching
  // the app's own background instead of staying stuck on the dark default.
  el('theme-color-meta').setAttribute('content', dark ? '#0a0a0a' : '#f5f5f5');
}

export function toggleTheme() {
  // The quick toggles pick an explicit theme; Settings can go back to System
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
  el('s-inline-nicks').checked = s.inlineNicks !== false;
  el('s-show-send').checked    = s.showSend    !== false;
  el('s-show-tab').checked     = s.showTab     !== false;
  el('s-theme').value          = themeChoice();
  el('s-text-size').value      = s.textSize   || '';
  el('s-timestamps').value     = s.timestamps || 'HH:mm:ss';
  el('s-dim-joins').checked    = s.dimJoins   !== false;
  el('s-filter-lines').checked = s.filterLines !== false;
  el('s-enclose-nick').checked = !!s.encloseNick;
  el('s-sync-read').checked    = s.syncRead   !== false;
  el('s-notifications').checked = notificationsEnabled();
  updateNotifNote();
  el('s-keep-awake').checked  = s.keepAwake === true;
  el('s-keep-awake').disabled = !wakeLockSupported();
  el('s-awake-note').textContent = wakeLockSupported() ? ''
    : isSecureContext ? 'Not supported by this browser.'
    : 'Needs Cathode served over HTTPS.';
  updateBackendVis();
  el('settings-overlay').style.display = '';
  overlayOpened('settings', hideSettings);
}

function hideSettings() {
  el('settings-overlay').style.display = 'none';
}

export function closeSettings() {
  if (el('settings-overlay').style.display === 'none') return;
  hideSettings();
  overlayClosed('settings');
}

// Display preferences that are pure CSS: body classes and a size variable.
// inline-nicks / hide-send / hide-tab only take effect below 700px.
export function applyDisplaySettings() {
  const s = state.settings;
  const b = document.body.classList;
  b.toggle('inline-nicks', s.inlineNicks !== false);
  b.toggle('hide-send',    s.showSend === false);
  b.toggle('hide-tab',     s.showTab  === false);
  b.toggle('dim-joins',    s.dimJoins !== false);
  b.toggle('time-short',   s.timestamps === 'HH:mm');
  b.toggle('time-none',    s.timestamps === 'none');
  const root = document.documentElement.style;
  if (s.textSize) root.setProperty('--msg-size', s.textSize + 'px');
  else root.removeProperty('--msg-size');
  applyPrefixWidth();
}

// ─── Notifications ────────────────────────────────────────────────────────────
// Off until switched on here: the permission prompt has to come from a tap
// (browsers quietly block prompts that don't). Older setups that already
// granted permission keep notifying.
export function notificationsEnabled() {
  if (!('Notification' in window)) return false;
  const v = state.settings.notifications;
  if (v === undefined) return Notification.permission === 'granted';
  return v && Notification.permission === 'granted';
}

function updateNotifNote() {
  const note = el('s-notif-note');
  const box  = el('s-notifications');
  if (!('Notification' in window)) {
    box.disabled = true;
    note.textContent = 'Not supported here (on iPhone: add Cathode to the Home Screen first).';
  } else if (Notification.permission === 'denied') {
    note.textContent = 'Blocked in the browser’s site settings — allow notifications there first.';
  } else {
    note.textContent = '';
  }
}

async function onNotifToggle() {
  const box = el('s-notifications');
  if (box.checked && 'Notification' in window && Notification.permission === 'default') {
    const p = await Notification.requestPermission();
    if (p !== 'granted') box.checked = false;
  }
  updateNotifNote();
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
  state.settings.inlineNicks = el('s-inline-nicks').checked;
  state.settings.showSend    = el('s-show-send').checked;
  state.settings.showTab     = el('s-show-tab').checked;
  state.settings.textSize    = el('s-text-size').value;
  state.settings.timestamps  = el('s-timestamps').value;
  state.settings.dimJoins    = el('s-dim-joins').checked;
  state.settings.filterLines = el('s-filter-lines').checked;
  state.settings.encloseNick = el('s-enclose-nick').checked;
  state.settings.syncRead    = el('s-sync-read').checked;
  state.settings.notifications = el('s-notifications').checked;
  state.settings.keepAwake   = el('s-keep-awake').checked;
  updateWakeLock();
  applyDisplaySettings();
  if (el('s-theme').value !== themeChoice()) {
    setTheme(el('s-theme').value);
    window.dispatchEvent(new CustomEvent('cathode:themechange'));
  }
  window.dispatchEvent(new CustomEvent('cathode:displaychange'));
  saveSettings();
  updateUploadButtonVisibility();
  closeSettings();
}

export function initSettingsPanel() {
  el('s-notifications').addEventListener('change', onNotifToggle);
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
