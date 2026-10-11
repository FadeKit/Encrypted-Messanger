#!/usr/bin/env bash
# =============================================================================
#  AE Secure — Termux installer and supervisor
# -----------------------------------------------------------------------------
#  Installs AE Secure from GitHub onto a phone running Termux, starts it, keeps
#  it running when it crashes or the phone reboots, and gives you an `ae-secure`
#  command to manage it.
#
#  Quick start (inside Termux):
#
#      pkg install -y git
#      git clone https://github.com/FadeKit/Encrypted-Messanger.git ~/ae-secure-src
#      bash ~/ae-secure-src/scripts/termux-install.sh
#
#  Private repository? Give the installer a token, or run `gh auth login`:
#
#      GITHUB_TOKEN=ghp_xxx bash scripts/termux-install.sh
#
#  Everything can be overridden with environment variables:
#
#      AE_OWNER  AE_REPO  AE_BRANCH  AE_DIR  AE_DATA  AE_PORT  AE_HOST
#      AE_GIT_URL (another remote)  AE_SOURCE_FILE (a local .tar.gz or .zip)
#
#  Commands: install (default) | update | start | stop | restart | status |
#            logs | url | backup | restore <file> | uninstall | doctor
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
AE_HEALTH_PATH="/api/health"
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
  [ -e "$AE_DIR" ] && [ ! -d "$AE_DIR/.git" ] && die "$AE_DIR exists and is not a git checkout — move it aside or set AE_DIR"
  say "cloning into $AE_DIR"
  git clone --depth 1 --branch "$AE_BRANCH" "$url" "$AE_DIR" >/dev/null 2>&1 || \
    git clone --depth 1 "$url" "$AE_DIR" >/dev/null 2>&1 || return 1
  git -C "$AE_DIR" checkout "$AE_BRANCH" >/dev/null 2>&1 || true
  return 0
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
  if [ -n "$inner" ]; then
    rm -rf "$AE_DIR"; mkdir -p "$(dirname "$AE_DIR")"; mv "$(dirname "$inner")" "$AE_DIR"
  else
    rm -rf "$AE_DIR"; mkdir -p "$AE_DIR"; cp -R "$tmp"/. "$AE_DIR"/
  fi
  rm -rf "$tmp"
  return 0
}

fetch_source() {
  step "Source"
  if [ -n "${AE_SOURCE_FILE:-}" ]; then
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

health_check() {
  local url="http://127.0.0.1:$AE_PORT$AE_HEALTH_PATH"
  if have curl; then
    curl -fsS --max-time "$AE_HEALTH_TIMEOUT" "$url" >/dev/null 2>&1 && return 0 || return 1
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
    curl -fsS --max-time "\$AE_HEALTH_TIMEOUT" "http://127.0.0.1:\$AE_PORT\$AE_HEALTH_PATH" >/dev/null 2>&1
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
  AE_DATA_DIR="\$AE_DATA" PORT="\$AE_PORT" HOST="\$AE_HOST" node server/index.js >> "\$AE_LOG" 2>&1 &
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
"$AE_BIN_DIR/ae-secure" start >/dev/null 2>&1
BOOT
  chmod +x "$boot_file"
  say "boot hook: $boot_file"
  note "Termux:Boot app (F-Droid) must be installed and opened once, or the boot hook will not run" 

  # Fallback: start it when a Termux session opens, for phones without Termux:Boot.
  local profile="$HOME/.bashrc"
  touch "$profile"
  if ! grep -q "ae-secure autostart" "$profile" 2>/dev/null; then
    cat >> "$profile" <<PROFILE

# >>> ae-secure autostart >>>
if [ -x "$AE_BIN_DIR/ae-secure" ] && [ -z "\${AE_SECURE_NOSTART:-}" ]; then
  "$AE_BIN_DIR/ae-secure" start >/dev/null 2>&1
fi
# <<< ae-secure autostart <<<
PROFILE
    say "session hook: $profile"
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

case "${1:-status}" in
  start)
    if status_line >/dev/null; then echo "already running"; exit 0; fi
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
  status)  status_line ;;
  logs)    tail -n "${2:-40}" "$AE_LOG" 2>/dev/null || echo "no log yet" ;;
  follow)  tail -f "$AE_LOG" ;;
  url)
    ip="$(lan_ip)"; [ -n "$ip" ] || ip="your-phone-ip"
    echo "on this phone : http://127.0.0.1:${AE_PORT:-3000}"
    echo "on your network: http://$ip:${AE_PORT:-3000}"
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
  doctor)
    echo "node      : $(node -v 2>/dev/null || echo 'missing')"
    echo "code      : $AE_DIR $([ -f "$AE_DIR/server/index.js" ] && echo ok || echo MISSING)"
    echo "data      : $AE_DATA $([ -d "$AE_DATA" ] && echo ok || echo missing)"
    echo "config    : $AE_CONF"
    echo "port      : ${AE_PORT:-3000}"
    echo "health    : $(curl -fsS --max-time 4 "http://127.0.0.1:${AE_PORT:-3000}/api/health" 2>/dev/null || echo 'no answer')"
    ;;
  *) echo "usage: ae-secure {start|stop|restart|status|logs|follow|url|update|backup|restore|doctor}"; exit 1 ;;
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
  write_config
  install_watchdog
  install_command
  install_boot_hook
  rotate_logs
  step "Starting"
  "$AE_BIN_DIR/ae-secure" start
  sleep 3
  step "Result"
  "$AE_BIN_DIR/ae-secure" status
  local answer; answer="$(curl -fsS --max-time 4 "http://127.0.0.1:$AE_PORT$AE_HEALTH_PATH" 2>/dev/null || true)"
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
  doctor)   load_config; cmd_cli doctor ;;
  *) die "unknown command: $COMMAND" ;;
esac
