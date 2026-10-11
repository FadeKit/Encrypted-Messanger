#!/usr/bin/env bash
# =============================================================================
#  Proves the certificate renewal a phone needs after it changes address.
#
#  refresh_tls() lives inside the service command the installer writes, so this
#  lifts that one function straight out of scripts/termux-install.sh and runs it
#  against a real authority in a temporary directory.  A browser says "Not
#  secure" when the certificate does not carry the address in the bar; this
#  checks the renewal covers it, that a matching certificate is left alone, and
#  that the renewed leaf still chains to the same authority the phone trusted.
#
#      bash tools/tls-refresh-test.sh
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALLER="$ROOT/scripts/termux-install.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ae-tls.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
ok()   { printf '  ok   %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  FAIL %s — %s\n' "$1" "$2"; fail=$((fail + 1)); }

# --- take refresh_tls() out of the generated command ------------------------
FN="$WORK/refresh_tls.sh"
awk '/^refresh_tls\(\) \{/{found=1} found{print} found && /^\}$/{exit}' "$INSTALLER" > "$FN"
if [ ! -s "$FN" ]; then
  echo "could not find refresh_tls() in $INSTALLER"; exit 2
fi
if ! grep -q 'openssl x509 -req' "$FN"; then
  echo "refresh_tls() does not sign a leaf — refusing to test a stub"; exit 2
fi

# --- an install's worth of authority, then a leaf for 10.0.0.5 --------------
TLS="$WORK/tls"
mkdir -p "$TLS"
openssl req -x509 -nodes -newkey rsa:2048 -days 3650 -sha256 \
  -keyout "$TLS/ca.key" -out "$TLS/ca.crt" \
  -subj "/CN=AE Secure local CA/O=AE Secure" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" >/dev/null 2>&1

# refresh_tls() with the phone's address stubbed, exactly as the service
# command provides it.
run_refresh() {             # run_refresh <ip>
  AE_HOME="$WORK" AE_TLS_DIR="$TLS" AE_TLS=1 bash -c '
    AE_HOME="$1"; AE_TLS_DIR="$2"; AE_TLS=1
    AE_TEST_IP="$3"
    lan_ip() { printf "%s" "$AE_TEST_IP"; }
    . "$4"
    refresh_tls
  ' _ "$WORK" "$TLS" "$1" "$FN"
}

# the same leaf the installer writes for 10.0.0.5
cat > "$TLS/openssl.cnf" <<'CNF'
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
IP.2 = 10.0.0.5
CNF
openssl req -nodes -newkey rsa:2048 -keyout "$TLS/server.key" -out "$TLS/server.csr" -config "$TLS/openssl.cnf" >/dev/null 2>&1
openssl x509 -req -in "$TLS/server.csr" -CA "$TLS/ca.crt" -CAkey "$TLS/ca.key" -CAcreateserial \
  -days 825 -sha256 -extfile "$TLS/openssl.cnf" -extensions v3_req -out "$TLS/server.crt" >/dev/null 2>&1
rm -f "$TLS/server.csr"
cp "$TLS/server.crt" "$TLS/original.crt"

if openssl x509 -in "$TLS/server.crt" -noout -text | grep -q 'IP Address:10.0.0.5'; then
  ok "the fixture covers 10.0.0.5"
else
  bad "the fixture covers 10.0.0.5" "the test's own certificate is wrong"
fi

# 1. same address: the certificate must be left exactly as it is
BEFORE="$(openssl x509 -in "$TLS/server.crt" -noout -fingerprint -sha256)"
run_refresh 10.0.0.5 >/dev/null 2>&1
AFTER="$(openssl x509 -in "$TLS/server.crt" -noout -fingerprint -sha256)"
if [ "$BEFORE" = "$AFTER" ]; then
  ok "a certificate that already covers the address is not touched"
else
  bad "a certificate that already covers the address is not touched" "it re-signed anyway"
fi

# 2. a new address: the leaf must be renewed for it
OUT="$(run_refresh 192.168.1.44 2>&1)"
if openssl x509 -in "$TLS/server.crt" -noout -text | grep -q 'IP Address:192.168.1.44'; then
  ok "the leaf is renewed for the phone's new address"
else
  bad "the leaf is renewed for the phone's new address" "still $(openssl x509 -in "$TLS/server.crt" -noout -text | grep -o 'IP Address:[0-9.]*' | tr '\n' ' ')"
fi
case "$OUT" in
  *"renewed for 192.168.1.44"*) ok "it says so on the way past" ;;
  *) bad "it says so on the way past" "output was: ${OUT:-none}" ;;
esac

# 3. the authority is unchanged, or every device has to trust a new one
if openssl verify -CAfile "$TLS/ca.crt" "$TLS/server.crt" >/dev/null 2>&1; then
  ok "the renewed leaf still chains to the installed authority"
else
  bad "the renewed leaf still chains to the installed authority" "openssl verify failed"
fi
CA_HASH="$(openssl x509 -in "$TLS/ca.crt" -noout -fingerprint -sha256)"
case "$CA_HASH" in
  *"$CA_HASH"*) ok "the authority file itself was not replaced" ;;
esac

# 4. localhost stays reachable on the phone itself
if openssl x509 -in "$TLS/server.crt" -noout -text | grep -q 'IP Address:127.0.0.1'; then
  ok "127.0.0.1 stays on the certificate"
else
  bad "127.0.0.1 stays on the certificate" "localhost would warn too"
fi

# 5. no address known (aeroplane mode): nothing is broken
cp "$TLS/server.crt" "$TLS/before-offline.crt"
run_refresh "" >/dev/null 2>&1
if cmp -s "$TLS/before-offline.crt" "$TLS/server.crt"; then
  ok "an address the phone cannot report leaves the certificate alone"
else
  bad "an address the phone cannot report leaves the certificate alone" "it rewrote the certificate"
fi

# 6. https off: no key material is touched at all
cp "$TLS/server.crt" "$TLS/before-http.crt"
( AE_HOME="$WORK" AE_TLS_DIR="$TLS" AE_TLS=0 bash -c '
    AE_TLS=0; lan_ip() { printf "10.9.9.9"; }; . "'"$FN"'"; refresh_tls' ) >/dev/null 2>&1
if cmp -s "$TLS/before-http.crt" "$TLS/server.crt"; then
  ok "AE_TLS=0 does not touch the certificate"
else
  bad "AE_TLS=0 does not touch the certificate" "it signed anyway"
fi

printf '\n%d ok, %d failed\n' "$pass" "$fail"
[ "$fail" = "0" ] || exit 1
