'use strict';

// ─── Blocked ports ────────────────────────────────────────────────────────────
const BLOCKED_PORTS = new Set([
  1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,
  101,102,103,104,107,109,110,111,113,115,117,119,123,135,137,139,
  143,161,179,389,427,465,512,513,514,515,526,530,531,532,540,548,
  554,556,563,587,601,636,989,990,993,995,1719,1720,1723,2049,3659,
  4045,5060,5061,6000,6566,6665,6666,6667,6668,6669,6697,10080
]);

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  ws:             null,
  connected:      false,
  buffers:        new Map(),   // id (number) → buffer object
  activeBufferId: null,
  settings:       loadSettings(),
  prefixAlignMax: 16,          // mirrors weechat.look.prefix_align_max
  scroll: { pinned: true, newCount: 0 },
};

// ─── Settings ─────────────────────────────────────────────────────────────────
function loadSettings() {
  try { return JSON.parse(localStorage.getItem('cathode_settings') || '{}'); }
  catch { return {}; }
}
function saveSettings() {
  localStorage.setItem('cathode_settings', JSON.stringify(state.settings));
}

// ─── DOM helper ───────────────────────────────────────────────────────────────
const el = id => document.getElementById(id);

// ─── ANSI → HTML ──────────────────────────────────────────────────────────────
const ANSI16 = [
  '#1a1a1a','#cc3333','#33cc33','#cccc33',
  '#3333cc','#cc33cc','#33cccc','#cccccc',
  '#555555','#ff5555','#55ff55','#ffff55',
  '#5555ff','#ff55ff','#55ffff','#ffffff',
];

function ansi256(n) {
  if (n < 16) return ANSI16[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  const i = n - 16;
  return `rgb(${Math.floor(i/36)*51},${Math.floor((i%36)/6)*51},${(i%6)*51})`;
}

function luminance(css) {
  let r, g, b;
  const m = css.match(/^rgb\((\d+),(\d+),(\d+)\)$/);
  if (m) { r = +m[1]; g = +m[2]; b = +m[3]; }
  else if (css.startsWith('#')) {
    const h = css.slice(1);
    if (h.length === 3) {
      r = parseInt(h[0]+h[0],16); g = parseInt(h[1]+h[1],16); b = parseInt(h[2]+h[2],16);
    } else {
      r = parseInt(h.slice(0,2),16); g = parseInt(h.slice(2,4),16); b = parseInt(h.slice(4,6),16);
    }
  } else return 0.5;
  const lin = c => { c /= 255; return c <= 0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055,2.4); };
  return 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b);
}

// In light theme, force near-white foreground colours to black so they remain legible.
function safeFg(css) {
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  if (theme === 'light' && luminance(css) > 0.70) return '#111111';
  return css;
}

