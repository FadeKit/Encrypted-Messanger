#!/usr/bin/env bash
# =============================================================================
#  AE Secure — stop the host running on this phone and patch it in place
# -----------------------------------------------------------------------------
#  Paste this into Termux. It does not need git, a token, or any argument:
#
#      curl -fsSL https://codeload.github.com/FadeKit/Encrypted-Messanger/tar.gz/refs/heads/arena/442b6c1e-encrypted-messanger \
#        | tar -xz -C "$TMPDIR" && bash "$TMPDIR"/Encrypted-Messanger-*/scripts/termux-patch.sh
#
#  What it does, in order:
#    1. finds the installation already on this phone (~/.ae-secure/config.env,
#       or a running supervisor, or the default paths)
#    2. stops the service — supervisor first, then the server process
#    3. downloads the current source and replaces the code, keeping the
#       encrypted data directory exactly where it is
#    4. generates a TLS certificate for this phone's address (WebCrypto needs
#       a secure context), re-applies the boot hooks and starts it again
#    5. prints the https address to open
#
#  It is safe to run repeatedly. Your accounts, messages and files are never
#  touched: only the application directory is replaced.
#
#  Options:
#      AE_BRANCH=<branch>       source branch            (default: app branch)
#      AE_PORT=<port>           listening port           (default: keeps the current one)
#      AE_DATA=<dir>            data directory           (default: keeps the current one)
#      AE_DISCORD_URL=<url>     developer link on the sign-in screen
#      AE_TLS=0                 serve plain http instead of https
#      AE_SOURCE_FILE=<path>    patch from a local .tar.gz/.zip
#      AE_SOURCE_DIR=<dir>      patch from a local checkout
#      AE_REBOOT=1              also restart the phone at the end, for a truly
#                               clean slate (uses termux-reboot if it is
#                               installed, otherwise svc power reboot, otherwise
#                               it says what to install)
# =============================================================================

set -uo pipefail

AE_OWNER="${AE_OWNER:-FadeKit}"
AE_REPO="${AE_REPO:-Encrypted-Messanger}"
AE_BRANCH="${AE_BRANCH:-arena/442b6c1e-encrypted-messanger}"
AE_REBOOT="${AE_REBOOT:-0}"

