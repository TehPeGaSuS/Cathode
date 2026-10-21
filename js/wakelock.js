// Settings → "Keep screen on while open": a Screen Wake Lock held while
// Cathode is connected and visible. A locked screen backgrounds the page,
// and backgrounded pages get throttled/frozen and lose the connection.
// The browser drops the lock whenever the page is hidden, so it's taken
// again on return. Needs a secure context (https or localhost).

import { state } from './state.js';

let sentinel  = null;
let requesting = false;

export const wakeLockSupported = () => 'wakeLock' in navigator;

const wanted = () => state.settings.keepAwake === true
  && state.connected
  && document.visibilityState === 'visible';

export async function updateWakeLock() {
  if (!wakeLockSupported()) return;
  if (!wanted()) {
    if (sentinel) { const s = sentinel; sentinel = null; try { await s.release(); } catch {} }
    return;
  }
  if ((sentinel && !sentinel.released) || requesting) return;
  requesting = true;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => { sentinel = null; });
    // Conditions may have changed while the request was pending
    if (!wanted()) await updateWakeLock();
  } catch {
    sentinel = null;   // e.g. battery saver, or not allowed right now
  } finally {
    requesting = false;
  }
}

document.addEventListener('visibilitychange', updateWakeLock);
