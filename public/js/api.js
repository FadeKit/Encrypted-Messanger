/* ============================================================================
   AE Secure — network layer
   Every request/response that carries user content is already encrypted by the
   caller; this module only moves ciphertext, tokens and counters.
   ========================================================================== */

const API = (() => {
  const TOKEN_KEY = 'ae.token';
  let token = null;
  let online = navigator.onLine;

  function setToken(value) {
    token = value || null;
    if (token) {
      try { localStorage.setItem(TOKEN_KEY, token); } catch { /* private mode */ }
    } else {
      try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
    }
  }

  function loadToken() {
    try { token = localStorage.getItem(TOKEN_KEY); } catch { token = null; }
    return token;
  }

  class ApiError extends Error {
    constructor(status, payload) {
      super((payload && (payload.error || payload.message)) || `Request failed (${status})`);
      this.status = status;
      this.code = payload && payload.code;
      this.payload = payload;
    }
  }

  async function request(method, path, body, options = {}) {
    // Traffic is announced to the console as method plus a route path. Query
    // strings are stripped here so no credential ever reaches the event bus.
    const route = String(path).split('?')[0];
    emit('api.request', { method, path: route });
    const headers = {};
    if (token) headers['x-ae-token'] = token;
    let payload;
    if (body instanceof Blob || body instanceof ArrayBuffer || body instanceof Uint8Array) {
      headers['Content-Type'] = 'application/octet-stream';
      payload = body;
    } else if (body !== undefined && body !== null) {
      if (options.form) {
        payload = body;
      } else {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
    }
    let response;
    try {
      response = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' });
    } catch (error) {
      online = false;
      emit('api.offline', { method, path: route });
      throw new ApiError(0, { error: 'Network unreachable — the server may be offline.', code: 'offline' });
    }
    online = true;
    if (!response.ok) emit('api.error', { method, path: route, status: response.status });
    const type = response.headers.get('content-type') || '';
    if (response.status === 204) return {};
    if (!type.includes('application/json')) {
      const buffer = await response.arrayBuffer();
      if (!response.ok) throw new ApiError(response.status, { error: 'Unexpected server response.' });
      return buffer;
    }
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401) setToken(null);
      throw new ApiError(response.status, data);
    }
    return data;
  }

  const get = (path) => request('GET', path);
  const post = (path, body) => request('POST', path, body === undefined ? {} : body);
  const patch = (path, body) => request('PATCH', path, body);
  const del = (path) => request('DELETE', path);
  const putRaw = (path, buffer) => request('PUT', path, buffer);

  // ------------------------------------------------------------- uploads
  /** Encrypts a Blob locally, then streams ciphertext chunks to the server. */
  async function uploadEncrypted(options) {
    const {
      kind, blob, wrapFileKey, meta = {}, ref = {}, onProgress = () => {}, label = 'upload',
      signal,
    } = options;
    const fileKeyRaw = await AE.generateAesRaw();
    const keyWrap = wrapFileKey ? await wrapFileKey(fileKeyRaw) : null;
    const init = await post('/api/files/init', {
      kind,
      size: blob.size,
      keyWrap,
      meta,
      ref,
    });
    const { fileId, chunks } = init;
    let sent = 0;
    for (let index = 0; index < chunks; index++) {
      if (signal && signal.aborted) throw new ApiError(0, { error: `${label} cancelled`, code: 'aborted' });
      const start = index * AE.CHUNK_PLAINTEXT;
      const slice = blob.slice(start, Math.min(blob.size, start + AE.CHUNK_PLAINTEXT));
      const plain = new Uint8Array(await slice.arrayBuffer());
      const sealed = await AE.encryptChunkKey(fileKeyRaw, plain, `ae-chunk:${fileId}:${index}`);
      await putRaw(`/api/files/${fileId}/chunk/${index}`, sealed);
      sent += plain.length;
      onProgress({ fileId, index, chunks, sent, total: blob.size, percent: Math.round((sent / blob.size) * 100) });
    }
    await post(`/api/files/${fileId}/complete`, {});
    return { fileId, fileKeyRaw, keyWrap, size: blob.size, chunks, init };
  }

  /** Downloads ciphertext chunks and decrypts them locally. */
  async function downloadDecrypted(fileId, { chunks, fileKeyRaw, mime = 'application/octet-stream', onProgress = () => {} }) {
    const parts = [];
    for (let index = 0; index < chunks; index++) {
      const buffer = await request('GET', `/api/files/${fileId}/chunk/${index}`);
      const plain = await AE.decryptChunkKey(fileKeyRaw, buffer, `ae-chunk:${fileId}:${index}`);
      parts.push(plain);
      onProgress({ index, chunks, percent: Math.round(((index + 1) / chunks) * 100) });
    }
    return new Blob(parts, { type: mime });
  }

  // --------------------------------------------------------------- events
  const listeners = new Map();
  let source = null;
  let reconnectTimer = null;
  let reconnectDelay = 1200;

  function on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => listeners.get(event).delete(handler);
  }

  function emit(event, payload) {
    for (const handler of listeners.get(event) || []) {
      try { handler(payload); } catch (error) { console.error('[ae] listener error', event, error); }
    }
    for (const handler of listeners.get('*') || []) {
      try { handler({ event, payload }); } catch (error) { console.error('[ae] listener error', error); }
    }
  }

  function connect(channels = 'user,presence,feed,click,public,global') {
    if (source) source.close();
    if (!token) return;
    const url = `/api/stream?channels=${encodeURIComponent(channels)}&token=${encodeURIComponent(token)}`;
    source = new EventSource(url);
    source.addEventListener('ready', (event) => {
      reconnectDelay = 1200;
      emit('ready', safeParse(event.data));
    });
    const names = ['message', 'message.updated', 'presence', 'presence.changed', 'typing', 'read', 'click', 'feed', 'stories.changed', 'public.changed', 'public.presence', 'forum.changed', 'global', 'notify', 'admin', 'neural', 'airdrop', 'dmcode', 'dmcode.redeemed', 'session.killed', 'account.updated', 'request.decision', 'storage', 'conversation.created', 'conversation.updated', 'conversation.removed', 'conversation.keys', 'users.changed'];
    for (const name of names) {
      source.addEventListener(name, (event) => emit(name, safeParse(event.data)));
    }
    source.onmessage = (event) => emit('message', safeParse(event.data));
    source.onerror = () => {
      emit('disconnected', {});
      if (source) source.close();
      source = null;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => connect(channels), reconnectDelay);
      reconnectDelay = Math.min(15000, reconnectDelay * 1.6);
    };
  }

  function safeParse(text) {
    try { return JSON.parse(text); } catch { return text; }
  }

  function disconnect() {
    clearTimeout(reconnectTimer);
    if (source) { source.close(); source = null; }
  }

  return {
    ApiError,
    setToken,
    loadToken,
    get token() { return token; },
    get online() { return online; },
    request, get, post, patch, del,
    uploadEncrypted,
    downloadDecrypted,
    on, emit, connect, disconnect,
    get connected() { return !!source; },
  };
})();

window.API = API;
