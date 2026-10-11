#!/usr/bin/env bash
# Isolated, local-source integration test for scripts/termux-patch.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/ae-patch-test.XXXXXX")"
TEST_HOME="$TMP/home"
RUNTIME="$TMP/runtime"
APP="$TMP/code"
DATA="$TMP/data"
PORT=""
PORT2=""

new_port() {
  node -e 'const net=require("net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}
PORT="$(new_port)"
PORT2="$(new_port)"
while [ "$PORT" = "$PORT2" ]; do PORT2="$(new_port)"; done
SENTINEL="encrypted-data-sentinel:$(date +%s)"

stop_test_host() {
  if [ -x "$RUNTIME/bin/ae-secure" ]; then
    AE_HOME="$RUNTIME" "$RUNTIME/bin/ae-secure" stop >/dev/null 2>&1 || true
  fi
}
cleanup() {
  local result=$?
  trap - EXIT
  stop_test_host
  if [ "$result" -ne 0 ]; then
    for log in "$TMP"/*.log; do
      [ -f "$log" ] || continue
      printf '\n--- %s ---\n' "$log" >&2
      cat "$log" >&2
    done
  fi
  rm -rf "$TMP"
  exit "$result"
}
trap cleanup EXIT

run_logged() {
  local log="$1"
  shift
  if ! "$@" >"$log" 2>&1; then
    printf 'command failed; see %s\n' "$log" >&2
    return 1
  fi
}

mkdir -p "$TEST_HOME" "$DATA"
printf '%s\n' "$SENTINEL" > "$DATA/preserve-me.enc"

# Seed a complete isolated install with non-default settings. No Termux boot
# files, phone reboot, network fetch, or repository data directory are involved.
run_logged "$TMP/install.log" env \
  HOME="$TEST_HOME" AE_HOME="$RUNTIME" AE_DIR="$APP" AE_DATA="$DATA" AE_PORT="$PORT" \
  AE_HOST=127.0.0.1 AE_TLS=0 AE_HTTP_PORT=8181 \
  AE_DISCORD_URL=https://discord.example/invite \
  AE_NO_BOOT=1 AE_NO_JOB=1 AE_SOURCE_DIR="$ROOT" \
  bash "$ROOT/scripts/termux-install.sh" install

[ -f "$RUNTIME/config.env" ]
[ -f "$APP/server/index.js" ]
printf 'must disappear after a code replacement\n' > "$APP/obsolete-patch-test-file"

# Patch with no overrides: existing install settings must survive intact.
run_logged "$TMP/patch-preserve.log" env \
  -u AE_TLS -u AE_HTTP_PORT -u AE_DISCORD_URL -u AE_PORT -u AE_DATA \
  -u AE_DIR -u AE_SOURCE_DIR -u AE_SOURCE_FILE \
  HOME="$TEST_HOME" AE_HOME="$RUNTIME" AE_REBOOT=0 AE_NO_BOOT=1 AE_NO_JOB=1 \
  bash "$ROOT/scripts/termux-patch.sh"

grep -Fxq "AE_HOME=\"$RUNTIME\"" "$RUNTIME/config.env"
grep -Fxq "AE_DIR=\"$APP\"" "$RUNTIME/config.env"
grep -Fxq "AE_DATA=\"$DATA\"" "$RUNTIME/config.env"
grep -Fxq "AE_PORT=\"$PORT\"" "$RUNTIME/config.env"
grep -Fxq 'AE_TLS="0"' "$RUNTIME/config.env"
grep -Fxq 'AE_HTTP_PORT="8181"' "$RUNTIME/config.env"
grep -Fxq 'AE_DISCORD_URL="https://discord.example/invite"' "$RUNTIME/config.env"
[ ! -e "$APP/obsolete-patch-test-file" ]
grep -Fq 'on your network: http://' "$TMP/patch-preserve.log"
[ "$(cat "$DATA/preserve-me.enc")" = "$SENTINEL" ]
curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" | grep -q '"ok":true'

# An explicit environment override must still win over the sourced config.
run_logged "$TMP/patch-override.log" env \
  -u AE_TLS -u AE_DISCORD_URL -u AE_DATA -u AE_DIR -u AE_SOURCE_DIR -u AE_SOURCE_FILE \
  HOME="$TEST_HOME" AE_HOME="$RUNTIME" AE_PORT="$PORT2" AE_HTTP_PORT=9191 \
  AE_REBOOT=0 AE_NO_BOOT=1 AE_NO_JOB=1 \
  bash "$ROOT/scripts/termux-patch.sh"

grep -Fxq "AE_PORT=\"$PORT2\"" "$RUNTIME/config.env"
grep -Fxq 'AE_HTTP_PORT="9191"' "$RUNTIME/config.env"
grep -Fxq "AE_DATA=\"$DATA\"" "$RUNTIME/config.env"
[ "$(cat "$DATA/preserve-me.enc")" = "$SENTINEL" ]
curl -fsS --max-time 5 "http://127.0.0.1:$PORT2/api/health" | grep -q '"ok":true'

# Force a candidate build to fail at runtime. The patch must restore the exact
# previous app tree and bring its health endpoint back before returning nonzero.
BROKEN="$TMP/broken-source"
mkdir -p "$BROKEN"
tar --exclude='./.git' --exclude='./node_modules' --exclude='./data' \
  -cf - -C "$ROOT" . | tar -xf - -C "$BROKEN"
printf 'throw new Error("intentional patch rollback test failure");\n' > "$BROKEN/server/index.js"
if env \
  -u AE_TLS -u AE_HTTP_PORT -u AE_DISCORD_URL -u AE_PORT -u AE_DATA \
  -u AE_DIR -u AE_SOURCE_FILE \
  HOME="$TEST_HOME" AE_HOME="$RUNTIME" AE_SOURCE_DIR="$BROKEN" AE_REBOOT=0 AE_NO_BOOT=1 AE_NO_JOB=1 \
  bash "$ROOT/scripts/termux-patch.sh" >"$TMP/patch-rollback.log" 2>&1; then
  echo 'expected the intentionally broken build to fail its health check' >&2
  exit 1
fi
grep -Fq 'the previous code will be restored' "$TMP/patch-rollback.log"
grep -Fq 'restoring the previous code tree' "$TMP/patch-rollback.log"
curl -fsS --max-time 5 "http://127.0.0.1:$PORT2/api/health" | grep -q '"ok":true'
grep -Fq 'AE Secure' "$APP/server/index.js"
[ "$(cat "$DATA/preserve-me.enc")" = "$SENTINEL" ]

# A valid custom TLS pair is install state too: an explicit path override must
# be saved, served over HTTPS, and never silently replaced by generated keys.
CUSTOM_TLS="$TMP/custom-tls"
TLS_DIR="$TMP/tls-runtime"
mkdir -p "$CUSTOM_TLS"
openssl req -x509 -nodes -newkey rsa:2048 -days 30 -sha256 \
  -keyout "$CUSTOM_TLS/key.pem" -out "$CUSTOM_TLS/cert.pem" \
  -subj '/CN=AE Secure patch test' \
  -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost' >/dev/null 2>&1
CERT_FINGERPRINT="$(openssl x509 -in "$CUSTOM_TLS/cert.pem" -noout -fingerprint -sha256)"
run_logged "$TMP/patch-tls.log" env \
  -u AE_SOURCE_DIR -u AE_SOURCE_FILE -u AE_DATA -u AE_DIR -u AE_DISCORD_URL \
  HOME="$TEST_HOME" AE_HOME="$RUNTIME" AE_TLS=1 AE_TLS_DIR="$TLS_DIR" \
  AE_TLS_CERT="$CUSTOM_TLS/cert.pem" AE_TLS_KEY="$CUSTOM_TLS/key.pem" AE_TLS_CA= \
  AE_HTTP_PORT=0 AE_REBOOT=0 AE_NO_BOOT=1 AE_NO_JOB=1 \
  bash "$ROOT/scripts/termux-patch.sh"
grep -Fxq 'AE_TLS="1"' "$RUNTIME/config.env"
grep -Fxq "AE_TLS_CERT=\"$CUSTOM_TLS/cert.pem\"" "$RUNTIME/config.env"
grep -Fxq "AE_TLS_KEY=\"$CUSTOM_TLS/key.pem\"" "$RUNTIME/config.env"
grep -Fq 'on your network: https://' "$TMP/patch-tls.log"
[ "$(openssl x509 -in "$CUSTOM_TLS/cert.pem" -noout -fingerprint -sha256)" = "$CERT_FINGERPRINT" ]
curl -kfsS --max-time 5 "https://127.0.0.1:$PORT2/api/health" | grep -q '"ok":true'
[ "$(cat "$DATA/preserve-me.enc")" = "$SENTINEL" ]

# Exercise the default reboot path without rebooting the test machine. Fake the
# Termux/API helpers, make each fail, and verify the script attempts its safe
# fallbacks before reporting the manual reboot command.
MOCK_BIN="$TMP/mock-bin"
MOCK_LOG="$TMP/reboot-attempts.log"
mkdir -p "$MOCK_BIN"
for helper in termux-reboot svc su; do
  cat > "$MOCK_BIN/$helper" <<'MOCK'
#!/usr/bin/env sh
printf '%s %s\n' "$(basename "$0")" "$*" >> "$MOCK_LOG"
exit 1
MOCK
  chmod +x "$MOCK_BIN/$helper"
done
run_logged "$TMP/patch-reboot-default.log" env \
  -u AE_REBOOT -u AE_TLS -u AE_TLS_DIR -u AE_TLS_CERT -u AE_TLS_KEY -u AE_TLS_CA \
  -u AE_SOURCE_DIR -u AE_SOURCE_FILE -u AE_DATA -u AE_DIR \
  HOME="$TEST_HOME" AE_HOME="$RUNTIME" AE_NO_BOOT=1 AE_NO_JOB=1 \
  TERMUX_VERSION=patch-test PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" \
  bash "$ROOT/scripts/termux-patch.sh"
grep -Fq 'Restarting the phone' "$TMP/patch-reboot-default.log"
grep -Fq 'no reboot helper succeeded' "$TMP/patch-reboot-default.log"
grep -Fq 'termux-reboot' "$MOCK_LOG"
grep -Fq 'svc power reboot' "$MOCK_LOG"
grep -Fq 'su -c reboot' "$MOCK_LOG"
curl -kfsS --max-time 5 "https://127.0.0.1:$PORT2/api/health" | grep -q '"ok":true'

printf 'Termux patch integration test passed (settings/data preserved, TLS retained, code replaced, rollback verified, default reboot path checked).\n'
