import { state, saveSettings } from './state.js';
import { ansiToHtml } from './ansi.js';
import { applySearch } from './search.js';
import { embedFor } from './embeds.js';

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
  // IBM Plex Mono is ~0.63em per char (8.2px at 13px); follow the text size
  const narrow = window.matchMedia('(max-width: 700px)').matches;
  const size   = parseFloat(state.settings.textSize) || (narrow ? 12 : 13);
  const chars = state.prefixAlignMax + (state.settings.encloseNick ? 2 : 0);   // + "<>"
  const px = Math.round(chars * size * 0.63) + 16;
  document.documentElement.style.setProperty('--prefix-col-width', px + 'px');
}

// ─── Chat header ──────────────────────────────────────────────────────────────
// Lines WeeChat's own /filter hides (the smart filter "irc_smart" included)
// arrive with displayed: false. Like weechat-android's "Filter lines", one
// global switch either respects that (default) or shows everything.
export const hideFiltered = () => state.settings.filterLines !== false;

export function renderChatHeader() {
  const buf = state.buffers.get(state.activeBufferId);
  if (!buf) return;
  el('chat-title').textContent = buf.short_name || buf.name || '';
  el('chat-topic').innerHTML   = buf.title ? ansiToHtml(buf.title) : '';
  const lv = buf.local_variables || {};
  // Phone app bar: second line under the title (topic lives in the ⋮ sheet)
  const n   = Object.keys(buf.nicks || {}).length;
  const sub = [lv.server && lv.server !== buf.short_name ? lv.server : '',
               lv.type === 'channel' && n ? `${n} user${n === 1 ? '' : 's'}` : ''];
  el('chat-sub').textContent = sub.filter(Boolean).join(' · ');
  el('nicklist-toggle').style.display = buf.nicklist || n ? '' : 'none';
  const sfBtn = el('smartfilter-btn');
  const on    = hideFiltered();
  sfBtn.textContent = on ? 'FILTERED: HIDDEN' : 'FILTERED: SHOWN';
  sfBtn.title       = (on ? 'Show' : 'Hide') + " lines hidden by WeeChat's /filter (e.g. the smart filter)";
  sfBtn.classList.toggle('sf-off', !on);
  sfBtn.style.display = '';
}

export function toggleFilterLines() {
  state.settings.filterLines = !hideFiltered();
  saveSettings();
  renderChatHeader();
  const buf = state.buffers.get(state.activeBufferId);
  if (buf) renderMessages(buf);
}

// ─── Message rendering ────────────────────────────────────────────────────────
// keepScroll: re-render in place (line edited, free buffer updated) without
// jumping to the bottom unless the view was already pinned there.
export function renderMessages(buf, keepScroll = false) {
  const box = el('messages');
  const top = box.scrollTop;
  box.innerHTML = '';
  delete box.dataset.insertDividerAfterNext;
  // Nothing read yet: the marker sits before the first line
  if (buf.lastReadId == null && buf.firstLineNotRead && buf.type !== 'free')
    box.dataset.insertDividerAfterNext = '1';
  if (buf.type !== 'free' && !buf.allLoaded && buf.lines.length) {
    const more = document.createElement('button');
    more.className   = 'load-older';
    more.textContent = buf.loadingOlder ? 'fetching…' : '↑ fetch more lines';
    more.disabled    = !!buf.loadingOlder;
    more.addEventListener('click', () =>
      window.dispatchEvent(new CustomEvent('cathode:loadolder', { detail: buf.id })));
    box.appendChild(more);
  }
  for (const line of buf.lines) appendLine(line, false, buf.lastReadId ?? null);
  box.scrollTop = (keepScroll && !state.scroll.pinned) ? top : box.scrollHeight;
  box.onscroll  = onMessagesScroll;
  applySearch();
}

// Joins, parts, quits and nick changes ("non-human" lines in weechat-android)
const JOINPART_TAGS = ['irc_join', 'irc_part', 'irc_quit', 'irc_nick', 'irc_smart_filter'];
const isJoinPart = line => (line.tags || []).some(t => JOINPART_TAGS.includes(t));

// Settings → "<nick>" brackets (weechat-android's enclose_nick): only lines
// someone said — not joins, /me actions or network notices
function isNickMessage(line) {
  const tags = line.tags || [];
  return tags.some(t => t.startsWith('nick_')) && !isJoinPart(line) && !tags.includes('irc_action');
}

