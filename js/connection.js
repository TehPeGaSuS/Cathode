import { state, saveSettings, BLOCKED_PORTS } from './state.js';
import { initNotifications } from './notifications.js';
import { applyPrefixWidth, sysMsg } from './chat.js';
import {
  onBufOpened, onBufUpdated, onBufCleared, onBufClosed,
  onLineAdded, onLineChanged, onNickAdded, onNickRemoved, onGroupChanged,
  onBufNumbers, collectNicks, rebuildBufList, activateBuffer, clearBufList,
} from './buffers.js';

const el = id => document.getElementById(id);

// ─── Reconnect state ──────────────────────────────────────────────────────────
const reconnect = {
  enabled:  false,   // set true after first successful connect; false on user disconnect
  timer:    null,
  backoff:  1000,    // ms, doubles each attempt up to MAX_BACKOFF
};
const MAX_BACKOFF  = 30_000;
const INITIAL_BACKOFF = 1_000;

// Periodic POST /api/ping so idle reverse proxies (nginx proxy_read_timeout,
// etc.) don't drop a quiet connection.
const PING_INTERVAL = 60_000;
let pingTimer = null;

// ─── Float-safe ID parser ─────────────────────────────────────────────────────
// The relay sometimes sends buffer IDs as JSON floats (e.g. 1709932823649184.0).
// Parsing those as Number loses precision — parse as string when safe.
export function parseId(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;          // already a string key
  if (typeof v === 'number') return String(Math.round(v)); // float → integer string
  return String(v);
}

// JSON.parse loses precision on integers past 2^53 *before* parseId ever sees
// them (a plain `Number` conversion during tokenizing), so quoting large IDs
// in the raw text — for keys named "id" or ending in "_id" — before parsing
// is the only way to preserve them. Only touches `"...id":<digits>` value
// positions, so it can't misfire on numbers embedded in message/string content.
const ID_KEY_RE = /"([a-zA-Z_]*id)":(-?\d{16,})([,}\]])/g;
function preserveLargeIds(text) {
  return text.replace(ID_KEY_RE, '"$1":"$2"$3');
}

// ─── WebSocket send ───────────────────────────────────────────────────────────
export function wsSend(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN)
    state.ws.send(JSON.stringify(obj));
}

// ─── Connect ──────────────────────────────────────────────────────────────────
export function connect() {
  const host = el('host').value.trim();
  const port = parseInt(el('port').value, 10);
  const pass = el('password').value;
  const tls  = el('tls').checked;

  if (!host || !port) return showConnError('Host and port are required.');
  if (BLOCKED_PORTS.has(port)) return showConnError(
    `Port ${port} is blocked by browsers. Use a different port — e.g. 9000.`);

  reconnect.enabled = false;   // reset; re-enabled on first successful connect
  clearReconnectTimer();
  connectTo(host, port, pass, tls);
}

function connectTo(host, port, pass, tls) {
  const hostFmt = (host.includes(':') && !host.startsWith('[')) ? `[${host}]` : host;
  const url     = `${tls ? 'wss' : 'ws'}://${hostFmt}:${port}/api`;

  hideConnError();
  setConnecting(true);

  let ws;
  try {
    ws = new WebSocket(url, [
      'api.weechat',
      `base64url.bearer.authorization.weechat.${buildAuth(pass)}`
    ]);
  } catch (e) {
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
    reconnect.enabled = true;
    reconnect.backoff = INITIAL_BACKOFF;
    const rememberPass = el('remember-pass').checked;
    Object.assign(state.settings, {
      host, port, tls, rememberPass,
      pass: rememberPass ? pass : undefined,
    });
    saveSettings();
    onConnected();
  };

  ws.onmessage = e => {
    let data;
    try { data = JSON.parse(preserveLargeIds(e.data)); } catch { return; }
    if (Array.isArray(data)) data.forEach(dispatch);
    else dispatch(data);
  };

  ws.onerror = () => {
    clearTimeout(timer);
    setConnecting(false);
    if (location.protocol === 'https:' && !tls) {
      showConnError('Secure connection error — cannot connect to an unencrypted relay (ws://) from an HTTPS page.');
    } else if (!reconnect.enabled) {
      showConnError('WebSocket error. Check host, port, TLS, and relay config.');
    }
  };

  ws.onclose = () => {
    clearTimeout(timer);
    stopPing();
    if (state.connected) {
      onDisconnected(/* userInitiated */ false);
      if (reconnect.enabled) scheduleReconnect(host, port, pass, tls);
    }
  };
}

