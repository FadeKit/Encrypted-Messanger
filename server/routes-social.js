'use strict';

const { store } = require('./store');
const { realtime } = require('./realtime');
const h = require('./helpers');
const { now, sanitizeText, clampNumber, humanCode, RateLimiter } = require('./util');

const writeLimiter = new RateLimiter({ points: 90, windowMs: 60000 });
const postLimiter = new RateLimiter({ points: 30, windowMs: 60000 });
const route = {};

// ---------------------------------------------------------------- helpers
function messageView(message, viewer, { includeKarma = false } = {}) {
  const isOwn = viewer && message.authorId === viewer.id;
  const canSeeKarma = viewer && h.isAdmin(viewer);
  const reactions = {};
  for (const [emoji, users] of Object.entries(message.reactions || {})) {
    reactions[emoji] = { count: users.length, mine: viewer ? users.includes(viewer.id) : false, users: viewer ? users.slice(0, 24) : undefined };
  }
  return {
    id: message.id,
    authorId: message.authorId,
    convId: message.convId || null,
    threadId: message.threadId || null,
    forumId: message.forumId || null,
    payload: message.deleted ? null : message.payload,
    kind: message.kind || 'text',
    attachments: message.deleted ? [] : (message.attachments || []),
    replyTo: message.replyTo || null,
    replyPreview: message.replyPreview || null,
    reactions,
    deleted: !!message.deleted,
    deletedBy: message.deletedBy || null,
    editedAt: message.editedAt || null,
    createdAt: message.createdAt,
    own: !!isOwn,
    myVote: viewer ? ((message.votes && message.votes[viewer.id]) || 0) : 0,
    ...(canSeeKarma && includeKarma ? { karma: messageKarma(message) } : {}),
  };
}

/** Messages live in two collections: chats in db.messages, forum posts in db.posts. */
function findMessage(id) {
  return store.db.messages[id] || (store.db.posts ? store.db.posts[id] : null) || null;
}

function updateTargets(message) {
  if (message.convId) return (store.db.conversations[message.convId] || {}).memberIds || [];
  if (message.forumId) {
    const forum = store.db.forums[message.forumId];
    if (!forum) return [];
    return forum.isPublic ? 'feed' : forum.memberIds;
  }
  return [message.authorId];
}

function messageKarma(message) {
  const votes = message.votes || {};
  let up = 0; let down = 0;
  for (const value of Object.values(votes)) {
    if (value > 0) up += 1;
    if (value < 0) down += 1;
  }
  return { up, down, score: up - down };
}

function conversationView(conversation, viewer, { withMessages = true } = {}) {
  const users = conversation.memberIds.map((id) => {
    if (conversation.anonAdmin && conversation.anonAdmin[viewer.id]) {
      const alias = conversation.anonAdmin[viewer.id][id];
      if (alias) return alias;
    }
    const user = store.userById(id);
    return user ? h.publicUser(user) : null;
  }).filter(Boolean);

  const ids = store.db.convMessages[conversation.id] || [];
  const lastIds = ids.slice(-1);
  const last = lastIds.map((id) => store.db.messages[id]).filter(Boolean)[0];
  const receipts = conversation.receipts || {};
  const lastRead = receipts[viewer.id] || 0;

  let unread = 0;
  for (let i = ids.length - 1; i >= 0; i--) {
    const message = store.db.messages[ids[i]];
    if (!message) continue;
    if (message.authorId === viewer.id) break;
    if (message.createdAt > lastRead) unread += 1;
    else break;
  }

  const peers = users.filter((u) => u.id !== viewer.id);
  let keyWrap = conversation.keyWraps[viewer.id] || null;
  // Masked operator channels never disclose the wrapping account id; the public
  // key travels inside the wrap instead so the member can still unwrap it.
  if (keyWrap && conversation.anonAdmin && conversation.anonAdmin[viewer.id]) {
    try { const parsed = JSON.parse(keyWrap); delete parsed.by; keyWrap = JSON.stringify(parsed); } catch { /* keep as-is */ }
  }
  return {
    id: conversation.id,
    type: conversation.type,
    title: conversation.title || (peers.length ? (conversation.type === 'dm' ? peers[0].publicAlias || peers[0].displayName : peers.map((p) => p.displayName).slice(0, 3).join(', ')) : 'Saved notes'),
    ownerId: conversation.ownerId,
    isOwner: conversation.ownerId === viewer.id,
    memberIds: conversation.memberIds.filter((id) => id !== viewer.id || conversation.type !== 'dm'),
    members: users,
    keyWrap,
    // ciphertext for the operator's identity key; members' clients only ever
    // read its presence, never its contents
    operatorWrap: conversation.operatorWrap || null,
    anon: !!(conversation.anonAdmin && conversation.anonAdmin[viewer.id]),
    unread,
    lastMessageAt: conversation.lastMessageAt,
    lastActivityBy: conversation.lastActivityBy,
    createdAt: conversation.createdAt,
    origin: conversation.origin || 'standard',
    ...(withMessages && last ? { lastMessage: messageView(last, viewer) } : {}),
  };
}

function conversationFeedKey(conversation) {
  return `conv:${conversation.id}`;
}

function markConversationActivity(conversation, user, type, detail = {}) {
  conversation.lastMessageAt = now();
  conversation.lastActivityBy = user.id;
  store.touch();
  const event = store.pushEvent({ type, userId: user.id, detail: Object.assign({ conversationId: conversation.id }, detail) });
  realtime.neural({ kind: 'event', event });
}

