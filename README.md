# AE Secure

**AE Secure** is a self-hosted, zero-knowledge messaging and storage platform: encrypted direct messages, group chats, communities and forums, 24-hour stories, a public square, an encrypted cloud drive, airdrops, a global click counter and a full operator console.

Every message, attachment, story, avatar and drive file is sealed in the browser with **AES-GCM-256** before it reaches the server. Keys are derived on the device with **PBKDF2-SHA256** and wrapped per member with **ECDH P-256**. The server stores ciphertext, wrapped keys, account metadata and counters — it cannot read message text, file names or file contents.

Running on a phone? The whole stack is dependency-free Node.js, so it runs comfortably in Termux.

---

## Highlights

| Area | What you get |
| --- | --- |
| Messaging | Direct messages, owned group chats, typing indicators, replies, edits, encrypted attachments, read receipts |
| Communities | Public squares readable by every member, private forums with wrapped membership keys, threads, posts, votes |
| Stories & public profiles | Public profile (off by default) with alias, bio, up to 8 permanent photos, stories that expire after exactly 24 hours |
| Cloud drive | Encrypted personal storage with encrypted-name folders; a single file is limited only by remaining quota |
| Airdrop | iPhone-style broadcast: delivers to members with airdrop enabled who are online, and to operators always |
| Admin console | Live statistics, neural network traffic graph, member management, limits, sessions, moderation, all uploads, story storage, karma, audit log, global switches |
| Requests | Members ask for larger upload limits, more drive space, bigger stories, purple status — operators approve with a value, approve as unlimited, or deny |
| Privacy tools | One-time DM codes that never reveal the operator account, backup codes, remote sign-out, activity status with manual overrides |
| Console | Taskbar dropdown with a live, visual-only activity log — link state, message counts, key changes, masked request lines — plus a local command line for theme, backdrop and navigation |
| Design | Ink on paper: greyscale themes, one optional signal ink, hairline rules, hard offset shadows, monospaced chrome, oversized display type, movable windows, static backdrops, square plates, full accessibility suite, bottom sheets and thumb-sized controls on phones |

---

## Requirements

* **Node.js 18 or newer** (tested on 22). No npm install step — the project has **zero dependencies**.
* A phone, laptop, Raspberry Pi or any always-on machine. Termux on Android works.

---

## Install on Termux (Android)

```bash
# 1. Install Termux from F-Droid, then:
pkg update && pkg upgrade
pkg install nodejs git

# 2. Fetch the project (or copy your own folder across)
git clone <this-repository-url> ae-secure
cd ae-secure

# 3. Start the server
npm start
```

The first run prints the addresses to open:

```
  AE Secure — encrypted messaging, communities and cloud drive
  listening on http://0.0.0.0:3000
  network       http://192.168.1.42:3000
  data directory /data/data/com.termux/files/home/ae-secure/data
```

Open the `network` address on any device connected to the same Wi-Fi. The **first account that registers becomes the owner** (full administrator) of the instance.

### Install and supervise it automatically

One command on the phone does everything — no token, no git needed:

```bash
curl -fsSL https://codeload.github.com/FadeKit/Encrypted-Messanger/tar.gz/refs/heads/arena/442b6c1e-encrypted-messanger \
  | tar -xz -C "$TMPDIR" && bash "$TMPDIR"/Encrypted-Messanger-*/scripts/install.sh
```

That is `scripts/install.sh`: it installs `curl`, downloads the project,
installs Node and the rest, starts the server, wires up the keep-alive
machinery, and prints the address to open. If the project is already on the
phone, run the same file from inside it: `bash scripts/install.sh`.

It delegates the real work to `scripts/termux-install.sh`, which is also the
lower-level entry point: run that one directly when you want the full set of
switches (a private token, another git remote, a local archive, or an existing
checkout).

**This application lives on the `arena/442b6c1e-encrypted-messanger` branch.**
`main` still holds the initial scaffold, which is why every command here names
the branch explicitly.

