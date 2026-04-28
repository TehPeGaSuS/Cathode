import { state, saveSettings, BLOCKED_PORTS } from './state.js';
import { initNotifications } from './notifications.js';
import { applyPrefixWidth } from './chat.js';
import { sysMsg } from './chat.js';
import {
  onBufOpened, onBufUpdated, onBufCleared, onBufClosed,
  onLineAdded, onNickAdded, onNickRemoved, onGroupChanged,
  collectNicks, rebuildBufList, activateBuffer,
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

// ─── Float-safe ID parser ─────────────────────────────────────────────────────
// The relay sometimes sends buffer IDs as JSON floats (e.g. 1709932823649184.0).
// Parsing those as Number loses precision — parse as string when safe.
export function parseId(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;          // already a string key
  if (typeof v === 'number') return String(Math.round(v)); // float → integer string
  return String(v);
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
    Object.assign(state.settings, { host, port, pass, tls });
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
    if (location.protocol === 'https:' && !tls) {
      showConnError('Secure connection error — cannot connect to an unencrypted relay (ws://) from an HTTPS page.');
    } else if (!reconnect.enabled) {
      showConnError('WebSocket error. Check host, port, TLS, and relay config.');
    }
  };

  ws.onclose = () => {
    clearTimeout(timer);
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
  wsSend({ request: 'DELETE /api/sync' });
  onDisconnected(/* userInitiated */ true);
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
function buildAuth(pw) {
  return btoa('plain:' + pw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

// ─── Message dispatch ─────────────────────────────────────────────────────────
function dispatch(msg) {
  if (!msg) return;
  if (msg.code === 0 && msg.event_name) { handleEvent(msg); return; }
  if (msg.request_id === 'init' && msg.body_type === 'buffers') { handleInit(msg); return; }
}

function handleEvent(msg) {
  switch (msg.event_name) {
    case 'buffer_opened':           onBufOpened(msg.body); break;
    case 'buffer_closed':           onBufClosed(msg.buffer_id); break;
    case 'buffer_renamed':
    case 'buffer_title_changed':
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
    case 'nicklist_nick_added':
    case 'nicklist_nick_changed':   onNickAdded(msg.buffer_id, msg.body); break;
    case 'nicklist_nick_removing':  onNickRemoved(msg.buffer_id, msg.body); break;
    case 'nicklist_group_added':
    case 'nicklist_group_changed':  onGroupChanged(msg.buffer_id); break;
    case 'upgrade':                 sysMsg(null, '⟳ WeeChat upgrading…'); break;
    case 'upgrade_ended':           sysMsg(null, '✓ WeeChat upgrade complete.'); break;
    case 'quit':                    onDisconnected(); break;
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────
function onConnected() {
  setStatus('connected', 'CONNECTED');
  initNotifications();
  wsSend([
    { request: 'GET /api/buffers?lines=-200&nicks=true&colors=ansi', request_id: 'init' },
    { request: 'POST /api/sync', body: { nicks: true, colors: 'ansi' } }
  ]);
}

function handleInit(msg) {
  state.buffers.clear();
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
      lastReadId: buf.last_read_line_id ? parseId(buf.last_read_line_id) : null });
    if (!state.smartFilter.has(id)) state.smartFilter.set(id, true);
  }
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
    el('buffer-list').innerHTML = '';
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
}

function showScreen(name) {
  el('connect-screen').style.display = name === 'connect' ? '' : 'none';
  el('chat-screen').style.display    = name === 'chat'    ? '' : 'none';
}
