#!/usr/bin/env bash
# =============================================================================
#  AE Secure — Termux installer and supervisor
# -----------------------------------------------------------------------------
#  Installs AE Secure from GitHub onto a phone running Termux, starts it, keeps
#  it running when it crashes or the phone reboots, and gives you an `ae-secure`
#  command to manage it.
#
#  Quick start (inside Termux): run scripts/install.sh from the checkout, or
#  use the one-command bootstrap, which does the same thing without git:
#
#      curl -fsSL https://codeload.github.com/FadeKit/Encrypted-Messanger/tar.gz/refs/heads/arena/442b6c1e-encrypted-messanger \
#        | tar -xz -C "$TMPDIR" && bash "$TMPDIR"/Encrypted-Messanger-*/scripts/install.sh
#
#  Everything can be overridden with environment variables:
#
#      AE_OWNER  AE_REPO  AE_BRANCH  AE_DIR  AE_DATA  AE_PORT  AE_HOST
#      AE_GIT_URL (another remote)  AE_SOURCE_FILE (a local .tar.gz or .zip)
#      AE_SOURCE_DIR (a local checkout)  AE_NO_JOB=1 (skip the periodic guard)
#      AE_TLS=0 (serve plain http)  AE_HTTP_PORT (plain-port redirect, default 8080)
#      AE_DISCORD_URL (the developer link shown on the sign-in screen)
#
#  Commands: install (default) | update | start | stop | restart | status |
#            logs | url | backup | restore <file> | trust | doctor
# =============================================================================

set -uo pipefail

# --------------------------------------------------------------- settings ----
AE_OWNER="${AE_OWNER:-FadeKit}"
AE_REPO="${AE_REPO:-Encrypted-Messanger}"
# The finished application currently lives on this branch. Set AE_BRANCH=main
# if you have merged it there yourself.
AE_BRANCH="${AE_BRANCH:-arena/442b6c1e-encrypted-messanger}"

AE_DIR="${AE_DIR:-$HOME/ae-secure}"              # application code
AE_DATA="${AE_DATA:-$HOME/ae-secure-data}"       # encrypted data, kept apart from the code
AE_PORT="${AE_PORT:-3000}"
AE_HOST="${AE_HOST:-0.0.0.0}"
AE_HOME="${AE_HOME:-$HOME/.ae-secure}"           # runtime files: logs, pids, config
AE_BIN_DIR="$AE_HOME/bin"
AE_LOG="$AE_HOME/logs/server.log"
AE_PID="$AE_HOME/run/server.pid"
AE_SUP_PID="$AE_HOME/run/supervisor.pid"
AE_CONF="$AE_HOME/config.env"
AE_HEALTH_PATH="${AE_HEALTH_PATH:-/api/health}"
AE_TLS="${AE_TLS:-1}"
AE_HTTP_PORT="${AE_HTTP_PORT:-8080}"
AE_TLS_DIR="${AE_TLS_DIR:-$AE_HOME/tls}"
AE_DISCORD_URL="${AE_DISCORD_URL:-}"
AE_HEALTH_TIMEOUT="${AE_HEALTH_TIMEOUT:-4}"
AE_HEALTH_FAILS="${AE_HEALTH_FAILS:-3}"          # missed checks before a hang is treated as a crash
AE_BACKOFF="${AE_BACKOFF:-2}"                    # seconds, doubled up to 30 on repeat failures

COMMAND="${1:-install}"