/** Direct conversation between two accounts, created idempotently. */
function ensureDirectConversation(a, b, meta = {}) {
  const existing = Object.values(store.db.conversations).find((c) => (
    c.type === 'dm' && c.memberIds.length === 2 && c.memberIds.includes(a.id) && c.memberIds.includes(b.id)
  ));
  if (existing) return existing;
  const id = normalizeConversationId(meta.id);
  const conversation = {
    id,
    type: 'dm',
    ownerId: null,
    title: '',
    memberIds: [a.id, b.id],
    keyWraps: {},
    receipts: {},
    anonAdmin: {},
    origin: meta.origin || 'standard',
    createdAt: now(),
    lastMessageAt: now(),
    lastActivityBy: a.id,
    requestId: meta.requestId || null,
  };
  // Administrators reachable through a one-time code stay masked for the other side.
  const admin = h.isAdmin(a) ? a : (h.isAdmin(b) ? b : null);
  const other = admin === a ? b : a;
  if (admin && meta.origin === 'dm-code') {
    conversation.anonAdmin[other.id] = {
      [admin.id]: {
        id: null,
        displayName: 'Server Administration',
        username: 'administration',
        role: 'admin',
        masked: true,
        verified: true,
        // The public half of the operator identity is required to seal a channel
        // key for them; it carries no name, handle or account id.
        identityPublic: admin.identityPublic,
      },
    };
  }
  store.db.conversations[id] = conversation;
  store.db.convMessages[id] = [];
  store.touch();
  return conversation;
}

// ------------------------------------------------------------ conversations
/** Client-supplied channel ids let the creator wrap keys before the record exists. */
function normalizeConversationId(candidate) {
  const value = String(candidate || '');
  if (/^c_[A-Za-z0-9]{8,32}$/.test(value) && !store.db.conversations[value]) return value;
  return store.nextId('c_');
}

route['GET /api/directory'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const query = String(ctx.query.q || '').toLowerCase().trim();
  const users = store.allUsers()
    .filter((candidate) => !candidate.banned && !candidate.disabled)
    // Operator accounts are reached through one-time codes, never picked from a list.
    .filter((candidate) => h.isAdmin(user) || !h.isAdmin(candidate))
    .filter((candidate) => !query || candidate.username.toLowerCase().includes(query) || (candidate.displayName || '').toLowerCase().includes(query) || (candidate.publicProfile.alias || '').toLowerCase().includes(query))
    .sort((a, b) => (b.status.lastActive || 0) - (a.status.lastActive || 0))
    .slice(0, 400)
    .map((candidate) => Object.assign(h.publicUser(candidate, { includeBio: true }), {
      identityPublic: candidate.identityPublic,
      self: candidate.id === user.id,
    }));
  return { users, count: users.length };
};

route['POST /api/conversations'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const limit = writeLimiter.hit(`conv:${user.id}`, 3);
  if (!limit.allowed) throw h.fail(429, 'Too many conversations started at once.', 'rate_limited');
  const type = ctx.body.type === 'group' ? 'group' : 'dm';
  const memberIds = [...new Set((ctx.body.memberIds || []).map(String))].filter((id) => id !== user.id);
  if (!memberIds.length) throw h.fail(400, 'Pick at least one other account.', 'bad_request');
  if (type === 'dm' && memberIds.length !== 1) throw h.fail(400, 'A direct message is between two accounts.', 'bad_request');
  const members = memberIds.map((id) => store.userById(id));
  if (members.some((m) => !m)) throw h.fail(404, 'One of those accounts no longer exists.', 'not_found');
  if (members.some((m) => m.banned)) throw h.fail(403, 'One of those accounts is suspended.', 'forbidden');
  if (type === 'dm') {
    const peer = members[0];
    const existing = Object.values(store.db.conversations).find((candidate) => (
      candidate.type === 'dm' && candidate.memberIds.length === 2
      && candidate.memberIds.includes(user.id) && candidate.memberIds.includes(peer.id)
    ));
    const conversation = existing || ensureDirectConversation(user, peer, { id: ctx.body.id });

    // These envelopes were sealed against the client-supplied id. Only adopt
    // them when that id was actually used for a new record. Reusing them on an
    // older conversation can silently replace the peer's working key and make
    // the entire history unreadable.
    if (!existing) {
      const requestedId = String(ctx.body.id || '');
      if (requestedId === conversation.id) {
        conversation.keyWraps = sanitizeWraps(ctx.body.keyWraps, conversation.memberIds);
        conversation.operatorWrap = sanitizeWrap(ctx.body.operatorWrap);
      }
      // If the id was rejected (for example, a collision), the supplied
      // envelopes are bound to the wrong id. The client will wrap them again
      // after this record is created and its real id is known.
      store.touch();
      realtime.send(peer.id, { event: 'conversation.created', conversationId: conversation.id }, 'conversation.created');
    }

    return {
      conversation: conversationView(conversation, user),
      // An old, completely unkeyed record can be initialized safely by the
      // client using the actual stored id. A partially keyed one must not be
      // replaced with a newly generated key.
      keySetupRequired: !Object.keys(conversation.keyWraps || {}).length,
    };
  }
  const title = sanitizeText(ctx.body.title, 60) || 'Group chat';
  const id = normalizeConversationId(ctx.body.id);
  const conversation = {
    id,
    type: 'group',
    ownerId: user.id,
    title,
    memberIds: [user.id, ...memberIds],
    keyWraps: sanitizeWraps(ctx.body.keyWraps || {}, [user.id, ...memberIds]),
    operatorWrap: sanitizeWrap(ctx.body.operatorWrap),
    receipts: {},
    anonAdmin: {},
    origin: 'standard',
    createdAt: now(),
    lastMessageAt: now(),
    lastActivityBy: user.id,
  };
  store.db.conversations[id] = conversation;
  store.db.convMessages[id] = [];
  store.touch();
  store.pushEvent({ type: 'group.created', userId: user.id, detail: { conversationId: id, members: conversation.memberIds.length } });
  for (const member of conversation.memberIds) {
    realtime.send(member, { event: 'conversation.created', conversationId: id }, 'conversation.created');
  }
  return { conversation: conversationView(conversation, user) };
};

/**
 * Members of a masked operator channel know the peer only as "administration".
 * Accept that alias (and the alias username) in place of the hidden account id.
 */
function expandMaskedWraps(input, conversation, viewerId) {
  const alias = conversation.anonAdmin && conversation.anonAdmin[viewerId];
  if (!alias) return input;
  const out = Object.assign({}, input || {});
  for (const [realId, card] of Object.entries(alias)) {
    for (const key of ['administration', 'masked-admin', card.username]) {
      if (out[key] !== undefined) { out[realId] = out[key]; delete out[key]; }
    }
  }
  return out;
}

/** One operator envelope: a small JSON string the client sealed for the owner. */
function sanitizeWrap(value) {
  return typeof value === 'string' && value.length < 4096 ? value : null;
}