if [ -t 1 ]; then C_DIM=$'\033[2m'; C_OFF=$'\033[0m'; else C_DIM=''; C_OFF=''; fi
say()  { printf '%s\n' "$*"; }
note() { printf '%s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }
step() { printf '\n== %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# Starts whatever install lives in $AE_HOME (used when a patch fails, so the
# phone is never left without a running host).
restart_existing() {
  if [ ! -x "$AE_HOME/bin/ae-secure" ]; then
    say "no service command in $AE_HOME — start it by hand once you are ready"
    return 0
  fi
  if AE_HOME="$AE_HOME" "$AE_HOME/bin/ae-secure" start >/dev/null 2>&1; then
    say "it is running again"
  else
    say "could not restart it — run: ae-secure start"
  fi
  return 0
}

if [ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux/files/usr ]; then
  ON_TERMUX=1
else
  ON_TERMUX=0
fi

# ------------------------------------------------------- find the install ----
step "Looking for the installation already on this phone"
DEFAULT_HOME="$HOME/.ae-secure"
DEFAULT_DIR="$HOME/ae-secure"
DEFAULT_DATA="$HOME/ae-secure-data"

FOUND_HOME=""
FOUND_DIR=""
FOUND_DATA=""
FOUND_PORT=""

# Adopt the settings of an installation home ($1).  Reads its config.env, which
# is what the installer and the ae-secure command use.
adopt_home() {
  [ -f "$1/config.env" ] || return 1
  # shellcheck disable=SC1090
  . "$1/config.env"
  FOUND_HOME="$1"
  FOUND_DIR="${AE_DIR:-$DEFAULT_DIR}"
  FOUND_DATA="${AE_DATA:-$DEFAULT_DATA}"
  FOUND_PORT="${AE_PORT:-3000}"
  return 0
}

# The supervisor processes running right now, by pid.
live_supervisors() {
  pgrep -f 'bin/watchdog' 2>/dev/null || true
}

# 1. the configuration written by a previous install
for conf in "$HOME/.ae-secure/config.env" "$DEFAULT_HOME/config.env"; do
  if adopt_home "$(dirname "$conf")"; then
    say "found the install on this phone: $FOUND_DIR"
    break
  fi
done

# 2. a host running right now, even without a config file.  The installer starts
#    it as "./bin/watchdog" from the install home, so a relative path has to be
#    resolved against that process's own working directory.
if [ -z "$FOUND_HOME" ]; then
  for RUNNING in $(live_supervisors); do
    LIVE_PATH="$(tr '\0' '\n' < "/proc/$RUNNING/cmdline" 2>/dev/null | grep -E '(^|/)bin/watchdog$' | tail -1 || true)"
    [ -n "$LIVE_PATH" ] || continue
    case "$LIVE_PATH" in
      /*) LIVE_SCRIPT="$LIVE_PATH" ;;
      *)  LIVE_CWD="$(readlink "/proc/$RUNNING/cwd" 2>/dev/null || true)"
          [ -n "$LIVE_CWD" ] || continue
          LIVE_SCRIPT="$LIVE_CWD/${LIVE_PATH#./}" ;;
    esac
    CAND_HOME="$(dirname "$(dirname "$LIVE_SCRIPT")")"
    if adopt_home "$CAND_HOME"; then
      say "found a host running from $FOUND_DIR"
      break
    fi
  done
fi

# 3. the supervisor pid file of a running host, wherever the home lives
if [ -z "$FOUND_HOME" ]; then
  for RUNNING in $(live_supervisors); do
    for pidfile in "$HOME"/*/run/supervisor.pid; do
      [ -f "$pidfile" ] || continue
      [ "$(cat "$pidfile" 2>/dev/null)" = "$RUNNING" ] || continue
      CAND_HOME="$(dirname "$(dirname "$pidfile")")"
      if adopt_home "$CAND_HOME"; then
        say "found a host running from $FOUND_DIR"
        break 2
      fi
    done
  done
fi

# 4. the default layout, or a fresh install
if [ -z "$FOUND_HOME" ] && [ -z "$FOUND_DIR" ]; then
  if [ "${AE_HOME:-}" = "" ] && [ "${AE_DIR:-}" = "" ]; then
    say "no previous install found — this will be a fresh one"
    say "set AE_HOME=/path/to/runtime if yours lives somewhere unusual"
  fi
fi
if [ -z "$FOUND_DIR" ] && [ -f "$DEFAULT_DIR/server/index.js" ]; then
  FOUND_DIR="$DEFAULT_DIR"
  say "found a checkout at $DEFAULT_DIR"
fi

AE_HOME="${AE_HOME:-${FOUND_HOME:-$DEFAULT_HOME}}"
AE_DIR="${AE_DIR:-${FOUND_DIR:-$DEFAULT_DIR}}"
AE_DATA="${AE_DATA:-${FOUND_DATA:-$DEFAULT_DATA}}"
AE_PORT="${AE_PORT:-${FOUND_PORT:-3000}}"

note "runtime : $AE_HOME"
note "code    : $AE_DIR"
note "data    : $AE_DATA"
note "port    : $AE_PORT"

# ------------------------------------------------------------- stop it -------
step "Stopping the host"
STOPPED=0
if [ -x "$AE_HOME/bin/ae-secure" ]; then
  AE_HOME="$AE_HOME" AE_DIR="$AE_DIR" AE_DATA="$AE_DATA" AE_PORT="$AE_PORT" \
    "$AE_HOME/bin/ae-secure" stop >/dev/null 2>&1 && STOPPED=1
fi
if [ "$STOPPED" = "0" ]; then
  # no service command: take the processes down directly, never by name pattern
  for pidfile in "$AE_HOME/run/supervisor.pid" "$AE_HOME/run/server.pid"; do
    if [ -f "$pidfile" ]; then
      pid="$(cat "$pidfile" 2>/dev/null)"
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill -TERM "$pid" 2>/dev/null
        sleep 1
        kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null
        say "stopped pid $pid from $(basename "$pidfile")"
      fi
      rm -f "$pidfile"
    fi
  done
fi
for pidfile in "$AE_HOME/run/supervisor.pid" "$AE_HOME/run/server.pid"; do rm -f "$pidfile"; done
sleep 1
# anything still wearing this install's paths
for pid in $(pgrep -f "$AE_HOME/bin/watchdog" 2>/dev/null || true); do kill -KILL "$pid" 2>/dev/null; done
say "host stopped"

# A second copy of AE Secure on the same port is the usual reason a patch
# "works" but keeps serving the old build, so say it plainly.
if have node; then
  if node -e '
      const net = require("net");
      const socket = net.connect({ host: "127.0.0.1", port: Number(process.argv[1]) });
      socket.on("connect", () => { socket.destroy(); process.exit(0); });
      socket.on("error", () => process.exit(1));
      setTimeout(() => { socket.destroy(); process.exit(1); }, 1500);
    ' "$AE_PORT"; then
    say ""
    say "warning: something is still listening on port $AE_PORT."
    say "         Another copy may hold this port. Stop it and run this script again:"
    say "           ae-secure stop;  pkill -f 'server/index.js'"
    say ""
  fi
fi

# ------------------------------------------------------------- source --------
step "Fetching the current source"
if [ -n "${AE_SOURCE_FILE:-}" ] || [ -n "${AE_SOURCE_DIR:-}" ]; then
  say "patching from a local source"
  SOURCE_MODE="local"
else
  SOURCE_MODE="remote"
fi

# ------------------------------------------------------------- install -------
step "Patching"
INSTALLER=""
if [ "$SOURCE_MODE" = "local" ]; then
  if [ -n "${AE_SOURCE_DIR:-}" ] && [ -f "${AE_SOURCE_DIR}/scripts/termux-install.sh" ]; then
    INSTALLER="$AE_SOURCE_DIR/scripts/termux-install.sh"
  elif [ -n "${AE_SOURCE_FILE:-}" ]; then
    TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ae-patch.XXXXXX")"
    case "$AE_SOURCE_FILE" in
      *.zip) have unzip || die "unzip is required (pkg install unzip)"; unzip -q "$AE_SOURCE_FILE" -d "$TMP_ROOT" ;;
      *) tar -xzf "$AE_SOURCE_FILE" -C "$TMP_ROOT" ;;
    esac
    INSTALLER="$(find "$TMP_ROOT" -maxdepth 3 -name termux-install.sh -path '*/scripts/*' | head -1)"
    [ -n "$INSTALLER" ] || die "no scripts/termux-install.sh inside $AE_SOURCE_FILE"
  fi
