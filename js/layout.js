// Off-canvas buffer-list/nicklist drawers for narrow (mobile) viewports,
// plus the touch plumbing shared by the rest of the UI: the back button
// closing whatever is open, swipe-to-open drawers and long-press.
// On wide viewports the CSS media query the drawers rely on doesn't apply,
// so toggling their classes is simply inert there.

const el = id => document.getElementById(id);

export const isNarrow = () => window.matchMedia('(max-width: 700px)').matches;

// ─── Overlays & the back button ──────────────────────────────────────────────
// Anything that covers the chat (drawers, sheets, settings) registers here so
// the Android back button / back gesture closes it instead of leaving the
// page. A single history entry stands for "something is open": it's pushed
// when the first overlay opens and consumed when the last one closes.
const openOverlays = [];          // [{ name, close }] — last one is on top
let historyEntry = false;
let ignoreNextPop = false;

export function overlayOpened(name, close) {
  overlayClosed(name);
  openOverlays.push({ name, close });
  if (!historyEntry) {
    history.pushState({ cathodeOverlay: true }, '');
    historyEntry = true;
  }
}

export function overlayClosed(name) {
  const i = openOverlays.findIndex(o => o.name === name);
  if (i < 0) return;
  openOverlays.splice(i, 1);
  // Deferred: closing one overlay and opening the next in the same tick
  // (drawer → sheet, sheet → sheet) must keep the history entry.
  setTimeout(() => {
    if (openOverlays.length === 0 && historyEntry) {
      historyEntry  = false;
      ignoreNextPop = true;
      history.back();
    }
  }, 0);
}

window.addEventListener('popstate', () => {
  if (ignoreNextPop) {
    ignoreNextPop = false;
    // Something was opened again before our own history.back() landed
    if (openOverlays.length && !historyEntry) {
      history.pushState({ cathodeOverlay: true }, '');
      historyEntry = true;
    }
    return;
  }
  historyEntry = false;
  const top = openOverlays.pop();
  if (top) top.close();
  if (openOverlays.length) {
    history.pushState({ cathodeOverlay: true }, '');
    historyEntry = true;
  }
});

// ─── Drawers ─────────────────────────────────────────────────────────────────
let activeDrawer = null; // 'sidebar' | 'nicklist' | null

function hideDrawer() {
  el('sidebar').classList.remove('open');
  el('nicklist-panel').classList.remove('open');
  el('drawer-backdrop').classList.remove('open');
  activeDrawer = null;
}

export function closeDrawer() {
  if (!activeDrawer) return;
  hideDrawer();
  overlayClosed('drawer');
}

export function openDrawer(which) {
  if (!isNarrow()) return;
  if (activeDrawer === which) return;
  hideDrawer();
  const panel = which === 'sidebar' ? el('sidebar') : el('nicklist-panel');
  panel.classList.add('open');
  el('drawer-backdrop').classList.add('open');
  activeDrawer = which;
  overlayOpened('drawer', hideDrawer);
}

function toggleDrawer(which) {
  if (activeDrawer === which) closeDrawer();
  else openDrawer(which);
}

// ─── Swipe ───────────────────────────────────────────────────────────────────
// A clear horizontal swipe across the messages opens a drawer (right → buffer
// list, left → nicklist); swiping a drawer back toward its edge closes it.
// Screen-edge swipes are left alone: browsers use them for back/forward.
function onSwipe(target, cb) {
  let sx = 0, sy = 0, st = 0, tracking = false;
  target.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { tracking = false; return; }
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY; st = Date.now(); tracking = true;
  }, { passive: true });
  target.addEventListener('touchend', e => {
    if (!tracking) return;
    tracking = false;
    const t  = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Date.now() - st > 600) return;
    if (Math.abs(dx) < 70 || Math.abs(dx) < 2 * Math.abs(dy)) return;
    cb(dx > 0 ? 'right' : 'left');
  }, { passive: true });
}

// ─── Long press ──────────────────────────────────────────────────────────────
// Touch: hold ~450ms without moving. Mouse: right-click. Links and buttons
// keep their native behaviour.
export function onLongPress(container, selector, cb) {
  let timer = null, sx = 0, sy = 0, lastFired = 0;
  const cancel = () => { clearTimeout(timer); timer = null; };
  container.addEventListener('touchstart', e => {
    const item = e.target.closest(selector);
    if (!item || e.target.closest('a, button, input') || e.touches.length !== 1) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      lastFired = Date.now();
      if (navigator.vibrate) navigator.vibrate(10);
      cb(item);
    }, 450);
  }, { passive: true });
  container.addEventListener('touchmove', e => {
    if (!timer) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10) cancel();
  }, { passive: true });
  container.addEventListener('touchend', cancel);
  container.addEventListener('touchcancel', cancel);
  container.addEventListener('scroll', cancel, true);
  // The tap that ends a long press must not also count as a click
  container.addEventListener('click', e => {
    if (Date.now() - lastFired < 600) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  container.addEventListener('contextmenu', e => {
    const item = e.target.closest(selector);
    if (!item || e.target.closest('a')) return;
    e.preventDefault();
    if (Date.now() - lastFired < 1000) return;  // Android fires both
    cb(item);
  });
}

export function initMobileLayout() {
  el('sidebar-toggle')  .addEventListener('click', () => toggleDrawer('sidebar'));
  el('nicklist-toggle') .addEventListener('click', () => toggleDrawer('nicklist'));
  el('drawer-backdrop') .addEventListener('click', closeDrawer);

  onSwipe(el('messages'), dir => {
    if (!isNarrow() || activeDrawer) return;
    if (dir === 'right') openDrawer('sidebar');
    else if (el('nicklist-toggle').offsetParent !== null) openDrawer('nicklist');
  });
  onSwipe(el('sidebar'),        dir => { if (dir === 'left')  closeDrawer(); });
  onSwipe(el('nicklist-panel'), dir => { if (dir === 'right') closeDrawer(); });
}
