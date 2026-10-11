#!/usr/bin/env bash
# =============================================================================
#  AE Secure — stop the host running on this phone and patch it in place
# -----------------------------------------------------------------------------
#  Paste this block into Termux. It does not need git, a token, or arguments:
#
#      set -o pipefail
#      PATCH_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ae-patch-source.XXXXXX")" &&
#        curl -fsSL https://codeload.github.com/FadeKit/Encrypted-Messanger/tar.gz/refs/heads/arena/442b6c1e-encrypted-messanger \
#          | tar -xz -C "$PATCH_DIR" &&
#        bash "$PATCH_DIR"/Encrypted-Messanger-*/scripts/termux-patch.sh
#
#  What it does, in order:
#    1. finds this phone's install and saves its existing settings
#    2. downloads and validates the new source before stopping anything
#    3. backs up the old code/runtime settings (not account data), then stops
#       only the matching AE Secure processes — never a broad pkill
#    4. replaces the code, reapplies boot hooks, starts the service and checks
#       health; a failed install restores the previous code/runtime settings
#    5. prints the correct http/https address to open
#    6. restarts the phone by default so its boot hook is tested (AE_REBOOT=0 skips it;
#       press any key during the ten-second countdown to skip it once)
#
#  It is safe to run repeatedly. AE_DATA and its encrypted accounts, messages,
#  and files are never read, copied, or removed: only the application directory
#  is replaced. Keep AE_HOME and AE_TLS_DIR outside AE_DIR as well.
#
#  The bootstrap above is fetched only once: this script reuses the extracted
#  checkout it came with instead of downloading the same archive again.
#
#  Options:
#      AE_BRANCH=<branch>       source branch            (default: app branch)
#      AE_PORT=<port>           listening port           (default: keeps the current one)
#      AE_DATA=<dir>            data directory           (default: keeps the current one)
#      AE_DISCORD_URL=<url>     developer link on the sign-in screen
#      AE_TLS=0                 serve plain http instead of https
#      AE_SOURCE_FILE=<path>    patch from a local .tar.gz/.zip
#      AE_SOURCE_DIR=<dir>      patch from a local checkout
#      AE_REBOOT=0              do not restart the phone when the patch is done
#                               (default: restart, using termux-reboot, else
#                               svc power reboot, else su -c reboot, else it
#                               prints the command to run by hand)
# =============================================================================

set -uo pipefail

# Remember explicit command-line environment overrides before config.env is
# sourced. The saved install settings are defaults; a supplied AE_PORT, AE_TLS,
# AE_DATA, etc. must still win when the install configuration is read.
INPUT_AE_OWNER_SET="${AE_OWNER+x}"; INPUT_AE_OWNER="${AE_OWNER-}"
INPUT_AE_REPO_SET="${AE_REPO+x}"; INPUT_AE_REPO="${AE_REPO-}"
INPUT_AE_BRANCH_SET="${AE_BRANCH+x}"; INPUT_AE_BRANCH="${AE_BRANCH-}"
INPUT_AE_HOME_SET="${AE_HOME+x}"; INPUT_AE_HOME="${AE_HOME-}"
INPUT_AE_DIR_SET="${AE_DIR+x}"; INPUT_AE_DIR="${AE_DIR-}"
INPUT_AE_DATA_SET="${AE_DATA+x}"; INPUT_AE_DATA="${AE_DATA-}"
INPUT_AE_PORT_SET="${AE_PORT+x}"; INPUT_AE_PORT="${AE_PORT-}"
INPUT_AE_HOST_SET="${AE_HOST+x}"; INPUT_AE_HOST="${AE_HOST-}"
INPUT_AE_HTTP_PORT_SET="${AE_HTTP_PORT+x}"; INPUT_AE_HTTP_PORT="${AE_HTTP_PORT-}"
INPUT_AE_TLS_SET="${AE_TLS+x}"; INPUT_AE_TLS="${AE_TLS-}"
INPUT_AE_TLS_DIR_SET="${AE_TLS_DIR+x}"; INPUT_AE_TLS_DIR="${AE_TLS_DIR-}"
INPUT_AE_TLS_CERT_SET="${AE_TLS_CERT+x}"; INPUT_AE_TLS_CERT="${AE_TLS_CERT-}"
INPUT_AE_TLS_KEY_SET="${AE_TLS_KEY+x}"; INPUT_AE_TLS_KEY="${AE_TLS_KEY-}"
INPUT_AE_TLS_CA_SET="${AE_TLS_CA+x}"; INPUT_AE_TLS_CA="${AE_TLS_CA-}"
INPUT_AE_DISCORD_URL_SET="${AE_DISCORD_URL+x}"; INPUT_AE_DISCORD_URL="${AE_DISCORD_URL-}"
INPUT_AE_GIT_URL_SET="${AE_GIT_URL+x}"; INPUT_AE_GIT_URL="${AE_GIT_URL-}"
INPUT_AE_HEALTH_PATH_SET="${AE_HEALTH_PATH+x}"; INPUT_AE_HEALTH_PATH="${AE_HEALTH_PATH-}"
INPUT_AE_HEALTH_TIMEOUT_SET="${AE_HEALTH_TIMEOUT+x}"; INPUT_AE_HEALTH_TIMEOUT="${AE_HEALTH_TIMEOUT-}"
INPUT_AE_HEALTH_FAILS_SET="${AE_HEALTH_FAILS+x}"; INPUT_AE_HEALTH_FAILS="${AE_HEALTH_FAILS-}"
INPUT_AE_BACKOFF_SET="${AE_BACKOFF+x}"; INPUT_AE_BACKOFF="${AE_BACKOFF-}"

