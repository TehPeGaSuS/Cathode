import { state } from './state.js';
import { notificationsEnabled } from './settings.js';

export function maybeNotify(buf, line, activateBufferFn) {
  if (!line) return;
  if (!notificationsEnabled()) return;   // Settings → Notifications

  // Buffer-level notify gate.
  // WeeChat's buffer.notify setting only gates the hotlist — it does NOT affect
  // line.highlight or line.notify_level, so we implement our own gate here.
  // The relay API doesn't expose buffer.notify, so we use config flags instead.
  const lv   = buf.local_variables || {};
  const type = lv.type || '';
  const cfg  = window.CATHODE_CONFIG || {};
  if (type === 'server' && cfg.notifyServerBuffers === false) return;

  // Detect highlight — check all three sources WeeChat may use
  const tags      = Array.isArray(line.tags) ? line.tags : [];
  const isHL      = line.highlight
    || (line.notify_level >= 3)
    || tags.includes('notify_highlight');
  const isPrivate = (line.notify_level === 2)
    || tags.includes('notify_private');

  if (!isHL && !isPrivate) return;

  // Suppress only when tab is visible AND the user is on this exact buffer
  const focused = document.visibilityState === 'visible'
    && state.activeBufferId === buf.id;
  if (focused) return;

  const bufName   = buf.short_name || buf.name || '?';
  const stripAnsi = s => (s || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
  const prefix    = stripAnsi(line.prefix);
  const body      = stripAnsi(line.message);
  const title     = isPrivate ? `PM from ${prefix}` : `${prefix} in ${bufName}`;

  const n = new Notification(title, {
    body,
    icon: 'apple-touch-icon.png',
    tag:  `cathode-${buf.id}`,  // collapses repeated pings from same buffer
  });
  n.onclick = () => {
    window.focus();
    activateBufferFn(buf.id);
    n.close();
  };
}

// "Hot" buffers, as in weechat-android's bell: highlights, plus private
// messages with anything unread. Ordered by buffer number.
export function hotBuffers() {
  return [...state.buffers.values()]
    .filter(b => b.id !== state.activeBufferId
      && (b.highlight > 0 || ((b.local_variables || {}).type === 'private' && b.unread > 0)))
    .sort((a, b) => a.number - b.number);
}

export function updateTitle() {
  let total = 0;
  for (const buf of state.buffers.values()) total += buf.highlight;
  document.title = total > 0 ? `(${total}) Cathode` : 'Cathode';

  const hot = hotBuffers();
  const btn = document.getElementById('hot-btn');
  if (btn) {
    btn.style.display = hot.length ? '' : 'none';
    btn.querySelector('.hot-count').textContent = hot.length;
    btn.title = hot.length ? `Go to ${hot[0].short_name || hot[0].name}` : '';
  }
  // Dot on ☰: something outside the current buffer wants attention
  const anyUnread = [...state.buffers.values()].some(b => b.id !== state.activeBufferId && b.unread > 0);
  const dot = document.getElementById('drawer-dot');
  if (dot) dot.className = hot.length ? 'hot' : anyUnread ? 'unread' : '';
}
