// Streaming-platform links → their official embed players (no API keys).
// embedFor(url) returns { provider, src, kind, thumb? } or null, where src is
// the iframe URL (with autoplay — it's only loaded after a click) and kind
// sizes the frame: 'video' 16:9, 'vertical' 9:16, 'audio' / 'audio-tall'.

const YT_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'];
const YT_ID    = /^[\w-]{11}$/;

// "83", "83s", "1m23s", "1h2m3s" → seconds
function parseStart(t) {
  if (!t) return 0;
  if (/^\d+$/.test(t)) return +t;
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  return m ? (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)) : 0;
}

function youtube(u, host, parts) {
  let id = null;
  if (host === 'youtu.be') id = parts[0];
  else if (YT_HOSTS.includes(host)) {
    if (parts[0] === 'watch') id = u.searchParams.get('v');
    else if (['shorts', 'live', 'embed'].includes(parts[0])) id = parts[1];
  }
  if (!id || !YT_ID.test(id)) return null;
  const start = parseStart(u.searchParams.get('t') || u.searchParams.get('start'));
  return {
    provider: 'YouTube',
    kind: parts[0] === 'shorts' ? 'vertical' : 'video',
    src: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0${start ? '&start=' + start : ''}`,
    thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  };
}

function vimeo(u, host, parts) {
  if (host === 'player.vimeo.com' && parts[0] === 'video' && /^\d+$/.test(parts[1]))
    return { provider: 'Vimeo', kind: 'video', src: `https://player.vimeo.com/video/${parts[1]}?autoplay=1` };
  if (host !== 'vimeo.com' && host !== 'www.vimeo.com') return null;
  // vimeo.com/123, vimeo.com/123/abcdef (unlisted), /channels/x/123, /groups/x/videos/123
  const i = parts.findIndex(p => /^\d+$/.test(p));
  if (i < 0) return null;
  const hash = parts[i + 1] && /^[\da-f]+$/.test(parts[i + 1]) ? `&h=${parts[i + 1]}` : '';
  return { provider: 'Vimeo', kind: 'video', src: `https://player.vimeo.com/video/${parts[i]}?autoplay=1${hash}` };
}

function dailymotion(u, host, parts) {
  let id = null;
  if (host === 'dai.ly') id = parts[0];
  else if (/(^|\.)dailymotion\.com$/.test(host) && parts[0] === 'video') id = (parts[1] || '').split('_')[0];
  if (!id || !/^[a-z0-9]+$/i.test(id)) return null;
  return { provider: 'Dailymotion', kind: 'video', src: `https://www.dailymotion.com/embed/video/${id}?autoplay=1` };
}

// Twitch requires the embedding page's hostname as "parent" (and HTTPS).
const TWITCH_RESERVED = new Set(['directory', 'videos', 'settings', 'p', 'downloads', 'jobs', 'turbo',
  'search', 'login', 'signup', 'subscriptions', 'inventory', 'wallet', 'drops', 'prime']);
function twitch(u, host, parts) {
  const parent = `&parent=${encodeURIComponent(location.hostname)}`;
  if (host === 'clips.twitch.tv' && parts[0])
    return { provider: 'Twitch', kind: 'video', src: `https://clips.twitch.tv/embed?clip=${encodeURIComponent(parts[0])}${parent}&autoplay=true` };
  if (!/(^|\.)twitch\.tv$/.test(host) || !parts[0]) return null;
  if (parts[0] === 'videos' && /^\d+$/.test(parts[1] || ''))
    return { provider: 'Twitch', kind: 'video', src: `https://player.twitch.tv/?video=v${parts[1]}${parent}&autoplay=true` };
  if (parts[1] === 'clip' && parts[2])
    return { provider: 'Twitch', kind: 'video', src: `https://clips.twitch.tv/embed?clip=${encodeURIComponent(parts[2])}${parent}&autoplay=true` };
  if (parts.length === 1 && /^\w{3,25}$/.test(parts[0]) && !TWITCH_RESERVED.has(parts[0].toLowerCase()))
    return { provider: 'Twitch', kind: 'video', src: `https://player.twitch.tv/?channel=${parts[0]}${parent}&autoplay=true` };
  return null;
}

const KICK_RESERVED = new Set(['categories', 'browse', 'following', 'search', 'settings', 'dashboard', 'terms-of-service', 'privacy-policy']);
function kick(u, host, parts) {
  if (host !== 'kick.com' && host !== 'www.kick.com') return null;
  if (parts.length !== 1 || !/^[\w-]{3,25}$/.test(parts[0]) || KICK_RESERVED.has(parts[0].toLowerCase())) return null;
  return { provider: 'Kick', kind: 'video', src: `https://player.kick.com/${parts[0]}` };
}

function streamable(u, host, parts) {
  if (host !== 'streamable.com' || !/^[a-z0-9]+$/i.test(parts[0] || '') || parts.length !== 1) return null;
  return { provider: 'Streamable', kind: 'video', src: `https://streamable.com/e/${parts[0]}?autoplay=1` };
}

function tiktok(u, host, parts) {
  if (!/(^|\.)tiktok\.com$/.test(host)) return null;
  const i = parts.indexOf('video');
  const id = i >= 0 ? parts[i + 1] : null;
  if (!id || !/^\d+$/.test(id)) return null;
  return { provider: 'TikTok', kind: 'vertical', src: `https://www.tiktok.com/embed/v2/${id}` };
}

function soundcloud(u, host, parts) {
  if (host !== 'soundcloud.com' && host !== 'www.soundcloud.com' && host !== 'm.soundcloud.com') return null;
  if (parts.length < 2 || ['discover', 'search', 'you', 'upload', 'stream'].includes(parts[0])) return null;
  const page = `https://soundcloud.com/${parts.join('/')}`;
  return { provider: 'SoundCloud', kind: parts[1] === 'sets' ? 'audio-tall' : 'audio',
           src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(page)}&auto_play=true` };
}

function spotify(u, host, parts) {
  if (host !== 'open.spotify.com') return null;
  if (/^intl-/.test(parts[0] || '')) parts = parts.slice(1);
  const [type, id] = parts;
  if (!['track', 'album', 'playlist', 'episode', 'show', 'artist'].includes(type) || !/^\w+$/.test(id || '')) return null;
  return { provider: 'Spotify', kind: ['track', 'episode'].includes(type) ? 'audio' : 'audio-tall',
           src: `https://open.spotify.com/embed/${type}/${id}` };
}

const PROVIDERS = [youtube, vimeo, dailymotion, twitch, kick, streamable, tiktok, soundcloud, spotify];

export function embedFor(href) {
  let u;
  try { u = new URL(href); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host  = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  for (const p of PROVIDERS) {
    const e = p(u, host, parts);
    if (e) return e;
  }
  return null;
}