function scheduleReconnect(host, port, pass, tls) {
  clearReconnectTimer();
  const delay = reconnect.backoff;
  reconnect.backoff = Math.min(reconnect.backoff * 2, MAX_BACKOFF);
  setStatus('connecting', `RECONNECTING in ${Math.round(delay/1000)}s…`);
  reconnect.timer = setTimeout(() => {
    if (!reconnect.enabled) return;
    setStatus('connecting', 'RECONNECTING…');
    connectTo(host, port, pass, tls);
  }, delay);
}

function clearReconnectTimer() {
  if (reconnect.timer) { clearTimeout(reconnect.timer); reconnect.timer = null; }
}

export function disconnect() {
  reconnect.enabled = false;
  clearReconnectTimer();
  // There is no "DELETE /api/sync" route; closing the socket (done in
  // onDisconnected) is enough for the relay to drop the sync.
  onDisconnected(/* userInitiated */ true);
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => wsSend({ request: 'POST /api/ping' }), PING_INTERVAL);
}

function stopPing() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
// WeeChat base64url-decodes this and compares the bytes against the UTF-8
// password, so encode as UTF-8 first (btoa alone throws on non-Latin-1 chars
// and encodes Latin-1 chars as single bytes).
function buildAuth(pw) {
  const bytes = new TextEncoder().encode('plain:' + pw);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

// ─── Message dispatch ─────────────────────────────────────────────────────────
function dispatch(msg) {
  if (!msg) return;
  if (msg.code === 0 && msg.event_name) { handleEvent(msg); return; }
  if (msg.code >= 400) { handleError(msg); return; }
  if (msg.request_id === 'init' && msg.body_type === 'buffers') { handleInit(msg); return; }
  if (msg.request_id === 'numbers' && msg.body_type === 'buffers') { onBufNumbers(msg.body); return; }
}

function handleError(msg) {
  const detail = (msg.body && msg.body.error) || msg.message || 'error';
  sysMsg(null, `✗ ${msg.request || 'request'}: ${detail} (${msg.code})`);
}

// Buffer numbers shift without any event when a buffer is closed (WeeChat
// renumbers the following buffers silently), so re-read them.
function refreshNumbers() {
  wsSend({ request: 'GET /api/buffers', request_id: 'numbers' });
}

function handleEvent(msg) {
  switch (msg.event_name) {
    case 'buffer_opened':           onBufOpened(msg.body); break;
    case 'buffer_closed':           onBufClosed(msg.buffer_id); refreshNumbers(); break;
    case 'buffer_renamed':
    case 'buffer_title_changed':
    case 'buffer_modes_changed':
    case 'buffer_type_changed':
    case 'buffer_time_for_each_line_changed':
    case 'buffer_prefix_for_each_line_changed':
    case 'buffer_localvar_added':
    case 'buffer_localvar_changed':
    case 'buffer_localvar_removed':
    case 'buffer_moved':
    case 'buffer_merged':
    case 'buffer_unmerged':
    case 'buffer_hidden':
    case 'buffer_unhidden':         onBufUpdated(msg.body); break;
    case 'buffer_cleared':          onBufCleared(msg.buffer_id); break;
    case 'buffer_line_added':       onLineAdded(msg.buffer_id, msg.body); break;
    case 'buffer_line_data_changed': onLineChanged(msg.buffer_id, msg.body); break;
    case 'nicklist_nick_added':
    case 'nicklist_nick_changed':   onNickAdded(msg.buffer_id, msg.body); break;
    case 'nicklist_nick_removing':  onNickRemoved(msg.buffer_id, msg.body); break;
    case 'nicklist_group_added':
    case 'nicklist_group_changed':
    case 'nicklist_group_removing': onGroupChanged(msg.buffer_id); break;
    case 'upgrade':                 sysMsg(null, '⟳ WeeChat upgrading…'); break;
    case 'upgrade_ended':           sysMsg(null, '✓ WeeChat upgrade complete.'); break;
    // Let the socket's own onclose handler run the normal close/reconnect
    // path instead of tearing down state here — a relay restart still
    // fires 'quit', and that shouldn't be treated as a user-initiated
    // disconnect that skips auto-reconnect.
    case 'quit':                    if (state.ws) state.ws.close(); break;
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────
function onConnected() {
  setStatus('connected', 'CONNECTED');
  initNotifications();
  // input: false — Cathode has its own input box; without it every keystroke
  // typed in the WeeChat terminal sends a full buffer object here.
  wsSend([
    { request: 'GET /api/buffers?lines=-200&nicks=true&colors=ansi', request_id: 'init' },
    { request: 'POST /api/sync', body: { nicks: true, input: false, colors: 'ansi' } }
  ]);
  startPing();
}

function handleInit(msg) {
  // On auto-reconnect, come back to the buffer the user was on.
  const prevActive = state.buffers.get(state.activeBufferId);
  const prevName   = prevActive ? prevActive.name : null;
  state.buffers.clear();
  state.activeBufferId = null;
  const cfg = window.CATHODE_CONFIG || {};
  if (cfg.prefixAlignMax) {
    state.prefixAlignMax          = cfg.prefixAlignMax;
    state.settings.prefixAlignMax = cfg.prefixAlignMax;
  } else if (state.settings.prefixAlignMax) {
    state.prefixAlignMax = state.settings.prefixAlignMax;
  }
  for (const buf of (msg.body || [])) {
    const nicks = {};
    collectNicks(buf.nicklist_root, nicks);
    // Use parseId to handle float IDs from the relay
    const id = parseId(buf.id) ?? buf.id;
    state.buffers.set(id, { ...buf, id, lines: buf.lines||[], nicks, unread:0, highlight:0,
      ...readMarker(buf) });
    if (!state.smartFilter.has(id)) state.smartFilter.set(id, true);
  }
  setConnecting(false);
  el('disconnect-btn').style.display = '';
  applyPrefixWidth();
  showScreen('chat');
  rebuildBufList();
  state.scroll.pinned   = true;
  state.scroll.newCount = 0;
  const prev  = prevName && [...state.buffers.values()].find(b => b.name === prevName);
  const first = prev ? prev.id : state.buffers.keys().next().value;
  if (first != null) activateBuffer(first);
}

// "last_read_line_id" is -1 when there's no read marker; "first_line_not_read"
// then tells whether nothing has been read yet (marker before the first line)
// or everything has.
export function readMarker(buf) {
  const id = buf.last_read_line_id;
  return {
    lastReadId:       (id != null && id !== -1 && id !== '-1') ? parseId(id) : null,
    firstLineNotRead: !!buf.first_line_not_read,
  };
}

export function onDisconnected(userInitiated = true) {
  if (!state.connected && !state.ws) return;
  state.connected = false;
  if (state.ws) { try { state.ws.close(); } catch(_){} state.ws = null; }
  setStatus('disconnected', 'DISCONNECTED');
  el('disconnect-btn').style.display = 'none';
  // Only return to connect screen on explicit user disconnect or first-time failure
  // On auto-reconnect we stay on the chat screen showing the status
  if (userInitiated) {
    showScreen('connect');
    state.buffers.clear();
    state.activeBufferId  = null;
    state.scroll.pinned   = true;
    state.scroll.newCount = 0;
    clearBufList();
    el('messages').innerHTML    = '';
    el('nicklist').innerHTML    = '';
    const banner = document.getElementById('new-msg-banner');
    if (banner) banner.remove();
  }
}

// ─── UI helpers (connection-screen) ──────────────────────────────────────────
function showConnError(msg) {
  el('conn-error').textContent   = msg;
  el('conn-error').style.display = 'block';
}
function hideConnError() { el('conn-error').style.display = 'none'; }

function setConnecting(on) {
  el('connect-btn').disabled    = on;
  el('connect-btn').textContent = on ? 'CONNECTING…' : 'CONNECT';
  if (on) setStatus('connecting', 'CONNECTING…');
}

function setStatus(s, text) {
  el('status-dot').className    = 'status-dot ' + s;
  el('status-text').textContent = text;
  // Phones hide the top bar on the chat screen; this strip carries the state
  const strip = el('conn-strip');
  strip.textContent = s === 'connected' ? '' : text;
  strip.className   = s === 'connected' ? '' : 'show ' + s;
}

function showScreen(name) {
  el('connect-screen').style.display = name === 'connect' ? '' : 'none';
  el('chat-screen').style.display    = name === 'chat'    ? '' : 'none';
  document.body.classList.toggle('chat-mode', name === 'chat');
}
