import { state, saveSettings } from './state.js';
import { parseId, readMarker, wsSend } from './connection.js';
import { nickColorToCss, safeFg } from './ansi.js';
import { renderMessages, renderChatHeader, hideNewMsgBanner, appendLine } from './chat.js';
import { maybeNotify, updateTitle } from './notifications.js';
import { closeDrawer, onLongPress, isNarrow } from './layout.js';
import { openNickSheet, matchesPending, openBufferSheet, closeBuffer } from './actions.js';

const el  = id => document.getElementById(id);
const esc = s  => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// Cap in-memory scrollback per buffer to avoid unbounded growth on long sessions.
const MAX_LINES = 2000;

// ─── Buffer events ────────────────────────────────────────────────────────────
export function onBufOpened(buf) {
  if (!buf) return;
  const id    = parseId(buf.id);
  const nicks = {};
  collectNicks(buf.nicklist_root, nicks);
  // buffer_opened carries *all* lines of the buffer, so apply the cap here too
  const lines = (buf.lines || []).slice(-MAX_LINES);
  state.buffers.set(id, { ...buf, id, lines, nicks, unread:0, highlight:0, ...readMarker(buf) });
  if (!state.smartFilter.has(id)) state.smartFilter.set(id, true);
  rebuildBufList();
  // A /join or /query sent from Cathode: switch to it here (WeeChat itself
  // was told -noswitch)
  if (state.activeBufferId == null || matchesPending(state.buffers.get(id))) activateBuffer(id);
}

export function onBufUpdated(buf) {
  if (!buf) return;
  const id = parseId(buf.id);
  const b  = state.buffers.get(id);
  if (!b) return;
  const relist = b.number !== buf.number || b.hidden !== buf.hidden
    || b.short_name !== buf.short_name
    || (b.local_variables || {}).type !== (buf.local_variables || {}).type;
  Object.assign(b, { ...buf, id });
  if (relist) rebuildBufList(); else paintNode(id);
  if (state.activeBufferId === id) renderChatHeader();
}

// Response to GET /api/buffers (no lines/nicks), used to resync numbers.
export function onBufNumbers(list) {
  let changed = false;
  for (const buf of (list || [])) {
    const b = state.buffers.get(parseId(buf.id));
    if (b && b.number !== buf.number) { b.number = buf.number; changed = true; }
  }
  if (changed) rebuildBufList();
}

export function onBufCleared(rawId) {
  const id = parseId(rawId);
  const b  = state.buffers.get(id);
  if (b) { b.lines = []; if (state.activeBufferId === id) el('messages').innerHTML = ''; }
}

export function onBufClosed(rawId) {
  const id = parseId(rawId);
  state.buffers.delete(id);
  removeNode(id);
  if (state.activeBufferId === id) {
    const first = state.buffers.keys().next().value;
    if (first != null) activateBuffer(first);
    else { state.activeBufferId = null; el('messages').innerHTML = ''; }
  }
}

export function onLineAdded(rawId, line) {
  if (!line) return;
  const id = parseId(rawId);
  const b  = state.buffers.get(id);
  if (!b) return;

  // Free-content buffers (/fset, /list, …) address lines by "y": a line with
  // an existing y replaces it rather than being appended.
  if (b.type === 'free' && line.y >= 0) {
    const i = b.lines.findIndex(l => l.y >= line.y);
    if (i < 0)                    b.lines.push(line);
    else if (b.lines[i].y === line.y) b.lines[i] = line;
    else                          b.lines.splice(i, 0, line);
    if (state.activeBufferId === id) renderMessages(b, /* keepScroll */ true);
    return;
  }

  b.lines.push(line);
  if (b.lines.length > MAX_LINES) b.lines.splice(0, b.lines.length - MAX_LINES);
  if (state.activeBufferId === id) {
    appendLine(line);
  } else if (countsAsUnread(line, b)) {
    b.unread++;
    if (line.highlight) b.highlight++;
    paintNode(id);
  }
  if (line.displayed) maybeNotify(b, line, activateBuffer);
  updateTitle();
}

