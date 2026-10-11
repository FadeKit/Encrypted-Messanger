/* ============================================================================
   AE Secure — client state, key custody and decryption helpers
   ========================================================================== */

const State = (() => {
  const listeners = new Map();
  const channelKeyCache = new Map();
  const channelRawCache = new Map();
  const decryptedCache = new Map();
  const objectUrls = new Set();

  const store = {
    boot: null,
    user: null,
    session: null,
    vault: null,          // { masterKey (raw b64), identityPrivate, identityPublic }
    masterKey: null,      // CryptoKey for local-only encryption
    conversations: [],
    activeConversationId: null,
    messages: new Map(),  // conversationId -> [message]
    forums: [],
    activeForumId: null,
    threads: [],
    posts: new Map(),
    stories: [],
    publicFeed: { posts: [], people: [] },
    driveFiles: [],
    files: [],
    airdrops: [],
    airdropCount: 0,
    requests: [],
    presence: {},
    sessions: [],
    clicker: { total: 0, week: 0, mine: 0 },
    admins: [],
    unread: { total: 0, byConversation: {} },
    locked: false,
  };

  function get(key) { return store[key]; }
  function snapshot() { return store; }

  function set(key, value) {
    store[key] = value;
    emit(key, value);
    emit('*', { key, value });
    return value;
  }

  function patch(partial) {
    for (const [key, value] of Object.entries(partial)) set(key, value);
  }

  function subscribe(key, handler) {
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(handler);
    return () => listeners.get(key).delete(handler);
  }

  function emit(key, value) {
    // Iterate a copy.  A handler that subscribes while it runs would otherwise
    // be visited by this same loop, and a handler that re-subscribes itself
    // (a render function that subscribes on every paint) turns one state change
    // into an endless loop — the tab stops responding entirely.
    for (const handler of [...(listeners.get(key) || [])]) {
      try { handler(value, key); } catch (error) { console.error('[ae] state listener', key, error); }
    }
  }

  // ------------------------------------------------------------ settings
  const DEFAULT_SETTINGS = {
    theme: 'nox', accent: 'ink', glass: 100, blur: 0, cornerRadius: 0, wallpaper: 'theme',
    // The site theme restyles the page itself, independently of the colour
    // ramp; `ink` is the house style this build ships with.
    siteTheme: 'ink',
    // An uploaded desktop picture: the library, the one in use, and how it is
    // drawn.  The files are encrypted like everything else.
    backgrounds: [], wallpaperFileId: null, wallpaperFit: 'cover', wallpaperDim: 25, wallpaperTone: true,
    // Whether this account follows the operator's published site appearance or
    // keeps its own choices.
    appearanceSource: 'site',
    density: 'comfortable', fontScale: 1, animations: true, reduceMotion: false,
    highContrast: false, dyslexiaFont: false, lineHeight: 1.45, colorBlind: 'none',
    focusRing: true, uiSounds: false, notificationToasts: true, desktopNotifications: false,
    timestamps: 'relative', enterToSend: true, autoLockMinutes: 30, rememberUnlockInTab: true,
    hideMessagePreviews: false, activityStatus: true, storyAutoplay: true, forumMedia: false,
    airdrop: false, airdropSound: false, disabledFeatures: {}, disabledMenus: [],
    customCss: '',
    layout: { order: ['messages', 'communities', 'stories', 'drive', 'files', 'airdrop'], hidden: [], sidebarCompact: false, showKarmaSelf: false },
  };

  function settings() {
    return Object.assign(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), store.user ? store.user.settings || {} : {});
  }

  function featureEnabled(key) {
    const config = settings().disabledFeatures || {};
    return config[key] !== true;
  }

  function menuHidden(id) {
    const layout = settings().layout || {};
    return (layout.hidden || []).includes(id) || (settings().disabledMenus || []).includes(id);
  }

  async function saveSettings(patchValue) {
    if (!store.user) return null;
    try {
      const result = await API.patch('/api/settings', { settings: patchValue });
      store.user.settings = result.settings;
      emit('user', store.user);
      return result.settings;
    } catch (error) {
      UI.toast({ level: 'danger', title: 'Could not save settings', body: error.message });
      throw error;
    }
  }

  // ---------------------------------------------------------- key custody
  function masterKey() { return store.masterKey; }

  async function unlock(vaultPlain, kdf) {
    store.vault = vaultPlain;
    store.masterKey = await AE.importAes(AE.b64decode(vaultPlain.masterKey));
    channelKeyCache.clear();
    if (kdf && settings().rememberUnlockInTab) {
      try { sessionStorage.setItem('ae.unlock', JSON.stringify({ vaultKey: kdf, at: Date.now() })); } catch { /* ignore */ }
    }
    emit('unlocked', true);
  }

  function lock() {
    store.vault = null;
    store.masterKey = null;
    // Wallpaper pixels are decrypted with the vault key, so remove their live
    // render as soon as the tab locks (sign-out also calls reset below).
    if (typeof Background !== 'undefined' && Background.reset) Background.reset();
    channelKeyCache.clear();
    channelRawCache.clear();
    decryptedCache.clear();
    try { sessionStorage.removeItem('ae.unlock'); } catch { /* ignore */ }
    emit('locked', true);
  }

  function cachedUnlock() {
    try { return JSON.parse(sessionStorage.getItem('ae.unlock') || 'null'); } catch { return null; }
  }

  function clearSession() {
    // The desktop picture is this account's; it goes with the session, not with
    // the browser.  Background is optional so this module keeps working alone.
    if (typeof Background !== 'undefined' && Background.reset) Background.reset();
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls.clear();
    channelKeyCache.clear();
    channelRawCache.clear();
    decryptedCache.clear();
    store.user = null;
    store.session = null;
    store.vault = null;
    store.masterKey = null;
    try { sessionStorage.removeItem('ae.unlock'); } catch { /* ignore */ }
  }

  // ------------------------------------------------------ channel keys
  function memberById(conversation, id) {
    return (conversation.members || []).find((member) => member.id === id) || null;
  }

  /** Unwraps (and caches) the AES key protecting a channel or community. */
  async function channelKey(conversation, context) {
    if (!conversation || !conversation.keyWrap) return null;
    const cacheKey = `${context}:${conversation.id}`;
    if (channelKeyCache.has(cacheKey)) return channelKeyCache.get(cacheKey);
    try {
      const payload = JSON.parse(conversation.keyWrap);
      const sender = memberById(conversation, payload.by) || { identityPublic: payload.pub };
      if (!sender || !sender.identityPublic) return null;
      const shared = await AE.deriveSharedKey(store.vault.identityPrivate, sender.identityPublic, `${context}:${conversation.id}`);
      const raw = await AE.unwrapKey(shared, payload.w);
      if (!raw) return null;
      const key = await AE.importAes(raw);
      channelKeyCache.set(cacheKey, key);
      channelRawCache.set(cacheKey, raw);
      return key;
    } catch (error) {
      console.warn('[ae] channel key unavailable', error);
      return null;
    }
  }

  /** Raw bytes of the channel key — needed to wrap it for new members. */
  async function channelKeyRaw(context, conversation) {
    if (!conversation) return null;
    const cacheKey = `${context}:${conversation.id}`;
    if (channelRawCache.has(cacheKey)) return channelRawCache.get(cacheKey);
    await channelKey(conversation, context);
    return channelRawCache.get(cacheKey) || null;
  }

  async function wrapChannelKey(context, conversationId, rawKey, peerPublic) {
    const shared = await AE.deriveSharedKey(store.vault.identityPrivate, peerPublic, `${context}:${conversationId}`);
    // `pub` makes the wrap self-describing: a recipient can rebuild the shared
    // secret even when the wrapping account is masked (operator channels).
    return JSON.stringify({ by: store.user.id, pub: store.user.identityPublic, w: await AE.wrapKey(shared, rawKey) });
  }

  /** Wraps a file key with the channel key so every member can open the file. */
  async function wrapFileKeyWithChannel(conversation, rawFileKey) {
    const key = await channelKey(conversation, conversation.type === 'group' || conversation.type === 'dm' ? 'conv' : 'forum');
    if (!key) throw new Error('Channel key unavailable — reopen the conversation.');
    return AE.wrapKey(key, rawFileKey);
  }

  /* -------------------------------------------------------------- operator
     The account that runs this server holds a second copy of every key, sealed
     for its public identity with ECDH.  A device writes these envelopes; only
     the operator's own device, holding the private half, can open one.  The
     server stores ciphertext either way.
  */
  let operatorPromise = null;

  function operatorIdentity() {
    if (!operatorPromise) {
      operatorPromise = API.get('/api/operator-key')
        .then((payload) => (payload && payload.operator) || null)
        .catch(() => null);
    }
    return operatorPromise;
  }

  /** Seals raw key bytes for the operator identity. Returns null when there is none. */
  async function sealForOperator(domain, rawKey, context) {
    if (!rawKey) return null;
    try {
      const operator = await operatorIdentity();
      if (!operator || !operator.identityPublic) return null;
      const tag = AE.randomB64(12).replace(/\W/g, '');
      const scope = `${context || domain}:${tag}`;
      const shared = await AE.deriveSharedKey(store.vault.identityPrivate, operator.identityPublic, scope);
      return JSON.stringify({
        v: 1, domain, scope,
        by: store.user.id,
        pub: store.user.identityPublic,
        w: await AE.wrapKey(shared, rawKey),
      });
    } catch (error) {
      console.warn('[ae] operator envelope could not be written', error);
      return null;
    }
  }

  /** The operator's side of the same envelope: raw key bytes, or null. */
  async function openOperatorWrap(envelope, domain) {
    if (!envelope) return null;
    try {
      const parsed = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
      if (!parsed || parsed.v !== 1) return null;
      if (domain && parsed.domain && parsed.domain !== domain) return null;
      if (!parsed.pub || !parsed.w || !parsed.scope) return null;
      const shared = await AE.deriveSharedKey(store.vault.identityPrivate, parsed.pub, parsed.scope);
      return await AE.unwrapKey(shared, parsed.w);
    } catch (error) {
      console.warn('[ae] operator envelope could not be opened', error);
      return null;
    }
  }

  async function unwrapFileKey(conversation, fileKeyWrap, contextPreference) {
    const contexts = contextPreference ? [contextPreference] : ['conv', 'forum'];
    for (const context of contexts) {
      const key = await channelKey(conversation, context);
      if (!key) continue;
      const raw = await AE.unwrapKey(key, fileKeyWrap);
      if (raw) return raw;
    }
    return null;
  }

  function registerObjectUrl(url) { objectUrls.add(url); return url; }
  function releaseObjectUrl(url) {
    if (!url) return;
    URL.revokeObjectURL(url);
    objectUrls.delete(url);
  }

  return {
    get, set, patch, subscribe, snapshot, emit,
    DEFAULT_SETTINGS, settings, saveSettings, featureEnabled, menuHidden,
    masterKey, unlock, lock, cachedUnlock, clearSession,
    channelKey, channelKeyRaw, wrapChannelKey, memberById,
    wrapFileKeyWithChannel, unwrapFileKey,
    operatorIdentity, sealForOperator, openOperatorWrap,
    registerObjectUrl, releaseObjectUrl, registerPublicUrl: registerObjectUrl,
    get user() { return store.user; },
    get vault() { return store.vault; },
  };
})();

