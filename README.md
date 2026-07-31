> [!WARNING]
> This was **definitely** vibecoded. Use at your own risk.\
> That said, I've been using it almost daily without any major issues.

# Cathode

A terminal-style web client for [WeeChat](https://weechat.org/), using the
modern **API relay protocol** (WeeChat ≥ 4.0). No build step. No framework.
Drop three files on a web server and go.

---

## Features

- Real-time IRC via WeeChat's JSON/WebSocket relay API
- Terminal aesthetic — white on black (default) and black on white, togglable
- Buffer list, nicklist, message history, input with command history (↑/↓)
- ANSI colour rendering, URL linkification
- Warns on browser-blocked ports before you try to connect
- Self-signed cert helper (opens relay URL in a new tab to accept the warning)
- Zero dependencies, zero build step — plain HTML/CSS/ES-module JS

---

## Requirements

- **WeeChat ≥ 4.0** with the relay plugin enabled and the **api** protocol configured
- A web server to serve the three static files (nginx, Caddy, Apache, or even
  `python3 -m http.server`)
- A domain + TLS cert for production use (certbot/Let's Encrypt recommended)

---

## WeeChat relay setup

```
# Inside WeeChat:

# Load the relay plugin if not already loaded
/plugin load relay

# Set a relay password (required)
/set relay.network.password "your_strong_password_here"

# Create the API relay listener on port 9000
# Do NOT use port 6667/6697 — those are blocked by browsers
/relay add api 9000

# For TLS (recommended for non-localhost):
/relay add tls.api 9000

# Verify it's listening:
/relay listport
```

> **Port note:** Ports 6665–6669 and 6697 (the traditional IRC port range)
> are blocked by all major browsers. Use any other port — 9000 is a safe
> default.

---

## Installation

### 1. Copy the files

```bash
# Clone or download, then copy to your web root:
cp index.html app.js style.css /var/www/cathode/

# Or serve from the repo directly for development:
python3 -m http.server 8080
```

### 2. Set up a reverse proxy (recommended)

For production you'll want a reverse proxy to handle TLS and serve both the
static files and the WeeChat relay API under the same origin — this avoids
mixed-content issues and makes self-signed certs unnecessary.

See the `proxy/` directory for ready-to-use configs:

| Server | File |
|--------|------|
| Caddy  | `proxy/Caddyfile` |
| nginx  | `proxy/nginx.conf` |
| Apache | `proxy/apache.conf` |

All three configs follow the same pattern:
- Serve static files at `/`
- Proxy `/api*` to `localhost:9000` (your WeeChat relay port)
- Handle WebSocket upgrade headers

### 3. Open in browser

Navigate to your domain. Enter the WeeChat relay host/port and password.
If you're using the reverse proxy setup, the host is your domain and the
port is 443 — the proxy forwards `/api` internally.

---

## Self-signed certificates

If you can't use Let's Encrypt (no domain, air-gapped, LAN-only), you can
still use TLS with a self-signed cert on the WeeChat relay. The browser will
refuse the WebSocket connection until you accept the cert exception:

1. Enter your host and port in Cathode's connect screen
2. Click the **⚠ CERT** button — this opens `https://host:port/api/version`
   in a new tab
3. Accept the browser's security warning in that tab
4. Return to Cathode and click **CONNECT**

The exception is remembered by the browser for subsequent sessions.

---

## Built-in uploads

Cathode ships a small, self-contained PHP upload backend in `upload/` so you
can host file/image sharing yourself instead of relying on Imgur or a
separate filehost service. It's a couple hundred lines of PHP with no
dependencies of its own — no database, no Composer.

### 1. Requirements

- PHP (8.0+) available to your web server, either via `mod_php` (Apache) or
  `php-fpm` (Apache or nginx/Caddy)
- The `upload/files/` directory writable by the web server user (e.g.
  `www-data`)

### 2. Web server config

`upload/index.php` must be reachable and PHP-executable at `/upload/`, but
`upload/files/` (where uploads are actually stored) must **only ever be
served as static files, with PHP execution disabled** — uploaded content is
untrusted. See the `proxy/` configs for ready-to-use examples of both parts
(search for "Built-in uploads" in each file).

### 3. Configure limits

Edit `upload/config.php` — max file size, retention window, etc. Two things
to double check:

- `MAX_FILESIZE` (in `upload/config.php`) must be **at or below** your
  `php.ini`'s `upload_max_filesize` **and** `post_max_size`. If either ini
  value is lower, PHP silently drops oversized uploads before the script
  ever sees them.
- Multiple PHP SAPIs (CLI, `mod_php`, `php-fpm`) each have their own
  `php.ini` — make sure you're editing the one your **web server** actually
  loads, not just the CLI one (`php --ini` only shows the CLI config).

### 4. Enable it in Cathode

```js
// config.js
uploadBackend: 'cathode',
```

### 5. Purge old files

Uploads are **not** deleted automatically — run the `purge` command
periodically (e.g. via cron) to enforce the retention window from
`upload/config.php`:

```bash
# /etc/cron.d/cathode-upload-purge
17 * * * * www-data php /var/www/cathode/upload/index.php purge >> /var/log/cathode-purge.log 2>&1
```

Run it as whichever user owns `upload/files/` (typically the web server
user) so file permissions line up.

---

## LAN / local use (no TLS)

If you're connecting from the same machine or a trusted LAN, you can skip TLS:

- In WeeChat: `/relay add api 9000` (without `tls.`)
- In Cathode: uncheck **USE TLS** before connecting
- Serve Cathode itself over plain HTTP too (or `file://` directly)

Note: `ws://` from an `https://` page is blocked by browsers (mixed content).
Either serve Cathode over plain HTTP as well, or use the reverse proxy approach.

---

## Directory structure

```
cathode/
├── index.html          — app shell
├── js/                 — client logic (ES modules, no build step)
├── style.css           — terminal theme, dark + light
├── config.js            — operator configuration
├── upload/              — optional built-in upload backend (see above)
│   ├── index.php
│   ├── config.php
│   └── files/           — uploaded files live here (gitignored)
├── proxy/
│   ├── Caddyfile       — Caddy reverse proxy config
│   ├── nginx.conf      — nginx reverse proxy config
│   └── apache.conf     — Apache reverse proxy config
└── README.md
```

---

## How it works

Cathode uses WeeChat's **API relay protocol** — a clean JSON-over-WebSocket
protocol introduced in WeeChat 4.0, replacing the old binary `weechat` relay
protocol that Glowing Bear was built on.

On connect, Cathode:
1. Opens a WebSocket to `wss://host:port/api` with the password encoded in
   the `Sec-WebSocket-Protocol` header (the only header the browser WebSocket
   API allows you to set)
2. Sends a batched request: fetch all buffers with last 200 lines and nicks,
   then subscribe to real-time events
3. Listens for push events (`buffer_line_added`, `buffer_opened`,
   `nicklist_nick_added`, etc.) and updates the UI accordingly

---

## License

GPL-3.0 — same as WeeChat and Glowing Bear.

---

*Cathode — Inspired by [Glowing Bear](https://github.com/glowing-bear/glowing-bear)*