# ---------------------------------------------------------------- output -----
if [ -t 1 ]; then C_DIM=$'\033[2m'; C_OFF=$'\033[0m'; else C_DIM=''; C_OFF=''; fi
say()  { printf '%s\n' "$*"; }
note() { printf '%s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }
step() { printf '\n== %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

on_termux() { [ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux/files/usr ]; }
have()      { command -v "$1" >/dev/null 2>&1; }

# ------------------------------------------------------------- config file ---
write_config() {
  mkdir -p "$AE_HOME"
  cat > "$AE_CONF" <<CONF
# AE Secure — install settings. Sourced by the ae-secure command.
AE_OWNER="$AE_OWNER"
AE_REPO="$AE_REPO"
AE_BRANCH="$AE_BRANCH"
AE_GIT_URL="${AE_GIT_URL:-}"
AE_DIR="$AE_DIR"
AE_DATA="$AE_DATA"
AE_PORT="$AE_PORT"
AE_HOST="$AE_HOST"
AE_HOME="$AE_HOME"
AE_HTTP_PORT="$AE_HTTP_PORT"
AE_TLS_CERT="${AE_TLS_CERT:-}"
AE_TLS_CA="${AE_TLS_CA:-}"
AE_TLS_KEY="${AE_TLS_KEY:-}"
AE_TLS="$AE_TLS"
AE_TLS_DIR="$AE_TLS_DIR"
AE_DISCORD_URL="$AE_DISCORD_URL"
AE_HEALTH_PATH="$AE_HEALTH_PATH"
AE_HEALTH_TIMEOUT="$AE_HEALTH_TIMEOUT"
AE_HEALTH_FAILS="$AE_HEALTH_FAILS"
AE_BACKOFF="$AE_BACKOFF"
CONF
  chmod 600 "$AE_CONF"
}

load_config() {
  if [ -f "$AE_CONF" ]; then
    # shellcheck disable=SC1090
    . "$AE_CONF"
    AE_BIN_DIR="$AE_HOME/bin"
    AE_LOG="$AE_HOME/logs/server.log"
    AE_PID="$AE_HOME/run/server.pid"
    AE_SUP_PID="$AE_HOME/run/supervisor.pid"
  fi
}

# ------------------------------------------------------------- packages ------
ensure_packages() {
  if ! on_termux; then
    note "not Termux: skipping package installation (node and git are expected on PATH)"
    return 0
  fi
  step "Packages"
  local needed=()
  have node || needed+=(nodejs-lts)
  have git  || needed+=(git)
  have curl || needed+=(curl)
  if [ ${#needed[@]} -gt 0 ]; then
    say "installing: ${needed[*]}"
    pkg install -y "${needed[@]}" || die "pkg install failed — run: pkg update && pkg upgrade"
  else
    say "node, git and curl are already installed"
  fi
  have termux-wake-lock || note "tip: install the Termux:API app and 'pkg install termux-api' for a wake lock"
}

check_node() {
  have node || die "node is not installed"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge 18 ] 2>/dev/null || die "node 18 or newer is required (found $(node -v 2>/dev/null || echo none))"
  say "node $(node -v) — ok"
}

# ------------------------------------------------------------------- tls -----
# WebCrypto only exists in a secure context, so a phone on the LAN must be
# served over https. A self-signed certificate is enough: the browser warns
# once, then the origin counts as secure and every crypto call works.
install_tls() {
  step "Transport"
  if [ "$AE_TLS" != "1" ]; then
    # A prior config may contain generated certificate paths. Clear them when
    # HTTP is explicitly selected, or the server can still start HTTPS while
    # the service command advertises a plain-http URL.
    AE_TLS_CERT=""
    AE_TLS_KEY=""
    AE_TLS_CA=""
    note "plain http requested (AE_TLS=0) — phones will not be able to create accounts"
    return 0
  fi
  if ! have openssl; then
    if on_termux; then
      say "installing openssl"
      pkg install -y openssl-tool >/dev/null 2>&1 || pkg install -y openssl >/dev/null 2>&1 || true
    fi
  fi
  if ! have openssl; then
    note "openssl is missing, so no certificate could be generated."
    note "Run: pkg install openssl-tool   and then re-run this installer."
    return 0
  fi

  local ip; ip="$(lan_ip)"
  local cert="$AE_TLS_DIR/server.crt" key="$AE_TLS_DIR/server.key"
  # Existing custom certificate paths are part of the install configuration.
  # Keep a valid custom pair intact instead of silently replacing it with a
  # generated key under AE_TLS_DIR. The default generated pair still follows
  # the address/expiry refresh path below.
  if [ -n "${AE_TLS_CERT:-}" ] || [ -n "${AE_TLS_KEY:-}" ]; then
    [ -n "${AE_TLS_CERT:-}" ] && [ -n "${AE_TLS_KEY:-}" ] || die "both AE_TLS_CERT and AE_TLS_KEY are required"
    if [ "$AE_TLS_CERT" != "$cert" ] || [ "$AE_TLS_KEY" != "$key" ]; then
      [ -f "$AE_TLS_CERT" ] && [ -f "$AE_TLS_KEY" ] || die "configured TLS certificate/key is missing; check AE_TLS_CERT and AE_TLS_KEY"
      openssl x509 -in "$AE_TLS_CERT" -noout >/dev/null 2>&1 || die "configured AE_TLS_CERT is not a valid certificate"
      openssl pkey -in "$AE_TLS_KEY" -noout >/dev/null 2>&1 || die "configured AE_TLS_KEY is not a valid private key"
      if [ -n "${AE_TLS_CA:-}" ] && [ ! -f "$AE_TLS_CA" ]; then die "configured AE_TLS_CA is missing"; fi
      say "using the configured TLS certificate: $AE_TLS_CERT"
      return 0
    fi
  fi
  mkdir -p "$AE_TLS_DIR"

  local needs=0
  [ -f "$cert" ] && [ -f "$key" ] || needs=1
  if [ -f "$cert" ] && [ -n "$(openssl x509 -in "$cert" -noout -checkend 86400 2>/dev/null || true)" ]; then
    :
  elif [ -f "$cert" ]; then
    needs=1
  fi
  if [ -f "$cert" ] && [ "$needs" = "0" ] && have openssl; then
    # keep the certificate if it already covers this address
    if ! openssl x509 -in "$cert" -noout -text 2>/dev/null | grep -q "IP Address:$ip"; then needs=1; fi
  fi

  # A leaf signed by the install's own authority.  Installing that one
  # certificate on a device is what removes "Not secure" — a plain self-signed
  # leaf cannot, because nothing else knows it.
  local ca_cert="$AE_TLS_DIR/ca.crt" ca_key="$AE_TLS_DIR/ca.key"
  local leaf_needs_ca=0
  if [ -f "$ca_cert" ] && [ -f "$ca_key" ]; then
    if [ -f "$cert" ] && openssl verify -CAfile "$ca_cert" "$cert" >/dev/null 2>&1; then
      :
    else
      leaf_needs_ca=1
    fi
  else
    say "creating a local certificate authority (CA)"
    openssl req -x509 -nodes -newkey rsa:2048 -days 3650 -sha256 \
      -keyout "$ca_key" -out "$ca_cert" \
      -subj "/CN=AE Secure local CA/O=AE Secure" \
      -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
      -addext "keyUsage=critical,keyCertSign,cRLSign" >/dev/null 2>&1 || true
    chmod 600 "$ca_key" 2>/dev/null || true
    if [ -f "$ca_cert" ]; then
      say "authority written to $ca_cert — install it once on each device"
      leaf_needs_ca=1
      needs=1
    else
      note "could not create a local authority; falling back to a self-signed certificate"
    fi
  fi

  if [ "$needs" = "0" ] && [ "$leaf_needs_ca" = "0" ]; then
    say "certificate already covers this address"
  else
    local cnf="$AE_TLS_DIR/openssl.cnf"
    cat > "$cnf" <<CNF
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req
[dn]
CN = AE Secure
O = AE Secure
[v3_req]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt
[alt]
DNS.1 = localhost
DNS.2 = ae-secure.local
IP.1 = 127.0.0.1
IP.2 = $ip
CNF
    if [ -f "$ca_cert" ] && [ -f "$ca_key" ]; then
      openssl req -nodes -newkey rsa:2048 -keyout "$key" -out "$AE_TLS_DIR/server.csr" -config "$cnf" >/dev/null 2>&1 \
        && openssl x509 -req -in "$AE_TLS_DIR/server.csr" -CA "$ca_cert" -CAkey "$ca_key" -CAcreateserial \
             -days 825 -sha256 -extfile "$cnf" -extensions v3_req -out "$cert" >/dev/null 2>&1
      rm -f "$AE_TLS_DIR/server.csr"
    fi
    if [ ! -f "$cert" ] || ! openssl x509 -in "$cert" -noout >/dev/null 2>&1; then
      openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
        -keyout "$key" -out "$cert" -config "$cnf" >/dev/null 2>&1 \
        || { note "could not generate a certificate — serving plain http"; return 0; }
      say "certificate generated for $ip (valid 825 days, self-signed)"
    else
      say "certificate generated for $ip (valid 825 days, signed by the local CA)"
    fi
    chmod 600 "$key"
  fi

  if [ -f "$ca_cert" ]; then
    local fingerprint
    fingerprint="$(openssl x509 -in "$ca_cert" -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*=//' || true)"
    say ""
    say "To stop the browser warning on your phone, tablet and PC:"
    say "  1. open  https://$ip:$AE_PORT/trust  on that device"
    say "  2. download the certificate and install it as a CA certificate"
    say "     Android: Settings -> Security -> Encryption & credentials -> Install a certificate"
    say "     Windows: double-click the file -> Install -> Local Machine -> Trusted Root"
    say "     macOS:   Keychain Access -> System -> drag it in -> Always Trust"
    say "  3. restart the browser: the address bar then shows a plain padlock"
    [ -n "$fingerprint" ] && note "CA fingerprint (SHA-256): $fingerprint"
    note "The trust page shows this same value — check they match before installing."
  fi

  AE_TLS_CERT="$cert"
  AE_TLS_KEY="$key"
  [ -f "$ca_cert" ] && AE_TLS_CA="$ca_cert"
  if [ -f "${AE_TLS_DIR:-$AE_HOME/tls}/ca.crt" ]; then
    say "https enabled — install the local certificate once per device (see above)"
  else
    say "https enabled — the browser will ask you to accept the certificate once"
  fi
}

# --------------------------------------------------------------- source ------
github_token() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then printf '%s' "$GITHUB_TOKEN"; return; fi
  if [ -n "${GH_TOKEN:-}" ]; then printf '%s' "$GH_TOKEN"; return; fi
  if [ -f "$AE_HOME/token" ]; then printf '%s' "$(tr -d '\r\n' < "$AE_HOME/token")"; return; fi
  if have gh && gh auth token >/dev/null 2>&1; then gh auth token; return; fi
  printf ''
}

# AE_GIT_URL points the installer at another remote: a mirror, a self-hosted
# forge, or a bare repository on this phone. It defaults to GitHub.
clone_url() {
  if [ -n "${AE_GIT_URL:-}" ]; then printf '%s' "$AE_GIT_URL"; return; fi
  local token="$1"
  if [ -n "$token" ]; then
    printf 'https://x-access-token:%s@github.com/%s/%s.git' "$token" "$AE_OWNER" "$AE_REPO"
  else
    printf 'https://github.com/%s/%s.git' "$AE_OWNER" "$AE_REPO"
  fi
}

fetch_git() {
  local token="$1" url; url="$(clone_url "$token")"
  if [ -d "$AE_DIR/.git" ]; then
    say "updating $AE_DIR from origin/$AE_BRANCH"
    git -C "$AE_DIR" remote set-url origin "$url" || true
    git -C "$AE_DIR" fetch --depth 1 origin "$AE_BRANCH" || return 1
    # reset, never --soft: the working tree must match the fetched commit exactly
    git -C "$AE_DIR" reset --hard FETCH_HEAD >/dev/null || return 1
    git -C "$AE_DIR" clean -fd -e node_modules >/dev/null || true
    return 0
  fi
  if [ -e "$AE_DIR" ]; then
    # A tarball install from before has no .git.  It is still this project, so
    # hand it to the archive path instead of refusing to patch the phone.
    assert_replaceable
    return 1
  fi
  say "cloning into $AE_DIR"
  git clone --depth 1 --branch "$AE_BRANCH" "$url" "$AE_DIR" >/dev/null 2>&1 || \
    git clone --depth 1 "$url" "$AE_DIR" >/dev/null 2>&1 || return 1
  git -C "$AE_DIR" checkout "$AE_BRANCH" >/dev/null 2>&1 || true
  return 0
}

# Replacing the code directory is only safe when it holds this project (a git
# checkout, a previous archive install, anything with server/index.js) or is
# empty.  A directory someone else owns is never deleted.
assert_replaceable() {
  [ -e "$AE_DIR" ] || return 0
  [ -d "$AE_DIR/.git" ] && return 0
  [ -f "$AE_DIR/server/index.js" ] && return 0
  [ -z "$(ls -A "$AE_DIR" 2>/dev/null)" ] && return 0
  die "$AE_DIR exists and does not look like AE Secure — move it aside or set AE_DIR"
}

fetch_tarball() {
  local token="$1"
  local url="https://codeload.github.com/$AE_OWNER/$AE_REPO/tar.gz/refs/heads/$AE_BRANCH"
  local tmp; tmp="$(mktemp -d "${TMPDIR:-/tmp}/ae-src.XXXXXX")" || return 1
  say "downloading archive from codeload.github.com"
  if [ -n "$token" ]; then
    curl -fsSL -H "Authorization: Bearer $token" -o "$tmp/src.tar.gz" "$url" || { rm -rf "$tmp"; return 1; }
  else
    curl -fsSL -o "$tmp/src.tar.gz" "$url" || { rm -rf "$tmp"; return 1; }
  fi
  tar -xzf "$tmp/src.tar.gz" -C "$tmp" || { rm -rf "$tmp"; return 1; }
  local inner; inner="$(find "$tmp" -maxdepth 1 -mindepth 1 -type d | head -1)"
  [ -n "$inner" ] || { rm -rf "$tmp"; return 1; }
  assert_replaceable
  rm -rf "$AE_DIR"
  mkdir -p "$(dirname "$AE_DIR")"
  mv "$inner" "$AE_DIR"
  rm -rf "$tmp"
  return 0
}

fetch_local() {
  local file="$1" tmp
  [ -f "$file" ] || die "AE_SOURCE_FILE not found: $file"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/ae-src.XXXXXX")" || return 1
  say "extracting $file"
  case "$file" in
    *.zip)  have unzip || die "unzip is required for zip archives (pkg install unzip)"; unzip -q "$file" -d "$tmp" ;;
    *.tar.gz|*.tgz) tar -xzf "$file" -C "$tmp" ;;
    *.tar)  tar -xf "$file" -C "$tmp" ;;
    *) die "unsupported archive: $file" ;;
  esac
  local inner; inner="$(find "$tmp" -maxdepth 2 -name server -type d | head -1)"
  assert_replaceable
  if [ -n "$inner" ]; then
    rm -rf "$AE_DIR"; mkdir -p "$(dirname "$AE_DIR")"; mv "$(dirname "$inner")" "$AE_DIR"
  else
    rm -rf "$AE_DIR"; mkdir -p "$AE_DIR"; cp -R "$tmp"/. "$AE_DIR"/
  fi
  rm -rf "$tmp"
  return 0
}