// Match WeeChat's hotlist: only displayed lines with notify level ≥ message
// (so no joins/parts at level 0, no notify_none at -1), and nothing Cathode's
// own smart filter would hide.
function countsAsUnread(line, buf) {
  if (!line.displayed) return false;
  if (line.highlight) return true;
  if (!(line.notify_level >= 1)) return false;
  if (line.tags && line.tags.includes('irc_smart_filter')
      && state.smartFilter.get(buf.id) !== false) return false;
  return true;
}

// buffer_line_data_changed: a line was updated in place (same id).
export function onLineChanged(rawId, line) {
  if (!line) return;
  const id = parseId(rawId);
  const b  = state.buffers.get(id);
  if (!b) return;
  const i = b.lines.findIndex(l => String(l.id) === String(line.id));
  if (i < 0) return;
  b.lines[i] = line;
  if (state.activeBufferId === id) renderMessages(b, /* keepScroll */ true);
}

// ─── Nick events ──────────────────────────────────────────────────────────────
export function collectNicks(group, out) {
  if (!group) return;
  for (const n of (group.nicks  || [])) out[n.id] = n;
  for (const g of (group.groups || [])) collectNicks(g, out);
}

export function onNickAdded(rawId, nick) {
  const id = parseId(rawId);
  const b  = state.buffers.get(id);
  if (!b || !nick) return;
  b.nicks[nick.id] = nick;
  if (state.activeBufferId === id) scheduleRenderNicklist(b);
}

export function onNickRemoved(rawId, nick) {
  const id = parseId(rawId);
  const b  = state.buffers.get(id);
  if (!b || !nick) return;
  delete b.nicks[nick.id];
  if (state.activeBufferId === id) scheduleRenderNicklist(b);
}

export function onGroupChanged(rawId) {
  const id = parseId(rawId);
  const b  = state.buffers.get(id);
  if (b && state.activeBufferId === id) scheduleRenderNicklist(b);
}

// ─── Nicklist ─────────────────────────────────────────────────────────────────
// Nick events (join/part bursts, netsplits) can fire dozens of times per
// frame; coalesce them into a single rebuild via rAF instead of rebuilding
// the whole DOM list on every individual event.
let nicklistRaf = null;
function scheduleRenderNicklist(buf) {
  if (nicklistRaf != null) return;
  nicklistRaf = requestAnimationFrame(() => {
    nicklistRaf = null;
    if (state.activeBufferId === buf.id) { renderNicklist(buf); renderChatHeader(); }
  });
}

export function renderNicklist(buf) {
  const box   = el('nicklist');
  box.innerHTML = '';
  const rank  = p => p==='~'?0 : p==='&'?1 : p==='@'?2 : p==='%'?3 : p==='+'?4 : 5;
  const nicks = Object.values(buf.nicks || {})
    .filter(n => n.visible !== false)
    .sort((a, b) => {
      const d = rank((a.prefix || '').trim()) - rank((b.prefix || '').trim());
      return d !== 0 ? d : a.name.localeCompare(b.name, undefined, {sensitivity:'base'});
    });
  el('nicklist-header').textContent = nicks.length ? `${nicks.length} USER${nicks.length === 1 ? '' : 'S'}` : 'NICKS';
  for (const nick of nicks) {
    const row = document.createElement('div');
    row.className    = 'nick-item';
    row.tabIndex      = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `${nick.name} — open actions`);
    const pfxChar = (nick.prefix && nick.prefix.trim()) ? esc(nick.prefix) : ' ';
    const pfxHtml = nick.prefix_color
      ? `<span class="nick-pfx" style="color:${safeFg(nickColorToCss(nick.prefix_color))}">${pfxChar}</span>`
      : `<span class="nick-pfx">${pfxChar}</span>`;
    const nameHtml = nick.color
      ? `<span class="nick-name" style="color:${safeFg(nickColorToCss(nick.color))}">${esc(nick.name)}</span>`
      : `<span class="nick-name">${esc(nick.name)}</span>`;
    row.innerHTML = pfxHtml + nameHtml;
    row.addEventListener('click', () => openNickSheet(nick.name, buf, activateBuffer));
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openNickSheet(nick.name, buf, activateBuffer); }
    });
    box.appendChild(row);
  }
}

// ─── Buffer list DOM ──────────────────────────────────────────────────────────
const bufNodes = new Map();

const bKey = id  => 'b:' + id;
const gKey = key => 'g:' + key;

