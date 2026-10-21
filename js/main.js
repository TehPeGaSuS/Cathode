import { state }                                    from './state.js';
import { initTheme, toggleTheme,
         openSettings, closeSettings,
         saveSettingsPanel, updateBackendVis,
         checkPort, openCertPage,
         applyDisplaySettings,
         initSettingsPanel }                        from './settings.js';
import { connect, disconnect, wsSend }              from './connection.js';
import { toggleFilterLines, renderMessages,
         renderChatHeader, applyPrefixWidth,
         toggleMedia }                              from './chat.js';
import { sendInput, onInputKey, triggerTabComplete } from './input.js';
import { uploadFile, initDragDrop,
         updateUploadButtonVisibility }              from './upload.js';
import { initBufferList, activateBuffer, requestOlderLines,
         renderNicklist, rebuildBufList }           from './buffers.js';
import { initMobileLayout, closeDrawer,
         onLongPress }                              from './layout.js';
import { openOverflowSheet, openLineSheet,
         openNickSheet, nickOfLine, confirmDisconnect,
         openJoinPrompt, openRecentSheet }          from './actions.js';
import { hotBuffers }                               from './notifications.js';
import { closeSheet }                               from './sheet.js';
import { initSearch, openSearch, closeSearch,
         isSearchOpen }                             from './search.js';

const el = id => document.getElementById(id);

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  applyDisplaySettings();
  initSettingsPanel();

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
  if (s.rememberPass) {
    el('remember-pass').checked = true;
    if (s.pass) el('password').value = s.pass;
  }
  if (s.prefixAlignMax) state.prefixAlignMax  = s.prefixAlignMax;
  updateUploadButtonVisibility();

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

  // ── Mobile sidebar/nicklist drawers ────────────────────────────────────────
  initMobileLayout();

  // ── Connection ────────────────────────────────────────────────────────────
  el('connect-btn')   .addEventListener('click', connect);
  el('disconnect-btn').addEventListener('click', confirmDisconnect);
  ['host','port','password'].forEach(id =>
    el(id).addEventListener('keydown', e => { if (e.key === 'Enter') connect(); })
  );
  el('port').addEventListener('input', checkPort);
  // Certificate help only matters for wss://
  const syncCertHelp = () => { el('cert-help').style.display = el('tls').checked ? '' : 'none'; };
  el('tls').addEventListener('change', syncCertHelp);
  syncCertHelp();
  el('password-toggle').addEventListener('click', () => {
    const input   = el('password');
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    el('password-toggle').textContent = showing ? 'SHOW' : 'HIDE';
    el('password-toggle').setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    el('password-toggle').setAttribute('aria-pressed', String(!showing));
  });

  // ── Chat input ────────────────────────────────────────────────────────────
  el('send-btn')  .addEventListener('click',   () => sendInput(wsSend));
  el('chat-input').addEventListener('keydown', e  => onInputKey(e, wsSend));
  el('tab-complete-btn').addEventListener('click', triggerTabComplete);

  // ── Smart filter ──────────────────────────────────────────────────────────
  el('smartfilter-btn').addEventListener('click', toggleFilterLines);

  // ── Buffer list (filter, close buttons, long-press) and join ──────────────
  initBufferList();
  el('sidebar-join-btn').addEventListener('click', () => openJoinPrompt(activateBuffer));

  // ── App bar (phones) ──────────────────────────────────────────────────────
  el('overflow-btn').addEventListener('click', openOverflowSheet);
  el('chat-titlebox').addEventListener('click', () => {
    if (window.matchMedia('(max-width: 700px)').matches) openOverflowSheet();
  });
  el('hot-btn').addEventListener('click', () => {
    const next = hotBuffers()[0];
    if (next) activateBuffer(next.id);
  });

  // ── Search, older lines, recent messages ─────────────────────────────────
  initSearch();
  el('search-btn').addEventListener('click', openSearch);
  window.addEventListener('cathode:loadolder', e => requestOlderLines(e.detail));
  // Long-press SEND (or right-click it) to re-use a sent message
  onLongPress(el('inputbar'), '#send-btn', openRecentSheet, { allowButtons: true });
  // Text size / timestamps / dimming changed in Settings
  window.addEventListener('cathode:displaychange', () => {
    applyPrefixWidth();
    renderChatHeader();
    const buf = state.buffers.get(state.activeBufferId);
    if (buf) renderMessages(buf, true);
  });

  // ── Messages: tap a nick, long-press / right-click a line ─────────────────
  el('messages').addEventListener('click', e => {
    const pfx = e.target.closest('.msg-prefix');
    if (!pfx) return;
    const line = pfx.closest('.msg-row')?._line;
    const nick = line && nickOfLine(line);
    const buf  = state.buffers.get(state.activeBufferId);
    if (nick && buf) openNickSheet(nick, buf, activateBuffer);
  });
  onLongPress(el('messages'), '.msg-row', row => {
    const buf = state.buffers.get(state.activeBufferId);
    if (row._line && buf) openLineSheet(row._line, buf, activateBuffer);
  });

  // ── Media preview (document-level delegation) ─────────────────────────────
  document.addEventListener('click', e => {
    const btn = e.target.closest('.media-toggle');
    if (btn) toggleMedia(btn);
  });

  // ── Theme ─────────────────────────────────────────────────────────────────
  el('theme-toggle').addEventListener('click', toggleTheme);
  window.addEventListener('cathode:themechange', () => {
    const buf = state.buffers.get(state.activeBufferId);
    // Colours are baked in at render time (light theme darkens pale ones)
    if (buf) {
      import('./chat.js').then(m => m.renderMessages(buf));
      renderNicklist(buf);
    }
    rebuildBufList();
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
    if (e.key === 'F' && (e.ctrlKey || e.metaKey) && e.shiftKey && state.connected) {
      e.preventDefault();
      if (isSearchOpen()) closeSearch(); else openSearch();
      return;
    }
    if (e.key === 'Escape') {
      closeSheet();
      closeSettings();
      closeDrawer();
      if (_emojiPicker) { _emojiPicker.remove(); _emojiPicker = null; }
    }
  });
});