# Copies a local checkout into AE_DIR. Used by scripts/install.sh, which has
# already downloaded the project, and by anyone running this from a clone.
fetch_local_dir() {
  local from="$1"
  [ -f "$from/server/index.js" ] || die "AE_SOURCE_DIR is not the project: $from (server/index.js is missing)"
  local target_source target_dir
  target_source="$(cd "$from" && pwd -P)"
  mkdir -p "$AE_DIR"
  target_dir="$(cd "$AE_DIR" && pwd -P)"
  if [ "$target_source" = "$target_dir" ]; then
    say "using the checkout in place: $target_dir"
    return 0
  fi
  case "$target_dir/" in
    "$target_source"/*) die "AE_DIR must not sit inside AE_SOURCE_DIR ($target_dir)";;
  esac
  say "installing from $target_source"
  ( cd "$target_source" && tar --exclude=./node_modules --exclude=./.git --exclude=./data -cf - . ) | ( cd "$target_dir" && tar -xf - )
}

fetch_source() {
  step "Source"
  if [ -n "${AE_SOURCE_DIR:-}" ]; then
    fetch_local_dir "$AE_SOURCE_DIR" || die "could not copy $AE_SOURCE_DIR"
  elif [ -n "${AE_SOURCE_FILE:-}" ]; then
    fetch_local "$AE_SOURCE_FILE" || die "could not extract $AE_SOURCE_FILE"
  else
    local token; token="$(github_token)"
    [ -n "$token" ] && say "using a GitHub token (kept in memory only)" || note "no token found — the repository must be public"
    if have git && fetch_git "$token"; then
      say "checked out $(git -C "$AE_DIR" rev-parse --short HEAD) on $AE_BRANCH"
    elif fetch_tarball "$token"; then
      say "installed the $AE_BRANCH archive into $AE_DIR"
    else
      die "download failed — check the owner/repo/branch and your token"
    fi
    if [ -z "${AE_GIT_URL:-}" ]; then
      [ -n "$token" ] && git -C "$AE_DIR" remote set-url origin "https://github.com/$AE_OWNER/$AE_REPO.git" 2>/dev/null || true
    fi
  fi
  [ -f "$AE_DIR/server/index.js" ] || die "server/index.js is missing — is the branch correct?"
  mkdir -p "$AE_DATA"
  note "code: $AE_DIR"
  note "data: $AE_DATA"
}

# --------------------------------------------------------- housekeeping ------
rotate_logs() {
  mkdir -p "$AE_HOME/logs" "$AE_HOME/run"
  if [ -f "$AE_LOG" ]; then
    local size; size="$(wc -c < "$AE_LOG" 2>/dev/null || echo 0)"
    if [ "$size" -gt 2000000 ]; then mv -f "$AE_LOG" "$AE_LOG.1"; fi
  fi
  : > "$AE_LOG"
}

acquire_wakelock() {
  if have termux-wake-lock; then termux-wake-lock 2>/dev/null || true; fi
}

release_wakelock() {
  if have termux-wake-unlock; then termux-wake-unlock 2>/dev/null || true; fi
}

notify_status() {
  have termux-notification || return 0
  local text="$1"
  termux-notification --id ae-secure --title "AE Secure" --content "$text" \
    --priority low --ongoing 2>/dev/null || true
}

lan_ip() {
  if have termux-wifi-connectioninfo; then
    local ip
    ip="$(termux-wifi-connectioninfo 2>/dev/null | sed -n 's/.*"ip".*"\([0-9.]\+\)".*/\1/p' | head -1)"
    [ -n "$ip" ] && [ "$ip" != "0.0.0.0" ] && { printf '%s' "$ip"; return; }
  fi
  if have ifconfig; then
    local ip
    ip="$(ifconfig 2>/dev/null | awk '/inet /{print $2}' | grep -v '127\.0\.0\.1' | head -1 | sed 's/addr://')"
    [ -n "$ip" ] && { printf '%s' "$ip"; return; }
  fi
  if have ip; then
    local ip
    ip="$(ip -4 addr show 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1 | grep -v '127\.0\.0\.1' | head -1)"
    [ -n "$ip" ] && { printf '%s' "$ip"; return; }
  fi
  printf 'your-phone-ip'
}