function bufMeta(buf) {
  const lv     = buf.local_variables || {};
  const plugin = lv.plugin || '';
  const server = lv.server || '';
  const type   = lv.type   || '';
  if (!plugin || plugin === 'core')
    return { group:'\x00core', groupLabel:'weechat', isServer:false, indent:false };
  if (plugin === 'irc') {
    if (type === 'server' || !server)
      return { group: server||buf.name, groupLabel: server||buf.name, isServer:true, indent:false };
    return { group: server, groupLabel: server, isServer:false, indent:true };
  }
  const gk = server ? `${plugin}.${server}` : plugin;
  return { group:gk, groupLabel: server ? `${plugin}/${server}` : plugin,
           isServer:!server, indent:!!server };
}

let bufFilter = '';

function buildWanted() {
  const sorted = [...state.buffers.values()]
    .filter(b => !b.hidden || b.id === state.activeBufferId)
    .sort((a,b) => a.number - b.number);
  // Filtering: a flat list of matches, no group headers
  if (bufFilter) {
    const f = bufFilter.toLowerCase();
    return sorted
      .filter(b => (b.short_name || '').toLowerCase().includes(f) || (b.name || '').toLowerCase().includes(f))
      .map(buf => ({ key:bKey(buf.id), type:'match', buf }));
  }
  const groups = new Map();
  for (const buf of sorted) {
    const m = bufMeta(buf);
    if (!groups.has(m.group)) groups.set(m.group, { label:m.groupLabel, srv:null, ch:[] });
    const g = groups.get(m.group);
    if (m.isServer) g.srv = buf; else g.ch.push(buf);
  }
  const items = [];
  for (const [gk, g] of groups) {
    if (g.srv) items.push({ key:bKey(g.srv.id), type:'server',  buf:g.srv });
    else        items.push({ key:gKey(gk),       type:'header',  label:g.label });
    for (const buf of g.ch)
      items.push({ key:bKey(buf.id), type:'channel', buf });
  }
  return items;
}

// Filter box, close buttons and long-press menu of the buffer list
export function initBufferList() {
  const input = el('buffer-filter');
  input.addEventListener('input', () => { bufFilter = input.value.trim(); rebuildBufList(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const first = el('buffer-list').querySelector('.buffer-item');
      if (first) activateBuffer(first.dataset.id);
      clearBufFilter();
    } else if (e.key === 'Escape') {
      clearBufFilter();
    }
  });
  el('buffer-list').addEventListener('click', e => {
    const btn = e.target.closest('.buf-close');
    if (!btn) return;
    e.stopPropagation();
    const buf = state.buffers.get(btn.dataset.id);
    if (buf) closeBuffer(buf);
  });
  onLongPress(el('buffer-list'), '.buffer-item', node => {
    const buf = state.buffers.get(node.dataset.id);
    if (buf) openBufferSheet(buf, { activate: activateBuffer, onMarkRead: b => {
      b.unread = 0; b.highlight = 0; paintNode(b.id); updateTitle();
    }});
  });
}

function clearBufFilter() {
  const input = el('buffer-filter');
  if (!input.value) return;
  input.value = ''; bufFilter = ''; rebuildBufList();
}

export function rebuildBufList() {
  const container = el('buffer-list');
  for (const [,node] of bufNodes) node.remove();
  bufNodes.clear();
  for (const item of buildWanted()) {
    const node = makeNode(item);
    bufNodes.set(item.key, node);
    container.appendChild(node);
    if (item.buf) paintNode(item.buf.id);   // restore active/unread/badge state
  }
}

// Full teardown of the buffer-list DOM/state, e.g. on user disconnect —
// keeps bufNodes in sync with the DOM instead of leaving it holding
// references to nodes that connection.js cleared out from under it.
export function clearBufList() {
  bufNodes.clear();
  el('buffer-list').innerHTML = '';
}

