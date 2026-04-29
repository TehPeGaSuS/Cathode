// ─── ANSI colour palette ──────────────────────────────────────────────────────
export const ANSI16 = [
  '#1a1a1a','#cc3333','#33cc33','#cccc33',
  '#3333cc','#cc33cc','#33cccc','#cccccc',
  '#555555','#ff5555','#55ff55','#ffff55',
  '#5555ff','#ff55ff','#55ffff','#ffffff',
];

export function ansi256(n) {
  if (n < 16) return ANSI16[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  const i = n - 16;
  return `rgb(${Math.floor(i/36)*51},${Math.floor((i%36)/6)*51},${(i%6)*51})`;
}

export function luminance(css) {
  let r, g, b;
  const m = css.match(/^rgb\((\d+),(\d+),(\d+)\)$/);
  if (m) { r = +m[1]; g = +m[2]; b = +m[3]; }
  else if (css.startsWith('#')) {
    const h = css.slice(1);
    if (h.length === 3) {
      r = parseInt(h[0]+h[0],16); g = parseInt(h[1]+h[1],16); b = parseInt(h[2]+h[2],16);
    } else {
      r = parseInt(h.slice(0,2),16); g = parseInt(h.slice(2,4),16); b = parseInt(h.slice(4,6),16);
    }
  } else return 0.5;
  const lin = c => { c /= 255; return c <= 0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); };
  return 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b);
}

// In light theme, force near-white foreground colours to black.
export function safeFg(css) {
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  if (theme === 'light' && luminance(css) > 0.70) return '#111111';
  return css;
}

// Partial-reset SGR codes — treat like a full reset (close all open spans).
const PARTIAL_RESET = new Set([21,22,23,24,25,27,28,29,39,49,51,52,53,54,55]);

// Convert ANSI-escaped text to HTML. Linkifies URLs and adds media-toggle buttons.
export function ansiToHtml(text) {
  if (!text) return '';
  let s = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  let out = '', spans = 0;
  // NOTE: the regex literal below must contain a literal ESC character (0x1b)
  // followed by \[ — do not modify with automated text tools.
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0, m;
  while ((m = re.exec(s)) !== null) {
    out += s.slice(last, m.index);
    last = m.index + m[0].length;
    const codes = m[1].split(';').map(Number);
    let i = 0;
    while (i < codes.length) {
      if (codes[i] === 0) {
        if (spans > 0) { out += '</span>'.repeat(spans); spans = 0; }
        i++; continue;
      }
      if (PARTIAL_RESET.has(codes[i])) {
        if (spans > 0) { out += '</span>'.repeat(spans); spans = 0; }
        i++; continue;
      }
      const st = [];
      while (i < codes.length && codes[i] !== 0 && !PARTIAL_RESET.has(codes[i])) {
        const c = codes[i];
        if      (c === 1)  { st.push('font-weight:bold'); }
        else if (c === 3)  { st.push('font-style:italic'); }
        else if (c === 4)  { st.push('text-decoration:underline'); }
        else if (c >= 30 && c <= 37)   { st.push(`color:${safeFg(ANSI16[c-30])}`); }
        else if (c === 38 && codes[i+1] === 5) { st.push(`color:${safeFg(ansi256(codes[i+2]))}`); i+=2; }
        else if (c === 38 && codes[i+1] === 2) { st.push(`color:${safeFg(`rgb(${codes[i+2]},${codes[i+3]},${codes[i+4]})`)}`); i+=4; }
        else if (c >= 40 && c <= 47)   { st.push(`background:${ANSI16[c-40]}`); }
        else if (c === 48 && codes[i+1] === 5) { st.push(`background:${ansi256(codes[i+2])}`); i+=2; }
        else if (c === 48 && codes[i+1] === 2) { st.push(`background:rgb(${codes[i+2]},${codes[i+3]},${codes[i+4]})`); i+=4; }
        else if (c >= 90 && c <= 97)   { st.push(`color:${safeFg(ANSI16[c-90+8])}`); }
        else if (c >= 100 && c <= 107) { st.push(`background:${ANSI16[c-100+8]}`); }
        i++;
      }
      if (st.length) { out += `<span style="${st.join(';')}">`;  spans++; }
    }
  }
  out += s.slice(last);
  if (spans > 0) out += '</span>'.repeat(spans);

  // Linkify URLs; match through &amp; so query strings aren't cut short
  return out.replace(/https?:\/\/(?:[^\s<>"']|&amp;)+/g, (url) => {
    const href  = url.replace(/&amp;/g, '&');
    const isImg = /\.(png|jpe?g|gif|webp|svg|bmp)(\?.*)?$/i.test(href);
    const isVid = /\.(mp4|webm|ogv|mov)(\?.*)?$/i.test(href);
    const btn   = (isImg || isVid)
      ? ` <button class="media-toggle" data-url="${href}" data-type="${isImg?'img':'vid'}">${isImg?'Show Image':'Show Video'}</button>`
      : '';
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>${btn}`;
  });
}

// ─── WeeChat colour name → CSS ────────────────────────────────────────────────
const WEECHAT_COLOR_NAMES = {
  'default':'inherit','bar_fg':'inherit','black':'#1a1a1a','darkgray':'#555555',
  'red':'#cc3333','lightred':'#ff5555','green':'#33cc33','lightgreen':'#55ff55',
  'brown':'#cccc33','yellow':'#ffff55','blue':'#3333cc','lightblue':'#5555ff',
  'magenta':'#cc33cc','lightmagenta':'#ff55ff','cyan':'#33cccc','lightcyan':'#55ffff',
  'gray':'#cccccc','white':'#ffffff',
};

// Convert a nick color value from the relay API to a CSS color string.
// The API sends either an ANSI escape sequence or a WeeChat color name.
export function nickColorToCss(colorVal) {
  if (!colorVal) return '';
  if (colorVal.includes('\x1b')) {
    // Extract colour from ANSI escape by running it through ansiToHtml
    const html = ansiToHtml(colorVal + 'X\x1b[0m');
    const m = html.match(/style="([^"]+)"/);
    if (m) {
      const cm = m[1].match(/(?:^|;)color:([^;]+)/);
      if (cm) return cm[1];
    }
    return '';
  }
  return WEECHAT_COLOR_NAMES[colorVal.toLowerCase()] || 'inherit';
}