function ansiToHtml(text) {
  if (!text) return '';
  let s = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  let out = '', spans = 0;
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0, m;
  while ((m = re.exec(s)) !== null) {
    out += s.slice(last, m.index);
    last = m.index + m[0].length;
    const codes = m[1].split(';').map(Number);
    const st = [];
    let i = 0;
    while (i < codes.length) {
      const c = codes[i];
      if (c === 0) {
        if (spans > 0) { out += '</span>'.repeat(spans); spans = 0; }
      } else if (c === 1)  { st.push('font-weight:bold');
      } else if (c === 3)  { st.push('font-style:italic');
      } else if (c === 4)  { st.push('text-decoration:underline');
      } else if (c >= 30 && c <= 37)   { st.push(`color:${safeFg(ANSI16[c-30])}`);
      } else if (c === 38 && codes[i+1] === 5) { st.push(`color:${safeFg(ansi256(codes[i+2]))}`); i+=2;
      } else if (c === 38 && codes[i+1] === 2) { st.push(`color:${safeFg(`rgb(${codes[i+2]},${codes[i+3]},${codes[i+4]})`)}`); i+=4;
      } else if (c >= 40 && c <= 47)   { st.push(`background:${ANSI16[c-40]}`);
      } else if (c === 48 && codes[i+1] === 5) { st.push(`background:${ansi256(codes[i+2])}`); i+=2;
      } else if (c === 48 && codes[i+1] === 2) { st.push(`background:rgb(${codes[i+2]},${codes[i+3]},${codes[i+4]})`); i+=4;
      } else if (c >= 90 && c <= 97)   { st.push(`color:${safeFg(ANSI16[c-90+8])}`);
      } else if (c >= 100 && c <= 107) { st.push(`background:${ANSI16[c-100+8]}`);
      }
      i++;
    }
    if (st.length) { out += `<span style="${st.join(';')}">`;  spans++; }
  }
  out += s.slice(last);
  if (spans > 0) out += '</span>'.repeat(spans);
  return out.replace(/(\bhttps?:\/\/[^\s<>"&]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

// ─── WebSocket / connection ───────────────────────────────────────────────────
function buildAuth(pw) {
  return btoa('plain:' + pw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

function connect() {
  const host = el('host').value.trim();
  const port = parseInt(el('port').value, 10);
  const pass = el('password').value;
  const tls  = el('tls').checked;

  if (!host || !port) return showConnError('Host and port are required.');
  if (BLOCKED_PORTS.has(port)) return showConnError(
    `Port ${port} is blocked by browsers. Use a different port — e.g. 9000.`);

  const hostFmt = (host.includes(':') && !host.startsWith('[')) ? `[${host}]` : host;
  const url = `${tls ? 'wss' : 'ws'}://${hostFmt}:${port}/api`;

  hideConnError();
  setConnecting(true);

  // Defer by one frame so the browser paints the button state before opening the socket
  setTimeout(() => {
  let ws;
  try {
    ws = new WebSocket(url, [
      'api.weechat',
      `base64url.bearer.authorization.weechat.${buildAuth(pass)}`
    ]);
  } catch(e) {
    setConnecting(false);
    showConnError(`Could not open WebSocket: ${e.message}`);
    return;
  }

  const timer = setTimeout(() => {
    ws.close();
    setConnecting(false);
    showConnError('Connection timed out. Check host, port, and relay config.');
  }, 8000);

  ws.onopen = () => {
    clearTimeout(timer);
    state.ws        = ws;
    state.connected = true;
    Object.assign(state.settings, { host, port, tls });
    saveSettings();
    onConnected();
  };

  ws.onmessage = e => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    if (Array.isArray(data)) data.forEach(dispatch);
    else dispatch(data);
  };

  ws.onerror = () => {
    clearTimeout(timer);
    setConnecting(false);
    // If on HTTPS with TLS unchecked, the error is almost certainly mixed content
    if (location.protocol === 'https:' && !tls) {
      showConnError('Secure connection error — cannot connect to an unencrypted relay (ws://) from an HTTPS page. Enable TLS on your relay or use a reverse proxy / Zero Trust tunnel.');
    } else {
      showConnError('WebSocket error. Check host, port, TLS, and relay config.');
    }
  };

  ws.onclose = () => {
    clearTimeout(timer);
    if (state.connected) onDisconnected();
  };
  }, 0); // end deferred frame
}

function wsSend(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN)
    state.ws.send(JSON.stringify(obj));
}

function disconnect() {
  wsSend({ request: 'DELETE /api/sync' });
  onDisconnected();
}

// ─── Message dispatch ─────────────────────────────────────────────────────────
function dispatch(msg) {
  if (!msg) return;
  // Push event
  if (msg.code === 0 && msg.event_name) { handleEvent(msg); return; }
  // Init response
  if (msg.request_id === 'init' && msg.body_type === 'buffers') { handleInit(msg); return; }
}

function handleEvent(msg) {
  switch (msg.event_name) {
    case 'buffer_opened':          onBufOpened(msg.body); break;
    case 'buffer_closed':          onBufClosed(msg.buffer_id); break;
    case 'buffer_renamed':
    case 'buffer_title_changed':
    case 'buffer_localvar_added':
    case 'buffer_localvar_changed':
    case 'buffer_localvar_removed':
    case 'buffer_moved':
    case 'buffer_merged':
    case 'buffer_unmerged':
    case 'buffer_hidden':
    case 'buffer_unhidden':        onBufUpdated(msg.body); break;
    case 'buffer_cleared':         onBufCleared(msg.buffer_id); break;
    case 'buffer_line_added':      onLineAdded(msg.buffer_id, msg.body); break;
    case 'nicklist_nick_added':
    case 'nicklist_nick_changed':  onNickAdded(msg.buffer_id, msg.body); break;
    case 'nicklist_nick_removing': onNickRemoved(msg.buffer_id, msg.body); break;
    case 'nicklist_group_added':
    case 'nicklist_group_changed': onGroupChanged(msg.buffer_id); break;
    case 'upgrade':                sysMsg(null, '⟳ WeeChat upgrading…'); break;
    case 'upgrade_ended':          sysMsg(null, '✓ WeeChat upgrade complete.'); break;
    case 'quit':                   onDisconnected(); break;
  }
}

// ─── Connection lifecycle ─────────────────────────────────────────────────────
function onConnected() {
  setStatus('connected', 'CONNECTED');
  // Stay in CONNECTING… state until handleInit() has data ready
  wsSend([
    { request: 'GET /api/buffers?lines=-200&nicks=true&colors=ansi', request_id: 'init' },
    { request: 'POST /api/sync', body: { nicks: true, colors: 'ansi' } }
  ]);
}

function handleInit(msg) {
  state.buffers.clear();
  // Apply saved prefix_align_max from settings if present
  if (state.settings.prefixAlignMax) state.prefixAlignMax = state.settings.prefixAlignMax;
  for (const buf of (msg.body || [])) {
    const nicks = {};
    collectNicks(buf.nicklist_root, nicks);
    state.buffers.set(buf.id, { ...buf, lines: buf.lines||[], nicks, unread:0, highlight:0 });
  }
  // Data is ready — now clear the connecting state and reveal the chat UI
  setConnecting(false);
  el('disconnect-btn').style.display = '';
  applyPrefixWidth();
  showScreen('chat');
  rebuildBufList();
  state.scroll.pinned   = true;
  state.scroll.newCount = 0;
  const first = state.buffers.keys().next().value;
  if (first != null) activateBuffer(first);
}

function onDisconnected() {
  if (!state.connected && !state.ws) return;
  state.connected = false;
  if (state.ws) { try { state.ws.close(); } catch(_){} state.ws = null; }
  setStatus('disconnected', 'DISCONNECTED');
  el('disconnect-btn').style.display = 'none';
  showScreen('connect');
  state.buffers.clear();
  state.activeBufferId = null;
  state.scroll.pinned   = true;
  state.scroll.newCount = 0;
  bufNodes.clear();
  el('buffer-list').innerHTML = '';
  el('messages').innerHTML    = '';
  el('nicklist').innerHTML    = '';
  hideNewMsgBanner();
}

// ─── Buffer events ────────────────────────────────────────────────────────────
function onBufOpened(buf) {
  if (!buf) return;
  state.buffers.set(buf.id, { ...buf, lines:buf.lines||[], nicks:{}, unread:0, highlight:0 });
  rebuildBufList();
  if (state.activeBufferId == null) activateBuffer(buf.id);
}

function onBufUpdated(buf) {
  if (!buf) return;
  const b = state.buffers.get(buf.id);
  if (!b) return;
  Object.assign(b, buf);
  paintNode(buf.id);
  if (state.activeBufferId === buf.id) renderChatHeader();
}

function onBufCleared(id) {
  const b = state.buffers.get(id);
  if (b) { b.lines = []; if (state.activeBufferId === id) el('messages').innerHTML = ''; }
}

function onBufClosed(id) {
  state.buffers.delete(id);
  removeNode(id);
  if (state.activeBufferId === id) {
    const first = state.buffers.keys().next().value;
    if (first != null) activateBuffer(first);
    else { state.activeBufferId = null; el('messages').innerHTML = ''; }
  }
}

function onLineAdded(id, line) {
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
}

// ─── Nick events ──────────────────────────────────────────────────────────────
function collectNicks(group, out) {
  if (!group) return;
  for (const n of (group.nicks  || [])) out[n.id] = n;
  for (const g of (group.groups || [])) collectNicks(g, out);
}

function onNickAdded(id, nick) {
  const b = state.buffers.get(id);
  if (!b || !nick) return;
  b.nicks[nick.id] = nick;
  if (state.activeBufferId === id) renderNicklist(b);
}

function onNickRemoved(id, nick) {
  const b = state.buffers.get(id);
  if (!b || !nick) return;
  delete b.nicks[nick.id];
  if (state.activeBufferId === id) renderNicklist(b);
}

function onGroupChanged(id) {
  const b = state.buffers.get(id);
  if (b && state.activeBufferId === id) renderNicklist(b);
}

// ─── Buffer list — keyed DOM, never wiped ─────────────────────────────────────
// bufNodes maps "b:<id>" and "g:<groupkey>" to their DOM nodes.
// Nodes are created once and reused; click listeners survive all updates.

const bufNodes = new Map();

function bKey(id)   { return 'b:' + id; }
function gKey(k)    { return 'g:' + k; }

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
    if (g.srv) items.push({ key:bKey(g.srv.id), type:'server', buf:g.srv });
    else        items.push({ key:gKey(gk),       type:'header', label:g.label });
    for (const buf of g.ch)
      items.push({ key:bKey(buf.id), type:'channel', buf });
  }
  return items;
}

// Full rebuild — called once on init and whenever structure changes (open/close).
function rebuildBufList() {
  const container = el('buffer-list');
  // Detach all existing nodes
  for (const [,node] of bufNodes) node.remove();
  bufNodes.clear();

  for (const item of buildWanted()) {
    const node = makeNode(item);
    bufNodes.set(item.key, node);
    container.appendChild(node);
  }
}

// Repaint a single buffer node (active state, badge, classes) — no DOM move.
function paintNode(id) {
  const node = bufNodes.get(bKey(id));
  if (!node) return;
  const buf   = state.buffers.get(id);
  if (!buf) return;
  const isServer = node.dataset.isServer === '1';
  const indent   = node.dataset.indent   === '1';

  const classes = ['buffer-item'];
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
    `<span class="buf-name">${escHtml(name)}</span>${badge}`;
}

// Remove a buffer's node; rebuild if group structure changed.
function removeNode(id) {
  const node = bufNodes.get(bKey(id));
  if (node) { node.remove(); bufNodes.delete(bKey(id)); }
  // May need to remove orphaned group header or promote remaining server entry
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

  // Listener reads id from dataset — survives innerHTML updates on the node.
  node.addEventListener('click', () => activateBuffer(Number(node.dataset.id)));

  // Initial paint
  const classes = ['buffer-item'];
  if (isServer) classes.push('buf-server');
  if (indent)   classes.push('buf-indented');
  node.className = classes.join(' ');

  const buf   = item.buf;
  const name  = buf.short_name || buf.name || '?';
  node.innerHTML =
    `<span class="buf-num">${buf.number}</span>` +
    `<span class="buf-name">${escHtml(name)}</span>`;

  return node;
}

// ─── Activate buffer ──────────────────────────────────────────────────────────
function activateBuffer(id) {
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
  el('chat-input').focus();
}

// ─── Chat rendering ───────────────────────────────────────────────────────────
function renderChatHeader() {
  const buf = state.buffers.get(state.activeBufferId);
  if (!buf) return;
  el('chat-title').textContent = buf.short_name || buf.name || '';
  el('chat-topic').innerHTML   = buf.title ? ansiToHtml(buf.title) : '';
}

function renderMessages(buf) {
  const box = el('messages');
  box.innerHTML = '';
  for (const line of buf.lines) appendLine(line, false);
  box.scrollTop = box.scrollHeight;
  // Re-attach scroll listener (innerHTML wipe doesn't remove it, but be safe)
  box.onscroll = onMessagesScroll;
}

function appendLine(line, scroll = true) {
  if (!line.displayed) return;
  const box = el('messages');

  // WeeChat may put newlines in a single message — split into sub-lines.
  const msgRaw    = line.message || '';
  const subLines  = msgRaw.split('\n');
  const time      = line.date ? fmtTime(line.date) : '';
  const prefix    = line.prefix ? ansiToHtml(truncPrefix(line.prefix)) : '';
  const hlClass   = line.highlight ? ' msg-highlight' : '';

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
      // Continuation line: blank time, blank prefix, same separator
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

function sysMsg(id, text) {
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

// ─── Scroll lock + new-messages banner ───────────────────────────────────────
function onMessagesScroll() {
  const box = el('messages');
  // "Pinned" = within 2px of the bottom (tolerance for subpixel rounding)
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 2;
  if (atBottom && !state.scroll.pinned) {
    state.scroll.pinned   = true;
    state.scroll.newCount = 0;
    hideNewMsgBanner();
  } else if (!atBottom && state.scroll.pinned) {
    state.scroll.pinned = false;
  }
}

function showNewMsgBanner(count) {
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

function hideNewMsgBanner() {
  const b = document.getElementById('new-msg-banner');
  if (b) b.remove();
}

// ─── Prefix truncation (weechat.look.prefix_align_max) ────────────────────────
// Strips ANSI, measures visible length, re-truncates the raw string.
function truncPrefix(raw) {
  if (!raw) return raw;
  const visible = raw.replace(/\[[0-9;]*m/g, '');
  const max     = state.prefixAlignMax;
  if (visible.length <= max) return raw;
  // Keep the leading ANSI resets/colour codes then truncate visible chars
  // Simple approach: strip ANSI, truncate, re-wrap with original opening escape
  const firstEsc = raw.match(/^(\[[0-9;]*m)*/);
  const prefix   = firstEsc ? firstEsc[0] : '';
  const plain    = visible.slice(0, max - 1) + '…';
  return prefix + plain + '[0m';
}

function applyPrefixWidth() {
  // Set a CSS variable so the prefix column matches prefix_align_max chars
  // IBM Plex Mono is monospaced at ~8px/char at 13px font size
  const charWidth = 8.2;
  const px = Math.round(state.prefixAlignMax * charWidth) + 16; // +16 for padding
  document.documentElement.style.setProperty('--prefix-col-width', px + 'px');
}

// ─── Nicklist ─────────────────────────────────────────────────────────────────
function renderNicklist(buf) {
  const box = el('nicklist');
  box.innerHTML = '';
  const nicks = Object.values(buf.nicks || {}).sort((a,b) => {
    const w = p => p==='@'?0 : p==='+'?1 : 2;
    const d = w(a.prefix) - w(b.prefix);
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });
  for (const nick of nicks) {
    const row = document.createElement('div');
    row.className = 'nick-item';

    // Prefix character — use prefix_color ANSI if provided, else dim default
    const pfxChar = (nick.prefix && nick.prefix.trim()) ? escHtml(nick.prefix) : ' ';
    const pfxHtml = nick.prefix_color
      ? `<span class="nick-pfx" style="color:${nickColorToCss(nick.prefix_color)}">${pfxChar}</span>`
      : `<span class="nick-pfx">${pfxChar}</span>`;

    // Nick name — use color ANSI if provided (irc.look.color_nicks_in_nicklist)
    const nameHtml = nick.color
      ? `<span class="nick-name" style="color:${safeFg(nickColorToCss(nick.color))}">${escHtml(nick.name)}</span>`
      : `<span class="nick-name">${escHtml(nick.name)}</span>`;

    row.innerHTML = pfxHtml + nameHtml;
    row.addEventListener('click', () => openNickMenu(nick, buf));
    box.appendChild(row);
  }
}

// Convert a nick color value from the API to a CSS color.
// The API returns either a plain ANSI escape string or a color name.
function nickColorToCss(colorVal) {
  if (!colorVal) return '';
  // If it looks like an ANSI escape sequence, extract the colour
  if (colorVal.includes('\x1b')) {
    // Parse the first colour from the escape — re-use ansiToHtml on a dummy char
    const html = ansiToHtml(colorVal + 'X\x1b[0m');
    const m = html.match(/style="([^"]+)"/);
    if (m) {
      const colorMatch = m[1].match(/(?:^|;)color:([^;]+)/);
      if (colorMatch) return colorMatch[1];
    }
    return '';
  }
  // Plain color name (e.g. "lightgreen", "bar_fg") — map known WeeChat names
  return weechatColorName(colorVal);
}

// Map WeeChat color names to CSS. bar_fg / default → inherit (use theme fg).
const WEECHAT_COLOR_NAMES = {
  'default':'inherit','bar_fg':'inherit','black':'#1a1a1a','darkgray':'#555555',
  'red':'#cc3333','lightred':'#ff5555','green':'#33cc33','lightgreen':'#55ff55',
  'brown':'#cccc33','yellow':'#ffff55','blue':'#3333cc','lightblue':'#5555ff',
  'magenta':'#cc33cc','lightmagenta':'#ff55ff','cyan':'#33cccc','lightcyan':'#55ffff',
  'gray':'#cccccc','white':'#ffffff',
};
function weechatColorName(name) {
  return WEECHAT_COLOR_NAMES[name.toLowerCase()] || 'inherit';
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

  const myPrefix = ownPrefix(buf);
  const isOp     = ['@','~','&'].includes(myPrefix);

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
      wsSend({ request:'POST /api/input', body:{ buffer_name:buf.name, command:a.cmd } });
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
  const nick = (buf.local_variables || {}).nick || '';
  const entry = Object.values(buf.nicks || {}).find(n => n.name === nick);
  return entry ? (entry.prefix || '') : '';
}

// ─── Input ────────────────────────────────────────────────────────────────────
const hist = { lines:[], pos:-1, draft:'' };

function sendInput() {
  const buf  = state.buffers.get(state.activeBufferId);
  const text = el('chat-input').value.trim();
  if (!buf || !text) return;
  hist.lines.unshift(text); hist.pos = -1;
  wsSend({ request:'POST /api/input', body:{ buffer_name:buf.name, command:text } });
  el('chat-input').value = '';
}

function onInputKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault(); sendInput();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (hist.pos === -1) hist.draft = el('chat-input').value;
    hist.pos = Math.min(hist.pos+1, hist.lines.length-1);
    if (hist.lines[hist.pos] !== undefined) el('chat-input').value = hist.lines[hist.pos];
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    hist.pos = Math.max(hist.pos-1, -1);
    el('chat-input').value = hist.pos === -1 ? hist.draft : hist.lines[hist.pos];
  }
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function showScreen(name) {
  el('connect-screen').style.display = name === 'connect' ? '' : 'none';
  el('chat-screen').style.display    = name === 'chat'    ? '' : 'none';
}

function showConnError(msg) {
  el('conn-error').textContent   = msg;
  el('conn-error').style.display = 'block';
}
function hideConnError() { el('conn-error').style.display = 'none'; }

function setConnecting(on) {
  el('connect-btn').disabled    = on;
  el('connect-btn').textContent = on ? 'CONNECTING…' : 'CONNECT';
  if (on) setStatus('connecting','CONNECTING…');
}

function setStatus(s, text) {
  el('status-dot').className     = 'status-dot ' + s;
  el('status-text').textContent  = text;
}

function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString([],
    {hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}); }
  catch { return ''; }
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── Theme ────────────────────────────────────────────────────────────────────
function initTheme() { setTheme(localStorage.getItem('cathode_theme') || 'dark'); }

function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('cathode_theme', t);
  el('theme-toggle').textContent = t === 'dark' ? '◐ LIGHT' : '◑ DARK';
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  setTheme(cur === 'dark' ? 'light' : 'dark');
  // Re-render active buffer so safeFg() picks up the new theme
  const buf = state.buffers.get(state.activeBufferId);
  if (buf) renderMessages(buf);
}

// ─── Port warning / cert ──────────────────────────────────────────────────────
function checkPort() {
  const port = parseInt(el('port').value, 10);
  const show = BLOCKED_PORTS.has(port);
  el('port-warning').textContent  = show
    ? `⚠ Port ${port} is blocked by browsers. Use a different port (e.g. 9000).` : '';
  el('port-warning').style.display = show ? 'block' : 'none';
}

function openCertPage() {
  const host = el('host').value.trim();
  const port = parseInt(el('port').value, 10);
  if (!host || !port) return alert('Enter host and port first.');
  window.open(`https://${host}:${port}/api/version`, '_blank');
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initTheme();

  const s = state.settings;
  if (s.host) el('host').value = s.host;
  if (s.port) el('port').value = s.port;
  if (s.tls  !== undefined) el('tls').checked = s.tls;

  showScreen('connect');
  setStatus('disconnected','DISCONNECTED');
  el('disconnect-btn').style.display = 'none';

  // HTTPS context — ws:// is blocked by the browser, inform the user but don't lock
  if (location.protocol === 'https:') {
    el('http-notice').style.display = '';
    el('tls-locked-note').style.display = '';
  }

  el('connect-btn')   .addEventListener('click',   connect);
  el('disconnect-btn').addEventListener('click',   disconnect);
  el('theme-toggle')  .addEventListener('click',   toggleTheme);
  el('cert-btn')      .addEventListener('click',   openCertPage);
  el('send-btn')      .addEventListener('click',   sendInput);
  el('chat-input')    .addEventListener('keydown', onInputKey);
  el('port')          .addEventListener('input',   checkPort);

  ['host','port','password'].forEach(id =>
    el(id).addEventListener('keydown', e => { if (e.key === 'Enter') connect(); })
  );
});
