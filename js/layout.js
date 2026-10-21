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
// A horizontal swipe anywhere on the chat screen — screen edges included —
// opens a drawer (right → buffer list, left → nicklist); swiping a drawer
// back toward its edge closes it. The browser's own swipe-to-go-back/forward
// is switched off in the CSS (overscroll-behavior), and once a touch is
// clearly horizontal its moves are cancelled too, for engines that ignore it.
// What can't be taken over: Android's system back gesture (it arrives as
// "back", which closes the open drawer/sheet) and Safari's in-tab edge swipe.
function onSwipe(target, cb, ignore = null) {
  let sx = 0, sy = 0, st = 0, tracking = false, horizontal = false;
  target.addEventListener('touchstart', e => {
    tracking = e.touches.length === 1 && !e.target.closest('input, textarea, select')
      && !(ignore && e.target.closest(ignore));
    if (!tracking) return;
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY; st = Date.now(); horizontal = false;
  }, { passive: true });
  target.addEventListener('touchmove', e => {
    if (!tracking) return;
    const t  = e.touches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (!horizontal && Math.abs(dx) > 12 && Math.abs(dx) > 1.5 * Math.abs(dy)) horizontal = true;
    if (horizontal && e.cancelable) e.preventDefault();
  }, { passive: false });
  target.addEventListener('touchend', e => {
    if (!tracking) return;
    tracking = false;
    const t  = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Date.now() - st > 700) return;
    if (Math.abs(dx) < 60 || Math.abs(dx) < 1.5 * Math.abs(dy)) return;
    cb(dx > 0 ? 'right' : 'left');
  }, { passive: true });
  target.addEventListener('touchcancel', () => { tracking = false; });
}

// Trackpad two-finger swipes (narrow desktop windows): same mapping
function onWheelSwipe(target, cb) {
  let acc = 0, timer = null, fired = false;
  target.addEventListener('wheel', e => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    acc += e.deltaX;
    clearTimeout(timer);
    timer = setTimeout(() => { acc = 0; fired = false; }, 250);
    if (!fired && Math.abs(acc) > 120) {
      fired = true;               // one drawer per gesture
      cb(acc < 0 ? 'right' : 'left');
    }
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

  const openFor = dir => {
    if (!isNarrow() || activeDrawer) return;
    if (dir === 'right') openDrawer('sidebar');
    else if (el('nicklist-toggle').offsetParent !== null) openDrawer('nicklist');
  };
  // Drawers live inside #chat-screen: their own handlers below deal with them
  onSwipe(el('chat-screen'), openFor, '#sidebar, #nicklist-panel');
  onWheelSwipe(el('chat-screen'), openFor);
  onSwipe(el('sidebar'),        dir => { if (dir === 'left')  closeDrawer(); });
  onSwipe(el('nicklist-panel'), dir => { if (dir === 'right') closeDrawer(); });
}
