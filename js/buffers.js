import { state, saveSettings } from './state.js';
import { ansiToHtml, nickColorToCss, safeFg } from './ansi.js';
import { renderMessages, renderChatHeader, hideNewMsgBanner, appendLine } from './chat.js';
import { maybeNotify, updateTitle } from './notifications.js';

const el  = id => document.getElementById(id);
const esc = s  => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// ─── Buffer events ────────────────────────────────────────────────────────────
export function onBufOpened(buf) {
  if (!buf) return;
  state.buffers.set(buf.id, { ...buf, lines: buf.lines||[], nicks:{}, unread:0, highlight:0 });
  if (!state.smartFilter.has(buf.id)) state.smartFilter.set(buf.id, true);
  rebuildBufList();
  if (state.activeBufferId == null) activateBuffer(buf.id);
}

export function onBufUpdated(buf) {
  if (!buf) return;
  const b = state.buffers.get(buf.id);
  if (!b) return;
  Object.assign(b, buf);
  paintNode(buf.id);
  if (state.activeBufferId === buf.id) renderChatHeader();
}

export function onBufCleared(id) {
  const b = state.buffers.get(id);
  if (b) { b.lines = []; if (state.activeBufferId === id) el('messages').innerHTML = ''; }
}

export function onBufClosed(id) {
  state.buffers.delete(id);
  removeNode(id);
  if (state.activeBufferId === id) {
    const first = state.buffers.keys().next().value;
    if (first != null) activateBuffer(first);
    else { state.activeBufferId = null; el('messages').innerHTML = ''; }
  }
}

export function onLineAdded(id, line) {
  if (!line) return;
  const b = state.buffers.get(id);
  if (!b) return;
  b.lines.push(line);
  if (state.activeBufferId === id) {
    appendLine(line);
  } else {
    b.unread++;
    if (line.highlight) b.highlight++;
    paintNode(id);
  }
  maybeNotify(b, line, activateBuffer);
  updateTitle();
}

// ─── Nick events ──────────────────────────────────────────────────────────────
export function collectNicks(group, out) {
  if (!group) return;
  for (const n of (group.nicks  || [])) out[n.id] = n;
  for (const g of (group.groups || [])) collectNicks(g, out);
}

export function onNickAdded(id, nick) {
  const b = state.buffers.get(id);
  if (!b || !nick) return;
  b.nicks[nick.id] = nick;
  if (state.activeBufferId === id) renderNicklist(b);
}

export function onNickRemoved(id, nick) {
  const b = state.buffers.get(id);
  if (!b || !nick) return;
  delete b.nicks[nick.id];
  if (state.activeBufferId === id) renderNicklist(b);
}

export function onGroupChanged(id) {
  const b = state.buffers.get(id);
  if (b && state.activeBufferId === id) renderNicklist(b);
}

// ─── Nicklist ─────────────────────────────────────────────────────────────────
export function renderNicklist(buf) {
  const box   = el('nicklist');
  box.innerHTML = '';
  const nicks = Object.values(buf.nicks || {}).sort((a, b) => {
    const w = p => p==='~'?0 : p==='&'?1 : p==='@'?2 : p==='%'?3 : p==='+'?4 : 5;
    const d = w(a.prefix) - w(b.prefix);
    return d !== 0 ? d : a.name.localeCompare(b.name, undefined, {sensitivity:'base'});
  });
  for (const nick of nicks) {
    const row = document.createElement('div');
    row.className = 'nick-item';
    const pfxChar = (nick.prefix && nick.prefix.trim()) ? esc(nick.prefix) : ' ';
    const pfxHtml = nick.prefix_color
      ? `<span class="nick-pfx" style="color:${nickColorToCss(nick.prefix_color)}">${pfxChar}</span>`
      : `<span class="nick-pfx">${pfxChar}</span>`;
    const nameHtml = nick.color
      ? `<span class="nick-name" style="color:${safeFg(nickColorToCss(nick.color))}">${esc(nick.name)}</span>`
      : `<span class="nick-name">${esc(nick.name)}</span>`;
    row.innerHTML = pfxHtml + nameHtml;
    row.addEventListener('click', () => openNickMenu(nick, buf));
    box.appendChild(row);
  }
}