health_scheme() {
  if [ "$AE_TLS" = "1" ] && [ -f "$AE_TLS_DIR/server.crt" ]; then printf 'https'; else printf 'http'; fi
}

health_check() {
  local url="$(health_scheme)://127.0.0.1:$AE_PORT$AE_HEALTH_PATH"
  if have curl; then
    # -k: the certificate is self-signed and expected to be unknown to curl
    curl -fsSk --max-time "$AE_HEALTH_TIMEOUT" "$url" >/dev/null 2>&1 && return 0 || return 1
  fi
  have node || return 1
  node -e '
    const http = require("http");
    const port = Number(process.argv[1]);
    const path = process.argv[2];
    const request = http.get({ host: "127.0.0.1", port, path, timeout: 3000 }, (res) => {
      res.resume();
      process.exit(res.statusCode === 200 ? 0 : 1);
    });
    request.on("timeout", () => { request.destroy(); process.exit(1); });
    request.on("error", () => process.exit(1));
  ' "$AE_PORT" "$AE_HEALTH_PATH" >/dev/null 2>&1
}

running_pid() {
  [ -f "$AE_SUP_PID" ] || return 1
  local pid; pid="$(cat "$AE_SUP_PID" 2>/dev/null)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  printf '%s' "$pid"
}

# ------------------------------------------------------------ supervisor -----
install_watchdog() {
  mkdir -p "$AE_BIN_DIR"
  cat > "$AE_BIN_DIR/watchdog" <<WATCHDOG
#!/usr/bin/env bash
# Generated by the AE Secure installer. Restarts the server when it exits,
# crashes, or stops answering on its health endpoint.
set -uo pipefail
AE_DIR="$AE_DIR"
AE_DATA="$AE_DATA"
AE_PORT="$AE_PORT"
AE_HOST="$AE_HOST"
AE_HOME="$AE_HOME"
AE_LOG="$AE_LOG"
AE_PID="$AE_PID"
AE_SUP_PID="$AE_SUP_PID"
AE_HEALTH_PATH="$AE_HEALTH_PATH"
AE_TLS_CERT="${AE_TLS_CERT:-}"
AE_TLS_KEY="${AE_TLS_KEY:-}"
AE_TLS_CA="${AE_TLS_CA:-}"
AE_HTTP_PORT="$AE_HTTP_PORT"
AE_DISCORD_URL="$AE_DISCORD_URL"
AE_SCHEME="http"
AE_HEALTH_TIMEOUT="$AE_HEALTH_TIMEOUT"
AE_HEALTH_FAILS="$AE_HEALTH_FAILS"
AE_BACKOFF="$AE_BACKOFF"

[ -n "\${PREFIX:-}" ] && export PATH="\$PREFIX/bin:\$HOME/bin:\$PATH"
mkdir -p "\$(dirname "\$AE_LOG")" "\$(dirname "\$AE_PID")"
echo \$\$ > "\$AE_SUP_PID"
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock

log() { printf '[%s] %s\n' "\$(date '+%Y-%m-%d %H:%M:%S')" "\$*" >> "\$AE_LOG"; }
health() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSk --max-time "\$AE_HEALTH_TIMEOUT" "\$AE_SCHEME://127.0.0.1:\$AE_PORT\$AE_HEALTH_PATH" >/dev/null 2>&1
  else
    node -e '
      const http = require("http");
      const request = http.get({ host: "127.0.0.1", port: Number(process.argv[1]), path: process.argv[2], timeout: 3000 }, (res) => { res.resume(); process.exit(res.statusCode === 200 ? 0 : 1); });
      request.on("timeout", () => { request.destroy(); process.exit(1); });
      request.on("error", () => process.exit(1));
    ' "\$AE_PORT" "\$AE_HEALTH_PATH" >/dev/null 2>&1
  fi
}