AE_OWNER="${AE_OWNER:-FadeKit}"
AE_REPO="${AE_REPO:-Encrypted-Messanger}"
AE_BRANCH="${AE_BRANCH:-arena/442b6c1e-encrypted-messanger}"
AE_REBOOT="${AE_REBOOT:-1}"
TMP_ROOT=""
PATCH_BACKUP=""
RUNTIME_BACKUP=""
RUNTIME_SNAPSHOT_READY=0
HAD_OLD_CODE=0
PATCH_STOPPED=0
PATCH_SUCCESS=0
KEEP_TMP_ROOT=0
cleanup_temp_only() {
  [ -n "$TMP_ROOT" ] && [ -d "$TMP_ROOT" ] && rm -rf "$TMP_ROOT"
}
trap cleanup_temp_only EXIT

if [ -t 1 ]; then C_DIM=$'\033[2m'; C_OFF=$'\033[0m'; else C_DIM=''; C_OFF=''; fi
say()  { printf '%s\n' "$*"; }
note() { printf '%s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }
step() { printf '\n== %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
on_termux() { [ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux/files/usr ]; }
choose_input() {
  if [ "$1" = "x" ] && [ -n "$2" ]; then printf '%s' "$2"; else printf '%s' "$3"; fi
}
choose_exact_input() {
  if [ "$1" = "x" ]; then printf '%s' "$2"; else printf '%s' "$3"; fi
}

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

# 1. an explicitly named installation, then the default configuration written
#    by the installer.
if [ -n "$INPUT_AE_HOME" ] && adopt_home "$INPUT_AE_HOME"; then
  say "found the install on this phone: $FOUND_DIR"
fi
if [ -z "$FOUND_HOME" ] && [ -z "$INPUT_AE_HOME" ]; then
  for conf in "$HOME/.ae-secure/config.env" "$DEFAULT_HOME/config.env"; do
    if adopt_home "$(dirname "$conf")"; then
      say "found the install on this phone: $FOUND_DIR"
      break
    fi
  done
fi

# 2. a host running right now, even without a config file.  The installer starts
#    it as "./bin/watchdog" from the install home, so a relative path has to be
#    resolved against that process's own working directory.
if [ -z "$FOUND_HOME" ] && [ -z "$INPUT_AE_HOME" ]; then
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
if [ -z "$FOUND_HOME" ] && [ -z "$INPUT_AE_HOME" ]; then
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
if [ -z "$FOUND_DIR" ] && [ -f "$DEFAULT_DIR/server/index.js" ] && [ -z "$INPUT_AE_HOME" ]; then
  FOUND_DIR="$DEFAULT_DIR"
  say "found a checkout at $DEFAULT_DIR"
fi
if [ -n "$INPUT_AE_HOME" ] && [ -z "$FOUND_HOME" ]; then
  [ -n "$INPUT_AE_DIR" ] && [ -n "$INPUT_AE_DATA" ] && [ -n "$INPUT_AE_PORT" ] \
    || die "no config.env exists in AE_HOME=$INPUT_AE_HOME; specify AE_DIR, AE_DATA, and AE_PORT rather than guessing"
fi

AE_HOME="$(choose_input "$INPUT_AE_HOME_SET" "$INPUT_AE_HOME" "${FOUND_HOME:-$DEFAULT_HOME}")"
AE_DIR="$(choose_input "$INPUT_AE_DIR_SET" "$INPUT_AE_DIR" "${FOUND_DIR:-$DEFAULT_DIR}")"
AE_DATA="$(choose_input "$INPUT_AE_DATA_SET" "$INPUT_AE_DATA" "${FOUND_DATA:-$DEFAULT_DATA}")"
AE_PORT="$(choose_input "$INPUT_AE_PORT_SET" "$INPUT_AE_PORT" "${FOUND_PORT:-3000}")"
AE_OWNER="$(choose_input "$INPUT_AE_OWNER_SET" "$INPUT_AE_OWNER" "${AE_OWNER:-FadeKit}")"
AE_REPO="$(choose_input "$INPUT_AE_REPO_SET" "$INPUT_AE_REPO" "${AE_REPO:-Encrypted-Messanger}")"
AE_BRANCH="$(choose_input "$INPUT_AE_BRANCH_SET" "$INPUT_AE_BRANCH" "${AE_BRANCH:-arena/442b6c1e-encrypted-messanger}")"
AE_HOST="$(choose_input "$INPUT_AE_HOST_SET" "$INPUT_AE_HOST" "${AE_HOST:-0.0.0.0}")"
AE_HTTP_PORT="$(choose_input "$INPUT_AE_HTTP_PORT_SET" "$INPUT_AE_HTTP_PORT" "${AE_HTTP_PORT:-8080}")"
AE_TLS="$(choose_input "$INPUT_AE_TLS_SET" "$INPUT_AE_TLS" "${AE_TLS:-1}")"
AE_TLS_DIR="$(choose_input "$INPUT_AE_TLS_DIR_SET" "$INPUT_AE_TLS_DIR" "${AE_TLS_DIR:-$AE_HOME/tls}")"
AE_TLS_CERT="$(choose_exact_input "$INPUT_AE_TLS_CERT_SET" "$INPUT_AE_TLS_CERT" "${AE_TLS_CERT:-}")"
AE_TLS_KEY="$(choose_exact_input "$INPUT_AE_TLS_KEY_SET" "$INPUT_AE_TLS_KEY" "${AE_TLS_KEY:-}")"
AE_TLS_CA="$(choose_exact_input "$INPUT_AE_TLS_CA_SET" "$INPUT_AE_TLS_CA" "${AE_TLS_CA:-}")"
AE_DISCORD_URL="$(choose_exact_input "$INPUT_AE_DISCORD_URL_SET" "$INPUT_AE_DISCORD_URL" "${AE_DISCORD_URL:-}")"
AE_GIT_URL="$(choose_exact_input "$INPUT_AE_GIT_URL_SET" "$INPUT_AE_GIT_URL" "${AE_GIT_URL:-}")"
AE_HEALTH_PATH="$(choose_input "$INPUT_AE_HEALTH_PATH_SET" "$INPUT_AE_HEALTH_PATH" "${AE_HEALTH_PATH:-/api/health}")"
AE_HEALTH_TIMEOUT="$(choose_input "$INPUT_AE_HEALTH_TIMEOUT_SET" "$INPUT_AE_HEALTH_TIMEOUT" "${AE_HEALTH_TIMEOUT:-4}")"
AE_HEALTH_FAILS="$(choose_input "$INPUT_AE_HEALTH_FAILS_SET" "$INPUT_AE_HEALTH_FAILS" "${AE_HEALTH_FAILS:-3}")"
AE_BACKOFF="$(choose_input "$INPUT_AE_BACKOFF_SET" "$INPUT_AE_BACKOFF" "${AE_BACKOFF:-2}")"

note "runtime : $AE_HOME"
note "code    : $AE_DIR"
note "data    : $AE_DATA"
note "port    : $AE_PORT"

# ---------------------------------------------------- stage source first -------
# Do not stop a working host until the new code is downloaded and validated.
step "Fetching and validating the source"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P)"
SCRIPT_ROOT="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd -P)"

resolve_path() {
  local target="$1" parent base
  if [ -d "$target" ]; then (cd "$target" 2>/dev/null && pwd -P); return; fi
  parent="$(dirname "$target")"
  base="$(basename "$target")"
  if [ -d "$parent" ]; then printf '%s/%s' "$(cd "$parent" && pwd -P)" "$base"; return; fi
  case "$target" in /*) printf '%s' "$target" ;; *) printf '%s/%s' "$PWD" "$target" ;; esac
}

path_is_inside() {
  local child="${1%/}" parent="${2%/}"
  case "$child/" in "$parent/"*) return 0 ;; esac
  return 1
}

archive_paths_are_safe() {
  local archive="$1" listing="$TMP_ROOT/archive-entries.txt"
  case "$archive" in
    *.zip)
      have unzip || return 1
      unzip -Z1 "$archive" > "$listing" 2>/dev/null || return 1
      ;;
    *)
      tar -tzf "$archive" > "$listing" 2>/dev/null || return 1
      ;;
  esac
  ! grep -Eq '(^/|(^|/)\.\.(/|$))' "$listing"
}

# Running the script extracted from the GitHub archive is already a complete
# source tree. Use it directly instead of downloading the exact same archive a
# second time. A copy inside the installed tree is not considered new source.
if [ -z "${AE_SOURCE_FILE:-}" ] && [ -z "${AE_SOURCE_DIR:-}" ] \
  && [ -f "$SCRIPT_ROOT/server/index.js" ] && [ -f "$SCRIPT_ROOT/scripts/termux-install.sh" ]; then
  SCRIPT_ROOT_ABS="$(resolve_path "$SCRIPT_ROOT")"
  TARGET_DIR_ABS="$(resolve_path "$AE_DIR")"
  if [ "$SCRIPT_ROOT_ABS" != "$TARGET_DIR_ABS" ]; then
    AE_SOURCE_DIR="$SCRIPT_ROOT_ABS"
    say "using the source tree this patch script came with"
  fi
fi

SOURCE_ROOT=""
INSTALLER=""
PATCH_SOURCE_FILE=""
PATCH_SOURCE_DIR=""
if [ -n "${AE_SOURCE_DIR:-}" ]; then
  SOURCE_ROOT="$(resolve_path "$AE_SOURCE_DIR")"
  [ -f "$SOURCE_ROOT/server/index.js" ] || die "AE_SOURCE_DIR is not an AE Secure checkout: $SOURCE_ROOT"
  [ -f "$SOURCE_ROOT/scripts/termux-install.sh" ] || die "scripts/termux-install.sh is missing from $SOURCE_ROOT"
  INSTALLER="$SOURCE_ROOT/scripts/termux-install.sh"
  PATCH_SOURCE_DIR="$SOURCE_ROOT"
elif [ -n "${AE_SOURCE_FILE:-}" ]; then
  TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ae-patch.XXXXXX")" || die "could not create a temporary directory"
  archive_paths_are_safe "$AE_SOURCE_FILE" || die "the source archive is invalid or contains an unsafe path"
  case "$AE_SOURCE_FILE" in
    *.zip) have unzip || die "unzip is required (pkg install unzip)"; unzip -q "$AE_SOURCE_FILE" -d "$TMP_ROOT" || die "could not extract $AE_SOURCE_FILE" ;;
    *) tar -xzf "$AE_SOURCE_FILE" -C "$TMP_ROOT" || die "could not extract $AE_SOURCE_FILE" ;;
  esac
  INSTALLER="$(find "$TMP_ROOT" -maxdepth 4 -type f -path '*/scripts/termux-install.sh' | head -1)"
  [ -n "$INSTALLER" ] || die "no scripts/termux-install.sh inside $AE_SOURCE_FILE"
  SOURCE_ROOT="$(dirname "$(dirname "$INSTALLER")")"
  [ -f "$SOURCE_ROOT/server/index.js" ] || die "server/index.js is missing from $AE_SOURCE_FILE"
  PATCH_SOURCE_FILE="$AE_SOURCE_FILE"
else
  TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ae-patch.XXXXXX")" || die "could not create a temporary directory"
  have curl || { on_termux && pkg install -y curl; }
  have curl || die "curl is required"
  ARCHIVE="https://codeload.github.com/$AE_OWNER/$AE_REPO/tar.gz/refs/heads/$AE_BRANCH"
  say "downloading $AE_BRANCH"
  curl -fsSL "$ARCHIVE" -o "$TMP_ROOT/ae-secure.tar.gz" || die "download failed — the current host has not been stopped"
  archive_paths_are_safe "$TMP_ROOT/ae-secure.tar.gz" || die "the downloaded archive is invalid or contains an unsafe path"
  tar -xzf "$TMP_ROOT/ae-secure.tar.gz" -C "$TMP_ROOT" || die "the source archive did not extract"
  INSTALLER="$(find "$TMP_ROOT" -maxdepth 4 -type f -path '*/scripts/termux-install.sh' | head -1)"
  [ -n "$INSTALLER" ] || die "the archive has no scripts/termux-install.sh"
  SOURCE_ROOT="$(dirname "$(dirname "$INSTALLER")")"
  [ -f "$SOURCE_ROOT/server/index.js" ] || die "server/index.js is missing from the source archive"
  PATCH_SOURCE_FILE="$TMP_ROOT/ae-secure.tar.gz"
fi

[ -f "$INSTALLER" ] || die "no installer found to run"
say "validated source: $SOURCE_ROOT"

# Replacing AE_DIR removes that directory. Refuse layouts where protected
# account data, runtime files, or TLS keys live inside it or the source tree.
AE_DIR_ABS="$(resolve_path "$AE_DIR")"
AE_DATA_ABS="$(resolve_path "$AE_DATA")"
AE_HOME_ABS="$(resolve_path "$AE_HOME")"
HOME_ABS="$(resolve_path "$HOME")"
AE_TLS_DIR_ABS="$(resolve_path "$AE_TLS_DIR")"
AE_TLS_CERT_ABS=""; [ -n "$AE_TLS_CERT" ] && AE_TLS_CERT_ABS="$(resolve_path "$AE_TLS_CERT")"
AE_TLS_KEY_ABS=""; [ -n "$AE_TLS_KEY" ] && AE_TLS_KEY_ABS="$(resolve_path "$AE_TLS_KEY")"
AE_TLS_CA_ABS=""; [ -n "$AE_TLS_CA" ] && AE_TLS_CA_ABS="$(resolve_path "$AE_TLS_CA")"
SOURCE_ROOT_ABS="$(resolve_path "$SOURCE_ROOT")"

[ "$AE_DIR_ABS" != "/" ] && [ "$AE_DIR_ABS" != "$HOME_ABS" ] \
  || die "refusing to replace the filesystem root or your home directory as AE_DIR"
path_is_inside "$HOME_ABS" "$AE_DIR_ABS" \
  && die "AE_DIR would contain your home directory; choose a dedicated code folder"
if path_is_inside "$AE_DATA_ABS" "$AE_DIR_ABS" || path_is_inside "$AE_DIR_ABS" "$AE_DATA_ABS"; then
  die "AE_DIR and AE_DATA overlap; move encrypted data outside the code tree before patching"
fi
if path_is_inside "$SOURCE_ROOT_ABS" "$AE_DATA_ABS"; then
  die "the source tree is inside AE_DATA; move it outside the encrypted data directory before patching"
fi
if [ -n "${AE_SOURCE_FILE:-}" ]; then
  SOURCE_FILE_ABS="$(resolve_path "$AE_SOURCE_FILE")"
  path_is_inside "$SOURCE_FILE_ABS" "$AE_DATA_ABS" \
    && die "AE_SOURCE_FILE is inside AE_DATA; move the patch archive outside the encrypted data directory"
fi

for protected_path in "$AE_HOME_ABS" "$AE_TLS_DIR_ABS" \
  "$AE_TLS_CERT_ABS" "$AE_TLS_KEY_ABS" "$AE_TLS_CA_ABS"; do
  [ -n "$protected_path" ] || continue
  if path_is_inside "$protected_path" "$AE_DIR_ABS"; then
    die "a runtime or TLS path is inside AE_DIR; move it outside the code tree before patching"
  fi
  if path_is_inside "$protected_path" "$SOURCE_ROOT_ABS"; then
    die "a runtime or TLS path is inside the source tree; keep it outside before packaging the patch"
  fi
  if path_is_inside "$protected_path" "$AE_DATA_ABS"; then
    die "a runtime or TLS path is inside AE_DATA; keep encrypted data separate from install files"
  fi
done
if [ "$SOURCE_ROOT_ABS" != "$AE_DIR_ABS" ] && path_is_inside "$AE_DIR_ABS" "$SOURCE_ROOT_ABS"; then
  die "AE_DIR is inside the source tree; use a separate checkout so a patch cannot package itself"
fi

# The installer's archive path removes the old code tree before extraction;
# package a local checkout that way too, so obsolete files cannot survive a
# patch as they would in a simple directory merge. Secret/environment files
# are not part of the app source bundle.
if [ -n "$PATCH_SOURCE_DIR" ]; then
  if [ -z "$TMP_ROOT" ]; then
    TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ae-patch.XXXXXX")" || die "could not create a source staging directory"
  fi
  PATCH_SOURCE_FILE="$TMP_ROOT/local-source.tar.gz"
  tar -czf "$PATCH_SOURCE_FILE" --exclude='./.git' --exclude='./node_modules' \
    --exclude='./data' --exclude='./.env' --exclude='./.env.*' --exclude='./tools/scratch' \
    -C "$PATCH_SOURCE_DIR" . || die "could not package the validated local source"
  PATCH_SOURCE_DIR=""
fi

if [ -e "$AE_DIR" ] && [ ! -d "$AE_DIR/.git" ] && [ ! -f "$AE_DIR/server/index.js" ] && [ -n "$(ls -A "$AE_DIR" 2>/dev/null)" ]; then
  die "$AE_DIR exists and does not look like AE Secure — move it aside or set AE_DIR"
fi

# Keep a compressed copy of the previous code only; the encrypted data remains
# in AE_DATA and is never included. If installation or its health check fails,
# the EXIT handler puts the old tree back and starts it again.
if [ -f "$AE_DIR/server/index.js" ]; then
  HAD_OLD_CODE=1
  if [ -z "$TMP_ROOT" ]; then
    TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ae-patch.XXXXXX")" || die "could not create a rollback directory"
  fi
  CODE_PARENT="$(dirname "$AE_DIR")"
  CODE_BASE="$(basename "$AE_DIR")"
  PATCH_BACKUP="$TMP_ROOT/previous-code.tar.gz"
  tar -czf "$PATCH_BACKUP" --exclude="$CODE_BASE/.git" --exclude="$CODE_BASE/node_modules" \
    -C "$CODE_PARENT" "$CODE_BASE" || die "could not make a rollback copy; the running host was not stopped"
fi

# The installer also rewrites its small runtime command/config files. Snapshot
# those separately so a failed patch restores the prior service configuration
# and supervisor, not only the application source tree.
RUNTIME_SNAPSHOT_READY=1
RUNTIME_ITEMS=()
for runtime_item in config.env bin/watchdog bin/ae-secure bin/guard-job.sh; do
  if [ -e "$AE_HOME/$runtime_item" ] || [ -L "$AE_HOME/$runtime_item" ]; then
    RUNTIME_ITEMS+=("$runtime_item")
  fi
done
if [ "${#RUNTIME_ITEMS[@]}" -gt 0 ]; then
  RUNTIME_BACKUP="$TMP_ROOT/previous-runtime.tar.gz"
  tar -czf "$RUNTIME_BACKUP" -C "$AE_HOME" "${RUNTIME_ITEMS[@]}" \
    || die "could not back up the current runtime settings; the host was not stopped"
fi

process_is_install_target() {
  local pid="$1" kind="$2" cmdline cwd
  [ -r "/proc/$pid/cmdline" ] || return 1
  cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  case "$kind" in
    supervisor)
      [[ "$cmdline" == *"$AE_HOME/bin/watchdog"* ]] && return 0
      ;;
    server)
      [ "$cwd" = "$AE_DIR_ABS" ] && [[ "$cmdline" == *"server/index.js"* ]] && return 0
      [[ "$cmdline" == *"$AE_DIR_ABS/server/index.js"* ]] && return 0
      ;;
  esac
  return 1
}