else
  ARCHIVE="https://codeload.github.com/$AE_OWNER/$AE_REPO/tar.gz/refs/heads/$AE_BRANCH"
  TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ae-patch.XXXXXX")"
  have curl || { on_termux && pkg install -y curl; }
  have curl || die "curl is required"
  say "downloading $AE_BRANCH"
  curl -fsSL "$ARCHIVE" -o "$TMP_ROOT/ae-secure.tar.gz" || { rm -rf "$TMP_ROOT"; die "download failed — check the branch and the connection"; }
  tar -xzf "$TMP_ROOT/ae-secure.tar.gz" -C "$TMP_ROOT" || { rm -rf "$TMP_ROOT"; die "the archive did not extract"; }
  INSTALLER="$(find "$TMP_ROOT" -maxdepth 3 -name termux-install.sh -path '*/scripts/*' | head -1)"
  [ -n "$INSTALLER" ] || { rm -rf "$TMP_ROOT"; die "the archive has no scripts/termux-install.sh"; }
fi

[ -f "$INSTALLER" ] || die "no installer found to run"

# Keep every setting this phone already had, replace only the code.
say "installing over $AE_DIR (data stays in $AE_DATA)"
# Feed the installer the source this run already has: the archive just
# downloaded, or the local copy the caller pointed at.  Never make the phone
# fetch the same bytes twice, and never quietly install something else than the
# caller asked for.
PATCH_SOURCE_FILE=""
PATCH_SOURCE_DIR=""
if [ "$SOURCE_MODE" = "local" ]; then
  [ -n "${AE_SOURCE_DIR:-}" ] && PATCH_SOURCE_DIR="$AE_SOURCE_DIR"
  [ -n "${AE_SOURCE_FILE:-}" ] && PATCH_SOURCE_FILE="$AE_SOURCE_FILE"
elif [ -f "${TMP_ROOT:-}/ae-secure.tar.gz" ]; then
  PATCH_SOURCE_FILE="$TMP_ROOT/ae-secure.tar.gz"
fi
AE_DIR="$AE_DIR" AE_DATA="$AE_DATA" AE_HOME="$AE_HOME" AE_PORT="$AE_PORT" \
  AE_SOURCE_FILE="$PATCH_SOURCE_FILE" AE_SOURCE_DIR="$PATCH_SOURCE_DIR" \
  bash "$INSTALLER" install
RESULT=$?

[ -n "${TMP_ROOT:-}" ] && rm -rf "$TMP_ROOT"

if [ "$RESULT" -ne 0 ]; then
  # The host was stopped to free the port, so never walk away leaving the phone
  # offline: put the version it already had back up, then explain.
  say ""
  say "the patch did not finish — starting the version that is already here"
  restart_existing
  die "the patch did not finish — see the output above, then: ae-secure logs"
fi

# ---------------------------------------------------------------- result -----
step "Patched"
CLI="$AE_HOME/bin/ae-secure"
if [ -x "$CLI" ]; then
  AE_HOME="$AE_HOME" "$CLI" status || true
  AE_HOME="$AE_HOME" "$CLI" url || true
else
  note "the service command was not found in $AE_HOME"
fi

say ""
say "Open the https address above — accept the certificate once, then"
say "account creation, sign-in and encryption all work."
say ""
note "Details: ae-secure doctor   ·   logs: ae-secure logs   ·   backup: ae-secure backup"
say ""

# ------------------------------------------------------------------ reboot ---
# Optional: an operator who wants the phone itself to come up clean can ask for
# a reboot here. The boot hook the installer wrote starts the server again.
if [ "$AE_REBOOT" = "1" ]; then
  step "Restarting the phone"
  say "the host starts again by itself on boot (Termux:Boot keeps that hook)"
  if have termux-reboot; then
    note "termux-reboot"
    termux-reboot
  elif [ "$ON_TERMUX" = "1" ] && have svc; then
    note "svc power reboot"
    svc power reboot || die "the system refused the reboot — run 'reboot' yourself"
  elif [ "$ON_TERMUX" = "1" ]; then
    say "no reboot helper found. Install Termux:API (pkg install termux-api), or"
    say "run this instead:  svc power reboot"
  else
    say "not on Termux, so the phone was left alone (AE_REBOOT was set)"
  fi
else
  note "Reboot the phone too? Run this again with AE_REBOOT=1, or: svc power reboot"
fi
say ""