function sanitizeWraps(input, allowedIds) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (allowedIds.includes(key) && typeof value === 'string' && value.length < 4096) out[key] = value;
  }
  return out;
}

route['GET /api/conversations'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const list = Object.values(store.db.conversations)
    .filter((c) => c.memberIds.includes(user.id))
    .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
    .map((c) => conversationView(c, user, { withMessages: true }));
  return { conversations: list };
};

route['GET /api/conversations/:id'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const conversation = h.assertConversationMember(user, h.conversationFor(ctx.params.id));
  return { conversation: conversationView(conversation, user, { withMessages: false }) };
};

route['POST /api/conversations/:id/keys'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const conversation = h.assertConversationMember(user, h.conversationFor(ctx.params.id));
  const wraps = sanitizeWraps(expandMaskedWraps(ctx.body.keyWraps, conversation, user.id), conversation.memberIds);
  conversation.keyWraps = Object.assign({}, conversation.keyWraps, wraps);
  store.touch();
  for (const member of conversation.memberIds) {
    realtime.send(member, { event: 'conversation.keys', conversationId: conversation.id }, 'conversation.keys');
  }
  return { ok: true, conversation: conversationView(conversation, user, { withMessages: false }) };
};

/**
 * A channel that was opened before this device had an envelope for the operator
 * gets one the first time a member holds the key open: the wrap is written once
 * and never overwritten, so no member can swap it for something else.
 */
route['POST /api/conversations/:id/operator-wrap'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const conversation = h.assertConversationMember(user, h.conversationFor(ctx.params.id));
  if (conversation.operatorWrap) return { ok: true, stored: false };
  const wrap = sanitizeWrap(ctx.body.operatorWrap);
  if (!wrap) throw h.fail(400, 'An operator envelope is required.', 'bad_request');
  conversation.operatorWrap = wrap;
  store.touch();
  return { ok: true, stored: true };
};

route['POST /api/forums/:id/operator-wrap'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const forum = h.assertForumAccess(user, h.forumFor(ctx.params.id));
  if (forum.operatorWrap) return { ok: true, stored: false };
  const wrap = sanitizeWrap(ctx.body.operatorWrap);
  if (!wrap) throw h.fail(400, 'An operator envelope is required.', 'bad_request');
  forum.operatorWrap = wrap;
  store.touch();
  return { ok: true, stored: true };
};

route['POST /api/conversations/:id/members'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const conversation = h.assertConversationMember(user, h.conversationFor(ctx.params.id));
  if (conversation.type !== 'group') throw h.fail(400, 'Only group chats have managed membership.', 'bad_request');
  if (conversation.ownerId !== user.id && !h.isAdmin(user)) throw h.fail(403, 'Only the group owner can add members.', 'forbidden');
  const ids = [...new Set((ctx.body.memberIds || []).map(String))].filter((id) => !conversation.memberIds.includes(id));
  const members = ids.map((id) => store.userById(id)).filter(Boolean);
  if (!members.length) throw h.fail(400, 'No new members selected.', 'bad_request');
  conversation.memberIds.push(...members.map((m) => m.id));
  conversation.keyWraps = Object.assign({}, conversation.keyWraps, sanitizeWraps(ctx.body.keyWraps || {}, conversation.memberIds.slice()));
  store.touch();
  for (const member of conversation.memberIds) realtime.send(member, { event: 'conversation.updated', conversationId: conversation.id }, 'conversation.updated');
  return { ok: true, conversation: conversationView(conversation, user, { withMessages: false }) };
};

route['DELETE /api/conversations/:id/members/:userId'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const conversation = h.assertConversationMember(user, h.conversationFor(ctx.params.id));
  if (conversation.type !== 'group') throw h.fail(400, 'Only group chats have managed membership.', 'bad_request');
  if (conversation.ownerId !== user.id && !h.isAdmin(user)) throw h.fail(403, 'Only the group owner can remove members.', 'forbidden');
  const target = String(ctx.params.userId);
  if (target === conversation.ownerId) throw h.fail(400, 'The owner cannot be removed. Transfer ownership first.', 'bad_request');
  conversation.memberIds = conversation.memberIds.filter((id) => id !== target);
  delete conversation.keyWraps[target];
  store.touch();
  realtime.send(target, { event: 'conversation.removed', conversationId: conversation.id }, 'conversation.removed');
  for (const member of conversation.memberIds) realtime.send(member, { event: 'conversation.updated', conversationId: conversation.id }, 'conversation.updated');
  return { ok: true, conversation: conversationView(conversation, user, { withMessages: false }) };
};

route['POST /api/conversations/:id/read'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const conversation = h.assertConversationMember(user, h.conversationFor(ctx.params.id));
  conversation.receipts = conversation.receipts || {};
  conversation.receipts[user.id] = now();
  store.touch();
  for (const member of conversation.memberIds) {
    if (member === user.id) continue;
    realtime.send(member, { event: 'read', conversationId: conversation.id, userId: user.id, at: conversation.receipts[user.id] }, 'read');
  }
  return { ok: true };
};