stop_pid() {
  local pid="$1" label="$2" kind="$3" attempt
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  [ "$pid" != "$$" ] || return 1
  process_is_install_target "$pid" "$kind" || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  kill -TERM "$pid" 2>/dev/null || true
  for attempt in 1 2 3 4; do
    kill -0 "$pid" 2>/dev/null || { say "stopped $label (pid $pid)"; return 0; }
    sleep 1
  done
  kill -KILL "$pid" 2>/dev/null || true
  say "stopped $label (pid $pid)"
  return 0
}

stop_running_install() {
  local pidfile pid
  # Pid files can be stale and PIDs can be reused. Verify each target against
  # /proc before sending a signal; never kill a process just because a number
  # was left behind by an earlier run.
  for pidfile in "$AE_HOME/run/supervisor.pid" "$AE_HOME/run/server.pid"; do
    [ -f "$pidfile" ] || continue
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    case "$pidfile" in
      */supervisor.pid) stop_pid "$pid" "AE Secure supervisor" supervisor || true ;;
      */server.pid) stop_pid "$pid" "AE Secure server" server || true ;;
    esac
  done

  if have pgrep && [ -d /proc ]; then
    for pid in $(pgrep -f 'bin/watchdog' 2>/dev/null || true); do
      process_is_install_target "$pid" supervisor && stop_pid "$pid" "AE Secure supervisor" supervisor || true
    done
    for pid in $(pgrep -f 'server/index.js' 2>/dev/null || true); do
      process_is_install_target "$pid" server && stop_pid "$pid" "AE Secure server" server || true
    done
  fi
  rm -f "$AE_HOME/run/supervisor.pid" "$AE_HOME/run/server.pid"
}