CHILD=0
stop() {
  log "supervisor stopping"
  [ "\$CHILD" -gt 0 ] && kill -TERM "\$CHILD" 2>/dev/null
  sleep 1
  [ "\$CHILD" -gt 0 ] && kill -KILL "\$CHILD" 2>/dev/null
  command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock
  rm -f "\$AE_SUP_PID" "\$AE_PID"
  exit 0
}
trap stop TERM INT

backoff="\$AE_BACKOFF"
while :; do
  cd "\$AE_DIR" || { log "cannot enter \$AE_DIR"; exit 1; }
  log "starting: node server/index.js on \$AE_HOST:\$AE_PORT"
  AE_DATA_DIR="\$AE_DATA" PORT="\$AE_PORT" HOST="\$AE_HOST" \
    AE_TLS_CERT="\$AE_TLS_CERT" AE_TLS_KEY="\$AE_TLS_KEY" AE_TLS_CA="\$AE_TLS_CA" AE_HTTP_PORT="\$AE_HTTP_PORT" \
    AE_DISCORD_URL="\$AE_DISCORD_URL" node server/index.js >> "\$AE_LOG" 2>&1 &
  CHILD=\$!
  echo "\$CHILD" > "\$AE_PID"
  log "child pid \$CHILD"

  misses=0
  while kill -0 "\$CHILD" 2>/dev/null; do
    sleep 10
    kill -0 "\$CHILD" 2>/dev/null || break
    if health; then
      misses=0
    else
      misses=\$((misses + 1))
      log "health check missed (\$misses/\$AE_HEALTH_FAILS)"
      if [ "\$misses" -ge "\$AE_HEALTH_FAILS" ]; then
        log "server is not answering — restarting"
        kill -TERM "\$CHILD" 2>/dev/null
        sleep 2
        kill -KILL "\$CHILD" 2>/dev/null
        break
      fi
    fi
  done

  wait "\$CHILD" 2>/dev/null
  code=\$?
  log "server exited (status \$code) — restarting in \${backoff}s"
  CHILD=0
  sleep "\$backoff"
  case "\$backoff" in 2) backoff=4;; 4) backoff=8;; 8) backoff=16;; 16) backoff=30;; *) backoff=30;; esac
  health && backoff="\$AE_BACKOFF"
done
WATCHDOG
    # the watchdog probes the same scheme the server is serving
  sed -i "s|^AE_TLS_CERT=\"\"|AE_TLS_CERT=\"${AE_TLS_CERT:-}\"|; s|^AE_SCHEME=.*|AE_SCHEME=$( [ "$AE_TLS" = "1" ] && [ -n "${AE_TLS_CERT:-}" ] && printf https || printf http )|" "$AE_BIN_DIR/watchdog"
chmod +x "$AE_BIN_DIR/watchdog"
}

# ---------------------------------------------------------- boot hooks -------
install_boot_hook() {
  step "Starting on boot"
  local boot_dir="$HOME/.termux/boot"
  local boot_file="$boot_dir/ae-secure.sh"
  mkdir -p "$boot_dir"
  cat > "$boot_file" <<BOOT
#!/data/data/com.termux/files/usr/bin/sh
# Written by the AE Secure installer. Termux:Boot runs this after the phone
# starts, so the server comes back without anyone opening Termux.
export PATH="/data/data/com.termux/files/usr/bin:$HOME/bin:$PATH"
export HOME="${HOME:-/data/data/com.termux/files/home}"
termux-wake-lock 2>/dev/null
sleep 12
"$AE_BIN_DIR/ae-secure" guard >/dev/null 2>&1
BOOT
  chmod +x "$boot_file"
  say "boot hook: $boot_file"
  note "Termux:Boot app (F-Droid) must be installed and opened once, or the boot hook will not run" 

  # Fallback: start it when a Termux session opens, for phones without Termux:Boot.
  local profile="$HOME/.bashrc"
  touch "$profile"
  strip_autostart_block "$profile"
  cat >> "$profile" <<PROFILE

# >>> ae-secure autostart >>>
if [ -x "$AE_BIN_DIR/ae-secure" ] && [ -z "\${AE_SECURE_NOSTART:-}" ]; then
  "$AE_BIN_DIR/ae-secure" guard >/dev/null 2>&1
fi
# <<< ae-secure autostart <<<
PROFILE
  say "session hook: $profile"
}

# Removes the managed block from a shell profile, leaving everything else alone.
strip_autostart_block() {
  local profile="$1" tmp
  grep -q "ae-secure autostart" "$profile" 2>/dev/null || return 0
  tmp="$(mktemp)" || return 0
  awk '/^# >>> ae-secure autostart >>>$/{skip=1;next} /^# <<< ae-secure autostart <<<$/{skip=0;next} !skip' "$profile" > "$tmp" && mv "$tmp" "$profile"
}

