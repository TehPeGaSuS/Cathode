/**
 * Cathode — operator configuration
 *
 * This file is loaded before app.js. Set properties on window.CATHODE_CONFIG
 * to configure your deployment. All properties are optional — omit anything
 * you don't need.
 *
 * For a self-hosted personal instance, fill this in once and forget it.
 * For a shared/public instance, set the upload backend here so users don't
 * need to configure it themselves (and can't change it).
 */

window.CATHODE_CONFIG = {

  // ── Notifications ─────────────────────────────────────────────────────────
  // The relay API doesn't expose WeeChat's per-buffer notify setting, so
  // Cathode can't read it directly. Use these flags as a workaround.
  //
  // notifyServerBuffers: false — suppress notifications from IRC server buffers
  //   (type=server). Set to false if your server buffers are set to
  //   "notify none" in WeeChat. Default: true (don't suppress).
  notifyServerBuffers: false,

  // ── Upload backend ────────────────────────────────────────────────────────
  // 'none'     — disable file upload entirely (default)
  // 'filehost' — single_php_filehost (https://github.com/Rouji/single_php_filehost)
  // 'imgur'    — Imgur API (requires a Client ID from https://api.imgur.com/oauth2/addclient)
  uploadBackend:  'none',
  filehostUrl:    '',       // e.g. 'https://files.example.com/'  (filehost only)
  imgurClientId:  '',       // e.g. 'abc123def456'                (imgur only)

  // ── Prefix align max ──────────────────────────────────────────────────────
  // Mirrors weechat.look.prefix_align_max — truncates long nicks in the
  // message column. Set to match your WeeChat config. Default: 16.
  prefixAlignMax: 16,

};