window.State = State;

/* ---------------------------------------------------------------- media */
const Media = (() => {
  const pending = new Map();

  function keyWrapForFile(file) { return file && file.keyWrap; }

  async function loadEncryptedImage(fileId, chunks, fileKeyRaw, mime) {
    const cacheId = `${fileId}:${fileKeyRaw.length}`;
    if (pending.has(cacheId)) return pending.get(cacheId);
    const promise = (async () => {
      const blob = await API.downloadDecrypted(fileId, { chunks, fileKeyRaw, mime });
      const url = URL.createObjectURL(blob);
      State.registerObjectUrl(url);
      return url;
    })().catch((error) => {
      console.warn('[ae] media load failed', error);
      return null;
    });
    pending.set(cacheId, promise);
    return promise;
  }

  const avatarUrls = new Map();

  async function loadAvatar(fileId) {
    if (!fileId) return null;
    if (avatarUrls.has(fileId)) return avatarUrls.get(fileId);
    try {
      const info = await API.get(`/api/files/${fileId}`);
      const file = info.file;
      if (!file || !file.keyWrap) return null;
      const raw = await AE.unwrapKey(State.masterKey(), file.keyWrap);
      if (!raw) return null;
      const blob = await API.downloadDecrypted(file.id, { chunks: file.chunks, fileKeyRaw: raw, mime: 'image/*' });
      const url = URL.createObjectURL(blob);
      State.registerObjectUrl(url);
      avatarUrls.set(fileId, url);
      return url;
    } catch {
      return null;
    }
  }

  /**
   * Decrypts an uploaded text file into a string, for the editor.  Returns null
   * when the key cannot be unwrapped rather than throwing: a file you do not own
   * simply is not editable.
   */
  async function loadTextFile(file) {
    if (!file) return null;
    try {
      const raw = await resolveFileKey(file);
      if (!raw) return null;
      const blob = await API.downloadDecrypted(file.id, {
        chunks: file.chunks,
        fileKeyRaw: raw,
        mime: (file.meta && file.meta.type) || 'text/plain',
      });
      return await blob.text();
    } catch {
      return null;
    }
  }

  /**
   * A file's own name, when it was saved by the editor: the name travels sealed
   * with the file key, so only this device can read it.  Returns null when the
   * file has no sealed name or when the key is not ours.
   */
  async function fileName(file, rawKey) {
    if (!file || !file.meta || !file.meta.nameWrapped) return null;
    try {
      const raw = rawKey || await resolveFileKey(file);
      if (!raw) return null;
      const plain = await AE.openSealedJson(raw, file.meta.nameWrapped);
      return (plain && typeof plain.name === 'string' && plain.name) || null;
    } catch {
      return null;
    }
  }

  async function resolveFileKey(file) {
    if (!file) return null;
    if (file.ownerId === State.user.id) {
      const raw = await AE.unwrapKey(State.masterKey(), file.keyWrap);
      if (raw) return raw;
    }
    return null;
  }

  return { loadEncryptedImage, loadAvatar, loadTextFile, fileName, resolveFileKey, keyWrapForFile };
})();

window.Media = Media;
