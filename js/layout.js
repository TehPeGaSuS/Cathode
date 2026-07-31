// Off-canvas buffer-list/nicklist drawers for narrow (mobile) viewports.
// On wide viewports the CSS media query these rely on doesn't apply, so
// toggling these classes is simply inert there.

const el = id => document.getElementById(id);

let activeDrawer = null; // 'sidebar' | 'nicklist' | null

export function closeDrawer() {
  if (!activeDrawer) return;
  el('sidebar').classList.remove('open');
  el('nicklist-panel').classList.remove('open');
  el('drawer-backdrop').classList.remove('open');
  activeDrawer = null;
}

function openDrawer(which) {
  closeDrawer();
  const panel = which === 'sidebar' ? el('sidebar') : el('nicklist-panel');
  panel.classList.add('open');
  el('drawer-backdrop').classList.add('open');
  activeDrawer = which;
}

function toggleDrawer(which) {
  if (activeDrawer === which) closeDrawer();
  else openDrawer(which);
}

export function initMobileLayout() {
  el('sidebar-toggle')  .addEventListener('click', () => toggleDrawer('sidebar'));
  el('nicklist-toggle') .addEventListener('click', () => toggleDrawer('nicklist'));
  el('drawer-backdrop') .addEventListener('click', closeDrawer);
}
