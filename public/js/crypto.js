/* ============================================================================
   AE Secure — client cryptography
   ----------------------------------------------------------------------------
   Everything sensitive is sealed in the browser before it is ever handed to
   the network layer:

     • passphrase  →  PBKDF2-SHA256 (two independent salts)
                      authKey  (travels to the server to prove identity)
                      vaultKey (never leaves the device)
     • vault       →  AES-GCM(vaultKey, {masterKey, identityPrivateKey})
     • identity    →  ECDH P-256 key pair, private half sealed in the vault
     • channels    →  per-conversation AES-GCM-256 key wrapped with an
                      ECDH-derived key for every participant
     • media       →  per-file AES-GCM-256 key, 512 KiB chunks, per-chunk IV,
                      chunk index bound as additional authenticated data
   ========================================================================== */

const AE = (() => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const subtle = crypto.subtle;
  const CHUNK_PLAINTEXT = 512 * 1024;
  const IV_BYTES = 12;

  // ------------------------------------------------------------- encoding
  function b64encode(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let out = '';
    const step = 0x8000;
    for (let i = 0; i < view.length; i += step) {
      out += String.fromCharCode.apply(null, view.subarray(i, i + step));
    }
    return btoa(out);
  }

  function b64decode(value) {
    if (!value) return new Uint8Array(0);
    const binary = atob(String(value));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function utf8(value) { return enc.encode(value); }
  function fromUtf8(bytes) { return dec.decode(bytes); }
  function randomBytes(length) {
    const out = new Uint8Array(length);
    crypto.getRandomValues(out);
    return out;
  }
  function randomB64(length) { return b64encode(randomBytes(length)); }

  function concat(...arrays) {
    const total = arrays.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of arrays) { out.set(part, offset); offset += part.length; }
    return out;
  }

  // -------------------------------------------------------------- hashing
  async function sha256(bytes) {
    return new Uint8Array(await subtle.digest('SHA-256', bytes));
  }

  async function pbkdf2(passphrase, salt, iterations = 210000, bits = 256) {
    const material = await subtle.importKey('raw', typeof passphrase === 'string' ? utf8(passphrase) : passphrase, 'PBKDF2', false, ['deriveBits']);
    const derived = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: typeof salt === 'string' ? b64decode(salt) : salt, iterations }, material, bits);
    return new Uint8Array(derived);
  }

  async function hkdf(inputBytes, saltBytes, info, bits = 256) {
    const material = await subtle.importKey('raw', inputBytes, 'HKDF', false, ['deriveBits']);
    const derived = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info: info ? utf8(info) : new Uint8Array(0) }, material, bits);
    return new Uint8Array(derived);
  }

  // ------------------------------------------------------------ symmetric
  async function importAes(rawBytes) {
    return subtle.importKey('raw', rawBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async function generateAesRaw() { return randomBytes(32); }

  async function encrypt(key, data, aad) {
    const iv = randomBytes(IV_BYTES);
    const params = { name: 'AES-GCM', iv };
    if (aad) params.additionalData = typeof aad === 'string' ? utf8(aad) : aad;
    const cipher = await subtle.encrypt(params, key, data);
    return { iv: b64encode(iv), ct: b64encode(new Uint8Array(cipher)) };
  }

  async function decrypt(key, payload, aad) {
    if (!payload || !payload.iv || !payload.ct) return null;
    const params = { name: 'AES-GCM', iv: b64decode(payload.iv) };
    if (aad) params.additionalData = typeof aad === 'string' ? utf8(aad) : aad;
    const plain = await subtle.decrypt(params, key, b64decode(payload.ct));
    return new Uint8Array(plain);
  }

  async function decryptText(key, payload, aad) {
    const bytes = await decrypt(key, payload, aad);
    return bytes ? fromUtf8(bytes) : null;
  }

  async function encryptJson(key, object, aad) {
    return encrypt(key, utf8(JSON.stringify(object)), aad);
  }

  async function decryptJson(key, payload, aad) {
    const text = await decryptText(key, payload, aad);
    if (text === null) return null;
    try { return JSON.parse(text); } catch { return null; }
  }

  /** Wrapping a raw key: iv is prepended to the ciphertext and base64 encoded. */
  async function wrapKey(wrappingKey, rawKey, aad) {
    const sealed = await encrypt(wrappingKey, rawKey, aad);
    return `${sealed.iv}.${sealed.ct}`;
  }

  async function unwrapKey(wrappingKey, wrapped, aad) {
    if (!wrapped || !wrapped.includes('.')) return null;
    const [iv, ct] = wrapped.split('.');
    return decrypt(wrappingKey, { iv, ct }, aad);
  }

  /** Streaming-safe AES-GCM over a chunk: returns iv || ciphertext. */
  async function encryptChunkKey(rawFileKey, bytes, aad) {
    const key = await importAes(rawFileKey);
    const iv = randomBytes(IV_BYTES);
    const params = { name: 'AES-GCM', iv };
    if (aad) params.additionalData = typeof aad === 'string' ? utf8(aad) : aad;
    const cipher = new Uint8Array(await subtle.encrypt(params, key, bytes));
    return concat(iv, cipher);
  }

  async function decryptChunkKey(rawFileKey, buffer, aad) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const iv = bytes.subarray(0, IV_BYTES);
    const body = bytes.subarray(IV_BYTES);
    const key = await importAes(rawFileKey);
    const params = { name: 'AES-GCM', iv };
    if (aad) params.additionalData = typeof aad === 'string' ? utf8(aad) : aad;
    const plain = await subtle.decrypt(params, key, body);
    return new Uint8Array(plain);
  }

  // ---------------------------------------------------------- identity keys
  async function generateIdentity() {
    const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const publicRaw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
    const privatePkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
    return { publicRaw: b64encode(publicRaw), privatePkcs8: b64encode(privatePkcs8) };
  }

  async function importPublic(rawB64) {
    return subtle.importKey('raw', b64decode(rawB64), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  }

  async function importPrivate(pkcs8B64) {
    return subtle.importKey('pkcs8', b64decode(pkcs8B64), { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  }

  /** Shared AES key between two accounts, salted with the channel identifier. */
  async function deriveSharedKey(privatePkcs8B64, peerPublicRawB64, context) {
    const privateKey = await importPrivate(privatePkcs8B64);
    const peerKey = await importPublic(peerPublicRawB64);
    const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: peerKey }, privateKey, 256));
    const derived = await hkdf(shared, utf8(`ae-secure|${context}`), 'ae-secure-channel-v1');
    return importAes(derived);
  }

  // ---------------------------------------------------------------- vault
  async function createVault(password, username, options = {}) {
    const iterations = options.iterations || 210000;
    const authSalt = randomBytes(16);
    const vaultSalt = randomBytes(16);
    const authKey = await pbkdf2(`ae-auth|${username}|${password}`, authSalt, iterations);
    const vaultKey = await pbkdf2(`ae-vault|${username}|${password}`, vaultSalt, iterations);
    const identity = await generateIdentity();
    const masterKey = randomBytes(32);
    const vault = {
      v: 1,
      masterKey: b64encode(masterKey),
      identityPrivate: identity.privatePkcs8,
      identityPublic: identity.publicRaw,
      username,
      createdAt: Date.now(),
    };
    const sealed = await encryptJson(await importAes(vaultKey), vault);
    return {
      sealed: JSON.stringify(sealed),
      vaultPlain: vault,
      authKey: b64encode(authKey),
      authSalt: b64encode(authSalt),
      vaultSalt: b64encode(vaultSalt),
      iterations,
      identityPublic: identity.publicRaw,
      vault: JSON.stringify(sealed),
      masterKey,
      identityPrivate: identity.privatePkcs8,
      identityPublicRaw: identity.publicRaw,
    };
  }

  async function unlockVault(password, username, kdf) {
    const authKey = await pbkdf2(`ae-auth|${username}|${password}`, b64decode(kdf.authSalt), kdf.iterations);
    return { authKey, authKeyB64: b64encode(authKey) };
  }

  async function openVault(password, username, kdf, sealedVault) {
    const vaultKey = await pbkdf2(`ae-vault|${username}|${password}`, b64decode(kdf.vaultSalt), kdf.iterations);
    const payload = typeof sealedVault === 'string' ? JSON.parse(sealedVault) : sealedVault;
    const vault = await decryptJson(await importAes(vaultKey), payload);
    if (!vault) throw new Error('Unable to unlock the key vault with that passphrase.');
    return vault;
  }

  // ----------------------------------------------------- recovery material
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function generateRecoveryCode() {
    const bytes = randomBytes(26);
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return `${out.slice(0, 5)}-${out.slice(5, 10)}-${out.slice(10, 15)}-${out.slice(15, 20)}-${out.slice(20, 26)}`;
  }

  /** proof travels to the server (hashed again there); key material never does. */
  async function recoveryProof(code, serverSalt) {
    const normalized = code.replace(/[\s-]/g, '').toUpperCase();
    const proof = await pbkdf2(`ae-recovery-proof|${normalized}`, b64decode(serverSalt), 120000);
    return b64encode(proof);
  }

  async function recoveryWrap(code, username, index, vaultPlain) {
    const normalized = code.replace(/[\s-]/g, '').toUpperCase();
    const keyBytes = await pbkdf2(`ae-recovery-wrap|${username}|${index}|${normalized}`, utf8(`ae-secure-recovery|${username}|${index}`), 150000);
    return JSON.stringify(await encryptJson(await importAes(keyBytes), vaultPlain));
  }

  async function recoveryUnwrap(code, username, index, wrapped) {
    const normalized = code.replace(/[\s-]/g, '').toUpperCase();
    const keyBytes = await pbkdf2(`ae-recovery-wrap|${username}|${index}|${normalized}`, utf8(`ae-secure-recovery|${username}|${index}`), 150000);
    return decryptJson(await importAes(keyBytes), typeof wrapped === 'string' ? JSON.parse(wrapped) : wrapped);
  }

  // ----------------------------------------------------------- public keys
  /** Deterministic public audience key: readable by every signed-in account. */
  async function audienceKey(seedB64, context) {
    const seed = b64decode(seedB64);
    return importAes(await hkdf(seed, utf8(`ae-public|${context}`), 'ae-secure-public-v1'));
  }

  function fingerprint(publicRawB64) {
    const bytes = b64decode(publicRawB64);
    let hash = 0;
    for (const byte of bytes) hash = (hash * 31 + byte) % 0xffffffffff;
    return hash.toString(16).padStart(10, '0').toUpperCase().match(/.{5}/g).join(' ');
  }

  return {
    CHUNK_PLAINTEXT,
    b64encode,
    b64decode,
    utf8,
    fromUtf8,
    randomBytes,
    randomB64,
    concat,
    sha256,
    pbkdf2,
    hkdf,
    importAes,
    generateAesRaw,
    encrypt,
    decrypt,
    encryptText: (key, text, aad) => encrypt(key, utf8(text), aad),
    decryptText,
    encryptJson,
    decryptJson,
    wrapKey,
    unwrapKey,
    encryptChunkKey,
    decryptChunkKey,
    generateIdentity,
    importPublic,
    importPrivate,
    deriveSharedKey,
    createVault,
    unlockVault,
    openVault,
    generateRecoveryCode,
    recoveryProof,
    recoveryWrap,
    recoveryUnwrap,
    audienceKey,
    fingerprint,
  };
})();

if (typeof window !== 'undefined') window.AE = AE;