// ----------------------------------------------------------------- messages
route['POST /api/conversations/:id/messages'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const limit = writeLimiter.hit(`msg:${user.id}`, 1);
  if (!limit.allowed) throw h.fail(429, 'You are sending messages very quickly. Pause for a moment.', 'rate_limited');
  const conversation = h.assertConversationMember(user, h.conversationFor(ctx.params.id));
  const payload = ctx.body.payload;
  if (!payload || !payload.iv || !payload.ct) throw h.fail(400, 'Encrypted payload missing.', 'bad_request');
  if (String(payload.ct).length > 512 * 1024) throw h.fail(413, 'That message is too large.', 'payload_too_large');

  const attachments = normalizeAttachments(ctx.body.attachments, user, conversation.id);
  const message = {
    id: store.nextId('m_'),
    convId: conversation.id,
    authorId: user.id,
    kind: ctx.body.kind === 'system' ? 'system' : 'text',
    payload,
    attachments,
    replyTo: ctx.body.replyTo ? String(ctx.body.replyTo) : null,
    replyPreview: ctx.body.replyPreview ? sanitizeText(ctx.body.replyPreview, 140) : null,
    reactions: {},
    votes: {},
    deleted: false,
    createdAt: now(),
  };
  store.db.messages[message.id] = message;
  store.db.convMessages[conversation.id] = store.db.convMessages[conversation.id] || [];
  store.db.convMessages[conversation.id].push(message.id);
  user.stats.messages += 1;
  user.history.lastMessageAt = message.createdAt;
  markConversationActivity(conversation, user, 'message.sent', { size: String(payload.ct).length, attachments: attachments.length });
  for (const file of attachments) {
    const record = store.db.files[file.fileId];
    if (record) {
      record.ref = Object.assign({}, record.ref, { messageId: message.id, conversationId: conversation.id });
      record.messageId = message.id;
    }
  }
  store.touch();

  const outbound = { event: 'message', conversationId: conversation.id, message: null };
  for (const member of conversation.memberIds) {
    if (member === user.id) continue;
    realtime.send(member, { event: 'message', conversationId: conversation.id, message: messageView(message, store.userById(member)) }, 'message');
  }
  return { ok: true, message: messageView(message, user) };
};

function normalizeAttachments(list, user, conversationId) {
  if (!list || !Array.isArray(list)) return [];
  const attachments = [];
  for (const entry of list.slice(0, 10)) {
    const file = store.db.files[String(entry.fileId)];
    if (!file) continue;
    if (file.ownerId !== user.id) continue;
    if (!file.complete) continue;
    h.checkDmUpload(user, file.size);
    attachments.push({ fileId: file.id, size: file.size, keyWrap: entry.keyWrap || file.keyWrap || null, type: sanitizeText(entry.type, 24) || 'file', poster: entry.poster || null });
  }
  return attachments;
}

route['GET /api/conversations/:id/messages'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const conversation = h.assertConversationMember(user, h.conversationFor(ctx.params.id));
  const limit = clampNumber(ctx.query.limit, 1, 200, 60);
  const ids = store.db.convMessages[conversation.id] || [];
  let slice = ids;
  if (ctx.query.before) {
    const index = ids.indexOf(String(ctx.query.before));
    if (index > -1) slice = ids.slice(0, index);
  }
  slice = slice.slice(-limit);
  const messages = slice.map((id) => store.db.messages[id]).filter(Boolean).map((m) => messageView(m, user, { includeKarma: true }));
  return { messages, hasMore: ids.length > slice.length && slice.length === limit };
};

route['POST /api/conversations/:id/typing'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const conversation = h.assertConversationMember(user, h.conversationFor(ctx.params.id));
  for (const member of conversation.memberIds) {
    if (member === user.id) continue;
    realtime.send(member, { event: 'typing', conversationId: conversation.id, userId: user.id, typing: !!ctx.body.typing }, 'typing');
  }
  return { ok: true };
};

// -------------------------------------------------- message interactions
route['POST /api/messages/:id/reactions'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const message = findMessage(ctx.params.id);
  if (!message) throw h.fail(404, 'That message is gone.', 'not_found');
  assertMessageAccess(user, message);
  const emoji = sanitizeText(ctx.body.emoji, 16);
  if (!emoji) throw h.fail(400, 'Pick an emoji first.', 'bad_request');
  const limit = writeLimiter.hit(`react:${user.id}`, 1);
  if (!limit.allowed) throw h.fail(429, 'Too many reactions at once.', 'rate_limited');
  message.reactions = message.reactions || {};
  const list = message.reactions[emoji] || [];
  const has = list.includes(user.id);
  message.reactions[emoji] = has ? list.filter((id) => id !== user.id) : [...list, user.id];
  if (!message.reactions[emoji].length) delete message.reactions[emoji];
  if (!has) user.stats.reactions += 1;
  store.touch();
  broadcastMessageUpdate(message);
  return { ok: true, reactions: messageView(message, user).reactions };
};

route['POST /api/messages/:id/vote'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const message = findMessage(ctx.params.id);
  if (!message) throw h.fail(404, 'That message is gone.', 'not_found');
  assertMessageAccess(user, message);
  if (message.authorId === user.id) throw h.fail(400, 'You cannot vote on your own message.', 'bad_request');
  const value = ctx.body.value === 1 ? 1 : ctx.body.value === -1 ? -1 : 0;
  message.votes = message.votes || {};
  const previous = message.votes[user.id] || 0;
  if (value === 0 || value === previous) delete message.votes[user.id];
  else message.votes[user.id] = value;
  store.touch();
  const view = messageView(message, user);
  broadcastMessageUpdate(message);
  return { ok: true, myVote: view.myVote, karma: value === 0 || value === previous ? null : messageKarma(message) };
};

function broadcastMessageUpdate(message) {
  const targets = updateTargets(message);
  if (targets === 'feed') {
    realtime.broadcast({ kind: 'forum.changed', forumId: message.forumId, messageId: message.id }, 'feed');
    realtime.send(message.authorId, { event: 'message.updated', messageId: message.id, message: messageView(message, store.userById(message.authorId)) }, 'message.updated');
    return;
  }
  for (const userId of targets) {
    realtime.send(userId, { event: 'message.updated', messageId: message.id, message: messageView(message, store.userById(userId)) }, 'message.updated');
  }
}

function assertMessageAccess(user, message) {
  if (h.isAdmin(user)) return true;
  if (message.convId) {
    const conversation = store.db.conversations[message.convId];
    if (!conversation || !conversation.memberIds.includes(user.id)) throw h.fail(403, 'Not your conversation.', 'forbidden');
    return true;
  }
  if (message.forumId) {
    const forum = store.db.forums[message.forumId];
    if (!forum) throw h.fail(404, 'Community not found.', 'not_found');
    if (forum.isPublic) return true;
    if (!forum.memberIds.includes(user.id)) throw h.fail(403, 'Not a member of this community.', 'forbidden');
    return true;
  }
  throw h.fail(403, 'Forbidden.', 'forbidden');
}

