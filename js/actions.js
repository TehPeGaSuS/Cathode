// What the menus do: nick/line/buffer/overflow action sheets, plus the
// commands behind them. Everything here leaves WeeChat's own windows alone —
// buffers are opened with -noswitch and Cathode switches to them itself.

import { state } from './state.js';
import { wsSend, disconnect } from './connection.js';
import { ansiToHtml } from './ansi.js';
import { openSheet, confirmSheet, promptSheet } from './sheet.js';
import { toggleSmartFilter, isSmartFilterable } from './chat.js';
import { toggleTheme, openSettings } from './settings.js';
import { uploadAvailable, pickUpload } from './upload.js';
import { recentMessages } from './input.js';
import { openSearch } from './search.js';

const el  = id => document.getElementById(id);
const esc = s  => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

export function sendCommand(buf, command) {
  wsSend({ request: 'POST /api/input', body: { buffer_name: buf.name, command } });
}

const lv = buf => buf.local_variables || {};

// ─── Opening buffers without switching WeeChat ───────────────────────────────
// Set before a /join or /query: when the matching buffer_opened event (or an
// already-open buffer) shows up, Cathode switches to it.
const PENDING_TTL = 15_000;

export function expectBuffer(server, shortName) {
  state.pendingOpen = { server: server || '', short: shortName.toLowerCase(), until: Date.now() + PENDING_TTL };
}

export function matchesPending(buf) {
  const p = state.pendingOpen;
  if (!p) return false;
  if (Date.now() > p.until) { state.pendingOpen = null; return false; }
  const short = (buf.short_name || '').toLowerCase();
  if (short !== p.short) return false;
  if (p.server && lv(buf).server && lv(buf).server !== p.server) return false;
  state.pendingOpen = null;
  return true;
}

function findBuffer(server, shortName) {
  const s = shortName.toLowerCase();
  return [...state.buffers.values()].find(b =>
    (b.short_name || '').toLowerCase() === s && (!server || lv(b).server === server));
}

// Open-or-switch helper used after sending a /join or /query
function goToOrExpect(server, shortName, activate) {
  const existing = findBuffer(server, shortName);
  if (existing) activate(existing.id);
  else expectBuffer(server, shortName);
}

