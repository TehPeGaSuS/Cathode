import { state }                                    from './state.js';
import { initTheme, toggleTheme,
         openSettings, closeSettings,
         saveSettingsPanel, updateBackendVis,
         checkPort, openCertPage }                  from './settings.js';
import { connect, disconnect, wsSend }              from './connection.js';
import { toggleSmartFilter, applyPrefixWidth }      from './chat.js';
import { sendInput, onInputKey }                    from './input.js';
import { uploadFile, initDragDrop }                 from './upload.js';
import { setWsSend }                               from './buffers.js';

const el = id => document.getElementById(id);

document.addEventListener('DOMContentLoaded', () => {
  initTheme();

  // ── Operator config (config.js → window.CATHODE_CONFIG) ──────────────────
  const cfg = window.CATHODE_CONFIG || {};

  if (cfg.uploadBackend) {
    state.settings.uploadBackend = cfg.uploadBackend;
    state.settings.filehostUrl   = cfg.filehostUrl   || '';
    state.settings.imgurClientId = cfg.imgurClientId || '';
    const sec = el('settings-upload-section');
    if (sec) sec.style.display = 'none';
  }
  if (cfg.prefixAlignMax) {
    state.prefixAlignMax          = cfg.prefixAlignMax;
    state.settings.prefixAlignMax = cfg.prefixAlignMax;
  }

  // ── Restore saved connection settings ────────────────────────────────────
  const s = state.settings;
  if (s.host) el('host').value         = s.host;
  if (s.port) el('port').value         = s.port;
  if (s.tls  !== undefined) el('tls').checked = s.tls;
  if (s.prefixAlignMax) state.prefixAlignMax = s.prefixAlignMax;

  // ── Initial UI state ──────────────────────────────────────────────────────
  el('connect-screen').style.display = '';
  el('chat-screen').style.display    = 'none';
  el('status-dot').className         = 'status-dot disconnected';
  el('status-text').textContent      = 'DISCONNECTED';
  el('disconnect-btn').style.display = 'none';

  // HTTPS notice — ws:// is blocked by browsers from https:// pages
  if (location.protocol === 'https:') {
    el('http-notice').style.display      = '';
    el('tls-locked-note').style.display  = '';
  }

  // ── Connection ────────────────────────────────────────────────────────────
  // Wire wsSend into buffers module so nick menu commands work
  setWsSend(wsSend);

  el('connect-btn')   .addEventListener('click',   connect);
  el('disconnect-btn').addEventListener('click',   disconnect);
  ['host','port','password'].forEach(id =>
    el(id).addEventListener('keydown', e => { if (e.key === 'Enter') connect(); })
  );
  el('port').addEventListener('input', checkPort);

  // ── Chat input ────────────────────────────────────────────────────────────
  el('send-btn')   .addEventListener('click',   () => sendInput(wsSend));
  el('chat-input') .addEventListener('keydown', e => onInputKey(e, wsSend));

  // ── Smart filter ──────────────────────────────────────────────────────────
  el('smartfilter-btn').addEventListener('click', toggleSmartFilter);

  // ── Buffer list: close button (delegated) ────────────────────────────────
  el('buffer-list').addEventListener('click', e => {
    const btn = e.target.closest('.buf-close');
    if (!btn) return;
    e.stopPropagation();
    const id  = btn.dataset.id;   // string key matching state.buffers Map
    const buf = state.buffers.get(id);
    if (!buf) return;
    wsSend({ request: 'POST /api/input', body: { buffer_name: buf.name, command: '/close' } });
  });

  // ── Sidebar join button ───────────────────────────────────────────────────
  el('sidebar-join-btn').addEventListener('click', () => {
    const ch  = prompt('Channel to join (e.g. #weechat):');
    if (!ch) return;
    const buf = state.buffers.get(state.activeBufferId);
    if (!buf) return;
    wsSend({ request: 'POST /api/input', body: { buffer_name: buf.name, command: '/join ' + ch } });
  });

  // ── Media preview (delegated — works before chat screen is shown) ────────
  document.addEventListener('click', e => {
    const btn = e.target.closest('.media-toggle');
    if (!btn) return;
    const url      = btn.dataset.url.replace(/&amp;/g, '&');
    const type     = btn.dataset.type;
    const existing = btn.nextElementSibling;
    if (existing && existing.classList.contains('media-preview')) {
      existing.remove();
      btn.textContent = type === 'img' ? 'Show Image' : 'Show Video';
      return;
    }
    const wrap = document.createElement('span');
    wrap.className = 'media-preview';
    if (type === 'img') {
      const img     = document.createElement('img');
      img.src       = url;
      img.className = 'preview-img';
      img.alt       = 'image';
      img.title     = 'Click to open full size';
      img.addEventListener('click', () => window.open(url, '_blank'));
      wrap.appendChild(img);
    } else {
      const vid      = document.createElement('video');
      vid.src        = url;
      vid.controls   = true;
      vid.className  = 'preview-vid';
      wrap.appendChild(vid);
    }
    btn.after(wrap);
    btn.textContent = type === 'img' ? 'Hide Image' : 'Hide Video';
  });

  // ── Theme ─────────────────────────────────────────────────────────────────
  el('theme-toggle').addEventListener('click', toggleTheme);
  // Re-render active buffer when theme changes (so safeFg() is re-evaluated)
  window.addEventListener('cathode:themechange', () => {
    const buf = state.buffers.get(state.activeBufferId);
    if (buf) import('./chat.js').then(m => m.renderMessages(buf));
  });

  // ── Cert helper ───────────────────────────────────────────────────────────
  el('cert-btn').addEventListener('click', openCertPage);

  // ── Upload ────────────────────────────────────────────────────────────────
  el('upload-btn') .addEventListener('click',  () => el('upload-file').click());
  el('upload-file').addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) { uploadFile(file); e.target.value = ''; }
  });
  initDragDrop();

  // ── Settings panel ────────────────────────────────────────────────────────
  el('settings-btn')      .addEventListener('click',  openSettings);
  el('settings-close')    .addEventListener('click',  closeSettings);
  el('settings-save')     .addEventListener('click',  saveSettingsPanel);
  el('s-upload-backend')  .addEventListener('change', updateBackendVis);
  el('settings-overlay')  .addEventListener('click',  e => {
    if (e.target === el('settings-overlay')) closeSettings();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeSettings();
  });
});