route['PATCH /api/messages/:id'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const message = findMessage(ctx.params.id);
  if (!message) throw h.fail(404, 'That message is gone.', 'not_found');
  assertMessageAccess(user, message);
  if (message.authorId !== user.id) throw h.fail(403, 'Only the author can edit a message.', 'forbidden');
  if (!ctx.body.payload || !ctx.body.payload.ct) throw h.fail(400, 'Encrypted payload missing.', 'bad_request');
  message.payload = ctx.body.payload;
  message.editedAt = now();
  store.touch();
  broadcastMessageUpdate(message);
  return { ok: true, message: messageView(message, user) };
};

route['DELETE /api/messages/:id'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const message = findMessage(ctx.params.id);
  if (!message) throw h.fail(404, 'That message is gone.', 'not_found');
  assertMessageAccess(user, message);

  if (message.convId && !h.isAdmin(user)) {
    throw h.fail(403, 'Direct messages and group chats cannot be deleted.', 'forbidden');
  }
  if (message.forumId && !h.isAdmin(user)) {
    const forum = store.db.forums[message.forumId];
    if (!forum || !forum.isPublic) throw h.fail(403, 'Posts in private communities cannot be deleted.', 'forbidden');
    if (message.authorId !== user.id) throw h.fail(403, 'Only the author can delete this post.', 'forbidden');
  }

  message.deleted = true;
  message.deletedBy = user.id;
  message.payload = null;
  message.attachments = [];
  message.reactions = {};
  store.touch();
  store.audit(user.id, 'message.deleted', { messageId: message.id, convId: message.convId, threadId: message.threadId });
  broadcastMessageUpdate(message);
  if (message.forumId) realtime.broadcast({ kind: 'forum.changed', forumId: message.forumId }, 'feed');
  return { ok: true };
};

// ---------------------------------------------------------------- communities
route['POST /api/forums'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const isPublic = !!ctx.body.isPublic;
  const name = sanitizeText(ctx.body.name, 60);
  if (name.length < 3) throw h.fail(400, 'Give the community a name of at least 3 characters.', 'bad_request');
  const candidate = String(ctx.body.id || '');
  const id = /^f_[A-Za-z0-9]{8,32}$/.test(candidate) && !store.db.forums[candidate] ? candidate : store.nextId('f_');
  const memberIds = [...new Set([user.id, ...(ctx.body.memberIds || []).map(String)])].filter((mid) => store.db.users[mid]);
  const forum = {
    id,
    name,
    isPublic,
    description: sanitizeText(ctx.body.description, 400),
    ownerId: user.id,
    memberIds,
    keyWraps: sanitizeWraps(ctx.body.keyWraps || {}, memberIds),
    operatorWrap: sanitizeWrap(ctx.body.operatorWrap),
    publicSeed: isPublic ? require('crypto').randomBytes(32).toString('base64') : null,
    createdAt: now(),
    lastActivityAt: now(),
    stats: { threads: 0, posts: 0 },
  };
  store.db.forums[id] = forum;
  store.touch();
  store.pushEvent({ type: 'forum.created', userId: user.id, detail: { forumId: id, isPublic } });
  realtime.broadcast({ kind: 'forum.created', forumId: id }, 'feed');
  return { forum: forumView(forum, user) };
};

function forumView(forum, viewer) {
  const isMember = forum.memberIds.includes(viewer.id);
  return {
    id: forum.id,
    name: forum.name,
    description: forum.description,
    isPublic: forum.isPublic,
    ownerId: forum.ownerId,
    isOwner: forum.ownerId === viewer.id,
    isMember,
    memberCount: forum.memberIds.length,
    keyWrap: forum.keyWraps[viewer.id] || null,
    operatorWrap: forum.operatorWrap || null,
    publicSeed: forum.isPublic ? forum.publicSeed : null,
    createdAt: forum.createdAt,
    lastActivityAt: forum.lastActivityAt,
    stats: forum.stats,
    members: forum.memberIds.slice(0, 24).map((id) => h.publicUser(store.userById(id))).filter(Boolean),
  };
}

route['GET /api/forums'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const forums = Object.values(store.db.forums)
    .filter((f) => f.isPublic || f.memberIds.includes(user.id))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .map((f) => forumView(f, user));
  return { forums };
};

route['GET /api/forums/:id'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const forum = h.assertForumAccess(user, h.forumFor(ctx.params.id));
  const threads = (store.db.forumThreads?.[forum.id] || [])
    .map((id) => store.db.threads[id])
    .filter(Boolean)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .map((t) => threadView(t, user));
  return { forum: forumView(forum, user), threads };
};

function threadView(thread, viewer) {
  return {
    id: thread.id,
    forumId: thread.forumId,
    authorId: thread.authorId,
    title: thread.titlePayload || null,
    payload: thread.deleted ? null : thread.payload,
    attachments: thread.deleted ? [] : (thread.attachments || []),
    createdAt: thread.createdAt,
    lastActivityAt: thread.lastActivityAt,
    postCount: thread.postCount,
    pinned: !!thread.pinned,
    locked: !!thread.locked,
    deleted: !!thread.deleted,
    own: thread.authorId === viewer.id,
    karma: h.isAdmin(viewer) ? threadKarmaSum(thread) : undefined,
  };
}

function threadKarmaSum(thread) {
  const ids = store.db.threadPosts[thread.id] || [];
  let up = 0; let down = 0;
  for (const postId of ids) {
    const post = store.db.posts[postId];
    if (!post) continue;
    const karma = messageKarma(post);
    up += karma.up;
    down += karma.down;
  }
  return { up, down, score: up - down };
}