export function appendLine(line, scroll = true, lastReadId = null) {
  const box = el('messages');
  const isLastRead = lastReadId !== null && String(line.id) === String(lastReadId);
  // Even when the last-read line itself is hidden below, the divider still
  // has to go before the next line that is shown.
  if (isLastRead) box.dataset.insertDividerAfterNext = '1';

  if (!line.displayed && hideFiltered()) return;

  // Read marker divider — insert before the first unread line
  if (isLastRead) {
    // This is the last-read line; the divider goes before the next shown line.
  } else if (box.dataset.insertDividerAfterNext === '1') {
    delete box.dataset.insertDividerAfterNext;
    const divider = document.createElement('div');
    divider.className   = 'read-marker';
    divider.textContent = '─── unread ───';
    box.appendChild(divider);
  }

  const subLines = (line.message || '').split('\n');
  const time     = line.date ? fmtTime(line.date) : '';
  let   prefix   = line.prefix ? ansiToHtml(truncPrefix(line.prefix)) : '';
  if (prefix && state.settings.encloseNick && isNickMessage(line))
    prefix = `<span class="nick-chev">&lt;</span>${prefix}<span class="nick-chev">&gt;</span>`;
  const hlClass  = (line.highlight ? ' msg-highlight' : '') + (isJoinPart(line) ? ' msg-joinpart' : '')
                 + (line.displayed ? '' : ' msg-filtered');   // shown although WeeChat filters it

  subLines.forEach((sub, i) => {
    const row = document.createElement('div');
    row.className = 'msg-row' + hlClass + (i > 0 ? ' msg-cont' : '');
    row._line = line;   // for tap / long-press actions
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
    // Settings → show images & videos automatically (loads them from the
    // linked site, so it's off by default)
    if (state.settings.autoMedia) row.querySelectorAll('.media-toggle').forEach(b => toggleMedia(b, { auto: true }));
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

// ─── Inline images / videos ───────────────────────────────────────────────────
// "Show Image" / "Show Video" / "▶ YouTube" buttons (added by ansiToHtml)
// toggle a preview loaded straight from the linked site. Streaming players
// only load on a click; shown automatically they start as a thumbnail card.
const btnLabel = (type, url) =>
  type === 'img' ? 'Show Image' : type === 'vid' ? 'Show Video' : `▶ ${embedFor(url)?.provider || 'Play'}`;

export function toggleMedia(btn, { auto = false } = {}) {
  const url      = btn.dataset.url.replace(/&amp;/g, '&');
  const type     = btn.dataset.type;
  const existing = btn.nextElementSibling;
  if (existing && existing.classList.contains('media-preview')) {
    existing.remove();
    btn.textContent = btnLabel(type, url);
    return;
  }
  const wrap = document.createElement('span');
  wrap.className = 'media-preview';
  // Media arriving late would push the view up; stay at the bottom if pinned
  const keepPinned = () => {
    const box = el('messages');
    if (state.scroll.pinned) box.scrollTop = box.scrollHeight;
  };
  if (type === 'embed') {
    const e = embedFor(url);
    if (!e) return;
    wrap.classList.add('embed', 'kind-' + e.kind);
    if (auto) wrap.appendChild(embedCard(e, wrap));
    else      wrap.appendChild(embedFrame(e));
    btn.after(wrap);
    btn.textContent = 'Hide ' + e.provider;
    requestAnimationFrame(keepPinned);
    return;
  }
  if (type === 'img') {
    const img     = document.createElement('img');
    img.src       = url;
    img.className = 'preview-img';
    img.alt       = 'image';
    img.title     = 'Click to open full size';
    img.loading   = 'lazy';
    img.addEventListener('load', keepPinned);
    img.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
    wrap.appendChild(img);
  } else {
    const vid     = document.createElement('video');
    vid.src       = url;
    vid.controls  = true;
    vid.preload   = 'metadata';   // first frame and duration, no autoplay
    vid.className = 'preview-vid';
    vid.addEventListener('loadedmetadata', keepPinned);
    wrap.appendChild(vid);
  }
  btn.after(wrap);
  btn.textContent = type === 'img' ? 'Hide Image' : 'Hide Video';
}

function embedFrame(e) {
  const f = document.createElement('iframe');
  f.src   = e.src;
  f.title = e.provider + ' player';
  f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen; clipboard-write';
  f.allowFullscreen = true;
  // YouTube refuses embeds that don't say which site they're on (error 153)
  f.referrerPolicy  = 'strict-origin-when-cross-origin';
  f.className = 'embed-frame';
  return f;
}

// Click-to-play card: no player code loads until it's tapped (the YouTube
// thumbnail is the only request, and only when shown automatically)
function embedCard(e, wrap) {
  const card = document.createElement('button');
  card.type      = 'button';
  card.className = 'embed-card';
  card.setAttribute('aria-label', `Play on ${e.provider}`);
  if (e.thumb) {
    const img = document.createElement('img');
    img.src = e.thumb; img.alt = ''; img.loading = 'lazy';
    card.appendChild(img);
  }
  const play = document.createElement('span');
  play.className   = 'embed-play';
  play.textContent = `▶ ${e.provider}`;
  card.appendChild(play);
  card.addEventListener('click', () => card.replaceWith(embedFrame(e)));
  return card;
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
  // Reaching the top fetches older lines on its own; the "fetch more lines"
  // button is there for buffers too short to scroll
  if (box.scrollTop < 60) {
    const buf = state.buffers.get(state.activeBufferId);
    if (buf && buf.type !== 'free' && !buf.allLoaded && !buf.loadingOlder && buf.lines.length)
      window.dispatchEvent(new CustomEvent('cathode:loadolder', { detail: buf.id }));
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
  const fmt = state.settings.timestamps || 'HH:mm:ss';
  if (fmt === 'none') return '';
  const opts = { hour:'2-digit', minute:'2-digit', hour12:false };
  if (fmt === 'HH:mm:ss') opts.second = '2-digit';
  try { return new Date(iso).toLocaleTimeString([], opts); }
  catch { return ''; }
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