// Typed "/join #x" or "/query nick" (and the /j and /q aliases): add
// -noswitch so WeeChat's own window stays where it is, and remember what to
// switch to here. Returns the (possibly rewritten) command.
const OPENERS = /^\/(join|j|query|q)(\s+)(.*)$/i;
export function rewriteOpeningCommand(text, buf, activate) {
  const m = text.match(OPENERS);
  if (!m) return text;
  const cmd  = m[1].toLowerCase();
  let   args = m[3];
  const words = args.split(/\s+/);
  let server = lv(buf).server || '';
  for (let i = 0; i < words.length; i++) {
    if (words[i] === '-server' && words[i + 1]) server = words[i + 1];
  }
  const target = words.filter((w, i) => !w.startsWith('-') && words[i - 1] !== '-server')[0];
  if (!words.includes('-noswitch')) args = '-noswitch ' + args;
  if (target) {
    let short = target.split(',')[0];
    if ((cmd === 'join' || cmd === 'j') && !/^[#&+!]/.test(short)) short = '#' + short;
    goToOrExpect(server, short, activate);
  }
  return `/${m[1]} ${args}`;
}

// ─── Mention ─────────────────────────────────────────────────────────────────
export function mention(nick) {
  const input = el('chat-input');
  const v = input.value;
  if (!v.trim()) input.value = `${nick}: `;
  else input.value = v.replace(/\s*$/, ' ') + nick + ' ';
  input.focus();
  input.selectionStart = input.selectionEnd = input.value.length;
}

// ─── Nick actions ────────────────────────────────────────────────────────────
const OP_PREFIXES = ['~', '&', '@', '%'];   // half-ops can kick too

function ownPrefix(buf) {
  const me    = lv(buf).nick || '';
  const entry = Object.values(buf.nicks || {}).find(n => n.name === me);
  return entry ? (entry.prefix || '').trim() : '';
}

export function openNickSheet(nickName, buf, activate) {
  const isMe = nickName === lv(buf).nick;
  const isOp = OP_PREFIXES.includes(ownPrefix(buf));
  const server = lv(buf).server || '';
  const entry = Object.values(buf.nicks || {}).find(n => n.name === nickName);
  const pfx   = entry && entry.prefix && entry.prefix.trim() ? entry.prefix.trim() : '';

  const items = [
    { icon: '@', label: 'Mention', onSelect: () => mention(nickName) },
  ];
  if (!isMe) items.push({ icon: '✉', label: 'Private message', onSelect: () => {
    sendCommand(buf, `/query -noswitch ${nickName}`);
    goToOrExpect(server, nickName, activate);
  }});
  items.push({ icon: 'ⓘ', label: 'Whois', onSelect: () => sendCommand(buf, `/whois ${nickName} ${nickName}`) });
  if (!isMe) items.push({ icon: '⊘', label: 'Ignore', onSelect: async () => {
    const ok = await confirmSheet({
      title: `Ignore ${nickName}?`,
      message: `Hides their messages on ${server || 'all servers'}. Undo with /ignore del.`,
      confirmLabel: 'Ignore',
    });
    if (ok) sendCommand(buf, `/ignore add ${nickName}${server ? ' ' + server : ''}`);
  }});
  if (isOp && !isMe && lv(buf).type === 'channel') {
    items.push('sep');
    items.push({ icon: '⏏', label: 'Kick…', danger: true, onSelect: async () => {
      const r = await promptSheet({ title: `Kick ${nickName}`, placeholder: 'Reason (optional)',
                                    confirmLabel: 'Kick', danger: true, required: false });
      if (r) sendCommand(buf, `/kick ${nickName}${r.value ? ' ' + r.value : ''}`);
    }});
    items.push({ icon: '⛔', label: 'Kick & ban…', danger: true, onSelect: async () => {
      const r = await promptSheet({ title: `Kick & ban ${nickName}`, placeholder: 'Reason (optional)',
                                    confirmLabel: 'Kick & ban', danger: true, required: false });
      if (r) sendCommand(buf, `/kickban ${nickName}${r.value ? ' ' + r.value : ''}`);
    }});
  }
  openSheet({ title: pfx + nickName, items });
}

// ─── Line actions (long-press / right-click on a message) ────────────────────
export function nickOfLine(line) {
  const tag = (line.tags || []).find(t => t.startsWith('nick_'));
  return tag ? tag.slice(5) : null;
}

const stripAnsi = s => (s || '').replace(/\x1b\[[0-9;]*m/g, '');

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Non-secure contexts (plain http on a LAN) have no async clipboard
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove();
  }
}

export function openLineSheet(line, buf, activate) {
  const nick = nickOfLine(line);
  const msg  = stripAnsi(line.message);
  const pfx  = stripAnsi(line.prefix).trim();
  const items = [];
  if (nick) {
    items.push({ icon: '@', label: `Mention ${nick}`, onSelect: () => mention(nick) });
    items.push({ icon: '☺', label: `${nick}…`, hint: 'nick actions',
                 onSelect: () => openNickSheet(nick, buf, activate) });
  }
  items.push({ icon: '⧉', label: 'Copy message', onSelect: () => copyText(msg) });
  if (pfx) items.push({ icon: '⧉', label: 'Copy with nick', onSelect: () => copyText(`<${pfx}> ${msg}`) });
  openSheet({
    title: pfx || 'Message',
    subtitleHtml: ansiToHtml(line.message).slice(0, 2000),
    items,
  });
}

// ─── Buffer actions ──────────────────────────────────────────────────────────
export async function closeBuffer(buf) {
  const type = lv(buf).type;
  const what = type === 'channel' ? `Leave ${buf.short_name || buf.name}?`
             : type === 'server'  ? `Disconnect and close ${buf.short_name || buf.name}?`
             : `Close ${buf.short_name || buf.name}?`;
  const msg  = type === 'channel' ? 'You will part the channel on IRC.'
             : type === 'server'  ? 'This closes the IRC connection in WeeChat.'
             : 'The buffer is closed in WeeChat too.';
  const ok = await confirmSheet({ title: what, message: msg,
                                  confirmLabel: type === 'channel' ? 'Leave' : 'Close', danger: true });
  if (ok) sendCommand(buf, '/buffer close');
}

export function markRead(buf) {
  if (state.settings.syncRead === false) return;   // local only, per Settings
  wsSend([
    { request: 'POST /api/input', body: { buffer_name: buf.name, command: '/buffer set unread' } },
    { request: 'POST /api/input', body: { buffer_name: buf.name, command: '/buffer set hotlist -1' } },
  ]);
}

function topicHtml(buf) {
  const parts = [];
  if (buf.title) parts.push(ansiToHtml(buf.title));
  const n = Object.keys(buf.nicks || {}).length;
  const meta = [lv(buf).server, n ? `${n} user${n === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
  if (meta) parts.push(`<span class="sheet-meta">${esc(meta)}</span>`);
  return parts.join('<br>');
}

// Long-press on a buffer in the list
export function openBufferSheet(buf, { activate, onMarkRead }) {
  const items = [];
  if (buf.id !== state.activeBufferId) items.push({ icon: '→', label: 'Open', onSelect: () => activate(buf.id) });
  if (buf.unread || buf.highlight) items.push({ icon: '✓', label: 'Mark as read', onSelect: () => { markRead(buf); onMarkRead(buf); } });
  items.push({ icon: '✕', label: lv(buf).type === 'channel' ? 'Leave channel' : 'Close buffer',
               danger: true, onSelect: () => closeBuffer(buf) });
  openSheet({ title: buf.short_name || buf.name, subtitleHtml: topicHtml(buf), items });
}

// ⋮ menu / tapping the title on phones
export function openOverflowSheet() {
  const buf   = state.buffers.get(state.activeBufferId);
  const items = [];
  if (buf) {
    if (isSmartFilterable(buf)) {
      items.push({ icon: '⇅', label: 'Hide joins/parts', checked: state.smartFilter.get(buf.id) !== false,
                   onSelect: toggleSmartFilter });
    }
    items.push({ icon: '⌕', label: 'Search', onSelect: openSearch });
    if (recentMessages().length) items.push({ icon: '↺', label: 'Recent messages', onSelect: openRecentSheet });
    if (uploadAvailable()) items.push({ icon: '⇪', label: 'Upload file', onSelect: pickUpload });
    items.push({ icon: '✕', label: lv(buf).type === 'channel' ? 'Leave channel' : 'Close buffer',
                 danger: true, onSelect: () => closeBuffer(buf) });
    items.push('sep');
  }
  const dark = (document.documentElement.getAttribute('data-theme') || 'dark') === 'dark';
  items.push({ icon: '◐', label: 'Dark theme', checked: dark, onSelect: toggleTheme });
  items.push({ icon: '⚙', label: 'Settings', onSelect: openSettings });
  items.push({ icon: '⏻', label: 'Disconnect', danger: true, onSelect: confirmDisconnect });
  openSheet({
    title: buf ? (buf.short_name || buf.name) : 'Cathode',
    subtitleHtml: buf ? topicHtml(buf) : undefined,
    items,
  });
}

// Re-use something already sent (weechat-android: long-press the input)
export function openRecentSheet() {
  const recent = recentMessages();
  if (!recent.length) return;
  openSheet({
    title: 'Recent messages',
    items: recent.map(text => ({
      label: text,
      onSelect: () => {
        const input = el('chat-input');
        input.value = text;
        input.focus();
        input.selectionStart = input.selectionEnd = text.length;
      },
    })),
  });
}

export async function confirmDisconnect() {
  const ok = await confirmSheet({
    title: 'Disconnect from the relay?',
    message: 'WeeChat keeps running; only this browser disconnects.',
    confirmLabel: 'Disconnect', danger: true,
  });
  if (ok) disconnect();
}

// ─── Join ────────────────────────────────────────────────────────────────────
export async function openJoinPrompt(activate) {
  const servers = [...new Set([...state.buffers.values()]
    .filter(b => lv(b).plugin === 'irc' && lv(b).server)
    .map(b => lv(b).server))];
  const active  = state.buffers.get(state.activeBufferId);
  const current = active && lv(active).server && servers.includes(lv(active).server)
    ? lv(active).server : servers[0];
  const r = await promptSheet({
    title: 'Join channel',
    message: servers.length === 1 ? `on ${servers[0]}` : servers.length ? undefined : 'No IRC server buffers found.',
    placeholder: '#channel',
    confirmLabel: 'Join',
    choices: servers, choiceLabel: 'SERVER', choice: current,
  });
  if (!r) return;
  let chan = r.value.split(/\s+/)[0];
  if (!/^[#&+!]/.test(chan)) chan = '#' + chan;
  const key    = r.value.split(/\s+/).slice(1).join(' ');
  const server = r.choice || '';
  const target = [...state.buffers.values()].find(b => lv(b).server === server && lv(b).type === 'server')
    || active;
  if (!target) return;
  sendCommand(target, `/join -noswitch${server ? ' -server ' + server : ''} ${chan}${key ? ' ' + key : ''}`);
  goToOrExpect(server, chan, activate);
}