route['POST /api/forums/:id/threads'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const forum = h.assertForumAccess(user, h.forumFor(ctx.params.id));
  if (!forum.isPublic && !forum.memberIds.includes(user.id)) throw h.fail(403, 'Join the community before posting.', 'forbidden');
  const limit = postLimiter.hit(`thread:${user.id}`, 1);
  if (!limit.allowed) throw h.fail(429, 'Slow down on new threads.', 'rate_limited');
  if (!ctx.body.payload || !ctx.body.payload.ct) throw h.fail(400, 'Encrypted payload missing.', 'bad_request');
  const attachments = normalizeForumAttachments(ctx.body.attachments, user, forum);
  const id = store.nextId('t_');
  const thread = {
    id,
    forumId: forum.id,
    authorId: user.id,
    payload: ctx.body.payload,
    titlePayload: ctx.body.titlePayload || null,
    attachments,
    createdAt: now(),
    lastActivityAt: now(),
    postCount: 0,
    pinned: false,
    locked: false,
    deleted: false,
  };
  store.db.threads[id] = thread;
  store.db.forumThreads = store.db.forumThreads || {};
  store.db.forumThreads[forum.id] = store.db.forumThreads[forum.id] || [];
  store.db.forumThreads[forum.id].push(id);
  store.db.threadPosts[id] = [];
  forum.stats.threads += 1;
  forum.lastActivityAt = thread.createdAt;
  user.stats.posts += 1;
  user.history.lastPostAt = thread.createdAt;
  for (const file of attachments) {
    const record = store.db.files[file.fileId];
    if (record) record.ref = Object.assign({}, record.ref, { threadId: id, forumId: forum.id });
  }
  store.touch();
  store.pushEvent({ type: 'forum.thread', userId: user.id, detail: { forumId: forum.id, threadId: id, isPublic: forum.isPublic, attachments: attachments.length } });
  realtime.broadcast({ kind: 'forum.changed', forumId: forum.id, threadId: id }, 'feed');
  return { thread: threadView(thread, user) };
};

function normalizeForumAttachments(list, user, forum) {
  const attachments = [];
  const settings = user.settings || {};
  if (list && list.length && !settings.forumMedia) {
    throw h.fail(403, 'Enable "Media in communities" in Settings before posting images or files to communities.', 'forum_media_disabled');
  }
  for (const entry of (list || []).slice(0, 8)) {
    const file = store.db.files[String(entry.fileId)];
    if (!file || file.ownerId !== user.id || !file.complete) continue;
    if (file.kind !== 'forum') throw h.fail(400, 'That upload was not prepared for a community post.', 'bad_kind');
    h.checkDmUpload(user, file.size);
    attachments.push({ fileId: file.id, size: file.size, keyWrap: entry.keyWrap || file.keyWrap || null, type: sanitizeText(entry.type, 24) || 'image', poster: entry.poster || null });
  }
  return attachments;
}

route['GET /api/threads/:id'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const thread = store.db.threads[ctx.params.id];
  if (!thread) throw h.fail(404, 'Thread not found.', 'not_found');
  const forum = h.assertForumAccess(user, h.forumFor(thread.forumId));
  const ids = store.db.threadPosts[thread.id] || [];
  const limit = clampNumber(ctx.query.limit, 1, 200, 80);
  let slice = ids;
  if (ctx.query.before) {
    const index = ids.indexOf(String(ctx.query.before));
    if (index > -1) slice = ids.slice(0, index);
  }
  slice = slice.slice(-limit);
  const posts = slice.map((id) => store.db.posts[id]).filter(Boolean).map((p) => messageView(p, user, { includeKarma: true }));
  return { thread: threadView(thread, user), forum: forumView(forum, user), posts };
};

route['POST /api/threads/:id/posts'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const thread = store.db.threads[ctx.params.id];
  if (!thread) throw h.fail(404, 'Thread not found.', 'not_found');
  const forum = h.assertForumAccess(user, h.forumFor(thread.forumId));
  if (thread.locked && !h.isAdmin(user)) throw h.fail(403, 'This thread is locked.', 'locked');
  const limit = postLimiter.hit(`post:${user.id}`, 1);
  if (!limit.allowed) throw h.fail(429, 'Slow down on replies.', 'rate_limited');
  if (!ctx.body.payload || !ctx.body.payload.ct) throw h.fail(400, 'Encrypted payload missing.', 'bad_request');
  const attachments = normalizeForumAttachments(ctx.body.attachments, user, forum);
  const id = store.nextId('p_');
  const post = {
    id,
    threadId: thread.id,
    forumId: forum.id,
    authorId: user.id,
    payload: ctx.body.payload,
    attachments,
    replyTo: ctx.body.replyTo ? String(ctx.body.replyTo) : null,
    replyPreview: ctx.body.replyPreview ? sanitizeText(ctx.body.replyPreview, 140) : null,
    reactions: {},
    votes: {},
    deleted: false,
    createdAt: now(),
  };
  store.db.posts[id] = post;
  store.db.threadPosts[thread.id].push(id);
  thread.postCount += 1;
  thread.lastActivityAt = post.createdAt;
  forum.stats.posts += 1;
  forum.lastActivityAt = post.createdAt;
  user.stats.posts += 1;
  user.history.lastPostAt = post.createdAt;
  store.touch();
  store.pushEvent({ type: 'forum.reply', userId: user.id, detail: { forumId: forum.id, threadId: thread.id, postId: id, isPublic: forum.isPublic, attachments: attachments.length } });
  realtime.broadcast({ kind: 'forum.changed', forumId: forum.id, threadId: thread.id }, 'feed');
  return { post: messageView(post, user, { includeKarma: true }) };
};

route['DELETE /api/threads/:id'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const thread = store.db.threads[ctx.params.id];
  if (!thread) throw h.fail(404, 'Thread not found.', 'not_found');
  const forum = h.forumFor(thread.forumId);
  if (!forum) throw h.fail(404, 'Community not found.', 'not_found');
  const isOwner = thread.authorId === user.id;
  if (!h.isAdmin(user)) {
    if (!forum.isPublic) throw h.fail(403, 'Threads in private communities cannot be deleted.', 'forbidden');
    if (!isOwner) throw h.fail(403, 'Only the author can delete this thread.', 'forbidden');
  }
  thread.deleted = true;
  thread.payload = null;
  thread.titlePayload = null;
  thread.attachments = [];
  thread.deletedBy = user.id;
  store.touch();
  store.audit(user.id, 'thread.deleted', { threadId: thread.id, forumId: forum.id });
  realtime.broadcast({ kind: 'forum.changed', forumId: forum.id }, 'feed');
  return { ok: true };
};

