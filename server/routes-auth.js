'use strict';

const crypto = require('crypto');
const { store, DEFAULT_LIMITS } = require('./store');
const { realtime } = require('./realtime');
const {
  fail, sendJson, readJson, requireAuth, requireAdmin, selfView, publicUser,
  limitLabel, notifyAdmins, isAdmin,
} = require('./helpers');
const { now, humanCode, sha256, sanitizeText, sanitizeHandle, isoWeek, RateLimiter, clampNumber } = require('./util');

const loginLimiter = new RateLimiter({ points: 10, windowMs: 60000, blockMs: 60000 });
const registerLimiter = new RateLimiter({ points: 5, windowMs: 300000, blockMs: 120000 });
const actionLimiter = new RateLimiter({ points: 60, windowMs: 60000 });
// The click counter is a gag, so it gets its own budget: the shared limiter
// charged three points a click, which capped one person at twenty clicks a
// minute and made the counter look broken.
const clickLimiter = new RateLimiter({ points: 1200, windowMs: 60000 });
const U = { UNLIMITED: -1 };

function scryptHex(value, salt, len = 32) {
  return crypto.scryptSync(String(value), String(salt), len).toString('hex');
}

function verifyScrypt(value, salt, expected) {
  const candidate = scryptHex(value, salt);
  const a = Buffer.from(candidate);
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function makeSession(user, ctx, extra = {}) {
  const ua = String(ctx.req.headers['user-agent'] || '');
  const device = detectDevice(ua);
  const session = store.createSession(user.id, Object.assign({
    device,
    platform: platformOf(ua),
    ip: ctx.ip,
    ua: ua.slice(0, 240),
  }, extra));
  user.history.lastAuthAt = now();
  store.touch();
  return session;
}

function detectDevice(ua) {
  if (!ua) return 'Unknown device';
  if (/android/i.test(ua)) return /tablet|tab/i.test(ua) ? 'Android tablet' : 'Android phone';
  if (/iphone|ipad|ipod/i.test(ua)) return /ipad/i.test(ua) ? 'iPad' : 'iPhone';
  if (/windows/i.test(ua)) return 'Windows PC';
  if (/macintosh|mac os/i.test(ua)) return 'Mac';
  if (/linux/i.test(ua)) return 'Linux desktop';
  return 'Browser';
}

function platformOf(ua) {
  if (/edg\//i.test(ua)) return 'Microsoft Edge';
  if (/opr\//i.test(ua)) return 'Opera';
  if (/firefox\//i.test(ua)) return 'Firefox';
  if (/chrome\//i.test(ua)) return 'Chrome';
  if (/safari\//i.test(ua)) return 'Safari';
  return 'Web';
}

function codename() {
  const adjectives = ['silent', 'amber', 'crimson', 'quiet', 'nova', 'lunar', 'iron', 'velvet', 'cobalt', 'hollow', 'static', 'ember', 'onyx', 'violet', 'frost', 'drift', 'gilded', 'arc'];
  const nouns = ['otter', 'falcon', 'cipher', 'harbor', 'beacon', 'kestrel', 'lattice', 'summit', 'quarry', 'meridian', 'cascade', 'thistle', 'aurora', 'basalt', 'rook', 'hollow', 'vector', 'orbit'];
  const pick = (list) => list[crypto.randomBytes(2).readUInt16BE(0) % list.length];
  return `${pick(adjectives)}-${pick(nouns)}-${1000 + (crypto.randomBytes(2).readUInt16BE(0) % 8999)}`;
}

function randomHandle() {
  for (let i = 0; i < 25; i++) {
    const candidate = codename();
    if (!store.userByName(candidate)) return candidate;
  }
  return `user-${crypto.randomBytes(6).toString('hex')}`;
}

function ensureUniqueHandle(base) {
  let candidate = sanitizeHandle(base) || randomHandle();
  if (candidate.length < 3) candidate = randomHandle();
  let suffix = 0;
  while (store.userByName(candidate)) {
    suffix += 1;
    candidate = `${sanitizeHandle(base).slice(0, 24)}-${suffix}`;
    if (suffix > 400) candidate = randomHandle();
  }
  return candidate;
}

const routes = {};

// ------------------------------------------------------------------ bootstrap
routes['GET /api/bootstrap'] = async (ctx) => {
  const global = store.db.global;
  return {
    version: '1.0.0',
    server: {
      registrationOpen: global.registrationOpen,
      maintenance: global.maintenance,
      notice: global.notice,
      maxUploadBytes: global.maxUploadBytes,
      termsVersion: global.termsVersion,
      time: now(),
      uptime: process.uptime(),
      counts: {
        users: Object.keys(store.db.users).length,
        messages: Object.keys(store.db.messages).length,
        communities: Object.keys(store.db.forums).length,
      },
    },
    defaults: DEFAULT_LIMITS,
    // The developer credit under the sign-in card.  AE_DISCORD_URL is set by the
    // installer; without it the client offers an encrypted DM instead.
    developer: {
      handle: 'Fade_Kit',
      role: 'Web developer',
      discordUrl: String(process.env.AE_DISCORD_URL || '').trim(),
    },
    clicks: clickerSnapshot(ctx.user),
    user: ctx.user ? selfView(ctx.user) : null,
    session: ctx.session ? { id: ctx.session.id, device: ctx.session.device, platform: ctx.session.platform, createdAt: ctx.session.createdAt } : null,
    presence: realtime.presenceSnapshot(),
    features: {
      minPasswordLength: 12,
      reactionLimit: 24,
      storyLifetimeHours: 24,
      storyMaxBytes: DEFAULT_LIMITS.storyQuotaBytes,
      dmCodeLifetimeHours: 72,
      backupCodeCount: 5,
      neuralMinIntervalMs: 4000,
    },
  };
};

function clickerSnapshot(user) {
  const counters = store.db.counters;
  const week = isoWeek();
  const weeks = counters.clickWeeks || {};
  return {
    total: counters.clicks || 0,
    week: weeks[week] || 0,
    weekLabel: week,
    mine: user ? (store.db.clicksByUser || {})[user.id] || 0 : 0,
  };
}

// ------------------------------------------------------------------ discovery
routes['POST /api/auth/salt'] = async (ctx) => {
  const username = String(ctx.body.username || '').toLowerCase().trim();
  if (!actionLimiter.hit(`salt:${ctx.ip}`).allowed) throw fail(429, 'Too many attempts, slow down.', 'rate_limited');
  const user = store.userByName(username);
  if (!user) {
    // Deterministic decoy so account discovery is not trivial.
    const decoy = crypto.createHash('sha256').update(`decoy|${username}`).digest('hex');
    return { authSalt: decoy.slice(0, 32), vaultSalt: decoy.slice(32, 64), proofSalt: decoy.slice(0, 32), iterations: 210000, exists: false };
  }
  return {
    authSalt: user.kdf.authSalt,
    vaultSalt: user.kdf.vaultSalt,
    proofSalt: user.kdf.proofSalt || user.serverSalt,
    iterations: user.kdf.iterations,
    exists: true,
  };
};

// ------------------------------------------------------------------ register
routes['POST /api/auth/register'] = async (ctx) => {
  const body = ctx.body;
  const limit = registerLimiter.hit(`reg:${ctx.ip}`);
  if (!limit.allowed) throw fail(429, 'Too many sign-ups from this device. Try again later.', 'rate_limited');
  if (!store.db.global.registrationOpen) throw fail(403, 'Registration is currently closed by the operator.', 'registration_closed');

  const username = sanitizeHandle(body.username) || randomHandle();
  const displayName = sanitizeText(body.displayName, 40) || username;
  if (username.length < 3) throw fail(400, 'Handle must be at least 3 characters.', 'bad_username');
  if (store.userByName(username)) throw fail(409, 'That handle is already taken.', 'handle_taken');
  for (const field of ['authKey', 'authSalt', 'vaultSalt', 'vault', 'identityPublic']) {
    if (!body[field]) throw fail(400, `Missing required field: ${field}`, 'bad_request');
  }
  if (!body.termsAccepted) throw fail(400, 'You must accept the usage terms to create an account.', 'terms_required');

  const serverSalt = crypto.randomBytes(16).toString('hex');
  const iterations = clampNumber(body.iterations, 100000, 2000000, 210000);
  const user = store.createUser({
    username,
    displayName,
    serverSalt,
    authHashStored: scryptHex(body.authKey, serverSalt),
    kdf: {
      authSalt: String(body.authSalt),
      vaultSalt: String(body.vaultSalt),
      proofSalt: String(body.proofSalt || serverSalt),
      iterations,
    },
    identityPublic: body.identityPublic,
    wrappedMaster: body.vault,
    wrappedIdentity: body.vault,
    role: Object.keys(store.db.users).length === 0 ? 'owner' : 'member',
    settings: defaultSettings(),
    terms: { accepted: true, at: now(), version: store.db.global.termsVersion },
  });

  if (Array.isArray(body.recoveryCodes)) {
    user.backup = {
      generatedAt: now(),
      codes: body.recoveryCodes.slice(0, 5).map((entry, index) => ({
        id: `rc_${index + 1}`,
        label: entry.label || `Recovery code ${index + 1}`,
        proofHash: scryptHex(entry.proof, serverSalt),
        wrapped: entry.wrapped,
        createdAt: now(),
        usedAt: null,
      })),
    };
  }

  const session = makeSession(user, ctx);
  store.audit(user.id, 'account.created', { handle: user.username });
  store.pushEvent({ type: 'user.joined', userId: user.id, detail: { handle: user.username } });
  notifyAdmins({ event: 'admin', kind: 'user.joined', userId: user.id, handle: user.username, at: now() });
  realtime.broadcast({ kind: 'presence.changed', userId: user.id, status: realtime.presenceSnapshot()[user.id] }, 'presence', { skipUser: user.id });
  return {
    token: session.token,
    session: { id: session.id, device: session.device },
    user: selfView(user),
    firstAccount: user.role === 'owner',
  };
};

// ------------------------------------------------------------------ login
routes['POST /api/auth/login'] = async (ctx) => {
  const key = `login:${ctx.ip}`;
  const limit = loginLimiter.hit(key);
  if (!limit.allowed) throw fail(429, `Too many sign-in attempts. Retry in ${Math.ceil(limit.retryAfter / 1000)}s.`, 'rate_limited');
  const username = String(ctx.body.username || '').toLowerCase().trim();
  const user = store.userByName(username);
  if (!user) throw fail(401, 'Invalid handle or passphrase.', 'bad_credentials');
  if (user.disabled) throw fail(403, 'This account has been disabled by an administrator.', 'disabled');

  if (ctx.body.recoveryProof) {
    const match = (user.backup.codes || []).find((code) => !code.usedAt && verifyScrypt(ctx.body.recoveryProof, user.serverSalt, code.proofHash));
    if (!match) throw fail(401, 'That recovery code is not valid for this account.', 'bad_recovery');
    match.usedAt = now();
    store.audit(user.id, 'account.recovery_used', { codeId: match.id });
    const session = makeSession(user, ctx, { recovered: true });
    const codeIndex = Number(String(match.id).replace('rc_', '')) - 1;
    notifyAdmins({ event: 'admin', kind: 'recovery.used', userId: user.id, handle: user.username, at: now() });
    return {
      token: session.token,
      session: { id: session.id, device: session.device },
      recovered: true,
      user: selfView(user, { recovered: true }),
      vault: { wrapped: match.wrapped, salt: user.kdf.vaultSalt, iterations: user.kdf.iterations },
      codeIndex: Number.isFinite(codeIndex) && codeIndex >= 0 ? codeIndex : 0,
      remaining: user.backup.codes.filter((c) => !c.usedAt).length,
    };
  }

  if (!ctx.body.authKey) throw fail(400, 'Missing passphrase key material.', 'bad_request');
  if (!verifyScrypt(ctx.body.authKey, user.serverSalt, user.authHashStored)) {
    if (user.banned) throw fail(403, 'This account is suspended.', 'banned');
    throw fail(401, 'Invalid handle or passphrase.', 'bad_credentials');
  }
  if (user.banned) throw fail(403, 'This account is suspended. Contact the operator.', 'banned');
  const session = makeSession(user, ctx);
  if (!user.terms.accepted || user.terms.version !== store.db.global.termsVersion) {
    user.terms.accepted = false;
  }
  realtime.broadcast({ kind: 'presence.changed', userId: user.id, status: realtime.presenceSnapshot()[user.id] }, 'presence', { skipUser: user.id });
  return { token: session.token, session: { id: session.id, device: session.device }, user: selfView(user) };
};

routes['POST /api/auth/logout'] = async (ctx) => {
  if (ctx.session) store.revokeSession(ctx.session.token);
  return { ok: true };
};

routes['GET /api/auth/me'] = async (ctx) => {
  const user = requireAuth(ctx);
  return { user: selfView(user), session: ctx.session ? { id: ctx.session.id } : null };
};

routes['POST /api/auth/terms'] = async (ctx) => {
  const user = requireAuth(ctx);
  if (!ctx.body.accepted) throw fail(400, 'Acceptance required.', 'bad_request');
  user.terms = { accepted: true, at: now(), version: store.db.global.termsVersion };
  store.touch();
  store.audit(user.id, 'terms.accepted', { version: user.terms.version, ip: ctx.ip });
  return { ok: true, terms: user.terms };
};

// ------------------------------------------------------------------ change passphrase
routes['POST /api/auth/password'] = async (ctx) => {
  const user = requireAuth(ctx);
  const limit = actionLimiter.hit(`pw:${user.id}`);
  if (!limit.allowed) throw fail(429, 'Too many attempts.', 'rate_limited');
  const { currentAuthKey, newAuthKey, newAuthSalt, newVaultSalt, vault, iterations, keepSessions } = ctx.body;
  // A session opened with a one-time backup code may re-seal the vault without
  // proving the old passphrase (which the recovering owner may not remember).
  const viaRecovery = !!(ctx.session && ctx.session.recovered);
  if (!viaRecovery && !verifyScrypt(currentAuthKey, user.serverSalt, user.authHashStored)) {
    throw fail(401, 'Current passphrase is incorrect.', 'bad_credentials');
  }
  if (!newAuthKey || !vault) throw fail(400, 'New passphrase material missing.', 'bad_request');
  user.serverSalt = crypto.randomBytes(16).toString('hex');
  user.authHashStored = scryptHex(newAuthKey, user.serverSalt);
  user.kdf = {
    authSalt: String(newAuthSalt || user.kdf.authSalt),
    vaultSalt: String(newVaultSalt || user.kdf.vaultSalt),
    iterations: clampNumber(iterations, 100000, 2000000, user.kdf.iterations),
  };
  user.wrappedMaster = vault;
  user.wrappedIdentity = vault;
  if (viaRecovery || !keepSessions) store.revokeUserSessions(user.id, ctx.session.token);
  if (ctx.session) ctx.session.recovered = false;
  store.audit(user.id, 'account.password_changed', { revokeOthers: viaRecovery || !keepSessions, viaRecovery });
  store.touch();
  return { ok: true, revokedOthers: !keepSessions };
};

routes['POST /api/auth/recovery/regenerate'] = async (ctx) => {
  const user = requireAuth(ctx);
  if (!Array.isArray(ctx.body.codes)) throw fail(400, 'Recovery payload missing.', 'bad_request');
  user.backup = {
    generatedAt: now(),
    codes: ctx.body.codes.slice(0, 5).map((entry, index) => ({
      id: `rc_${index + 1}`,
      label: entry.label || `Recovery code ${index + 1}`,
      proofHash: scryptHex(entry.proof, user.serverSalt),
      wrapped: entry.wrapped,
      createdAt: now(),
      usedAt: null,
    })),
  };
  store.touch();
  store.audit(user.id, 'account.recovery_regenerated', {});
  return { ok: true, backup: { count: user.backup.codes.length, generatedAt: user.backup.generatedAt } };
};

// ------------------------------------------------------------------ sessions
routes['GET /api/sessions'] = async (ctx) => {
  const user = requireAuth(ctx);
  const sessions = store.userSessions(user.id).map((s) => ({
    id: s.id,
    device: s.device,
    platform: s.platform,
    ip: s.ip ? s.ip.split('.').slice(0, 2).join('.') + '.x.x' : 'hidden',
    createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt,
    current: ctx.session && s.token === ctx.session.token,
  }));
  return { sessions };
};

routes['POST /api/sessions/revoke'] = async (ctx) => {
  const user = requireAuth(ctx);
  const token = String(ctx.body.token || '');
  const session = token ? store.sessionByToken(token) : store.userSessions(user.id).find((s) => s.id === String(ctx.body.id || ''));
  if (!session || session.userId !== user.id) throw fail(404, 'Session not found.', 'not_found');
  realtime.send(user.id, { event: 'session.killed', token: session.token }, 'session.killed');
  store.revokeSession(session.token);
  store.audit(user.id, 'session.revoked', { sessionId: session.id, device: session.device });
  return { ok: true };
};

routes['POST /api/sessions/revoke-others'] = async (ctx) => {
  const user = requireAuth(ctx);
  const removed = store.revokeUserSessions(user.id, ctx.session.token);
  store.audit(user.id, 'session.revoked_all_others', { removed });
  return { ok: true, removed };
};

// ------------------------------------------------------------------ settings & presence
function defaultSettings() {
  return {
    theme: 'nox',
    accent: 'ink',
    glass: 100,
    blur: 0,
    cornerRadius: 0,
    wallpaper: 'theme',
    density: 'comfortable',
    fontScale: 1,
    uiSounds: false,
    animations: true,
    reduceMotion: false,
    highContrast: false,
    dyslexiaFont: false,
    lineHeight: 1.45,
    colorBlind: 'none',
    screenReaderHints: false,
    focusRing: true,
    notificationToasts: true,
    desktopNotifications: false,
    timestamps: 'relative',
    enterToSend: true,
    autoLockMinutes: 30,
    rememberUnlockInTab: true,
    hideMessagePreviews: false,
    activityStatus: true,
    storyAutoplay: true,
    forumMedia: false,
    airdrop: false,
    airdropSound: false,
    disabledFeatures: {},
    disabledMenus: [],
    customCss: '',
    layout: {
      order: ['messages', 'communities', 'stories', 'drive', 'files', 'airdrop'],
      hidden: [],
      sidebarCompact: false,
      showKarmaSelf: false,
    },
  };
}
routes.defaultSettings = defaultSettings;

routes['PATCH /api/settings'] = async (ctx) => {
  const user = requireAuth(ctx);
  const patch = ctx.body || {};
  const incoming = patch.settings || patch;
  const next = JSON.parse(JSON.stringify(user.settings || defaultSettings()));
  const merge = (target, source) => {
    for (const [key, value] of Object.entries(source || {})) {
      if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
        merge(target[key], value);
      } else {
        target[key] = value;
      }
    }
  };
  if (incoming && typeof incoming === 'object') {
    const clone = JSON.parse(JSON.stringify(incoming));
    if (typeof clone.customCss === 'string') clone.customCss = clone.customCss.slice(0, 20000);
    merge(next, clone);
  }
  user.settings = next;
  store.touch();
  return { ok: true, settings: user.settings };
};

routes['PATCH /api/profile'] = async (ctx) => {
  const user = requireAuth(ctx);
  const body = ctx.body || {};
  if (body.displayName !== undefined) user.displayName = sanitizeText(body.displayName, 40) || user.username;
  if (body.bio !== undefined) user.bio = sanitizeText(body.bio, 400);
  if (body.avatarId !== undefined) user.avatarId = body.avatarId ? String(body.avatarId) : null;
  store.touch();
  return { ok: true, user: selfView(user) };
};

routes['POST /api/presence'] = async (ctx) => {
  const user = requireAuth(ctx);
  const record = realtime.markPresence(user.id, {
    mode: typeof ctx.body.mode === 'string' ? ctx.body.mode : null,
    custom: typeof ctx.body.custom === 'string' ? ctx.body.custom : undefined,
    manual: ctx.body.manual,
  });
  const snapshot = { userId: user.id, status: realtime.statusOf(user.id) };
  realtime.broadcast({ kind: 'presence.changed', ...snapshot }, 'presence', { skipUser: user.id });
  return { ok: true, status: snapshot.status, server: { mode: record.mode } };
};

// ------------------------------------------------------------------ public profile
routes['PATCH /api/public-profile'] = async (ctx) => {
  const user = requireAuth(ctx);
  const body = ctx.body || {};
  const profile = user.publicProfile;
  if (body.enabled !== undefined) profile.enabled = !!body.enabled;
  if (body.alias !== undefined) profile.alias = sanitizeText(body.alias, 40);
  if (body.bio !== undefined) profile.bio = sanitizeText(body.bio, 1000);
  if (body.images !== undefined && Array.isArray(body.images)) profile.images = body.images.slice(0, 8).map((id) => String(id));
  if (body.audienceKey !== undefined) profile.audienceKey = body.audienceKey ? String(body.audienceKey) : null;
  profile.updatedAt = now();
  store.touch();
  realtime.broadcast({ kind: 'public.presence', userId: user.id, enabled: profile.enabled }, 'public', { skipUser: user.id });
  return { ok: true, publicProfile: profile };
};

// ------------------------------------------------------------------ shared clicker
routes['GET /api/click'] = async (ctx) => clickerSnapshot(ctx.user);

routes['POST /api/click'] = async (ctx) => {
  const limit = clickLimiter.hit(`click:${ctx.user ? ctx.user.id : ctx.ip}`, 1);
  if (!limit.allowed) throw fail(429, 'That is a lot of clicking — take a breath and try again.', 'rate_limited');
  const week = isoWeek();
  store.db.counters.clicks = (store.db.counters.clicks || 0) + 1;
  store.db.counters.clickWeeks = store.db.counters.clickWeeks || {};
  store.db.counters.clickWeeks[week] = (store.db.counters.clickWeeks[week] || 0) + 1;
  if (ctx.user) {
    store.db.clicksByUser = store.db.clicksByUser || {};
    store.db.clicksByUser[ctx.user.id] = (store.db.clicksByUser[ctx.user.id] || 0) + 1;
  }
  const weeks = Object.keys(store.db.counters.clickWeeks);
  if (weeks.length > 12) {
    for (const key of weeks.sort().slice(0, weeks.length - 12)) delete store.db.counters.clickWeeks[key];
  }
  store.touch();
  const snapshot = clickerSnapshot(ctx.user);
  realtime.broadcast({ kind: 'click', ...snapshot }, 'click');
  return snapshot;
};

// ------------------------------------------------------------------ storage requests
routes['POST /api/requests'] = async (ctx) => {
  const user = requireAuth(ctx);
  const limit = actionLimiter.hit(`req:${user.id}`, 2);
  if (!limit.allowed) throw fail(429, 'Too many requests in a row. Give the operator a moment.', 'rate_limited');
  const kind = ['dm', 'drive', 'story', 'purple', 'verified', 'unban', 'other'].includes(ctx.body.kind) ? ctx.body.kind : 'other';
  const openExisting = Object.values(store.db.requests).find((r) => r.userId === user.id && r.status === 'open' && r.kind === kind);
  if (openExisting) throw fail(409, 'You already have an open request of that type.', 'duplicate');
  const request = {
    id: store.nextId('r_'),
    userId: user.id,
    kind,
    requestedBytes: ctx.body.requestedBytes ? clampNumber(ctx.body.requestedBytes, 1024, 100 * 1024 * 1024 * 1024 * 1024, null) : null,
    requestedLabel: sanitizeText(ctx.body.requestedLabel, 40),
    message: sanitizeText(ctx.body.message, 800),
    status: 'open',
    createdAt: now(),
    updatedAt: now(),
    expiresAt: now() + 1000 * 60 * 60 * 24 * 30,
    decision: null,
    conversationId: null,
    dmCode: null,
  };
  store.db.requests[request.id] = request;
  store.touch();
  store.audit(user.id, 'request.created', { kind, requestedBytes: request.requestedBytes });
  notifyAdmins({ event: 'admin', kind: 'request.created', request: requestToView(request, true), at: now() });
  realtime.neural({ kind: 'event', event: { id: request.id, type: 'request.created', at: request.createdAt, userId: user.id, detail: { kind } } });
  return { ok: true, request: requestToView(request, true) };
};

function requestToView(request, forAdmin = false) {
  const user = store.userById(request.userId);
  return {
    id: request.id,
    kind: request.kind,
    status: request.status,
    message: request.message,
    requestedBytes: request.requestedBytes,
    requestedLabel: request.requestedLabel || (request.requestedBytes ? limitLabel(request.requestedBytes) : ''),
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    conversationId: request.conversationId,
    decision: request.decision,
    current: user ? {
      dmUploadBytes: user.limits.dmUploadBytes,
      driveQuotaBytes: user.limits.driveQuotaBytes,
      driveUsed: user.driveUsed,
      purpleAllowed: !!user.purpleAllowed,
      verified: !!user.verified,
    } : null,
    user: user ? (forAdmin ? { ...publicUser(user, { includeBio: true }), banned: user.banned, disabled: user.disabled, role: user.role } : publicUser(user)) : null,
  };
}
routes.requestToView = requestToView;

routes['GET /api/requests'] = async (ctx) => {
  const user = requireAuth(ctx);
  const mine = Object.values(store.db.requests)
    .filter((r) => r.userId === user.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((r) => requestToView(r, false));
  const decisions = {};
  for (const request of Object.values(store.db.requests)) {
    if (request.userId === user.id && request.decision) decisions[request.id] = request.decision;
  }
  return { requests: mine, decisions };
};

// ------------------------------------------------------------------ one-time DM codes
routes['POST /api/dm-codes'] = async (ctx) => {
  const user = requireAuth(ctx);
  const limit = actionLimiter.hit(`dmc:${user.id}`, 3);
  if (!limit.allowed) throw fail(429, 'Too many codes generated. Wait a moment.', 'rate_limited');
  const target = ctx.body.userId ? store.userById(String(ctx.body.userId)) : null;
  if (ctx.body.userId && !target) throw fail(404, 'User not found.', 'not_found');
  const isOwnerFlow = isAdmin(user);
  if (!isOwnerFlow && target) throw fail(403, 'Only administrators can target a code at a specific account.', 'forbidden');
  if (isOwnerFlow && !target) throw fail(400, 'Select the account this code is for.', 'bad_request');

  const code = humanCode(3, 4);
  const record = {
    code,
    id: store.nextId('dc_'),
    createdBy: user.id,
    forUserId: target ? target.id : null,
    direction: target ? 'admin-to-user' : 'user-to-admin',
    createdAt: now(),
    expiresAt: now() + 1000 * 60 * 60 * 72,
    uses: 0,
    maxUses: 1,
    requestId: ctx.body.requestId ? String(ctx.body.requestId) : null,
  };
  store.db.dmCodes[code] = record;
  if (record.requestId && store.db.requests[record.requestId]) {
    store.db.requests[record.requestId].dmCode = code;
  }
  store.touch();
  store.audit(user.id, 'dmcode.created', { direction: record.direction });
  if (target) {
    realtime.send(target.id, { event: 'dmcode', code, note: 'An administrator generated a secure one-time chat code for you.' }, 'dmcode');
  }
  return {
    code,
    expiresAt: record.expiresAt,
    direction: record.direction,
    // The peer identity is intentionally omitted here so a leaked code cannot unmask an operator.
  };
};

routes['POST /api/dm-codes/redeem'] = async (ctx) => {
  const user = requireAuth(ctx);
  const code = String(ctx.body.code || '').toUpperCase().trim();
  const limit = actionLimiter.hit(`dmc-redeem:${user.id}`, 5);
  if (!limit.allowed) throw fail(429, 'Too many attempts.', 'rate_limited');
  const record = store.db.dmCodes[code];
  if (!record) throw fail(404, 'That code is invalid or already used.', 'not_found');
  if (record.expiresAt <= now()) {
    delete store.db.dmCodes[code];
    store.touch();
    throw fail(410, 'That code has expired.', 'expired');
  }
  if (record.direction === 'admin-to-user' && record.forUserId !== user.id) {
    throw fail(403, 'That code was issued for a different account.', 'forbidden');
  }
  if (record.direction === 'user-to-admin' && record.createdBy === user.id) {
    throw fail(400, 'This is your own code — share it with the operator instead.', 'own_code');
  }

  const otherId = record.direction === 'admin-to-user' ? record.createdBy : record.createdBy;
  const other = store.userById(otherId);
  if (!other) throw fail(404, 'The other party no longer exists.', 'not_found');

  const conversation = require('./routes-social').ensureDirectConversation(user, other, { origin: 'dm-code', requestId: record.requestId });
  record.uses += 1;
  if (record.uses >= record.maxUses) delete store.db.dmCodes[code];
  if (record.requestId && store.db.requests[record.requestId]) {
    const request = store.db.requests[record.requestId];
    request.conversationId = conversation.id;
    request.updatedAt = now();
    if (request.status === 'open' && request.dmCode === code) request.status = 'contacted';
  }
  store.touch();
  store.audit(user.id, 'dmcode.redeemed', { conversationId: conversation.id, direction: record.direction });
  realtime.send(other.id, {
    event: 'dmcode.redeemed',
    conversationId: conversation.id,
    note: 'Your one-time chat code was redeemed.',
  }, 'dmcode.redeemed');
  // Whenever the other party is an administrator, the identity stays masked so a
  // leaked code can never unmask the operator account.
  const otherCard = isAdmin(other) && !isAdmin(user)
    ? { id: null, username: 'administration', displayName: 'Server Administration', masked: true, verified: true, role: 'admin', identityPublic: other.identityPublic }
    : publicUser(other);
  return {
    ok: true,
    conversationId: conversation.id,
    peer: otherCard,
    direction: record.direction,
    // encrypted key material for the requesting user's side of the conversation
    keyWrap: conversation.keyWraps[user.id] || null,
  };
};

// ------------------------------------------------------------------ airdrop
const airdropLimiter = new RateLimiter({ points: 12, windowMs: 60000 });

routes['GET /api/airdrop/recipients'] = async (ctx) => {
  const user = requireAuth(ctx);
  const online = [];
  const admins = [];
  for (const candidate of store.allUsers()) {
    if (candidate.id === user.id || candidate.banned || candidate.disabled) continue;
    const card = { id: candidate.id, username: candidate.username, displayName: candidate.displayName, avatarId: candidate.avatarId, verified: candidate.verified, identityPublic: candidate.identityPublic, role: candidate.role };
    if (isAdmin(candidate)) { admins.push(card); continue; }
    if (!(candidate.settings || {}).airdrop) continue;
    const status = realtime.statusOf(candidate.id).key;
    if (status === 'online' || status === 'purple' || status === 'dnd' || status === 'idle') online.push(card);
  }
  return {
    online,
    admins,
    onAir: online.length + admins.length,
    note: 'Airdrops reach members who enabled airdrop and are online right now. Operators always receive drops, even offline.',
  };
};

routes['POST /api/airdrop'] = async (ctx) => {
  const user = requireAuth(ctx);
  const limit = airdropLimiter.hit(`air:${user.id}`, 2);
  if (!limit.allowed) throw fail(429, 'Slow down on the airdrops.', 'rate_limited');
  const body = ctx.body || {};
  const kind = body.kind === 'file' ? 'file' : body.kind === 'image' ? 'image' : 'text';
  const size = kind === 'text' ? 0 : clampNumber(body.size, 1, store.db.global.maxUploadBytes, 0);
  if (kind !== 'text' && !body.fileId) throw fail(400, 'Airdrop payload missing.', 'bad_request');
  if (kind !== 'text') require('./helpers').checkDmUpload(user, size || store.db.files[body.fileId]?.size || 0);

  const recipients = [];
  for (const candidate of store.allUsers()) {
    if (candidate.id === user.id) continue;
    const settings = candidate.settings || {};
    if (!settings.airdrop) continue;
    if (candidate.banned || candidate.disabled) continue;
    const status = realtime.statusOf(candidate.id).key;
    if (status !== 'online' && status !== 'purple' && status !== 'dnd' && status !== 'idle') continue;
    recipients.push(candidate);
  }
  const admins = store.allUsers().filter((u) => isAdmin(u) && u.id !== user.id && !recipients.some((r) => r.id === u.id));

  const airdrop = {
    id: store.nextId('ad_'),
    senderId: user.id,
    kind,
    createdAt: now(),
    expiresAt: now() + 1000 * 60 * 60 * 12,
    payload: body.payload || null,          // { iv, ct } for text drops
    fileId: body.fileId || null,
    size: size || 0,
    recipientIds: recipients.map((r) => r.id),
    adminIds: admins.map((a) => a.id),
    keyWraps: body.keyWraps || {},
    deliveredOffline: admins.length > 0,
  };
  store.db.airdrops = store.db.airdrops || {};
  store.db.airdrops[airdrop.id] = airdrop;
  store.touch();

  for (const recipient of recipients) {
    realtime.send(recipient.id, { event: 'airdrop', airdrop: { id: airdrop.id, senderId: user.id, kind, size, at: airdrop.createdAt } }, 'airdrop');
  }
  for (const admin of admins) {
    realtime.send(admin.id, { event: 'airdrop', airdrop: { id: airdrop.id, senderId: user.id, kind, size, at: airdrop.createdAt, offlineDelivered: true } }, 'airdrop');
  }
  store.pushEvent({ type: 'airdrop.sent', userId: user.id, detail: { kind, recipients: recipients.length, size: airdrop.size } });
  realtime.neural({ kind: 'event', event: { id: airdrop.id, type: 'airdrop.sent', at: airdrop.createdAt, userId: user.id, detail: { kind, recipients: recipients.length } } });
  realtime.broadcast({ kind: 'events.changed' }, 'feed');
  return { ok: true, id: airdrop.id, delivered: recipients.length, adminDelivered: admins.length };
};

routes['POST /api/airdrop/:id/ack'] = async (ctx) => {
  const user = requireAuth(ctx);
  const airdrop = (store.db.airdrops || {})[ctx.params.id];
  if (!airdrop) throw fail(404, 'Airdrop not found.', 'not_found');
  airdrop.ackedBy = airdrop.ackedBy || [];
  if (!airdrop.ackedBy.includes(user.id)) airdrop.ackedBy.push(user.id);
  store.touch();
  return { ok: true };
};

module.exports = { routes, defaultSettings, codename, randomHandle, ensureUniqueHandle, clickerSnapshot, requestToView, scryptHex, verifyScrypt };
