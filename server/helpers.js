'use strict';

const { store } = require('./store');
const { realtime } = require('./realtime');
const { now, formatBytes } = require('./util');

const ROLE_RANK = { member: 0, mod: 1, admin: 2, owner: 3 };

class HttpError extends Error {
  constructor(status, message, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
  store.bumpMetrics({ bytesOut: Buffer.byteLength(body) });
  return undefined;
}

function sendError(res, error) {
  if (error instanceof HttpError) {
    return sendJson(res, error.status, { error: error.message, code: error.code });
  }
  console.error('[api]', error);
  return sendJson(res, 500, { error: 'Internal server error', code: 'internal' });
}

function fail(status, message, code = 'error') {
  return new HttpError(status, message, code);
}

function readJson(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(fail(413, 'Payload too large', 'payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      store.bumpMetrics({ bytesIn: size });
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(fail(400, 'Malformed JSON body', 'bad_json'));
      }
    });
    req.on('error', reject);
  });
}

function isAdmin(user) {
  return !!user && (user.role === 'owner' || user.role === 'admin');
}

function isStaff(user) {
  return !!user && ROLE_RANK[user.role] >= ROLE_RANK.mod;
}

function requireAuth(ctx) {
  if (!ctx.user) throw fail(401, 'Sign in required', 'unauthorized');
  if (ctx.user.banned) throw fail(403, 'This account is suspended', 'banned');
  if (ctx.user.disabled) throw fail(403, 'This account is disabled', 'disabled');
  return ctx.user;
}

function requireAdmin(ctx) {
  requireAuth(ctx);
  if (!isAdmin(ctx.user)) throw fail(403, 'Administrator access required', 'forbidden');
  return ctx.user;
}

function requireOwner(ctx) {
  requireAuth(ctx);
  if (ctx.user.role !== 'owner') throw fail(403, 'Owner access required', 'forbidden');
  return ctx.user;
}

/** The self-view of a user, including the encrypted key material needed to unlock. */
function selfView(user, extras = {}) {
  return Object.assign({
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    createdAt: user.createdAt,
    avatarId: user.avatarId,
    bio: user.bio,
    verified: user.verified,
    purpleAllowed: user.purpleAllowed,
    identityPublic: user.identityPublic,
    wrappedMaster: user.wrappedMaster,
    wrappedIdentity: user.wrappedIdentity,
    kdf: user.kdf,
    limits: user.limits,
    driveUsed: user.driveUsed,
    uploadUsed: user.uploadUsed,
    publicProfile: {
      enabled: user.publicProfile.enabled,
      alias: user.publicProfile.alias,
      bio: user.publicProfile.bio,
      images: user.publicProfile.images,
      audienceKey: user.publicProfile.audienceKey,
    },
    status: Object.assign({}, user.status, { effective: realtime.statusOf(user.id) }),
    settings: user.settings,
    terms: user.terms,
    backup: { count: user.backup.codes.filter((c) => !c.usedAt).length, generatedAt: user.backup.generatedAt },
    stats: user.stats,
    banned: user.banned,
    disabled: user.disabled,
  }, extras);
}

/** The public card other users see. No key material except the public identity key. */
function publicUser(user, { includeBio = false } = {}) {
  if (!user) return null;
  const profile = user.publicProfile || {};
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    avatarId: user.avatarId || null,
    verified: !!user.verified,
    identityPublic: user.identityPublic,
    status: realtime.statusOf(user.id),
    publicAlias: profile.enabled && profile.alias ? profile.alias : null,
    // Public audience key: readable by every signed-in account, used to seal
    // stories, public posts and public profile photos.
    audienceKey: profile.enabled ? profile.audienceKey : null,
    createdAt: user.createdAt,
    ...(includeBio ? { bio: profile.enabled ? profile.bio : '' } : {}),
  };
}

function fileView(file) {
  return {
    id: file.id,
    ownerId: file.ownerId,
    kind: file.kind,
    size: file.size,
    chunks: file.chunks,
    keyWrap: file.keyWrap || null,
    uploaded: !!file.complete,
    createdAt: file.createdAt,
    ref: file.ref || null,
    audience: file.audience || 'private',
    meta: file.meta || null,
  };
}

function canAccessFile(user, file) {
  if (!user || !file) return false;
  if (file.ownerId === user.id) return true;
  if (isAdmin(user)) return true;
  if (file.audience === 'public') return true;
  const ref = file.ref || {};
  if (ref.conversationId && store.db.conversations[ref.conversationId]?.memberIds.includes(user.id)) return true;
  if (ref.airdropId && store.db.stories[ref.airdropId]) return true;
  const airdrop = Object.values(store.db.airdrops || {}).find((a) => a.id === ref.airdropId);
  if (airdrop && airdrop.recipientIds.includes(user.id)) return true;
  if (ref.forumId) {
    const forum = store.db.forums[ref.forumId];
    if (forum && (forum.isPublic || forum.memberIds.includes(user.id))) return true;
  }
  return false;
}

