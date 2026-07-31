<?php
/**
 * Cathode — built-in upload backend configuration.
 *
 * See the "Built-in uploads" section of the top-level README for the full
 * setup (web server config, cron entry for purging, etc).
 */
class UploadConfig
{
    // Maximum allowed upload size, in MiB. This must also be <= your
    // php.ini's upload_max_filesize AND post_max_size (both — post_max_size
    // caps the whole request, not just the file). If either ini value is
    // lower than this, PHP silently truncates the upload before this
    // script ever runs and you'll get a generic error instead of the
    // proper "too large" response below.
    const MAX_FILESIZE = 10;

    // Retention window, in days. Smaller files are kept closer to
    // MAX_FILEAGE, larger files are pushed toward MIN_FILEAGE — see
    // DECAY_EXP. Purging only happens when the `purge` CLI command runs
    // (see README's cron example); nothing here is automatic on its own.
    const MIN_FILEAGE = 1;
    const MAX_FILEAGE = 14;
    const DECAY_EXP   = 1;      // higher = penalise large files more steeply

    // Where uploaded files are stored. Must be writable by the web server
    // user (e.g. www-data). This directory must be served directly by your
    // web server as plain static files, with PHP execution disabled — see
    // the proxy/ configs for ready-to-use examples. This script never
    // serves downloads itself.
    const STORE_PATH  = __DIR__ . '/files/';

    // The public URL path files are served at, relative to the site root.
    // Must match wherever your web server maps STORE_PATH above.
    const PUBLIC_PATH = 'upload/files/';

    // Random filename length (in characters, before the extension). Grows
    // automatically if a name collides.
    const ID_LENGTH   = 12;

    // Max length of a preserved file extension (e.g. "tar.gz" is 6 chars).
    const MAX_EXT_LEN = 7;

    // Optional: path to a tab-separated upload log (timestamp, uploader
    // IP, size, original filename, stored filename). Set to null to
    // disable logging entirely.
    const LOG_PATH = null;

    public static function siteUrl(): string
    {
        $proto = ($_SERVER['HTTPS'] ?? 'off') === 'on' ? 'https' : 'http';
        return "$proto://{$_SERVER['HTTP_HOST']}";
    }
}
