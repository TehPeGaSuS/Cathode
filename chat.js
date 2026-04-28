import { state } from './state.js';
import { ansiToHtml } from './ansi.js';

const el = id => document.getElementById(id);

// ─── Prefix truncation ────────────────────────────────────────────────────────
// Mirrors weechat.look.prefix_align_max — truncates long nicks in the prefix
// column. Strips ANSI to measure visible length, re-wraps with original escape.
//
// IMPORTANT: the regex literals below must contain a literal ESC byte (0x1b).
// Do not modify with automated text replacement tools.
export function truncPrefix(raw) {
  if (!raw) return raw;
  const visible = raw.replace(/\x1b\[[0-9;]*m/g, '');
  const max     = state.prefixAlignMax;
  if (visible.length <= max) return raw;
  // Preserve leading colour escape, truncate visible chars, close with reset
  const esc   = raw.match(/^(\x1b\[[0-9;]*m)*/);
  const lead  = esc ? esc[0] : '';
  const plain = visible.slice(0, max - 1) + '…';
  return lead + plain + '\x1b[0m';
}

export function applyPrefixWidth() {
  const charWidth = 8.2; // IBM Plex Mono px/char at 13px
  const px = Math.round(state.prefixAlignMax * charWidth) + 16;
  document.documentElement.style.setProperty('--prefix-col-width', px + 'px');
}

// ─── Chat header ──────────────────────────────────────────────────────────────
export function renderChatHeader() {
  const buf = state.buffers.get(state.activeBufferId);
  if (!buf) return;
  el('chat-title').textContent = buf.short_name || buf.name || '';
  el('chat-topic').innerHTML   = buf.title ? ansiToHtml(buf.title) : '';
  const lv    = buf.local_variables || {};
  const isIrc = lv.plugin === 'irc' && lv.type !== 'server';
  const sfBtn = el('smartfilter-btn');
  if (isIrc) {
    const on = state.smartFilter.get(buf.id) !== false;
    sfBtn.textContent = on ? 'FILTER: ON' : 'FILTER: OFF';
    sfBtn.classList.toggle('sf-off', !on);
    sfBtn.style.display = '';
  } else {
    sfBtn.style.display = 'none';
  }
}

export function toggleSmartFilter() {
  const id = state.activeBufferId;
  if (id == null) return;
  const cur = state.smartFilter.get(id) !== false;
  state.smartFilter.set(id, !cur);
  renderChatHeader();
  const buf = state.buffers.get(id);
  if (buf) renderMessages(buf);
}

// ─── Message rendering ────────────────────────────────────────────────────────
export function renderMessages(buf) {
  const box = el('messages');
  box.innerHTML = '';
  for (const line of buf.lines) appendLine(line, false, buf.lastReadId);
  box.scrollTop = box.scrollHeight;
  box.onscroll  = onMessagesScroll;
}

export function appendLine(line, scroll = true, lastReadId = null) {
  if (!line.displayed) return;
  // Smart filter: skip join/part/quit noise tagged by WeeChat
  if (line.tags && line.tags.includes('irc_smart_filter')) {
    if (state.smartFilter.get(state.activeBufferId) !== false) return;
  }
  const box      = el('messages');

  // Read marker divider — insert before the first unread line
  if (lastReadId !== null && String(line.id) === String(lastReadId)) {
    // This is the last-read line; the NEXT line will be unread.
    // We track this by inserting the divider after this line is appended.
    // We use a sentinel attribute on the box so we know to insert after this row.
    box.dataset.insertDividerAfterNext = '1';
  } else if (box.dataset.insertDividerAfterNext === '1') {
    delete box.dataset.insertDividerAfterNext;
    const divider = document.createElement('div');
    divider.className   = 'read-marker';
    divider.textContent = '─── unread ───';
    box.appendChild(divider);
  }

  const subLines = (line.message || '').split('\n');
  const time     = line.date ? fmtTime(line.date) : '';
  const prefix   = line.prefix ? ansiToHtml(truncPrefix(line.prefix)) : '';
  const hlClass  = line.highlight ? ' msg-highlight' : '';

  subLines.forEach((sub, i) => {
    const row = document.createElement('div');
    row.className = 'msg-row' + hlClass;
    if (i === 0) {
      row.innerHTML =
        `<span class="msg-time">${time}</span>` +
        `<span class="msg-prefix">${prefix}</span>` +
        `<span class="msg-sep"></span>` +
        `<span class="msg-text">${ansiToHtml(sub)}</span>`;
    } else {
      row.innerHTML =
        `<span class="msg-time"></span>` +
        `<span class="msg-prefix"></span>` +
        `<span class="msg-sep"></span>` +
        `<span class="msg-text">${ansiToHtml(sub)}</span>`;
    }
    box.appendChild(row);
  });

  if (scroll) {
    if (state.scroll.pinned) {
      box.scrollTop = box.scrollHeight;
    } else {
      state.scroll.newCount++;
      showNewMsgBanner(state.scroll.newCount);
    }
  }
}

export function sysMsg(id, text) {
  if (id != null && id !== state.activeBufferId) return;
  const box = el('messages');
  const row = document.createElement('div');
  row.className = 'msg-row msg-system';
  row.innerHTML =
    `<span class="msg-time">${fmtTime(new Date().toISOString())}</span>` +
    `<span class="msg-prefix">--</span>` +
    `<span class="msg-sep"></span>` +
    `<span class="msg-text">${escHtml(text)}</span>`;
  box.appendChild(row);
  if (state.scroll.pinned) box.scrollTop = box.scrollHeight;
}

// ─── Scroll lock ──────────────────────────────────────────────────────────────
export function onMessagesScroll() {
  const box     = el('messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 2;
  if (atBottom && !state.scroll.pinned) {
    state.scroll.pinned   = true;
    state.scroll.newCount = 0;
    hideNewMsgBanner();
  } else if (!atBottom && state.scroll.pinned) {
    state.scroll.pinned = false;
  }
}

export function showNewMsgBanner(count) {
  let banner = document.getElementById('new-msg-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id        = 'new-msg-banner';
    banner.className = 'new-msg-banner';
    banner.addEventListener('click', () => {
      const box = el('messages');
      box.scrollTop         = box.scrollHeight;
      state.scroll.pinned   = true;
      state.scroll.newCount = 0;
      hideNewMsgBanner();
    });
    el('main').appendChild(banner);
  }
  banner.textContent = `▼  ${count} new message${count === 1 ? '' : 's'}`;
}

export function hideNewMsgBanner() {
  const b = document.getElementById('new-msg-banner');
  if (b) b.remove();
}

// ─── Helpers (local) ─────────────────────────────────────────────────────────
function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString([],
    {hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false}); }
  catch { return ''; }
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