route['POST /api/forums/:id/members'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const forum = h.assertForumAccess(user, h.forumFor(ctx.params.id));
  if (forum.isPublic) return { ok: true, forum: forumView(forum, user) };
  const ids = (ctx.body.userId ? [ctx.body.userId] : (ctx.body.memberIds || [])).map(String);
  const needsInvite = !forum.memberIds.includes(user.id);
  if (needsInvite) {
    if (!ctx.body.invite && !h.isAdmin(user)) {
      // joining a private community requires an owner-added membership
      throw h.fail(403, 'This community is invite-only.', 'forbidden');
    }
    forum.memberIds.push(user.id);
    forum.keyWraps = Object.assign({}, forum.keyWraps, sanitizeWraps(ctx.body.keyWraps || {}, forum.memberIds));
  } else if (forum.ownerId === user.id || h.isAdmin(user)) {
    for (const id of ids) {
      if (!store.db.users[id] || forum.memberIds.includes(id)) continue;
      forum.memberIds.push(id);
    }
    forum.keyWraps = Object.assign({}, forum.keyWraps, sanitizeWraps(ctx.body.keyWraps || {}, forum.memberIds));
  } else {
    throw h.fail(403, 'Only the community owner can manage membership.', 'forbidden');
  }
  store.touch();
  realtime.broadcast({ kind: 'forum.changed', forumId: forum.id }, 'feed');
  return { ok: true, forum: forumView(forum, user) };
};

// ------------------------------------------------------------------- stories
route['POST /api/stories'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const profile = user.publicProfile;
  if (!profile.enabled) throw h.fail(403, 'Turn on your public profile before posting a story.', 'public_disabled');
  const kind = ['image', 'video'].includes(ctx.body.kind) ? ctx.body.kind : 'image';
  const file = store.db.files[String(ctx.body.fileId)];
  if (!file || file.ownerId !== user.id || !file.complete) throw h.fail(400, 'Upload the media before publishing the story.', 'bad_file');
  if (file.kind !== 'story') throw h.fail(400, 'That upload was not prepared as a story.', 'bad_kind');
  h.checkStoryUpload(user, file.size);
  const story = {
    id: store.nextId('st_'),
    userId: user.id,
    kind,
    fileId: file.id,
    payload: ctx.body.payload || null,
    caption: sanitizeText(ctx.body.caption, 200),
    createdAt: now(),
    expiresAt: now() + 1000 * 60 * 60 * 24,
    views: [],
    reactions: {},
  };
  store.db.stories[story.id] = story;
  file.ref = Object.assign({}, file.ref, { storyId: story.id });
  store.touch();
  store.pushEvent({ type: 'story.posted', userId: user.id, detail: { storyId: story.id, kind, size: file.size } });
  realtime.broadcast({ kind: 'stories.changed' }, 'feed');
  return { story: storyView(story, user) };
};

function storyView(story, viewer) {
  const author = store.userById(story.userId);
  return {
    id: story.id,
    kind: story.kind,
    fileId: story.fileId,
    payload: story.payload,
    caption: story.caption,
    createdAt: story.createdAt,
    expiresAt: story.expiresAt,
    author: author ? h.publicUser(author, { includeBio: true }) : null,
    views: story.views.length,
    seen: viewer ? story.views.includes(viewer.id) : false,
    reactions: Object.fromEntries(Object.entries(story.reactions || {}).map(([emoji, ids]) => [emoji, { count: ids.length, mine: !!viewer && ids.includes(viewer.id) }])),
    own: viewer ? story.userId === viewer.id : false,
  };
}

