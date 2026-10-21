// In-buffer search over the lines Cathode has loaded (use "load older lines"
// to search further back). Plain text by default; /pattern/ is a regex.
// ↑ goes to older matches, ↓ to newer, starting from the newest — the same
// direction as weechat-android's search buttons.

import { overlayOpened, overlayClosed } from './layout.js';

const el = id => document.getElementById(id);

let active    = false;
let caseSens  = false;
let matches   = [];   // first .msg-row of each matching line, oldest → newest
let current   = -1;

const strip = s => (s || '').replace(/\x1b\[[0-9;]*m/g, '');

function buildMatcher(q) {
  const re = q.match(/^\/(.+)\/$/);
  if (re) {
    try {
      const r = new RegExp(re[1], caseSens ? '' : 'i');
      return s => r.test(s);
    } catch { return null; }
  }
  const needle = caseSens ? q : q.toLowerCase();
  return s => (caseSens ? s : s.toLowerCase()).includes(needle);
}

export function isSearchOpen() { return active; }

export function openSearch() {
  if (!active) {
    active = true;
    el('search-bar').classList.add('open');
    overlayOpened('search', hideSearch);
  }
  el('search-input').focus();
  el('search-input').select();
  applySearch();
}

function hideSearch() {
  active = false;
  el('search-bar').classList.remove('open');
  clearMarks();
  matches = []; current = -1;
}

export function closeSearch() {
  if (!active) return;
  hideSearch();
  overlayClosed('search');
}

function clearMarks() {
  for (const r of el('messages').querySelectorAll('.search-match, .search-current'))
    r.classList.remove('search-match', 'search-current');
}

// Re-run on every render (buffer switch, new lines loaded, …)
export function applySearch() {
  if (!active) return;
  clearMarks();
  matches = []; current = -1;
  const q = el('search-input').value;
  const count = el('search-count');
  if (!q) { count.textContent = ''; return; }
  const test = buildMatcher(q);
  if (!test) { count.textContent = 'bad regex'; return; }
  const seen = new Set();
  for (const row of el('messages').querySelectorAll('.msg-row')) {
    const line = row._line;
    if (!line || seen.has(line)) continue;
    seen.add(line);
    const pfx = strip(line.prefix), msg = strip(line.message);
    // message, nick, or "nick message" (weechat-android: prefix/message/both)
    if (test(msg) || (pfx && (test(pfx) || test(pfx + ' ' + msg)))) {
      matches.push(row);
      // mark every row of a multi-line message
      for (let r = row; r && r._line === line; r = r.nextElementSibling) r.classList.add('search-match');
    }
  }
  current = matches.length - 1;
  show();
}

function show() {
  const count = el('search-count');
  if (!matches.length) { count.textContent = el('search-input').value ? '0' : ''; return; }
  count.textContent = `${current + 1}/${matches.length}`;
  for (const r of el('messages').querySelectorAll('.search-current')) r.classList.remove('search-current');
  const row = matches[current];
  row.classList.add('search-current');
  row.scrollIntoView({ block: 'center' });
}

function step(delta) {
  if (!matches.length) return;
  current = (current + delta + matches.length) % matches.length;
  show();
}

export function initSearch() {
  const input = el('search-input');
  let t = null;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(applySearch, 150); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); step(e.shiftKey ? 1 : -1); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSearch(); }
  });
  el('search-up')  .addEventListener('click', () => step(-1));
  el('search-down').addEventListener('click', () => step(1));
  el('search-close').addEventListener('click', closeSearch);
  el('search-case').addEventListener('click', () => {
    caseSens = !caseSens;
    el('search-case').classList.toggle('on', caseSens);
    el('search-case').setAttribute('aria-pressed', String(caseSens));
    applySearch();
  });
}