function paintNode(id) {
  const node = bufNodes.get(bKey(id));
  if (!node) return;
  const buf      = state.buffers.get(id);
  if (!buf) return;
  const isServer = node.dataset.isServer === '1';
  const indent   = node.dataset.indent   === '1';
  const classes  = ['buffer-item'];
  if (isServer)                       classes.push('buf-server');
  if (indent)                         classes.push('buf-indented');
  if (buf.id === state.activeBufferId) classes.push('active');
  if (buf.highlight > 0)              classes.push('highlight');
  else if (buf.unread > 0)            classes.push('unread');
  node.className = classes.join(' ');
  const name  = buf.short_name || buf.name || '?';
  const badge = buf.highlight > 0
    ? `<span class="badge hl-badge">${buf.highlight}</span>`
    : buf.unread > 0 ? `<span class="badge">${buf.unread}</span>` : '';
  node.innerHTML =
    `<span class="buf-num">${buf.number}</span>` +
    `<span class="buf-name">${esc(name)}</span>${badge}` +
    `<button class="buf-close" data-id="${buf.id}" title="Close buffer" aria-label="Close buffer">×</button>`;
}

function removeNode(id) {
  const node = bufNodes.get(bKey(id));
  if (node) { node.remove(); bufNodes.delete(bKey(id)); }
  rebuildBufList();
}

function makeNode(item) {
  if (item.type === 'header') {
    const node = document.createElement('div');
    node.className   = 'buf-group-header';
    node.dataset.key = item.key;
    node.textContent = item.label;
    return node;
  }
  const isServer = item.type === 'server';
  const indent   = item.type === 'channel';
  const node     = document.createElement('div');
  node.dataset.key      = item.key;
  node.dataset.id       = String(item.buf.id);
  node.dataset.isServer = isServer ? '1' : '0';
  node.dataset.indent   = indent   ? '1' : '0';
  node.tabIndex = 0;
  node.setAttribute('role', 'button');
  node.addEventListener('click', () => activateBuffer(node.dataset.id));
  node.addEventListener('keydown', e => {
    if (e.target !== node) return;   // let the nested close button handle its own keys
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateBuffer(node.dataset.id); }
  });
  const classes = ['buffer-item'];
  if (isServer) classes.push('buf-server');
  if (indent)   classes.push('buf-indented');
  node.className = classes.join(' ');
  const buf  = item.buf;
  const name = buf.short_name || buf.name || '?';
  node.innerHTML =
    `<span class="buf-num">${buf.number}</span>` +
    `<span class="buf-name">${esc(name)}</span>` +
    `<button class="buf-close" data-id="${buf.id}" title="Close buffer" aria-label="Close buffer">×</button>`;
  return node;
}

// ─── Activate buffer ──────────────────────────────────────────────────────────
export function activateBuffer(id) {
  const prev = state.activeBufferId;
  const buf  = state.buffers.get(id);
  if (!buf) return;
  const prevBuf = prev != null && prev !== id ? state.buffers.get(prev) : null;
  state.activeBufferId  = id;
  state.scroll.pinned   = true;
  state.scroll.newCount = 0;
  buf.unread    = 0;
  buf.highlight = 0;
  if (prevBuf) {
    // Leaving a buffer: everything in it has been seen, like WeeChat does
    // when switching away — the marker shows up there on the next visit.
    const last = prevBuf.lines[prevBuf.lines.length - 1];
    if (last) { prevBuf.lastReadId = String(last.id); prevBuf.firstLineNotRead = false; }
    paintNode(prev);
  }
  // Hidden buffers are only listed while active, so the list changes shape
  if (buf.hidden || (prevBuf && prevBuf.hidden)) rebuildBufList(); else paintNode(id);
  renderChatHeader();
  renderMessages(buf);
  renderNicklist(buf);
  hideNewMsgBanner();
  updateTitle();
  closeDrawer();
  if (bufFilter) clearBufFilter();
  // On phones, focusing would pop the keyboard up on every buffer switch
  if (!isNarrow()) el('chat-input').focus();
  syncReadState(prevBuf, buf);
}

// Mirror read state to WeeChat without touching which buffer its own windows
// display: "/buffer set" acts on the buffer the input is sent to, so the
// read marker / hotlist of that buffer change and nothing else does.
function syncReadState(left, entered) {
  const reqs = [];
  const cmd  = (b, command) => ({ request: 'POST /api/input', body: { buffer_name: b.name, command } });
  if (left) {
    if (left.type !== 'free') reqs.push(cmd(left, '/buffer set unread'));
    reqs.push(cmd(left, '/buffer set hotlist -1'));
  }
  reqs.push(cmd(entered, '/buffer set hotlist -1'));
  wsSend(reqs);
}