Afterwards, one command manages everything:

| Command | What it does |
| --- | --- |
| `ae-secure status` | Supervisor and server PIDs, or `stopped` |
| `ae-secure url` | Addresses to open, on the phone and on the network, with a QR code if `qrencode` is installed |
| `ae-secure logs [n]` | Tail the server log |
| `ae-secure update` | Fetch the branch, reset the checkout, restart |
| `ae-secure guard` | Start it only if it is not already running (used by the automatic hooks) |
| `ae-secure autostart on\|off` | Toggle the shell startup hook |
| `ae-secure backup [file]` | Archive the encrypted data directory |
| `ae-secure restore <file>` | Put a backup back and restart |
| `ae-secure restart \| stop \| start` | Control the service |
| `ae-secure doctor` | Node version, paths, port and a live health probe |

Where things live: code in `~/ae-secure`, data in `~/ae-secure-data` (kept out
of the checkout, so updates cannot touch it), runtime files in `~/.ae-secure`.

**How it stays up, in four layers:**

1. a supervisor restarts the server when the process exits, and treats three
   missed `/api/health` checks as a crash, so a *hung* server is replaced too.
   Backoff grows 2s → 30s and resets after a healthy run.
2. `~/.termux/boot/ae-secure.sh` starts it when Android boots. This needs the
   **Termux:Boot** app from F-Droid, opened once.
3. an Android **job scheduler** entry (every 15 minutes, `ae-secure guard`)
   revives it after a force-stop. This needs the **Termux:API** app plus
   `pkg install termux-api`.
4. `~/.bashrc` starts it whenever you open Termux by hand.

Plus a wake lock while it runs, so Doze does not freeze the server, and log
rotation at 2 MB.

Every knob is an environment variable: `AE_OWNER`, `AE_REPO`, `AE_BRANCH`,
`AE_DIR`, `AE_DATA`, `AE_HOME`, `AE_PORT`, `AE_HOST`, `AE_TLS`, `AE_HTTP_PORT`,
`AE_DISCORD_URL`, `AE_GIT_URL` (another remote), `AE_SOURCE_FILE` (a local
`.tar.gz`/`.zip`), `AE_SOURCE_DIR` (a local checkout), `AE_NO_BOOT=1`,
`AE_NO_JOB=1`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AE_TLS` | `1` | Serve **https** with a self-signed certificate generated for this phone's address. Browsers only expose WebCrypto (`crypto.subtle`) on a secure origin, so account creation and decryption need this. `AE_TLS=0` serves plain http. |
| `AE_HTTP_PORT` | `8080` | When https is on, this second listener only redirects `http://…` to the `https://` address. |
| `AE_DISCORD_URL` | empty | Your Discord invite. The credit line under the sign-in card then opens it in a new tab; without it the same link starts an encrypted DM with the credited developer instead. |

### Patch a phone that is already running AE Secure

`scripts/termux-patch.sh` stops the host that is running now, installs the
current source over it, keeps the encrypted data directory exactly where it is,
and starts it again — one line, no arguments:

```bash
curl -fsSL https://codeload.github.com/FadeKit/Encrypted-Messanger/tar.gz/refs/heads/arena/442b6c1e-encrypted-messanger \
  | tar -xz -C "$TMPDIR" && bash "$TMPDIR"/Encrypted-Messanger-*/scripts/termux-patch.sh
```

It finds the install through `~/.ae-secure/config.env`, or through the
supervisor that is running, or through its pid file, and it prints the address
to open when it is done. If the patch fails it puts the version that was
already on the phone back up, so a failed patch never leaves the phone dark.
Options: `AE_BRANCH`, `AE_PORT`, `AE_DATA`, `AE_HOME`, `AE_TLS=0`,
`AE_DISCORD_URL`, `AE_SOURCE_DIR`, `AE_SOURCE_FILE`.

### Private fork?