// ─── Nick context menu ────────────────────────────────────────────────────────
function openNickMenu(nick, buf) {
  closeNickMenu();
  const overlay = document.createElement('div');
  overlay.id        = 'nick-overlay';
  overlay.className = 'nick-overlay';
  overlay.addEventListener('click', e => { if (e.target === overlay) closeNickMenu(); });

  const menu = document.createElement('div');
  menu.className = 'nick-menu';

  const hdr = document.createElement('div');
  hdr.className   = 'nick-menu-hdr';
  hdr.textContent = (nick.prefix && nick.prefix.trim() ? nick.prefix : '') + nick.name;
  menu.appendChild(hdr);

  const myPfx = ownPrefix(buf);
  const isOp  = ['@','~','&'].includes(myPfx);

  const actions = [
    { label: '💬  Query',        cmd: `/query ${nick.name}` },
    { label: '🔍  Whois',        cmd: `/whois ${nick.name}` },
    { label: '🔍  Whois (full)', cmd: `/whois ${nick.name} ${nick.name}` },
    { label: '📌  Ignore',       cmd: `/ignore ${nick.name}` },
    { label: '🔇  Kick',         cmd: `/kick ${nick.name}`,  op: true },
    { label: '🚫  Ban',          cmd: `/ban ${nick.name}`,   op: true },
  ];
  for (const a of actions) {
    if (a.op && !isOp) continue;
    const btn = document.createElement('button');
    btn.className   = 'nick-menu-btn';
    btn.textContent = a.label;
    btn.addEventListener('click', () => {
      wsSendRef(a.cmd, buf.name);
      closeNickMenu();
    });
    menu.appendChild(btn);
  }

  overlay.appendChild(menu);
  document.body.appendChild(overlay);
  overlay._esc = e => { if (e.key === 'Escape') closeNickMenu(); };
  document.addEventListener('keydown', overlay._esc);
}

function closeNickMenu() {
  const ov = document.getElementById('nick-overlay');
  if (!ov) return;
  document.removeEventListener('keydown', ov._esc);
  ov.remove();
}

function ownPrefix(buf) {
  const nick  = (buf.local_variables || {}).nick || '';
  const entry = Object.values(buf.nicks || {}).find(n => n.name === nick);
  return entry ? (entry.prefix || '') : '';
}

// wsSend reference — set by main.js after connection module loads
let wsSendRef = () => {};
export function setWsSend(fn) {
  wsSendRef = (cmd, bufName) => fn({ request: 'POST /api/input', body: { buffer_name: bufName, command: cmd } });
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

function buildWanted() {
  const sorted = [...state.buffers.values()].sort((a,b) => a.number - b.number);
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

export function rebuildBufList() {
  const container = el('buffer-list');
  for (const [,node] of bufNodes) node.remove();
  bufNodes.clear();
  for (const item of buildWanted()) {
    const node = makeNode(item);
    bufNodes.set(item.key, node);
    container.appendChild(node);
  }
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
    `<button class="buf-close" data-id="${buf.id}" title="Close buffer">×</button>`;
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
  node.addEventListener('click', () => activateBuffer(Number(node.dataset.id)));
  const classes = ['buffer-item'];
  if (isServer) classes.push('buf-server');
  if (indent)   classes.push('buf-indented');
  node.className = classes.join(' ');
  const buf  = item.buf;
  const name = buf.short_name || buf.name || '?';
  node.innerHTML =
    `<span class="buf-num">${buf.number}</span>` +
    `<span class="buf-name">${esc(name)}</span>` +
    `<button class="buf-close" data-id="${buf.id}" title="Close buffer">×</button>`;
  return node;
}

// ─── Activate buffer ──────────────────────────────────────────────────────────
export function activateBuffer(id) {
  const prev = state.activeBufferId;
  const buf  = state.buffers.get(id);
  if (!buf) return;
  state.activeBufferId  = id;
  state.scroll.pinned   = true;
  state.scroll.newCount = 0;
  buf.unread    = 0;
  buf.highlight = 0;
  if (prev != null && prev !== id) paintNode(prev);
  paintNode(id);
  renderChatHeader();
  renderMessages(buf);
  renderNicklist(buf);
  hideNewMsgBanner();
  updateTitle();
  el('chat-input').focus();

  // Sync read position back to WeeChat by switching to the buffer there too.
  // This marks lines as read in WeeChat's state, updating last_read_line_id.
  // We send it as a direct API input command rather than going through the input box.
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      request: 'POST /api/input',
      body: { buffer_name: 'core.weechat', command: `/buffer ${buf.name}` }
    }));
  }
}