# ------------------------------------------------------- scheduled guard -----
# Termux:API exposes Android's job scheduler. A 15-minute guard job restarts the
# service after Android has killed everything, which survives without Termux:Boot.
install_guard_job() {
  [ "${AE_NO_JOB:-0}" = "1" ] && { note "periodic guard skipped (AE_NO_JOB=1)"; return 0; }
  if ! have termux-job-scheduler; then
    note "tip: install the Termux:API app, then 'pkg install termux-api' for a periodic"
    note "     keep-alive job that also survives a force-stop"
    return 0
  fi
  cat > "$AE_BIN_DIR/guard-job.sh" <<GUARD
#!/data/data/com.termux/files/usr/bin/sh
# Written by the AE Secure installer: the periodic keep-alive job.
exec "$AE_BIN_DIR/ae-secure" guard
GUARD
  chmod +x "$AE_BIN_DIR/guard-job.sh"
  if termux-job-scheduler --job-id 9421 --period-ms 900000 --persisted true \
       --script "$AE_BIN_DIR/guard-job.sh" >/dev/null 2>&1; then
    say "periodic guard: every 15 minutes (job 9421)"
  else
    note "could not register the periodic guard job — the boot hook still applies"
  fi
}

# ------------------------------------------------------------- command -------
install_command() {
  mkdir -p "$AE_BIN_DIR"
  cat > "$AE_BIN_DIR/ae-secure" <<'CLI'
#!/usr/bin/env bash
# AE Secure service command. The installer substitutes @AE_HOME_DEFAULT@
# below with the real directory, so this works from any shell and from
# Termux:Boot without any environment set up first.
set -uo pipefail
[ -n "${PREFIX:-}" ] && export PATH="$PREFIX/bin:$HOME/bin:$PATH"
AE_HOME="${AE_HOME:-@AE_HOME_DEFAULT@}"
AE_CONF="$AE_HOME/config.env"
[ -f "$AE_CONF" ] && . "$AE_CONF"
AE_BIN_DIR="$AE_HOME/bin"
AE_LOG="$AE_HOME/logs/server.log"

strip_autostart_block() {
  local profile="$1" tmp
  [ -f "$profile" ] || return 0
  grep -q "ae-secure autostart" "$profile" 2>/dev/null || return 0
  tmp="$(mktemp)" || return 0
  awk '/^# >>> ae-secure autostart >>>$/{skip=1;next} /^# <<< ae-secure autostart <<<$/{skip=0;next} !skip' "$profile" > "$tmp" && mv "$tmp" "$profile"
}

status_line() {
  local pid
  if pid="$(cat "$AE_HOME/run/supervisor.pid" 2>/dev/null)" && [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    printf 'running (supervisor %s' "$pid"
    local child; child="$(cat "$AE_HOME/run/server.pid" 2>/dev/null)"
    [ -n "$child" ] && kill -0 "$child" 2>/dev/null && printf ', server %s' "$child"
    printf ')\n'
    return 0
  fi
  printf 'stopped\n'
  return 1
}

lan_ip() {
  if command -v termux-wifi-connectioninfo >/dev/null 2>&1; then
    termux-wifi-connectioninfo 2>/dev/null | sed -n 's/.*"ip".*"\([0-9.]\+\)".*/\1/p' | head -1
  elif command -v ifconfig >/dev/null 2>&1; then
    ifconfig 2>/dev/null | awk '/inet /{print $2}' | grep -v '127\.0\.0\.1' | head -1 | sed 's/addr://'
  elif command -v ip >/dev/null 2>&1; then
    ip -4 addr show 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1 | grep -v '127\.0\.0\.1' | head -1
  fi
}

# A phone changes address — a new network, a new lease, a reboot — and a
# certificate that does not carry today's address is what turns the padlock
# back into "Not secure".  Re-sign the leaf for the address this phone holds
# right now, under the same authority, before the host starts.  Nothing leaves
# the phone: same CA, same key file, a fresh leaf.
refresh_tls() {
  [ "${AE_TLS:-1}" = "1" ] || return 0
  command -v openssl >/dev/null 2>&1 || return 0
  local dir="${AE_TLS_DIR:-$AE_HOME/tls}"
  local cert="$dir/server.crt" key="$dir/server.key" ca="$dir/ca.crt"
  # Custom certificate locations are caller-managed; do not replace them with
  # a generated leaf when the boot hook refreshes the current LAN address.
  if [ -n "${AE_TLS_CERT:-}" ] || [ -n "${AE_TLS_KEY:-}" ]; then
    [ "${AE_TLS_CERT:-}" = "$cert" ] && [ "${AE_TLS_KEY:-}" = "$key" ] || return 0
  fi
  [ -f "$key" ] || return 0
  local ip; ip="$(lan_ip)"
  [ -n "$ip" ] || return 0
  if [ -f "$cert" ] \
     && openssl x509 -in "$cert" -noout -text 2>/dev/null | grep -q "IP Address:$ip" \
     && [ -n "$(openssl x509 -in "$cert" -noout -checkend 604800 2>/dev/null || true)" ]; then
    return 0
  fi
  local cnf="$dir/openssl.cnf"
  mkdir -p "$dir"
  cat > "$cnf" <<TLS
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req
[dn]
CN = AE Secure
O = AE Secure
[v3_req]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt
[alt]
DNS.1 = localhost
DNS.2 = ae-secure.local
IP.1 = 127.0.0.1
IP.2 = $ip
TLS
  if [ -f "$ca" ] && [ -f "$dir/ca.key" ]; then
    openssl req -nodes -newkey rsa:2048 -keyout "$key" -out "$dir/server.csr" -config "$cnf" >/dev/null 2>&1 \
      && openssl x509 -req -in "$dir/server.csr" -CA "$ca" -CAkey "$dir/ca.key" -CAcreateserial \
           -days 825 -sha256 -extfile "$cnf" -extensions v3_req -out "$cert" >/dev/null 2>&1
    rm -f "$dir/server.csr"
  fi
  if [ ! -f "$cert" ] || ! openssl x509 -in "$cert" -noout >/dev/null 2>&1; then
    openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
      -keyout "$key" -out "$cert" -config "$cnf" >/dev/null 2>&1 || return 0
  fi
  chmod 600 "$key" 2>/dev/null || true
  printf 'certificate renewed for %s\n' "$ip"
}

case "${1:-status}" in
  start)
    if status_line >/dev/null; then echo "already running"; exit 0; fi
    refresh_tls
    mkdir -p "$AE_HOME/logs" "$AE_HOME/run"
    if [ -f "$AE_LOG" ] && [ "$(wc -c < "$AE_LOG" 2>/dev/null || echo 0)" -gt 2000000 ]; then mv -f "$AE_LOG" "$AE_LOG.1"; fi
    nohup "$AE_BIN_DIR/watchdog" >/dev/null 2>&1 &
    sleep 2
    echo "started"
    "$0" url
    ;;
  stop)
    if pid="$(cat "$AE_HOME/run/supervisor.pid" 2>/dev/null)" && [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null
      sleep 2
      kill -KILL "$pid" 2>/dev/null
      child="$(cat "$AE_HOME/run/server.pid" 2>/dev/null)"
      [ -n "$child" ] && kill -KILL "$child" 2>/dev/null
      rm -f "$AE_HOME/run/supervisor.pid" "$AE_HOME/run/server.pid"
      echo "stopped"
    else
      echo "not running"
    fi
    ;;
  restart) "$0" stop >/dev/null; sleep 1; "$0" start ;;
  guard)
    # Called by the boot hook and by the periodic Android job. Starting an
    # already-running service is a no-op, so this is safe to call often.  The
    # certificate is refreshed here too: this is what runs after a reboot,
    # which is exactly when the phone may have a different address.
    if status_line >/dev/null; then refresh_tls >/dev/null 2>&1; exit 0; fi
    "$0" start >/dev/null 2>&1
    ;;
  status)  status_line ;;
  logs)    tail -n "${2:-40}" "$AE_LOG" 2>/dev/null || echo "no log yet" ;;
  follow)  tail -f "$AE_LOG" ;;
  url)
    ip="$(lan_ip)"; [ -n "$ip" ] || ip="your-phone-ip"
    scheme="http"
    [ "${AE_TLS:-1}" = "1" ] && [ -n "${AE_TLS_CERT:-}" ] && [ -f "$AE_TLS_CERT" ] \
      && [ -n "${AE_TLS_KEY:-}" ] && [ -f "$AE_TLS_KEY" ] && scheme="https"
    echo "on this phone : $scheme://127.0.0.1:${AE_PORT:-3000}"
    echo "on your network: $scheme://$ip:${AE_PORT:-3000}"
    if [ "$scheme" = "https" ]; then
      if [ -n "${AE_TLS_CA:-}" ] && [ -f "$AE_TLS_CA" ]; then
        echo "install $scheme://$ip:${AE_PORT:-3000}/ca.crt once per device, then the"
        echo "warning disappears ('ae-secure trust' walks through it)"
      else
        echo "accept the self-signed certificate once, then crypto works"
      fi
    else
      echo "warning: plain http — phones cannot create accounts or decrypt here"
    fi
    if command -v qrencode >/dev/null 2>&1; then
      qrencode -t ANSIUTF8 "$scheme://$ip:${AE_PORT:-3000}" 2>/dev/null || true
    fi
    ;;
  update)
    "$0" stop >/dev/null
    if [ -d "$AE_DIR/.git" ]; then
      git -C "$AE_DIR" fetch --depth 1 origin "$AE_BRANCH" && git -C "$AE_DIR" reset --hard FETCH_HEAD && \
        echo "updated to $(git -C "$AE_DIR" log --oneline -1)"
    else
      echo "this install was extracted from an archive — re-run the installer to update"
    fi
    "$0" start
    ;;
  backup)
    stamp="$(date '+%Y%m%d-%H%M%S')"
    out="${2:-$HOME/ae-secure-backup-$stamp.tar.gz}"
    tar -czf "$out" -C "$(dirname "$AE_DATA")" "$(basename "$AE_DATA")" && echo "backup written: $out"
    ;;
  restore)
    [ -n "${2:-}" ] || { echo "usage: ae-secure restore <backup.tar.gz>"; exit 1; }
    "$0" stop >/dev/null
    rm -rf "$AE_DATA"
    tar -xzf "$2" -C "$(dirname "$AE_DATA")" && echo "restored from $2"
    "$0" start
    ;;
  autostart)
    profile="$HOME/.bashrc"
    case "${2:-on}" in
      on)
        touch "$profile"
        strip_autostart_block "$profile"
        printf '\n# >>> ae-secure autostart >>>\n[ -x "%s" ] && "%s" guard >/dev/null 2>&1\n# <<< ae-secure autostart <<<\n' "$AE_BIN_DIR/ae-secure" "$AE_BIN_DIR/ae-secure" >> "$profile"
        echo "shell autostart enabled in $profile"
        ;;
      off)
        strip_autostart_block "$profile"
        echo "shell autostart disabled"
        ;;
      *) echo "usage: ae-secure autostart on|off"; exit 1 ;;
    esac
    ;;
  trust)
    # Prints what to install and hands the certificate file to Android, which
    # opens the "install a certificate" flow for it.
    dir="${AE_TLS_DIR:-$AE_HOME/tls}"
    cert="$dir/ca.crt"
    ip="${AE_HOST_IP:-}"
    [ -n "$ip" ] || ip="$(ip -4 addr show 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1 | grep -v '^127\.' | head -1)"
    if [ ! -f "$cert" ]; then
      echo "no local authority on this install — the server is using a plain"
      echo "self-signed certificate, so every device has to accept the warning once."
      echo "re-run the installer (bash $0 install) to create one."
      exit 1
    fi
    echo "certificate : $cert"
    echo "fingerprint : $(openssl x509 -in "$cert" -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*=//')"
    echo
    echo "1. on this phone, open:  https://127.0.0.1:${AE_PORT:-3000}/trust"
    [ -n "$ip" ] && echo "   on any other device:  https://$ip:${AE_PORT:-3000}/trust"
    echo "2. download ae-secure-ca.crt and install it as a CA certificate"
    echo "   Android: Settings -> Security & privacy -> More security settings ->"
    echo "            Encryption & credentials -> Install a certificate -> CA certificate"
    echo "3. close and reopen the browser tab: the padlock replaces the warning"
    if command -v termux-open >/dev/null 2>&1; then
      echo
      echo "opening the certificate file now so Android can install it…"
      termux-open --content-type application/x-x509-ca-cert "$cert" >/dev/null 2>&1 || true
    fi
    ;;
  doctor)
    echo "node      : $(node -v 2>/dev/null || echo 'missing')"
    echo "code      : $AE_DIR $([ -f "$AE_DIR/server/index.js" ] && echo ok || echo MISSING)"
    echo "data      : $AE_DATA $([ -d "$AE_DATA" ] && echo ok || echo missing)"
    echo "config    : $AE_CONF"
    echo "port      : ${AE_PORT:-3000}"
    scheme="http"
    [ "${AE_TLS:-1}" = "1" ] && [ -f "${AE_TLS_DIR:-$AE_HOME/tls}/server.crt" ] && scheme="https"
    echo "transport : $scheme (WebCrypto needs https or localhost)"
    health="$(curl -fsSk --max-time 4 "$scheme://127.0.0.1:${AE_PORT:-3000}/api/health" 2>/dev/null || true)"
    build_id="$(printf '%s' "$health" | sed -n 's/.*"build":{"id":"\([^"]*\)".*/\1/p')"
    build_at="$(printf '%s' "$health" | sed -n 's/.*"at":"\([^"]*\)".*/\1/p')"
    echo "build     : ${build_id:-unknown}${build_at:+ ($build_at)}"
    echo "            Settings -> About on the site shows the same identifier"
    echo "cert      : ${AE_TLS_DIR:-$AE_HOME/tls}/server.crt $([ -f "${AE_TLS_DIR:-$AE_HOME/tls}/server.crt" ] && echo present || echo missing)"
    if [ -f "${AE_TLS_DIR:-$AE_HOME/tls}/server.crt" ]; then
      ip="$(lan_ip)"
      if [ -n "$ip" ] && openssl x509 -in "${AE_TLS_DIR:-$AE_HOME/tls}/server.crt" -noout -text 2>/dev/null | grep -q "IP Address:$ip"; then
        echo "address   : $ip — the certificate carries this phone's address"
      else
        echo "address   : this phone is ${ip:-not on a network} — the certificate does NOT carry it,"
        echo "            which is what puts 'Not secure' in the bar. 'ae-secure start' renews it."
      fi
    fi
    if [ -f "${AE_TLS_DIR:-$AE_HOME/tls}/ca.crt" ]; then
      echo "authority : ${AE_TLS_DIR:-$AE_HOME/tls}/ca.crt present — install it once per device"
      echo "            $(openssl x509 -in "${AE_TLS_DIR:-$AE_HOME/tls}/ca.crt" -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*=//' | cut -c1-32)…"
      echo "            'ae-secure trust' explains how"
    else
      echo "authority : none (self-signed leaf: every device must accept the warning)"
    fi
    echo "health    : ${health:-no answer}"
    ;;
  *) echo "usage: ae-secure {start|stop|restart|guard|status|logs|follow|url|update|backup|restore|autostart|trust|doctor}"; exit 1 ;;
esac
CLI
  # bake in this install's directory: `ae-secure status` must work in a fresh
  # shell, where nothing from the install is exported
  sed -i "s|@AE_HOME_DEFAULT@|$AE_HOME|" "$AE_BIN_DIR/ae-secure"
  grep -q '@AE_HOME_DEFAULT@' "$AE_BIN_DIR/ae-secure" && die "could not bake the install path into the command"
  chmod +x "$AE_BIN_DIR/ae-secure"

  # make it reachable from any Termux prompt
  # $PREFIX is Termux's usr directory; fall back to ~/bin elsewhere
  if [ -n "${PREFIX:-}" ] && [ -d "$PREFIX/bin" ] && [ -w "$PREFIX/bin" ]; then
    ln -sf "$AE_BIN_DIR/ae-secure" "$PREFIX/bin/ae-secure" 2>/dev/null || true
  else
    mkdir -p "$HOME/bin" 2>/dev/null || true
    ln -sf "$AE_BIN_DIR/ae-secure" "$HOME/bin/ae-secure" 2>/dev/null || true
  fi
}

# ------------------------------------------------------------ commands -------
cmd_install() {
  step "AE Secure on Termux"
  ensure_packages
  check_node
  fetch_source
  install_tls
  write_config
  install_watchdog
  install_command
  if [ "${AE_NO_BOOT:-0}" = "1" ]; then
    note "boot hook skipped (AE_NO_BOOT=1)"
  else
    install_boot_hook
  fi
  install_guard_job
  rotate_logs
  step "Starting"
  # A plain install over a running server replaced the code on disk, so make it
  # reload: "start" alone would see a healthy process and leave the old files in
  # memory.
  if "$AE_BIN_DIR/ae-secure" status >/dev/null 2>&1; then
    "$AE_BIN_DIR/ae-secure" restart >/dev/null 2>&1 || true
  else
    "$AE_BIN_DIR/ae-secure" start
  fi
  sleep 3
  step "Result"
  "$AE_BIN_DIR/ae-secure" status
  local scheme; scheme="$( [ "$AE_TLS" = "1" ] && [ -n "${AE_TLS_CERT:-}" ] && printf https || printf http )"
  local answer; answer="$(curl -fsSk --max-time 4 "$scheme://127.0.0.1:$AE_PORT$AE_HEALTH_PATH" 2>/dev/null || true)"
  [ -n "$answer" ] && say "health: $answer" || say "health: no answer yet — check: ae-secure logs"
  notify_status "Running on port $AE_PORT"
  say ""
  say "Manage it with:  ae-secure {status|logs|update|backup|stop|start}"
  note "Keep the phone plugged in and disable battery optimisation for Termux so Android does not freeze it."
}

cmd_cli() { load_config; [ -x "$AE_BIN_DIR/ae-secure" ] || die "not installed — run: bash $0 install"; "$AE_BIN_DIR/ae-secure" "$@"; }

case "$COMMAND" in
  install)  cmd_install ;;
  update)   load_config; cmd_cli update ;;
  start)    load_config; cmd_cli start ;;
  stop)     load_config; cmd_cli stop ;;
  restart)  load_config; cmd_cli restart ;;
  status)   load_config; cmd_cli status ;;
  logs)     load_config; cmd_cli logs "${2:-40}" ;;
  follow)   load_config; cmd_cli follow ;;
  url)      load_config; cmd_cli url ;;
  backup)   load_config; cmd_cli backup "${2:-}" ;;
  restore)  load_config; cmd_cli restore "${2:-}" ;;
  trust)    load_config; cmd_cli trust ;;
  doctor)   load_config; cmd_cli doctor ;;
  *) die "unknown command: $COMMAND" ;;
esac