Point the installer at a token and it clones with it, from any of:
`GITHUB_TOKEN`, `GH_TOKEN`, `~/.ae-secure/token`, or `gh auth login`. Tokens are
never written into the config file.

### Keep it running by hand (without the installer)

```bash
# keep the phone awake while the server runs
termux-wake-lock

# run in the background, logging to a file
nohup node server/index.js > ae.log 2>&1 &

# stop it later
pkill -f server/index.js
```

Useful options — all optional, all via environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Listening port |
| `HOST` | `0.0.0.0` | Interface to bind (keep `0.0.0.0` so other devices can reach it) |
| `AE_DATA_DIR` | `./data` | Where the JSON database and encrypted blobs live |

```bash
PORT=8080 AE_DATA_DIR=/sdcard/ae-secure-data node server/index.js
```

### Reaching it from outside your home network

Put a TLS reverse proxy in front of the port (Caddy needs two lines and issues its own certificate), or use a tunnel. **Serve it over HTTPS** whenever the instance is reachable from the internet: the app derives keys locally, but the passphrase still travels through the browser's own transport to reach your device.

---

## First steps

1. **Register** the first account — it becomes the owner.
2. **Save the five backup codes** shown once after registration. They are the only way to recover an account.
3. Open **Settings → Storage & requests** to see your allowances and file a request if you need more.
4. Turn on airdrop in **Settings → Privacy & activity** if you want to receive drops.
5. Optional: enable a public profile to post stories and appear in the public square.

### Storage defaults

| Surface | Default limit | Notes |
| --- | --- | --- |
| Message attachments | 15 MB per file | Chats, community posts and airdrops |
| Cloud drive | 1 GB total | A single file is limited only by remaining space |
| Story items | 1 GB per item | Accounted separately from messaging and drive uploads |

Nothing is raised automatically. Members request more, and an operator approves a specific value, approves unlimited, or denies it — a denial changes nothing.

---

## Operator guide

Operators (roles `owner` and `admin`) get the **Admin Console** on the desktop, taskbar and start menu.

* **Overview** — uptime, memory, storage split by surface, traffic sparkline, member counts.
* **Neural network** — every member, channel and community as a node; live activity pulses; scroll to zoom, drag to pan, click a node to inspect it, and open a community or thread to read title, body and replies. It only samples while the console is open and the tab is visible, and it backfills from the event log so the graph still reflects when data actually moved.
* **Members** — avatars, verification toggle, purple status, limits, moderation, session list with remote sign-out, one-time DM codes, karma totals.
* **Requests** — approve with a value, approve as unlimited, or deny with a note.
* **Uploads & stories** — every blob on the server with owner, size and surface; story storage is tracked separately.
* **Audit & global** — the full action log and instance-wide switches (registration, maintenance mode, operator notice).

Karma (up/down votes) is visible to operators only. Public forum content is deletable by its author; direct messages, group chats and private forums are not deletable by members, and operators can remove anything in public forums and direct messages.

---

## Security model

```
passphrase ──PBKDF2(210k)──┬─► authKey ─scrypt─► server (hash only)
                           └─► vaultKey ──► seals masterKey + identity key pair
vault (sealed) ──stored on server──► opened locally on every unlock
channel key (random AES-256) ──ECDH+HKDF per member──► wrapped key material
file chunks ──AES-GCM-256, fresh IV per 512 KiB chunk, index authenticated──► ciphertext
```

* The passphrase never leaves the device; only a scrypt hash of the locally derived `authKey` is stored.
* Recovery codes each seal the vault independently and work once.
* Operator channels from one-time codes wrap the channel key for the alias `administration`; the operator's handle and account id are never disclosed in those chats.
* Files are streamed as encrypted chunks, so large uploads never need the whole file in memory.
* The server adds a strict CSP, `nosniff`, `no-referrer`, rate limits per route and no third-party requests.

Copy the `data/` directory to back up an instance. It contains ciphertext, wrapped keys, accounts and audit history — it does **not** contain anything that can decrypt a member's data, and losing a member's passphrase *and* backup codes means their content cannot be recovered by anyone, including the operator.

