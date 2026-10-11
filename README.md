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
| Design | Windows 11 style acrylic windows, themes, accents, 5 themes, 9 accents, full accessibility suite, phone-friendly layout |

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

### Keep it running

```bash
# keep the phone awake while the server runs
termux-wake-lock

# run in the background, logging to a file (mktemp -d not needed)
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

| Suite | What it proves |
| --- | --- |
| `tests/run.js` | 121 checks over accounts, recovery, sessions, messaging, communities, uploads, quotas, requests, one-time codes, airdrops, stories and the operator surface |
| `tests/flows.js` | 79 checks driving the server with `public/js/crypto.js` executed in a VM: masked operator channels opened from codes, encrypted drive folders and chunked files, airdrops sealed per recipient, audience-key stories, session revocation, the request queue and every console endpoint |
| `tests/client.js` | 81 checks loading all 17 browser scripts in index.html order against a DOM shim: duplicate bindings, missing surfaces, `Apps.open()` targets, registered window ids and resolvable help articles |

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
tests/run.js       end-to-end suite
data/              created on first run (git-ignored)
```

### Troubleshooting

* **Login says the server is unreachable** — the phone dropped the Wi-Fi. Re-run `termux-wake-lock` and restart the server.
* **Other devices cannot connect** — make sure the server is bound to `0.0.0.0` and that the phone's firewall or hotspot client isolation is not blocking the port.
* **Blur feels slow on an old phone** — reduce *Blur radius* and enable *Reduce motion* in Settings → Accessibility.
* **A member lost their device** — they sign in with a backup code, set a new passphrase, and every other session is signed out immediately. If they believe someone else took the account over, review their sessions from the member panel.
