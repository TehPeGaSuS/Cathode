// ─── Blocked ports (browser hard-block list) ─────────────────────────────────
export const BLOCKED_PORTS = new Set([
  1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,
  101,102,103,104,107,109,110,111,113,115,117,119,123,135,137,139,
  143,161,179,389,427,465,512,513,514,515,526,530,531,532,540,548,
  554,556,563,587,601,636,989,990,993,995,1719,1720,1723,2049,3659,
  4045,5060,5061,6000,6566,6665,6666,6667,6668,6669,6697,10080
]);

// ─── Settings persistence ─────────────────────────────────────────────────────
export function loadSettings() {
  try { return JSON.parse(localStorage.getItem('cathode_settings') || '{}'); }
  catch { return {}; }
}

export function saveSettings() {
  localStorage.setItem('cathode_settings', JSON.stringify(state.settings));
}

// ─── Shared application state ─────────────────────────────────────────────────
export const state = {
  ws:             null,
  connected:      false,
  buffers:        new Map(),   // id (number) → buffer object
  activeBufferId: null,
  settings:       loadSettings(),
  prefixAlignMax: 16,          // mirrors weechat.look.prefix_align_max
  scroll:         { pinned: true, newCount: 0 },
  smartFilter:    new Map(),   // bufferId → boolean
};
