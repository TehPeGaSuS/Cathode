<?php
/**
 * Cathode — built-in upload backend.
 *
 * POST a multipart/form-data request with a "file" field (and, optionally,
 * a truthy "keep_name" field) to this script to store it and get back a
 * JSON {"url": "..."} response, or {"error": "..."} on failure.
 *
 * Uploaded files are served as plain static files by your web server at
 * UploadConfig::PUBLIC_PATH — this script never handles GET/download
 * requests itself, so it can't be tricked into executing anything it
 * stores.
 *
 * Run `php index.php purge` (e.g. from cron) to delete files past their
 * retention window — see the README for a ready-to-use cron entry. This
 * is based on, and replaces the need for, github.com/Rouji/single_php_filehost.
 */

require __DIR__ . '/config.php';

function json_response(int $status, array $body): void
{
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($body);
    exit;
}

// Random filename component. Not cryptographically unguessable by design
// once ID_LENGTH is small — pick a longer ID_LENGTH in config.php if
// uploaded files shouldn't be discoverable by guessing.
function rnd_str(int $len): string
{
    $chars     = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    $chars_len = strlen($chars);
    $random    = random_bytes($len);
    $out       = '';
    for ($i = 0; $i < $len; ++$i) {
        $out .= $chars[ord($random[$i]) % $chars_len];
    }
    return $out;
}

// Extracts a file extension from a path, with special-cased handling of
// .tar.* archives so e.g. "foo.tar.gz" keeps "tar.gz" rather than just "gz".
function ext_by_path(string $path): string
{
    $ext = pathinfo($path, PATHINFO_EXTENSION);
    if ($ext === '') return '';
    $rest = substr($path, 0, -(strlen($ext) + 1));
    $ext2 = pathinfo($rest, PATHINFO_EXTENSION);
    return $ext2 === 'tar' ? "$ext2.$ext" : $ext;
}

function upload_error_message(int $code): string
{
    switch ($code) {
        case UPLOAD_ERR_INI_SIZE:
        case UPLOAD_ERR_FORM_SIZE:
            return 'File exceeds the maximum allowed upload size ('.UploadConfig::MAX_FILESIZE.' MiB).';
        case UPLOAD_ERR_PARTIAL:
            return 'Upload was interrupted.';
        case UPLOAD_ERR_NO_FILE:
            return 'No file was uploaded.';
        default:
            return "Upload failed (error code $code).";
    }
}

function handle_upload(): void
{
    if (!isset($_FILES['file'])) {
        // A missing $_FILES with a non-empty Content-Length usually means
        // post_max_size was exceeded and PHP dropped the whole request
        // body (including $_POST) before populating anything.
        $len = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
        if ($len > 0) {
            json_response(413, ['error' => 'Upload exceeds the server\'s maximum request size.']);
        }
        json_response(400, ['error' => 'No file field in request.']);
    }

    $file = $_FILES['file'];
    if ($file['error'] !== UPLOAD_ERR_OK) {
        $status = in_array($file['error'], [UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE], true) ? 413 : 400;
        json_response($status, ['error' => upload_error_message($file['error'])]);
    }
    if (!is_uploaded_file($file['tmp_name'])) {
        json_response(400, ['error' => 'Invalid upload.']);
    }

    $size = filesize($file['tmp_name']);
    if ($size > UploadConfig::MAX_FILESIZE * 1024 * 1024) {
        json_response(413, ['error' => upload_error_message(UPLOAD_ERR_FORM_SIZE)]);
    }
    if ($size === 0) {
        json_response(400, ['error' => 'Uploaded file is empty.']);
    }

    if (!is_dir(UploadConfig::STORE_PATH) && !mkdir(UploadConfig::STORE_PATH, 0750, true) && !is_dir(UploadConfig::STORE_PATH)) {
        json_response(500, ['error' => 'Could not create storage directory.']);
    }

    $ext      = substr(ext_by_path($file['name']), 0, UploadConfig::MAX_EXT_LEN);
    $keepName = !empty($_POST['keep_name']);
    $base     = null;
    if ($keepName) {
        $base = preg_replace('/[^\p{L}\p{N}._-]/u', '_', pathinfo($file['name'], PATHINFO_FILENAME));
        if (empty($base)) $base = null; // e.g. an original name that was entirely stripped
    }

    $target       = null;
    $name         = null;
    $tries_per_len = 3;
    for ($len = UploadConfig::ID_LENGTH; $target === null; ++$len) {
        for ($n = 0; $n <= $tries_per_len; ++$n) {
            $id       = rnd_str($len);
            $name     = ($base !== null ? "{$base}_{$id}" : $id) . (empty($ext) ? '' : ".$ext");
            $candidate = UploadConfig::STORE_PATH . $name;
            if (!file_exists($candidate)) { $target = $candidate; break 2; }
        }
    }

    if (!move_uploaded_file($file['tmp_name'], $target)) {
        json_response(500, ['error' => 'Could not store file.']);
    }

    if (UploadConfig::LOG_PATH) {
        file_put_contents(UploadConfig::LOG_PATH, implode("\t", [
            date('c'), $_SERVER['REMOTE_ADDR'] ?? '-', $size, $file['name'], $name,
        ])."\n", FILE_APPEND | LOCK_EX);
    }

    $url = UploadConfig::siteUrl().'/'.UploadConfig::PUBLIC_PATH.rawurlencode($name);
    json_response(200, ['url' => $url]);
}

function purge_files(): void
{
    if (!is_dir(UploadConfig::STORE_PATH)) {
        echo "Nothing to purge — storage directory doesn't exist yet.\n";
        return;
    }

    $numDeleted = 0;
    $totalSize  = 0.0;

    foreach (scandir(UploadConfig::STORE_PATH) as $file) {
        if ($file === '.' || $file === '..') continue;
        $path = UploadConfig::STORE_PATH . $file;
        if (!is_file($path)) continue;

        $sizeMiB = filesize($path) / (1024 * 1024);
        $ageDays = (time() - filemtime($path)) / (60 * 60 * 24);

        // Always keep files below the minimum age, regardless of size.
        if ($ageDays < UploadConfig::MIN_FILEAGE) continue;

        $maxAge = UploadConfig::MIN_FILEAGE +
                  (UploadConfig::MAX_FILEAGE - UploadConfig::MIN_FILEAGE) *
                  pow(max(0, 1 - ($sizeMiB / UploadConfig::MAX_FILESIZE)), UploadConfig::DECAY_EXP);

        if ($ageDays > $maxAge) {
            unlink($path);
            printf("deleted %s (%.2f MiB, %.1f days old)\n", $file, $sizeMiB, $ageDays);
            $numDeleted++;
            $totalSize += $sizeMiB;
        }
    }

    printf("Purged %d file(s), %.2f MiB total.\n", $numDeleted, $totalSize);
}

// ── Dispatch ─────────────────────────────────────────────────────────────
if (php_sapi_name() === 'cli') {
    if (($argv[1] ?? null) === 'purge') {
        purge_files();
    } else {
        fwrite(STDERR, "Usage: php index.php purge\n");
        exit(1);
    }
} elseif ($_SERVER['REQUEST_METHOD'] === 'POST') {
    handle_upload();
} else {
    json_response(405, ['error' => 'Method not allowed. POST a file here to upload.']);
}