restore_runtime() {
  [ "$RUNTIME_SNAPSHOT_READY" = "1" ] || return 0
  local runtime_item
  mkdir -p "$AE_HOME" || return 1
  for runtime_item in config.env bin/watchdog bin/ae-secure bin/guard-job.sh; do
    rm -f "$AE_HOME/$runtime_item" || return 1
  done
  if [ -n "$RUNTIME_BACKUP" ] && [ -f "$RUNTIME_BACKUP" ]; then
    tar -xzf "$RUNTIME_BACKUP" -C "$AE_HOME" || {
      say "runtime restore failed — the saved settings are at $RUNTIME_BACKUP"
      return 1
    }
  fi
  return 0
}

rollback_code() {
  [ "$HAD_OLD_CODE" = "1" ] && [ -f "$PATCH_BACKUP" ] || return 1
  say "restoring the previous code tree"
  rm -rf "$AE_DIR" || {
    say "could not remove the failed code tree"
    return 1
  }
  mkdir -p "$(dirname "$AE_DIR")" || return 1
  tar -xzf "$PATCH_BACKUP" -C "$(dirname "$AE_DIR")" || {
    say "rollback extraction failed — the saved copy is at $PATCH_BACKUP"
    return 1
  }
  [ -f "$AE_DIR/server/index.js" ] || {
    say "the restored tree is incomplete — the saved copy is at $PATCH_BACKUP"
    return 1
  }
  return 0
}

