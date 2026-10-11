#!/usr/bin/env bash
# =============================================================================
#  AE Secure — one-command install for Termux
# -----------------------------------------------------------------------------
#  Paste this into Termux and everything else happens on its own:
#
#      curl -fsSL https://codeload.github.com/FadeKit/Encrypted-Messanger/tar.gz/refs/heads/arena/442b6c1e-encrypted-messanger \
#        | tar -xz -C "$TMPDIR" && bash "$TMPDIR"/Encrypted-Messanger-*/scripts/install.sh
#
#  If you already have the project on the phone, this is the same thing:
#
#      bash ~/ae-secure-src/scripts/install.sh
#
#  It downloads the project, installs the packages it needs, starts the server,
#  keeps it alive (crash, hang and reboot), and prints the address to open.
#
#  Options, all optional:
#      AE_BRANCH=<branch>     source branch            (default: the app branch)
#      AE_PORT=<port>         listening port           (default: 3000)
#      AE_DIR / AE_DATA / AE_HOME                       (see scripts/termux-install.sh)
#      AE_NO_BOOT=1           do not install the boot hook
#      AE_NO_JOB=1            do not register the periodic keep-alive job
#      AE_SOURCE_FILE=<path>  install from a local .tar.gz/.zip instead of GitHub
# =============================================================================

set -uo pipefail

AE_OWNER="${AE_OWNER:-FadeKit}"
AE_REPO="${AE_REPO:-Encrypted-Messanger}"
AE_BRANCH="${AE_BRANCH:-arena/442b6c1e-encrypted-messanger}"

if [ -t 1 ]; then C_DIM=$'\033[2m'; C_OFF=$'\033[0m'; else C_DIM=''; C_OFF=''; fi
say()  { printf '%s\n' "$*"; }
note() { printf '%s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }
step() { printf '\n== %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

if [ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux/files/usr ]; then
  ON_TERMUX=1
else
  ON_TERMUX=0
fi

# ------------------------------------------------------------------ banner ---
say ""
say "  AE Secure — encrypted messaging, communities and cloud drive"
say "  installing onto this phone"
say ""

# --------------------------------------------------------------- packages ----
step "Packages"
if [ "$ON_TERMUX" = "1" ]; then
  if ! have curl; then
    say "installing curl"
    pkg install -y curl || die "pkg install curl failed — run: pkg update && pkg upgrade"
  fi
  # node, git and tar are handled by the installer; curl is needed here.
else
  note "not Termux: continuing anyway (node and curl are expected on PATH)"
  have curl || die "curl is required"
fi

# ------------------------------------------------------------------ source ---
step "Downloading the project"
if [ -n "${AE_SOURCE_FILE:-}" ]; then
  say "using the local archive ${AE_SOURCE_FILE}"
  SOURCE_DIR=""
else
  # Is this script already inside a checkout? Then there is nothing to download.
  SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)"
  PROJECT_DIR="$(cd "$SELF_DIR/.." && pwd -P)"
  if [ -f "$PROJECT_DIR/server/index.js" ]; then
    say "using the project in $PROJECT_DIR"
    SOURCE_DIR="$PROJECT_DIR"
  else
    ARCHIVE="https://codeload.github.com/$AE_OWNER/$AE_REPO/tar.gz/refs/heads/$AE_BRANCH"
    say "fetching $AE_BRANCH"
    TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ae-secure.XXXXXX")" || die "could not create a temporary directory"
    if ! curl -fsSL "$ARCHIVE" -o "$TMP_ROOT/ae-secure.tar.gz"; then
      rm -rf "$TMP_ROOT"
      die "download failed — check the branch name and your connection"
    fi
    tar -xzf "$TMP_ROOT/ae-secure.tar.gz" -C "$TMP_ROOT" || { rm -rf "$TMP_ROOT"; die "the archive did not extract"; }
    SOURCE_DIR="$(find "$TMP_ROOT" -maxdepth 1 -mindepth 1 -type d | head -1)"
    [ -f "$SOURCE_DIR/server/index.js" ] || { rm -rf "$TMP_ROOT"; die "the archive has no server/index.js"; }
    CLEANUP_DIR="$TMP_ROOT"
    say "downloaded $(du -h "$TMP_ROOT/ae-secure.tar.gz" 2>/dev/null | cut -f1 | tr -d ' ') of source"
  fi
fi

[ -f "$SOURCE_DIR/server/index.js" ] || die "no project found to install"

# ----------------------------------------------------------------- install ---
step "Installing"
INSTALLER="$SOURCE_DIR/scripts/termux-install.sh"
[ -f "$INSTALLER" ] || die "scripts/termux-install.sh is missing from the download"

# AE_SOURCE_DIR makes the installer copy the tree it was started from, so the
# download is not repeated. Everything else passes through untouched.
AE_SOURCE_DIR="$SOURCE_DIR" bash "$INSTALLER" install
INSTALL_RESULT=$?

[ -n "${CLEANUP_DIR:-}" ] && rm -rf "$CLEANUP_DIR"
[ "$INSTALL_RESULT" -eq 0 ] || die "the installer reported a failure (see the output above)"

# ------------------------------------------------------------------- done ----
AE_HOME="${AE_HOME:-$HOME/.ae-secure}"
AE_CONF="$AE_HOME/config.env"
# shellcheck disable=SC1090
[ -f "$AE_CONF" ] && . "$AE_CONF"
AE_CLI="${AE_HOME}/bin/ae-secure"

step "Ready"
if [ -x "$AE_CLI" ]; then
  "$AE_CLI" url || true
else
  note "the service command was not found in $AE_HOME — run: ae-secure doctor"
fi

say ""
say "Open the network address above on any device on the same Wi-Fi."
say "The first account you register becomes the owner of this instance."
say ""
say "Keeps itself running: restarts after a crash or a hang, starts on boot,"
say "and a periodic guard job revives it if Android force-stops Termux."
say ""
say "Manage it with:"
say "  ae-secure status | logs | url | update | backup | stop | start"
say ""
note "Termux:Boot (F-Droid, opened once) is what makes the boot hook run."
note "Termux:API gives you the 15-minute guard job and the wifi address readout."
note "Keep the phone on a charger and disable battery optimisation for Termux."
say ""