---

## Terms and liability

Members accept the in-app usage agreement before signing in. It states plainly that the operator hosts software, stores ciphertext and metadata, takes no part in what members send or publish, **is not liable for anything shared, posted, uploaded, sent or viewed on the instance, and accepts no responsibility for legal action arising from member activity**. The agreement version is recorded per account, and operators can bump the version to present a revised notice.

Operate the instance responsibly: you are the host, and the people you invite are the users.

---

## Development

```bash
npm test            # API suite — registers accounts and exercises every route
npm run test:flows  # client flows — real browser crypto against a throwaway server
npm run test:client # client static suite — every script, surface and help article
npm run test:all    # all three, in order
```

Two browser harnesses run the real interface in headless Chrome against a
throwaway server on a throwaway port. Both need `puppeteer-core` and a Chrome
binary; they are development tools and are not installed by the server.

```bash
# every surface, at a chosen viewport: blank screens, clipping, overlaps
AE_LABEL=phone AE_W=390 AE_H=844 AE_PORT=3480 node tools/visual-audit.mjs
AE_LABEL=desktop AE_W=1440 AE_H=900 AE_PORT=3481 node tools/visual-audit.mjs

# the flows people actually perform: crop a picture and switch between the last
# three, post and delete a 24-hour note, make a file and reopen it from the
# drive, the taskbar tabs, the click counter
AE_LABEL=phone AE_W=390 AE_H=844 AE_PORT=3490 node tools/e2e-punchlist.mjs
```

Set `AE_SHOTS` to keep the screenshots somewhere other than `/tmp/ae/shots`.

| Suite | What it proves |
| --- | --- |
| `tests/run.js` | 121 checks over accounts, recovery, sessions, messaging, communities, uploads, quotas, requests, one-time codes, airdrops, stories and the operator surface |
| `tests/flows.js` | 81 checks driving the server with `public/js/crypto.js` executed in a VM: masked operator channels opened from codes, encrypted drive folders and chunked files, airdrops sealed per recipient, audience-key stories, session revocation, the request queue and every console endpoint |
| `tests/client.js` | 307 checks loading all 22 browser scripts in index.html order against a DOM shim: duplicate bindings, missing surfaces, `Apps.open()` targets, registered window ids, styled classes and resolvable help articles |

Every suite boots the real server on a random port with a temporary data directory and cleans up after itself — no fixtures to maintain and nothing touches `data/`.

### Layout

```
server/            zero-dependency HTTP server
  index.js         router, security headers, static files, SSE endpoint
  store.js         JSON database + encrypted blob storage, periodic flush
  helpers.js       auth guards, views, quotas, notifications
  realtime.js      SSE hub: presence, push channels, neural sampling
  routes-auth.js   accounts, sessions, settings, presence, requests, codes, airdrops, clicker
  routes-social.js conversations, messages, communities, stories, public feed, directory
  routes-files.js  chunked encrypted uploads, drive folders, quota accounting
  routes-admin.js  operator console data and decisions
public/            the client (no build step, no frameworks)
  css/             design tokens, base, window chrome, components
  js/              crypto, api, ui, windows, state, registry, feature modules, shell
tests/               end-to-end suites (server, flows, client)
tools/               browser harnesses: surface audit and the punch-list flows
data/              created on first run (git-ignored)
```

### Troubleshooting

* **Login says the server is unreachable** — the phone dropped the Wi-Fi. Re-run `termux-wake-lock` and restart the server.
* **Other devices cannot connect** — make sure the server is bound to `0.0.0.0` and that the phone's firewall or hotspot client isolation is not blocking the port.
* **Blur feels slow on an old phone** — reduce *Blur radius* and enable *Reduce motion* in Settings → Accessibility.
* **A member lost their device** — they sign in with a backup code, set a new passphrase, and every other session is signed out immediately. If they believe someone else took the account over, review their sessions from the member panel.
