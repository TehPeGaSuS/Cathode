import { state } from './state.js';
import { EMOJI } from './emoji.js';

const el = id => document.getElementById(id);

const hist = { lines: [], pos: -1, draft: '' };
const tab  = { matches: [], pos: -1, stem: '' };

export function sendInput(wsSend) {
  const buf  = state.buffers.get(state.activeBufferId);
  const text = el('chat-input').value.trim();
  if (!buf || !text) return;
  hist.lines.unshift(text);
  hist.pos    = -1;
  tab.matches = [];
  tab.pos     = -1;
  wsSend({ request: 'POST /api/input', body: { buffer_name: buf.name, command: text } });
  el('chat-input').value = '';
}

export function onInputKey(e, wsSend) {
  if (e.key === 'Tab') {
    e.preventDefault();
    doTabComplete();
    return;
  }
  if (e.key !== 'Shift') { tab.matches = []; tab.pos = -1; }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendInput(wsSend);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (hist.pos === -1) hist.draft = el('chat-input').value;
    hist.pos = Math.min(hist.pos + 1, hist.lines.length - 1);
    if (hist.lines[hist.pos] !== undefined) el('chat-input').value = hist.lines[hist.pos];
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    hist.pos = Math.max(hist.pos - 1, -1);
    el('chat-input').value = hist.pos === -1 ? hist.draft : hist.lines[hist.pos];
  }
}

function doTabComplete() {
  const input  = el('chat-input');
  const val    = input.value;
  const caret  = input.selectionStart;
  const before = val.slice(0, caret);
  const tokenMatch = before.match(/(\S+)$/);
  const token  = tokenMatch ? tokenMatch[1] : '';
  if (!token) return;

  const lower = token.toLowerCase();

  if (tab.matches.length === 0 || tab.stem !== lower) {
    const buf = state.buffers.get(state.activeBufferId);
    if (!buf) return;

    const prevWord = before.slice(0, before.length - token.length).trim().split(/\s+/).pop() || '';
    const wantChannel = token.startsWith('#') || prevWord.toLowerCase() === '/join';
    const wantEmoji   = token.startsWith(':') && token.length > 1;

    let candidates;
    if (wantEmoji) {
      // Emoji shortcode completion: :fire → 🔥
      const stem = token.slice(1).toLowerCase();
      candidates = [];
      for (const [name, glyph] of EMOJI) {
        if (name.startsWith(stem)) candidates.push(glyph + name);
      }
      // Sort by name length (shorter = more likely intended)
      candidates.sort((a, b) => a.length - b.length);
    } else if (wantChannel) {
      candidates = [...state.buffers.values()]
        .filter(b => {
          const lv = b.local_variables || {};
          return lv.type === 'channel' || (b.short_name || '').startsWith('#');
        })
        .map(b => b.short_name || b.name);
    } else {
      candidates = Object.values(buf.nicks || {}).map(n => n.name);
    }

    tab.matches = wantEmoji
      ? candidates                    // already filtered and sorted during construction
      : candidates.filter(c => c.toLowerCase().startsWith(lower));
    if (!wantEmoji)
      tab.matches.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    tab.pos  = -1;
    tab.stem = lower;
    if (tab.matches.length === 0) return;
  }

  tab.pos = (tab.pos + 1) % tab.matches.length;
  const match    = tab.matches[tab.pos];
  // Emoji matches are stored as "🔥fire" — extract just the glyph (may be multi-codepoint)
  const isEmoji  = /^\p{Emoji}/u.test(match);
  const insert   = isEmoji ? [...match][0] : match;  // spread handles multi-byte glyphs
  const atStart  = before.trimStart() === token;
  const isNick   = !insert.startsWith('#') && !isEmoji;
  const suffix   = (atStart && isNick) ? ': ' : ' ';
  const completed = before.slice(0, before.length - token.length) + insert + suffix;
  input.value = completed + val.slice(caret);
  input.selectionStart = input.selectionEnd = completed.length;
}
