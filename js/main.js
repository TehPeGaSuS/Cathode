import { state }                                    from './state.js';
import { initTheme, toggleTheme,
         openSettings, closeSettings,
         saveSettingsPanel, updateBackendVis,
         checkPort, openCertPage }                  from './settings.js';
import { connect, disconnect, wsSend }              from './connection.js';
import { toggleSmartFilter }                        from './chat.js';
import { sendInput, onInputKey }                    from './input.js';
import { uploadFile, initDragDrop }                 from './upload.js';
import { setWsSend }                                from './buffers.js';

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
  if (s.host) el('host').value                = s.host;
  if (s.port) el('port').value                = s.port;
  if (s.tls  !== undefined) el('tls').checked = s.tls;
  if (s.prefixAlignMax) state.prefixAlignMax  = s.prefixAlignMax;

  // ── Initial UI state ──────────────────────────────────────────────────────
  el('connect-screen').style.display = '';
  el('chat-screen').style.display    = 'none';
  el('status-dot').className         = 'status-dot disconnected';
  el('status-text').textContent      = 'DISCONNECTED';
  el('disconnect-btn').style.display = 'none';

  if (location.protocol === 'https:') {
    el('http-notice').style.display     = '';
    el('tls-locked-note').style.display = '';
  }

  // ── Wire wsSend into buffers (nick menu commands) ─────────────────────────
  setWsSend(wsSend);

  // ── Connection ────────────────────────────────────────────────────────────
  el('connect-btn')   .addEventListener('click', connect);
  el('disconnect-btn').addEventListener('click', disconnect);
  ['host','port','password'].forEach(id =>
    el(id).addEventListener('keydown', e => { if (e.key === 'Enter') connect(); })
  );
  el('port').addEventListener('input', checkPort);

  // ── Chat input ────────────────────────────────────────────────────────────
  el('send-btn')  .addEventListener('click',   () => sendInput(wsSend));
  el('chat-input').addEventListener('keydown', e  => onInputKey(e, wsSend));

  // ── Smart filter ──────────────────────────────────────────────────────────
  el('smartfilter-btn').addEventListener('click', toggleSmartFilter);

  // ── Buffer close buttons (delegated) ─────────────────────────────────────
  el('buffer-list').addEventListener('click', e => {
    const btn = e.target.closest('.buf-close');
    if (!btn) return;
    e.stopPropagation();
    const buf = state.buffers.get(btn.dataset.id);
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

  // ── Media preview (document-level delegation) ─────────────────────────────
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
      const vid     = document.createElement('video');
      vid.src       = url;
      vid.controls  = true;
      vid.className = 'preview-vid';
      wrap.appendChild(vid);
    }
    btn.after(wrap);
    btn.textContent = type === 'img' ? 'Hide Image' : 'Hide Video';
  });

  // ── Theme ─────────────────────────────────────────────────────────────────
  el('theme-toggle').addEventListener('click', toggleTheme);
  window.addEventListener('cathode:themechange', () => {
    const buf = state.buffers.get(state.activeBufferId);
    if (buf) import('./chat.js').then(m => m.renderMessages(buf));
    if (_emojiPicker) { _emojiPicker.remove(); _emojiPicker = null; }
  });

  // ── Emoji picker ──────────────────────────────────────────────────────────
  let _emojiPicker    = null;
  let _emojiDataCache = null;

  async function getEmojiData() {
    if (_emojiDataCache) return _emojiDataCache;
    const res       = await fetch('vendor/emoji-data.json');
    _emojiDataCache = await res.json();
    return _emojiDataCache;
  }

  el('emoji-btn').addEventListener('click', async e => {
    e.stopPropagation();
    if (_emojiPicker) {
      _emojiPicker.remove(); _emojiPicker = null; return;
    }
    if (!window.EmojiMart?.Picker) return;
    const data   = await getEmojiData();
    const theme  = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    _emojiPicker = new EmojiMart.Picker({
      data,
      theme,
      onEmojiSelect: emoji => {
        const input = el('chat-input');
        const pos   = input.selectionStart ?? input.value.length;
        input.value =
          input.value.slice(0, pos) + emoji.native + input.value.slice(pos);
        input.selectionStart = input.selectionEnd = pos + [...emoji.native].length;
        _emojiPicker.remove(); _emojiPicker = null;
        input.focus();
      },
      onClickOutside: () => {
        if (_emojiPicker) { _emojiPicker.remove(); _emojiPicker = null; }
      },
    });
    _emojiPicker.style.cssText = 'position:absolute;bottom:48px;right:8px;z-index:200;';
    el('main').appendChild(_emojiPicker);
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
  el('settings-btn')    .addEventListener('click',  openSettings);
  el('settings-close')  .addEventListener('click',  closeSettings);
  el('settings-save')   .addEventListener('click',  saveSettingsPanel);
  el('s-upload-backend').addEventListener('change', updateBackendVis);
  el('settings-overlay').addEventListener('click',  e => {
    if (e.target === el('settings-overlay')) closeSettings();
  });

  // ── Global keyboard shortcuts ─────────────────────────────────────────────
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeSettings();
      if (_emojiPicker) { _emojiPicker.remove(); _emojiPicker = null; }
    }
  });
});