route['GET /api/stories'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const t = now();
  const stories = Object.values(store.db.stories)
    .filter((s) => s.expiresAt > t)
    .filter((s) => {
      const author = store.userById(s.userId);
      if (!author) return false;
      if (author.id === user.id) return true;
      return author.publicProfile.enabled;
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((s) => storyView(s, user));
  return { stories };
};

route['POST /api/stories/:id/seen'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const story = store.db.stories[ctx.params.id];
  if (!story) throw h.fail(404, 'Story not found.', 'not_found');
  if (!story.views.includes(user.id)) {
    story.views.push(user.id);
    store.touch();
  }
  return { ok: true };
};

route['POST /api/stories/:id/reactions'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const story = store.db.stories[ctx.params.id];
  if (!story) throw h.fail(404, 'Story not found.', 'not_found');
  const emoji = sanitizeText(ctx.body.emoji, 16);
  if (!emoji) throw h.fail(400, 'Pick an emoji.', 'bad_request');
  story.reactions = story.reactions || {};
  const list = story.reactions[emoji] || [];
  story.reactions[emoji] = list.includes(user.id) ? list.filter((id) => id !== user.id) : [...list, user.id];
  if (!story.reactions[emoji].length) delete story.reactions[emoji];
  store.touch();
  return { ok: true, reactions: storyView(story, user).reactions };
};

route['DELETE /api/stories/:id'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const story = store.db.stories[ctx.params.id];
  if (!story) throw h.fail(404, 'Story not found.', 'not_found');
  if (story.userId !== user.id && !h.isAdmin(user)) throw h.fail(403, 'Only the author can remove this story.', 'forbidden');
  const file = store.db.files[story.fileId];
  if (file) h.releaseFile(file, 'story');
  delete store.db.stories[story.id];
  store.touch();
  realtime.broadcast({ kind: 'stories.changed' }, 'feed');
  return { ok: true };
};

// ------------------------------------------------------- public talk section
route['POST /api/public/posts'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  if (!user.publicProfile.enabled) throw h.fail(403, 'Enable your public profile to post in the public square.', 'public_disabled');
  const limit = postLimiter.hit(`pub:${user.id}`, 1);
  if (!limit.allowed) throw h.fail(429, 'Slow down a little.', 'rate_limited');
  const payload = ctx.body.payload;
  if (!payload || !payload.ct) throw h.fail(400, 'Encrypted payload missing.', 'bad_request');
  if (String(payload.ct).length > 64 * 1024) throw h.fail(413, 'Post is too large.', 'payload_too_large');
  const post = {
    id: store.nextId('pp_'),
    userId: user.id,
    payload,
    attachments: (ctx.body.attachments || []).slice(0, 4).map((entry) => {
      const file = store.db.files[String(entry.fileId)];
      if (!file || file.ownerId !== user.id || !file.complete) return null;
      if (file.kind !== 'public') throw h.fail(400, 'That upload was not prepared for a public post.', 'bad_kind');
      return { fileId: file.id, size: file.size, keyWrap: entry.keyWrap || file.keyWrap || null, type: sanitizeText(entry.type, 24) || 'image' };
    }).filter(Boolean),
    reactions: {},
    createdAt: now(),
    hidden: false,
  };
  store.db.publicPosts = store.db.publicPosts || {};
  store.db.publicPosts[post.id] = post;
  store.db.publicFeed = store.db.publicFeed || [];
  store.db.publicFeed.push(post.id);
  user.stats.posts += 1;
  user.history.lastPostAt = post.createdAt;
  store.touch();
  store.pushEvent({ type: 'public.post', userId: user.id, detail: { postId: post.id } });
  realtime.broadcast({ kind: 'public.changed' }, 'feed');
  return { post: publicPostView(post, user) };
};

function publicPostView(post, viewer) {
  const author = store.userById(post.userId);
  if (author && !author.publicProfile.enabled && author.id !== viewer.id && !h.isAdmin(viewer)) return null;
  return {
    id: post.id,
    author: author ? h.publicUser(author, { includeBio: false }) : null,
    payload: post.payload,
    attachments: post.attachments,
    reactions: Object.fromEntries(Object.entries(post.reactions || {}).map(([emoji, ids]) => [emoji, { count: ids.length, mine: !!viewer && ids.includes(viewer.id) }])),
    createdAt: post.createdAt,
    own: post.userId === viewer.id,
    hidden: !!post.hidden,
  };
}

route['GET /api/public/feed'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const ids = (store.db.publicFeed || []).slice(-120).reverse();
  const posts = ids
    .map((id) => store.db.publicPosts[id])
    .filter(Boolean)
    .map((p) => publicPostView(p, user))
    .filter(Boolean);
  const people = store.allUsers()
    .filter((u) => u.publicProfile.enabled && u.id !== user.id)
    .sort((a, b) => (b.publicProfile.updatedAt || 0) - (a.publicProfile.updatedAt || 0))
    .slice(0, 60)
    .map((u) => h.publicUser(u, { includeBio: true }));
  return { posts, people };
};

route['POST /api/public/posts/:id/reactions'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const post = (store.db.publicPosts || {})[ctx.params.id];
  if (!post) throw h.fail(404, 'Post not found.', 'not_found');
  const emoji = sanitizeText(ctx.body.emoji, 16);
  if (!emoji) throw h.fail(400, 'Pick an emoji.', 'bad_request');
  post.reactions = post.reactions || {};
  const list = post.reactions[emoji] || [];
  post.reactions[emoji] = list.includes(user.id) ? list.filter((id) => id !== user.id) : [...list, user.id];
  if (!post.reactions[emoji].length) delete post.reactions[emoji];
  store.touch();
  return { ok: true, reactions: publicPostView(post, user).reactions };
};

route['DELETE /api/public/posts/:id'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const post = (store.db.publicPosts || {})[ctx.params.id];
  if (!post) throw h.fail(404, 'Post not found.', 'not_found');
  if (post.userId !== user.id && !h.isAdmin(user)) throw h.fail(403, 'Only the author or an administrator can remove this.', 'forbidden');
  delete store.db.publicPosts[post.id];
  store.db.publicFeed = (store.db.publicFeed || []).filter((id) => id !== post.id);
  store.touch();
  realtime.broadcast({ kind: 'public.changed' }, 'feed');
  return { ok: true };
};

route['GET /api/public/profile/:id'] = async (ctx) => {
  const viewer = h.requireAuth(ctx);
  const target = store.userById(String(ctx.params.id));
  if (!target) throw h.fail(404, 'Profile not found.', 'not_found');
  const isSelf = target.id === viewer.id;
  if (!target.publicProfile.enabled && !isSelf && !h.isAdmin(viewer)) throw h.fail(404, 'This account keeps a private profile.', 'not_found');
  const stories = Object.values(store.db.stories)
    .filter((s) => s.userId === target.id && s.expiresAt > now())
    .map((s) => storyView(s, viewer));
  const posts = (store.db.publicFeed || [])
    .map((id) => store.db.publicPosts[id])
    .filter((p) => p && p.userId === target.id)
    .slice(-30)
    .reverse()
    .map((p) => publicPostView(p, viewer))
    .filter(Boolean);
  return {
    profile: Object.assign(h.publicUser(target, { includeBio: true }), {
      publicImages: target.publicProfile.images,
      stats: { posts: posts.length, stories: stories.length, joined: target.createdAt },
    }),
    stories,
    posts,
  };
};

// ------------------------------------------------------------------ airdrop
route['GET /api/airdrop'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const t = now();
  const incoming = Object.values(store.db.airdrops || {})
    .filter((a) => a.expiresAt > t && (a.recipientIds.includes(user.id) || a.adminIds.includes(user.id)))
    .filter((a) => a.senderId !== user.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 80)
    .map((a) => ({
      id: a.id,
      senderId: a.senderId,
      sender: h.publicUser(store.userById(a.senderId)),
      kind: a.kind,
      payload: a.payload,
      fileId: a.fileId,
      size: a.size,
      createdAt: a.createdAt,
      keyWrap: a.keyWraps[user.id] || null,
      offlineDelivered: a.adminIds.includes(user.id) && !a.recipientIds.includes(user.id),
      seen: (a.ackedBy || []).includes(user.id),
    }));
  return {
    airdrops: incoming,
    count: incoming.filter((a) => !a.seen).length,
    enabled: !!(user.settings && user.settings.airdrop),
  };
};

route['POST /api/airdrop/ack-all'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const t = now();
  for (const airdrop of Object.values(store.db.airdrops || {})) {
    if (airdrop.expiresAt <= t) continue;
    if (!airdrop.recipientIds.includes(user.id) && !airdrop.adminIds.includes(user.id)) continue;
    airdrop.ackedBy = airdrop.ackedBy || [];
    if (!airdrop.ackedBy.includes(user.id)) airdrop.ackedBy.push(user.id);
  }
  store.touch();
  return { ok: true };
};

module.exports = { routes: route, findMessage, ensureDirectConversation, messageView, messageKarma, conversationView, forumView, threadView, storyView, publicPostView };