/** Removes a blob from disk and returns its bytes to the owner's quota. */
function releaseFile(file, kind = null) {
  if (!file) return;
  const owner = store.userById(file.ownerId);
  if (owner) {
    if ((kind || file.kind) === 'drive') owner.driveUsed = Math.max(0, owner.driveUsed - file.size);
    else owner.uploadUsed = Math.max(0, owner.uploadUsed - file.size);
  }
  store.deleteFileBlobs(file.id);
  delete store.db.files[file.id];
  store.touch();
}

function conversationFor(id) {
  return store.db.conversations[id] || null;
}

function assertConversationMember(user, conversation) {
  if (!conversation) throw fail(404, 'Conversation not found', 'not_found');
  if (!conversation.memberIds.includes(user.id)) throw fail(403, 'You are not part of this conversation', 'forbidden');
  return conversation;
}

function forumFor(id) {
  return store.db.forums[id] || null;
}

function assertForumAccess(user, forum) {
  if (!forum) throw fail(404, 'Community not found', 'not_found');
  if (forum.isPublic) return forum;
  if (!forum.memberIds.includes(user.id)) throw fail(403, 'You are not a member of this community', 'forbidden');
  return forum;
}

// ------------------------------------------------------------------ quotas
const UNLIMITED = -1;

function limitLabel(bytes) {
  return bytes === UNLIMITED ? 'Unlimited' : formatBytes(bytes);
}

function checkDmUpload(user, size) {
  const limit = user.limits.dmUploadBytes;
  if (!Number.isFinite(size) || size <= 0) throw fail(400, 'Invalid file size', 'bad_size');
  if (limit !== UNLIMITED && size > limit) {
    throw fail(413, `Attachment exceeds your ${limitLabel(limit)} messaging upload allowance. Request a larger limit in Settings.`, 'quota_exceeded');
  }
  const absolute = store.db.global.maxUploadBytes;
  if (size > absolute) throw fail(413, `Files are capped at ${formatBytes(absolute)} on this server.`, 'server_limit');
  return true;
}

function checkDriveUpload(user, size) {
  const quota = user.limits.driveQuotaBytes;
  if (!Number.isFinite(size) || size <= 0) throw fail(400, 'Invalid file size', 'bad_size');
  if (quota !== UNLIMITED) {
    const remaining = quota - user.driveUsed;
    if (remaining <= 0) throw fail(413, `Your drive is full (${formatBytes(quota)}). Request more space in Settings.`, 'drive_full');
    if (size > remaining) {
      throw fail(413, `That file needs ${formatBytes(size)} but only ${formatBytes(Math.max(0, remaining))} of your ${limitLabel(quota)} drive is free.`, 'drive_full');
    }
  }
  return true;
}

function checkStoryUpload(user, size) {
  const limit = user.limits.storyQuotaBytes;
  if (limit !== UNLIMITED && size > limit) throw fail(413, `Story items are limited to ${limitLabel(limit)} on your account.`, 'quota_exceeded');
  return true;
}

function maxUploadForKind(user, kind) {
  if (kind === 'drive') return user.limits.driveQuotaBytes;
  if (kind === 'story') return user.limits.storyQuotaBytes;
  if (kind === 'airdrop') return user.limits.dmUploadBytes;
  return user.limits.dmUploadBytes;
}

// ---------------------------------------------------------------- counters
function bumpUserHistory(user, patch) {
  Object.assign(user.history, patch);
  store.touch();
}

function recordActivity(user, type, detail = {}) {
  const event = store.pushEvent({ type, userId: user.id, detail });
  realtime.neural({ kind: 'event', event });
  return event;
}

function notifyUsers(userIds, payload) {
  realtime.sendMany([...new Set(userIds.filter(Boolean))], payload, payload.event || 'notify');
}

function notifyAdmins(payload) {
  const ids = store.allUsers().filter(isAdmin).map((u) => u.id);
  realtime.sendMany(ids, payload, payload.event || 'admin');
}

module.exports = {
  HttpError,
  fail,
  sendJson,
  sendError,
  readJson,
  isAdmin,
  isStaff,
  requireAuth,
  requireAdmin,
  requireOwner,
  selfView,
  publicUser,
  fileView,
  canAccessFile,
  releaseFile,
  conversationFor,
  assertConversationMember,
  forumFor,
  assertForumAccess,
  checkDmUpload,
  checkDriveUpload,
  checkStoryUpload,
  maxUploadForKind,
  limitLabel,
  bumpUserHistory,
  recordActivity,
  notifyUsers,
  notifyAdmins,
  ROLE_RANK,
  UNLIMITED,
};