cleanup() {
  local exit_code=$?
  if [ "$PATCH_STOPPED" = "1" ] && [ "$PATCH_SUCCESS" != "1" ]; then
    # The installer may have started a new process before failing its health
    # check. Stop only processes verified as belonging to this install.
    stop_running_install || true
    CODE_RESTORED=1
    RUNTIME_RESTORED=1
    if [ "$HAD_OLD_CODE" = "1" ] && ! rollback_code; then CODE_RESTORED=0; fi
    if ! restore_runtime; then RUNTIME_RESTORED=0; fi
    if [ "$HAD_OLD_CODE" = "1" ] && [ "$CODE_RESTORED" = "1" ] && [ "$RUNTIME_RESTORED" = "1" ]; then
      restart_existing
    elif [ "$HAD_OLD_CODE" = "1" ]; then
      KEEP_TMP_ROOT=1
      say "rollback did not complete; retained recovery files under $TMP_ROOT"
      say "the host may remain stopped until the saved code/runtime is restored"
    else
      say "this was a fresh install, so there was no previous code to restore"
      if [ "$RUNTIME_RESTORED" != "1" ]; then
        KEEP_TMP_ROOT=1
        say "runtime recovery files were retained under $TMP_ROOT"
      fi
    fi
  fi
  if [ "$KEEP_TMP_ROOT" != "1" ] && [ -n "$TMP_ROOT" ] && [ -d "$TMP_ROOT" ]; then
    rm -rf "$TMP_ROOT"
  fi
  return "$exit_code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ------------------------------------------------------------- stop it -------
step "Stopping the host"
stop_running_install
sleep 1
PATCH_STOPPED=1
say "host stop requested"

port_open() {
  if have node; then
    node -e '
      const net = require("net");
      const socket = net.connect({ host: "127.0.0.1", port: Number(process.argv[1]) });
      socket.on("connect", () => { socket.destroy(); process.exit(0); });
      socket.on("error", () => process.exit(1));
      setTimeout(() => { socket.destroy(); process.exit(1); }, 1200);
    ' "$AE_PORT" >/dev/null 2>&1
  elif have nc; then
    nc -z 127.0.0.1 "$AE_PORT" >/dev/null 2>&1
  else
    return 1
  fi
}

for attempt in 1 2 3 4 5; do
  port_open || break
  sleep 1
done
if port_open; then
  say ""
  say "The port is still in use. Nothing has been replaced."
  say "Inspect only the matching process with: ps -A | grep '[s]erver/index.js'"
  say "Stop that specific PID with: kill -TERM <PID>"
  say "Then rerun this patch script. No broad pkill was used."
  die "port $AE_PORT did not become free"
fi

# ------------------------------------------------------------- install -------
step "Patching"
say "installing over $AE_DIR (encrypted data stays in $AE_DATA)"

# Send every saved setting into the child installer. Otherwise its defaults can
# silently replace the phone's TLS mode, redirect port, Discord link or health
# settings when it rewrites config.env.
AE_OWNER="$AE_OWNER" AE_REPO="$AE_REPO" AE_BRANCH="$AE_BRANCH" AE_GIT_URL="$AE_GIT_URL" \
  AE_DIR="$AE_DIR" AE_DATA="$AE_DATA" AE_PORT="$AE_PORT" AE_HOST="$AE_HOST" AE_HOME="$AE_HOME" \
  AE_HTTP_PORT="$AE_HTTP_PORT" AE_TLS="$AE_TLS" AE_TLS_DIR="$AE_TLS_DIR" \
  AE_TLS_CERT="$AE_TLS_CERT" AE_TLS_KEY="$AE_TLS_KEY" AE_TLS_CA="$AE_TLS_CA" \
  AE_DISCORD_URL="$AE_DISCORD_URL" AE_HEALTH_PATH="$AE_HEALTH_PATH" \
  AE_HEALTH_TIMEOUT="$AE_HEALTH_TIMEOUT" AE_HEALTH_FAILS="$AE_HEALTH_FAILS" AE_BACKOFF="$AE_BACKOFF" \
  AE_NO_BOOT="${AE_NO_BOOT:-0}" AE_NO_JOB="${AE_NO_JOB:-0}" \
  AE_SOURCE_FILE="$PATCH_SOURCE_FILE" AE_SOURCE_DIR="$PATCH_SOURCE_DIR" \
  bash "$INSTALLER" install
RESULT=$?
if [ "$RESULT" -ne 0 ]; then die "the installer failed (exit $RESULT)"; fi

CLI="$AE_HOME/bin/ae-secure"
[ -x "$CLI" ] || die "the installer did not create $CLI"

URL_INFO="$(AE_HOME="$AE_HOME" "$CLI" url 2>&1 || true)"
printf '%s\n' "$URL_INFO"
if printf '%s\n' "$URL_INFO" | grep -q 'on your network: https://'; then
  ACTUAL_SCHEME="https"
else
  ACTUAL_SCHEME="http"
fi
if [ "$AE_TLS" = "1" ] && [ "$ACTUAL_SCHEME" != "https" ]; then
  die "TLS was requested but the service did not start HTTPS; restoring the previous install instead of leaving a broken insecure setup"
fi

health_check() {
  if have curl; then
    curl -fsSk --max-time 3 "$ACTUAL_SCHEME://127.0.0.1:$AE_PORT$AE_HEALTH_PATH" >/dev/null 2>&1
  elif have node; then
    node -e '
      const scheme = process.argv[1];
      const transport = scheme === "https" ? require("https") : require("http");
      const request = transport.get({ hostname: "127.0.0.1", port: Number(process.argv[2]), path: process.argv[3], rejectUnauthorized: false, timeout: 3000 }, (response) => {
        response.resume(); process.exit(response.statusCode === 200 ? 0 : 1);
      });
      request.on("timeout", () => { request.destroy(); process.exit(1); });
      request.on("error", () => process.exit(1));
    ' "$ACTUAL_SCHEME" "$AE_PORT" "$AE_HEALTH_PATH" >/dev/null 2>&1
  else
    return 1
  fi
}

HEALTH_OK=0
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if health_check; then HEALTH_OK=1; break; fi
  sleep 1
done
[ "$HEALTH_OK" = "1" ] || die "the patched host did not answer its health check; the previous code will be restored"
PATCH_SUCCESS=1
PATCH_STOPPED=0

# ---------------------------------------------------------------- result -----
step "Patched"
CLI="$AE_HOME/bin/ae-secure"
if [ -x "$CLI" ]; then
  AE_HOME="$AE_HOME" "$CLI" status || true
else
  note "the service command was not found in $AE_HOME"
fi

# Say which build landed, so it can be compared with Settings -> About.
if have node; then
  BUILD="$(cd "$AE_DIR" 2>/dev/null && node -e 'try{const b=require("./server/build");process.stdout.write(b.build.id)}catch{}' 2>/dev/null || true)"
  [ -n "$BUILD" ] && say "build $BUILD is installed — Settings -> About on the site shows this same value"
fi
say ""
say "Open the address printed above. If it is HTTPS, trust the phone certificate"
say "on each device once; keep the encrypted data directory unchanged."
say ""
note "Details: ae-secure doctor   ·   logs: ae-secure logs   ·   backup: ae-secure backup"
say ""

# ------------------------------------------------------------------ reboot ---
# The patch ends with the phone restarting, which is the cleanest state to test
# from: the boot hook the installer wrote brings the host back by itself. The
# reboot is skipped with AE_REBOOT=0, or by pressing a key during the countdown.
if [ "$AE_REBOOT" = "1" ]; then
  step "Restarting the phone"
  say "The host starts again on its own once the phone has booted."
  SKIP_REBOOT=0
  # Without a terminal (a piped install) there is nobody to ask, so go straight
  # on rather than reading from a closed stdin.
  if [ -t 0 ]; then
    say "Press any key in the next ten seconds to keep the phone on."
    if read -r -t 10 -n 1 -s; then SKIP_REBOOT=1; fi
    say ""
  fi
  if [ "$SKIP_REBOOT" = "1" ]; then
    note "reboot skipped — when you are ready: svc power reboot"
  else
    REBOOT_REQUESTED=0
    if have termux-reboot; then
      note "termux-reboot"
      if termux-reboot; then REBOOT_REQUESTED=1; else note "Termux:API reboot failed; trying the system service"; fi
    fi
    if [ "$REBOOT_REQUESTED" = "0" ] && [ "$ON_TERMUX" = "1" ] && have svc; then
      note "svc power reboot"
      if svc power reboot; then REBOOT_REQUESTED=1; else note "svc could not reboot the phone"; fi
    fi
    if [ "$REBOOT_REQUESTED" = "0" ] && [ "$ON_TERMUX" = "1" ] && have su; then
      note "su -c reboot"
      if su -c reboot; then REBOOT_REQUESTED=1; else note "root reboot was refused"; fi
    fi
    if [ "$REBOOT_REQUESTED" = "0" ] && [ "$ON_TERMUX" = "1" ]; then
      say "no reboot helper succeeded. Install Termux:API (pkg install termux-api), or"
      say "reboot the phone yourself with:  svc power reboot"
    elif [ "$ON_TERMUX" != "1" ]; then
      say "not on Termux, so the phone was left alone"
    fi
  fi
else
  note "The phone was not restarted (AE_REBOOT=0)."
fi
say ""
