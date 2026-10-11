'use strict';

const os = require('os');
const fs = require('fs');
const { store, BLOB_DIR } = require('./store');
const { realtime } = require('./realtime');
const h = require('./helpers');
const { now, clampNumber, sanitizeText, formatBytes, isoWeek } = require('./util');
const { requestToView } = require('./routes-auth');
const { messageView, messageKarma, forumView, threadView } = require('./routes-social');

const route = {};

function activeSessions(userId) {
  return store.userSessions(userId);
}

function dirSize(dir, depth = 0) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (depth < 2) total += dirSize(full, depth + 1);
      } else {
        try { total += fs.statSync(full).size; } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return total;
}

// ------------------------------------------------------------------ overview
route['GET /api/admin/overview'] = async (ctx) => {
  h.requireAdmin(ctx);
  const stats = store.stats();
  const mem = process.memoryUsage();
  const series = store.metricsSeries(60);
  const totals = series.reduce((acc, point) => {
    acc.requests += point.req;
    acc.bytesIn += point.bytesIn;
    acc.bytesOut += point.bytesOut;
    acc.messages += point.msgs;
    acc.uploads += point.uploads;
    return acc;
  }, { requests: 0, bytesIn: 0, bytesOut: 0, messages: 0, uploads: 0 });

  const usersByRole = { owner: 0, admin: 0, mod: 0, member: 0 };
  let banned = 0;
  let verified = 0;
  for (const user of store.allUsers()) {
    usersByRole[user.role] = (usersByRole[user.role] || 0) + 1;
    if (user.banned) banned += 1;
    if (user.verified) verified += 1;
  }

  const lastMinute = series[series.length - 1] || { req: 0 };
  const previous = series[series.length - 2] || { req: 0 };
  const openRequests = Object.values(store.db.requests).filter((r) => r.status === 'open').length;

  return {
    server: {
      name: 'AE Secure',
      version: '1.0.0',
      node: process.version,
      platform: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      hostname: os.hostname(),
      uptime: process.uptime(),
      processUptime: process.uptime(),
      startedAt: Date.now() - process.uptime() * 1000,
      loadAverage: os.loadavg(),
      cpuCount: os.cpus().length,
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
        systemTotal: os.totalmem(),
        systemFree: os.freemem(),
      },
      dataDirBytes: dirSize(BLOB_DIR),
    },
    traffic: {
      series,
      totals,
      requestsPerMinute: lastMinute.req || 0,
      trend: (lastMinute.req || 0) - (previous.req || 0),
      neuralSubscribers: realtime.neuralSubscribers,
      liveSockets: realtime.clients.size,
      onlineUsers: realtime.onlineUserIds().length,
    },
    counts: Object.assign({}, stats, { usersByRole, banned, verified, openRequests }),
    storage: stats.storage,
    recent: store.db.events.slice(-30).reverse().map(eventSummary),
    topUsers: store.allUsers()
      .sort((a, b) => (b.history.lastMessageAt || 0) - (a.history.lastMessageAt || 0))
      .slice(0, 8)
      .map((u) => ({
        id: u.id,
        displayName: u.displayName,
        username: u.username,
        avatarId: u.avatarId,
        verified: u.verified,
        role: u.role,
        lastMessageAt: u.history.lastMessageAt,
        lastUploadAt: u.history.lastUploadAt,
        storage: store.db.files ? Object.values(store.db.files).filter((f) => f.ownerId === u.id).reduce((sum, f) => sum + f.size, 0) : 0,
      })),
    clicker: { total: store.db.counters.clicks || 0, week: (store.db.counters.clickWeeks || {})[isoWeek()] || 0 },
    global: store.db.global,
  };
};

function eventSummary(event) {
  const user = store.userById(event.userId);
  return {
    id: event.id,
    at: event.at,
    type: event.type,
    userId: event.userId,
    handle: user ? (user.publicProfile.enabled && user.publicProfile.alias ? user.publicProfile.alias : user.displayName) : 'system',
    avatarId: user ? user.avatarId : null,
    detail: event.detail || {},
  };
}

// ------------------------------------------------------------------ users
function adminUserRow(user) {
  const storage = Object.values(store.db.files).filter((f) => f.ownerId === user.id).reduce((sum, f) => sum + f.size, 0);
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarId: user.avatarId,
    role: user.role,
    verified: user.verified,
    purpleAllowed: user.purpleAllowed,
    banned: user.banned,
    disabled: user.disabled,
    createdAt: user.createdAt,
    bio: user.bio,
    limits: user.limits,
    driveUsed: user.driveUsed,
    uploadUsed: user.uploadUsed,
    storageBytes: storage,
    publicProfile: {
      enabled: user.publicProfile.enabled,
      alias: user.publicProfile.alias,
      stories: Object.values(store.db.stories).filter((s) => s.userId === user.id).length,
      images: user.publicProfile.images.length,
    },
    stats: user.stats,
    history: user.history,
    status: realtime.statusOf(user.id),
    sessions: activeSessions(user.id).length,
    clicks: (store.db.clicksByUser || {})[user.id] || 0,
    karma: karmaForUser(user.id),
  };
}
route.adminUserRow = adminUserRow;

function karmaForUser(userId) {
  let up = 0; let down = 0;
  let receivedUp = 0; let receivedDown = 0;
  for (const message of Object.values(store.db.messages)) {
    if (!message.votes) continue;
    for (const [voterId, value] of Object.entries(message.votes)) {
      if (voterId === userId) { if (value > 0) up += 1; else down += 1; }
      if (message.authorId === userId) { if (value > 0) receivedUp += 1; else receivedDown += 1; }
    }
  }
  for (const post of Object.values(store.db.posts || {})) {
    if (!post.votes) continue;
    for (const [voterId, value] of Object.entries(post.votes)) {
      if (voterId === userId) { if (value > 0) up += 1; else down += 1; }
      if (post.authorId === userId) { if (value > 0) receivedUp += 1; else receivedDown += 1; }
    }
  }
  return { given: { up, down }, received: { up: receivedUp, down: receivedDown }, score: receivedUp - receivedDown };
}

route['GET /api/admin/users'] = async (ctx) => {
  h.requireAdmin(ctx);
  const q = String(ctx.query.q || '').toLowerCase().trim();
  const role = ctx.query.role ? String(ctx.query.role) : '';
  const filter = ctx.query.filter ? String(ctx.query.filter) : '';
  let users = store.allUsers();
  if (q) {
    users = users.filter((u) => u.username.toLowerCase().includes(q)
      || (u.displayName || '').toLowerCase().includes(q)
      || (u.publicProfile.alias || '').toLowerCase().includes(q));
  }
  if (role) users = users.filter((u) => u.role === role);
  if (filter === 'verified') users = users.filter((u) => u.verified);
  if (filter === 'banned') users = users.filter((u) => u.banned);
  if (filter === 'online') {
    const online = new Set(realtime.onlineUserIds());
    users = users.filter((u) => online.has(u.id));
  }
  if (filter === 'pending') {
    const pending = new Set(Object.values(store.db.requests).filter((r) => r.status === 'open').map((r) => r.userId));
    users = users.filter((u) => pending.has(u.id));
  }
  users.sort((a, b) => b.createdAt - a.createdAt);
  return {
    users: users.map(adminUserRow),
    totals: { count: users.length, openRequests: Object.values(store.db.requests).filter((r) => r.status === 'open').length },
  };
};

route['GET /api/admin/users/:id'] = async (ctx) => {
  h.requireAdmin(ctx);
  const user = store.userById(String(ctx.params.id));
  if (!user) throw h.fail(404, 'User not found.', 'not_found');
  const files = Object.values(store.db.files).filter((f) => f.ownerId === user.id);
  const conversations = Object.values(store.db.conversations).filter((c) => c.memberIds.includes(user.id));
  return {
    user: adminUserRow(user),
    detail: {
      sessions: activeSessions(user.id).map((s) => ({
        id: s.id,
        device: s.device,
        platform: s.platform,
        ip: s.ip,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        current: false,
      })),
      files: files.slice(0, 100).map((f) => ({
        id: f.id,
        kind: f.kind,
        size: f.size,
        complete: f.complete,
        createdAt: f.createdAt,
        meta: f.meta,
      })),
      stories: Object.values(store.db.stories).filter((s) => s.userId === user.id).map((s) => ({
        id: s.id,
        kind: s.kind,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        views: s.views.length,
        size: (store.db.files[s.fileId] || {}).size || 0,
      })),
      conversations: conversations.map((c) => ({
        id: c.id,
        type: c.type,
        members: c.memberIds.length,
        lastMessageAt: c.lastMessageAt,
      })),
      requests: Object.values(store.db.requests).filter((r) => r.userId === user.id).map((r) => requestToView(r, true)),
      messagesSent: user.stats.messages,
      bio: user.bio,
      clicks: (store.db.clicksByUser || {})[user.id] || 0,
      karma: karmaForUser(user.id),
      ips: [...new Set(activeSessions(user.id).map((s) => s.ip).filter(Boolean))],
      devices: [...new Set(activeSessions(user.id).map((s) => s.device))],
    },
  };
};

route['PATCH /api/admin/users/:id'] = async (ctx) => {
  const admin = h.requireAdmin(ctx);
  const user = store.userById(String(ctx.params.id));
  if (!user) throw h.fail(404, 'User not found.', 'not_found');
  const body = ctx.body || {};
  if (user.role === 'owner' && admin.role !== 'owner') throw h.fail(403, 'Only the owner can modify the owner account.', 'forbidden');
  const before = {
    role: user.role,
    verified: user.verified,
    purpleAllowed: user.purpleAllowed,
    limits: Object.assign({}, user.limits),
  };
  if (body.role && ['member', 'mod', 'admin'].includes(body.role)) {
    if (admin.role === 'owner' || (admin.role === 'admin' && ['member', 'mod'].includes(body.role))) {
      user.role = body.role;
    }
  }
  if (body.ownerTransfer === true && admin.role === 'owner' && user.id !== admin.id) {
    user.role = 'owner';
    admin.role = 'admin';
  }
  if (body.verified !== undefined) user.verified = !!body.verified;
  if (body.purpleAllowed !== undefined) user.purpleAllowed = !!body.purpleAllowed;
  if (body.banned !== undefined) {
    user.banned = !!body.banned;
    if (user.banned) store.revokeUserSessions(user.id);
  }
  if (body.disabled !== undefined) {
    user.disabled = !!body.disabled;
    if (user.disabled) store.revokeUserSessions(user.id);
  }
  if (body.displayName !== undefined) user.displayName = sanitizeText(body.displayName, 40) || user.username;
  if (body.bio !== undefined) user.bio = sanitizeText(body.bio, 400);
  if (body.limits && typeof body.limits === 'object') {
    const limits = body.limits;
    const apply = (key) => {
      if (limits[key] === undefined) return;
      const value = Number(limits[key]);
      if (!Number.isFinite(value) || value === -1) user.limits[key] = -1;
      else user.limits[key] = clampNumber(value, 1024, 100 * 1024 * 1024 * 1024 * 1024, user.limits[key]);
    };
    apply('dmUploadBytes');
    apply('driveQuotaBytes');
    apply('storyQuotaBytes');
    user.limits.updatedAt = now();
    user.limits.updatedBy = admin.id;
  }
  if (body.resetDrive) user.driveUsed = 0;
  store.touch();
  store.audit(admin.id, 'admin.user_updated', { userId: user.id, before, after: { role: user.role, verified: user.verified, purpleAllowed: user.purpleAllowed, limits: user.limits } });
  realtime.send(user.id, {
    event: 'account.updated',
    source: 'admin',
    limits: user.limits,
    verified: user.verified,
    purpleAllowed: user.purpleAllowed,
    banned: user.banned,
    disabled: user.disabled,
  }, 'account.updated');
  if (user.banned || user.disabled) realtime.send(user.id, { event: 'session.killed', reason: user.banned ? 'banned' : 'disabled' }, 'session.killed');
  return { ok: true, user: adminUserRow(user) };
};

route['GET /api/admin/users/:id/sessions'] = async (ctx) => {
  h.requireAdmin(ctx);
  const user = store.userById(String(ctx.params.id));
  if (!user) throw h.fail(404, 'User not found.', 'not_found');
  return {
    sessions: activeSessions(user.id).map((s) => ({
      token: s.token,
      id: s.id,
      device: s.device,
      platform: s.platform,
      ip: s.ip,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      ua: s.ua,
    })),
  };
};

route['POST /api/admin/sessions/revoke'] = async (ctx) => {
  const admin = h.requireAdmin(ctx);
  const token = String(ctx.body.token || '');
  const session = store.sessionByToken(token);
  if (!session) throw h.fail(404, 'That session already ended.', 'not_found');
  const user = store.userById(session.userId);
  realtime.send(session.userId, { event: 'session.killed', reason: 'admin', device: session.device }, 'session.killed');
  store.revokeSession(token);
  store.audit(admin.id, 'admin.session_revoked', { userId: session.userId, device: session.device, ip: session.ip });
  realtime.send(session.userId, {
    event: 'notify',
    level: 'warning',
    title: 'Session ended by an administrator',
    body: `The session on ${session.device} was signed out by ${admin.role === 'owner' ? 'the operator' : 'an administrator'}.`,
  }, 'notify');
  return { ok: true, handle: user ? user.username : null };
};

route['POST /api/admin/users/:id/sessions/revoke-all'] = async (ctx) => {
  const admin = h.requireAdmin(ctx);
  const user = store.userById(String(ctx.params.id));
  if (!user) throw h.fail(404, 'User not found.', 'not_found');
  const removed = store.revokeUserSessions(user.id);
  realtime.send(user.id, { event: 'session.killed', reason: 'admin-all' }, 'session.killed');
  store.audit(admin.id, 'admin.sessions_revoked_all', { userId: user.id, removed });
  return { ok: true, removed };
};

route['DELETE /api/admin/users/:id'] = async (ctx) => {
  const admin = h.requireAdmin(ctx);
  const user = store.userById(String(ctx.params.id));
  if (!user) throw h.fail(404, 'User not found.', 'not_found');
  if (user.role === 'owner') throw h.fail(403, 'The owner account cannot be deleted.', 'forbidden');
  for (const file of Object.values(store.db.files)) {
    if (file.ownerId === user.id) h.releaseFile(file, file.kind);
  }
  for (const [storyId, story] of Object.entries(store.db.stories)) {
    if (story.userId === user.id) delete store.db.stories[storyId];
  }
  store.revokeUserSessions(user.id);
  store.removeUser(user.id);
  store.audit(admin.id, 'admin.user_deleted', { handle: user.username, userId: user.id });
  realtime.broadcast({ kind: 'users.changed' }, 'feed');
  return { ok: true };
};

// ------------------------------------------------------------------ requests
route['GET /api/admin/requests'] = async (ctx) => {
  h.requireAdmin(ctx);
  const status = ctx.query.status ? String(ctx.query.status) : '';
  const requests = Object.values(store.db.requests)
    .filter((r) => (status ? r.status === status : true))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 300)
    .map((r) => requestToView(r, true));
  const counts = { open: 0, approved: 0, denied: 0, expired: 0, contacted: 0 };
  for (const request of Object.values(store.db.requests)) counts[request.status] = (counts[request.status] || 0) + 1;
  return { requests, counts };
};

route['POST /api/admin/requests/:id/decision'] = async (ctx) => {
  const admin = h.requireAdmin(ctx);
  const request = store.db.requests[ctx.params.id];
  if (!request) throw h.fail(404, 'Request not found.', 'not_found');
  const user = store.userById(request.userId);
  if (!user) throw h.fail(404, 'That account no longer exists.', 'not_found');
  const decision = ctx.body.decision === 'approve' ? 'approve' : ctx.body.decision === 'deny' ? 'deny' : null;
  if (!decision) throw h.fail(400, 'Decision must be approve or deny.', 'bad_request');
  const note = sanitizeText(ctx.body.note, 600);
  const grantedBytes = ctx.body.bytes === -1 || ctx.body.unlimited ? -1 : clampNumber(ctx.body.bytes, 1024, 100 * 1024 * 1024 * 1024 * 1024, null);

  const applied = {};
  if (decision === 'approve') {
    if (request.kind === 'dm' && grantedBytes !== null) {
      user.limits.dmUploadBytes = grantedBytes;
      applied.dmUploadBytes = grantedBytes;
    } else if (request.kind === 'drive' && grantedBytes !== null) {
      user.limits.driveQuotaBytes = grantedBytes;
      applied.driveQuotaBytes = grantedBytes;
    } else if (request.kind === 'story' && grantedBytes !== null) {
      user.limits.storyQuotaBytes = grantedBytes;
      applied.storyQuotaBytes = grantedBytes;
    } else if (request.kind === 'purple') {
      user.purpleAllowed = true;
      applied.purpleAllowed = true;
    } else if (request.kind === 'verified') {
      user.verified = true;
      applied.verified = true;
    } else if (request.kind === 'unban') {
      user.banned = false;
      applied.banned = false;
    }
  }
  request.status = decision === 'approve' ? 'approved' : 'denied';
  request.updatedAt = now();
  request.decision = {
    status: request.status,
    note,
    at: request.updatedAt,
    by: admin.id,
    byRole: admin.role,
    grantedBytes,
    applied,
  };
  store.touch();
  store.audit(admin.id, `admin.request_${request.status}`, { requestId: request.id, userId: user.id, kind: request.kind, applied });

  realtime.send(user.id, {
    event: 'notify',
    level: decision === 'approve' ? 'success' : 'info',
    title: decision === 'approve' ? 'Storage request approved' : 'Storage request denied',
    body: buildDecisionBody(request, decision, grantedBytes, note),
  }, 'notify');
  realtime.send(user.id, {
    event: 'request.decision',
    requestId: request.id,
    decision: request.decision,
    limits: user.limits,
    verified: user.verified,
    purpleAllowed: user.purpleAllowed,
  }, 'request.decision');
  realtime.send(user.id, { event: 'storage', driveUsed: user.driveUsed, uploadUsed: user.uploadUsed, limits: user.limits }, 'storage');
  return { ok: true, request: requestToView(request, true), limits: user.limits };
};

function buildDecisionBody(request, decision, grantedBytes, note) {
  const label = { dm: 'messaging upload', drive: 'drive storage', story: 'story upload', purple: 'purple status', verified: 'verified badge', other: 'request' }[request.kind] || 'request';
  if (decision === 'deny') return note ? `Your ${label} request was declined. Operator note: ${note}` : `Your ${label} request was declined.`;
  const amount = grantedBytes === -1 ? 'unlimited' : grantedBytes ? formatBytes(grantedBytes) : null;
  const base = amount ? `Your ${label} limit is now ${amount}.` : `Your ${label} request was approved.`;
  return note ? `${base} Operator note: ${note}` : base;
}

// ------------------------------------------------------------------ global state
route['POST /api/admin/global'] = async (ctx) => {
  const admin = h.requireAdmin(ctx);
  const body = ctx.body || {};
  const global = store.db.global;
  if (body.registrationOpen !== undefined) global.registrationOpen = !!body.registrationOpen;
  if (body.maintenance !== undefined) global.maintenance = !!body.maintenance;
  if (body.notice !== undefined) global.notice = sanitizeText(body.notice, 400);
  if (body.maxUploadBytes !== undefined) global.maxUploadBytes = clampNumber(body.maxUploadBytes, 1024 * 1024, 1024 * 1024 * 1024 * 1024, global.maxUploadBytes);
  if (body.termsVersion !== undefined) global.termsVersion = sanitizeText(body.termsVersion, 12) || global.termsVersion;
  store.touch();
  store.audit(admin.id, 'admin.global_updated', body);
  realtime.broadcast({ kind: 'global', global }, 'global');
  return { ok: true, global };
};

// ------------------------------------------------------------------ files (server-wide)
route['GET /api/admin/files'] = async (ctx) => {
  h.requireAdmin(ctx);
  const kind = ctx.query.kind ? String(ctx.query.kind) : '';
  const q = String(ctx.query.q || '').toLowerCase().trim();
  const sort = ctx.query.sort === 'owner' ? 'owner' : 'recent';
  let files = Object.values(store.db.files);
  if (kind) files = files.filter((f) => f.kind === kind);
  if (q) {
    files = files.filter((f) => {
      const owner = store.userById(f.ownerId);
      // Search by real handle is allowed here: the operator is looking someone
      // up on purpose, and only the ROW LABEL stays anonymous.
      return (owner && (owner.username.toLowerCase().includes(q) || (owner.displayName || '').toLowerCase().includes(q))) || f.id.includes(q);
    });
  }
  files = sort === 'recent' ? files.sort((a, b) => b.createdAt - a.createdAt) : files.sort((a, b) => a.ownerId.localeCompare(b.ownerId));
  const byKind = {};
  let total = 0;
  for (const file of Object.values(store.db.files)) {
    byKind[file.kind] = (byKind[file.kind] || 0) + file.size;
    total += file.size;
  }
  return {
    files: files.slice(0, 600).map((f) => {
      const owner = store.userById(f.ownerId);
      return {
        id: f.id,
        kind: f.kind,
        size: f.size,
        complete: f.complete,
        createdAt: f.createdAt,
        completedAt: f.completedAt,
        meta: f.meta,
        audience: f.audience,
        chunks: f.chunks || 0,
        mime: (f.meta && (f.meta.type || f.meta.mime)) || '',
        // The envelope the uploading device sealed for the operator identity.
        // It opens for exactly one private key, so shipping it here discloses
        // nothing to anyone else; without it the row stays opaque.
        operatorWrap: (f.meta && f.meta.operatorWrap) || null,
        sealedName: (f.meta && f.meta.nameWrapped) || null,
        // Anonymised on purpose: the operator can see every blob and act on it
        // without the panel becoming a list of who-uploaded-what.
        owner: owner ? {
          id: owner.id,
          label: pseudonym(owner.id),
          role: owner.role,
        } : null,
        ref: {
          conversationId: f.ref?.conversationId || null,
          threadId: f.ref?.threadId || null,
          forumId: f.ref?.forumId || null,
          storyId: f.ref?.storyId || null,
        },
      };
    }),
    totals: { count: Object.keys(store.db.files).length, bytes: total, byKind },
    note: 'Every blob is stored as ciphertext. Rows carrying an operator envelope can be opened here, because the uploading device sealed a second copy of that file key for this server’s operator identity.',
  };
};

// ------------------------------------------------------------------ neural graph
route['GET /api/admin/neural'] = async (ctx) => {
  h.requireAdmin(ctx);
  const windowMinutes = clampNumber(ctx.query.window, 5, 360, 60);
  const since = now() - windowMinutes * 60000;
  const users = store.allUsers();
  const conversations = Object.values(store.db.conversations);
  const forums = Object.values(store.db.forums);

  const nodes = [];
  const edges = [];
  const content = {};

  const userNodeId = (id) => `user:${id}`;
  const convNodeId = (id) => `conv:${id}`;
  const forumNodeId = (id) => `forum:${id}`;

  const activityByUser = new Map();

  for (const user of users) {
    const lastActivity = Math.max(user.history.lastMessageAt || 0, user.history.lastUploadAt || 0, user.history.lastPostAt || 0, user.status.lastActive || 0);
    nodes.push({
      id: userNodeId(user.id),
      type: 'user',
      label: user.publicProfile.enabled && user.publicProfile.alias ? user.publicProfile.alias : user.displayName || user.username,
      sublabel: `@${user.username}`,
      avatarId: user.avatarId,
      verified: user.verified,
      role: user.role,
      createdAt: user.createdAt,
      lastActivityAt: lastActivity,
      status: realtime.statusOf(user.id).key,
      metrics: {
        messages: user.stats.messages,
        files: user.stats.files,
        posts: user.stats.posts,
        storageBytes: Object.values(store.db.files).filter((f) => f.ownerId === user.id).reduce((sum, f) => sum + f.size, 0),
        karma: karmaForUser(user.id).score,
        lastMessageAt: user.history.lastMessageAt,
        lastUploadAt: user.history.lastUploadAt,
        lastPostAt: user.history.lastPostAt,
      },
      weight: Math.min(10, 1 + Math.log10(2 + user.stats.messages + user.stats.posts * 3)),
    });
    activityByUser.set(user.id, lastActivity);
  }

  for (const conversation of conversations) {
    const convIds = store.db.convMessages[conversation.id] || [];
    const messageIds = convIds.filter((id) => {
      const message = store.db.messages[id];
      return message && message.createdAt >= since;
    });
    const totalMessages = convIds.length;
    const isDirect = conversation.type === 'dm';
    nodes.push({
      id: convNodeId(conversation.id),
      type: isDirect ? 'dm' : 'group',
      label: isDirect ? 'Direct channel' : (conversation.title || 'Group chat'),
      sublabel: `${conversation.memberIds.length} members`,
      createdAt: conversation.createdAt,
      lastActivityAt: conversation.lastMessageAt,
      metrics: {
        messages: totalMessages,
        messagesInWindow: messageIds.length,
        members: conversation.memberIds.length,
        attachments: (store.db.convMessages[conversation.id] || []).reduce((sum, id) => {
          const message = store.db.messages[id];
          return sum + (message && message.attachments ? message.attachments.length : 0);
        }, 0),
      },
      encrypted: true,
      weight: Math.min(12, 1 + Math.log10(2 + totalMessages)),
    });
    for (const memberId of conversation.memberIds) {
      edges.push({
        id: `${memberId}-${conversation.id}`,
        from: userNodeId(memberId),
        to: convNodeId(conversation.id),
        type: 'participant',
        weight: 1,
        createdAt: conversation.createdAt,
        lastActivityAt: conversation.lastMessageAt,
      });
    }
    content[convNodeId(conversation.id)] = {
      kind: 'conversation',
      encrypted: true,
      members: conversation.memberIds.map((id) => {
        const user = store.userById(id);
        return user ? { id: user.id, label: user.publicProfile.enabled && user.publicProfile.alias ? user.publicProfile.alias : user.displayName, avatarId: user.avatarId, verified: user.verified, handle: user.username } : null;
      }).filter(Boolean),
      recent: convIds.slice(-14).map((id) => {
        const message = store.db.messages[id];
        if (!message) return null;
        const author = store.userById(message.authorId);
        return {
          id: message.id,
          at: message.createdAt,
          author: author ? author.displayName : 'unknown',
          avatarId: author ? author.avatarId : null,
          payload: message.payload || null,
          bytes: message.payload ? String(message.payload.ct).length : 0,
          payload: message.payload || null,
          decryptable: false,
        };
      }).filter(Boolean),
      note: 'Message bodies stay sealed to the channel key; the operator envelope opens them for the account that holds the server.',
    };
  }

  for (const forum of forums) {
    const threadIds = store.db.forumThreads?.[forum.id] || [];
    nodes.push({
      id: forumNodeId(forum.id),
      type: 'forum',
      label: forum.name,
      sublabel: forum.isPublic ? 'public community' : 'private community',
      createdAt: forum.createdAt,
      lastActivityAt: forum.lastActivityAt,
      metrics: Object.assign({}, forum.stats, { members: forum.memberIds.length, threads: threadIds.length }),
      encrypted: !forum.isPublic,
      publicSeed: forum.isPublic ? forum.publicSeed : null,
      weight: Math.min(14, 2 + Math.log10(2 + forum.stats.posts + forum.stats.threads * 4)),
    });
    for (const memberId of forum.memberIds) {
      edges.push({
        id: `${memberId}-${forum.id}`,
        from: userNodeId(memberId),
        to: forumNodeId(forum.id),
        type: 'member',
        weight: 0.6,
        createdAt: forum.createdAt,
        lastActivityAt: forum.lastActivityAt,
      });
    }
    content[forumNodeId(forum.id)] = {
      kind: 'forum',
      isPublic: forum.isPublic,
      publicSeed: forum.isPublic ? forum.publicSeed : null,
      threads: threadIds.slice(-24).map((threadId) => {
        const thread = store.db.threads[threadId];
        if (!thread) return null;
        const author = store.userById(thread.authorId);
        const postIds = store.db.threadPosts[threadId] || [];
        return {
          id: thread.id,
          title: thread.titlePayload || null,
          body: thread.payload || null,
          createdAt: thread.createdAt,
          lastActivityAt: thread.lastActivityAt,
          deleted: thread.deleted,
          author: author ? { id: author.id, label: author.publicProfile.enabled && author.publicProfile.alias ? author.publicProfile.alias : author.displayName, avatarId: author.avatarId, verified: author.verified } : null,
          replies: postIds.slice(-12).map((postId) => {
            const post = store.db.posts[postId];
            if (!post) return null;
            const postAuthor = store.userById(post.authorId);
            return {
              id: post.id,
              payload: post.payload || null,
              at: post.createdAt,
              deleted: post.deleted,
              reactions: Object.keys(post.reactions || {}).length,
              author: postAuthor ? { id: postAuthor.id, label: postAuthor.publicProfile.enabled && postAuthor.publicProfile.alias ? postAuthor.publicProfile.alias : postAuthor.displayName, avatarId: postAuthor.avatarId, verified: postAuthor.verified } : null,
            };
          }).filter(Boolean),
        };
      }).filter(Boolean),
      decryptable: forum.isPublic,
    };
  }

  const events = store.db.events
    .filter((event) => event.at >= since)
    .slice(-260)
    .map(eventSummary);

  return {
    generatedAt: now(),
    windowMinutes,
    live: true,
    counts: {
      users: users.length,
      conversations: conversations.length,
      forums: forums.length,
      threads: Object.keys(store.db.threads).length,
      posts: Object.keys(store.db.posts).length,
      messages: Object.keys(store.db.messages).length,
      stories: Object.values(store.db.stories).filter((s) => s.expiresAt > now()).length,
    },
    nodes,
    edges,
    content,
    events,
    telemetry: {
      series: store.metricsSeries(30),
      neuralSubscribers: realtime.neuralSubscribers,
      uptime: process.uptime(),
    },
    privacy: 'Direct messages and private communities remain end-to-end encrypted. Public community content is readable here because those keys are shared with every signed-in account.',
  };
};

route['GET /api/admin/neural/node/:type/:id'] = async (ctx) => {
  h.requireAdmin(ctx);
  const type = String(ctx.params.type);
  const id = String(ctx.params.id);
  if (type === 'conversation') {
    const conversation = store.db.conversations[id];
    if (!conversation) throw h.fail(404, 'Channel not found.', 'not_found');
    const ids = store.db.convMessages[id] || [];
    return {
      node: {
        id,
        type: conversation.type,
        title: conversation.title || 'Direct channel',
        createdAt: conversation.createdAt,
        lastMessageAt: conversation.lastMessageAt,
        members: conversation.memberIds.map((memberId) => {
          const user = store.userById(memberId);
          return user ? { id: user.id, label: user.displayName, handle: user.username, avatarId: user.avatarId, verified: user.verified, role: user.role, lastMessageAt: user.history.lastMessageAt } : null;
        }).filter(Boolean),
        encrypted: true,
      },
      items: ids.slice(-40).reverse().map((messageId) => {
        const message = store.db.messages[messageId];
        if (!message) return null;
        const author = store.userById(message.authorId);
        return {
          id: message.id,
          at: message.createdAt,
          author: author ? { id: author.id, label: author.displayName, handle: author.username, avatarId: author.avatarId } : null,
          attachments: message.attachments || [],
          bytes: message.payload ? String(message.payload.ct).length : 0,
          payload: null,
          encrypted: true,
        };
      }).filter(Boolean),
    };
  }
  if (type === 'forum' || type === 'thread') {
    const threadId = type === 'thread' ? id : null;
    const thread = threadId ? store.db.threads[threadId] : null;
    const forum = thread ? store.db.forums[thread.forumId] : store.db.forums[id];
    if (!forum) throw h.fail(404, 'Community not found.', 'not_found');
    if (thread) {
      const posts = (store.db.threadPosts[thread.id] || []).map((postId) => store.db.posts[postId]).filter(Boolean);
      return {
        node: {
          id: thread.id,
          type: 'thread',
          forumId: forum.id,
          forumName: forum.name,
          isPublic: forum.isPublic,
          publicSeed: forum.isPublic ? forum.publicSeed : null,
          title: thread.titlePayload || null,
          body: thread.payload || null,
          createdAt: thread.createdAt,
          deleted: thread.deleted,
        },
        items: posts.map((post) => ({
          id: post.id,
          at: post.createdAt,
          author: (() => {
            const user = store.userById(post.authorId);
            return user ? { id: user.id, label: user.displayName, handle: user.username, avatarId: user.avatarId, verified: user.verified } : null;
          })(),
          payload: post.payload || null,
          reactions: post.reactions || {},
          karma: messageKarma(post),
          deleted: post.deleted,
        })),
      };
    }
    const threadIds = store.db.forumThreads?.[forum.id] || [];
    return {
      node: {
        id: forum.id,
        type: 'forum',
        name: forum.name,
        description: forum.description,
        isPublic: forum.isPublic,
        publicSeed: forum.isPublic ? forum.publicSeed : null,
        createdAt: forum.createdAt,
        stats: forum.stats,
      },
      items: threadIds.slice(-40).reverse().map((threadId2) => {
        const t = store.db.threads[threadId2];
        if (!t) return null;
        const author = store.userById(t.authorId);
        return {
          id: t.id,
          title: t.titlePayload || null,
          body: t.payload || null,
          at: t.createdAt,
          lastActivityAt: t.lastActivityAt,
          postCount: t.postCount,
          deleted: t.deleted,
          author: author ? { id: author.id, label: author.displayName, handle: author.username, avatarId: author.avatarId } : null,
        };
      }).filter(Boolean),
    };
  }
  if (type === 'user') {
    const user = store.userById(id);
    if (!user) throw h.fail(404, 'User not found.', 'not_found');
    const sessions = activeSessions(user.id);
    return {
      node: {
        id: user.id,
        type: 'user',
        label: user.displayName,
        handle: user.username,
        avatarId: user.avatarId,
        verified: user.verified,
        role: user.role,
        createdAt: user.createdAt,
        bio: user.bio,
        publicAlias: user.publicProfile.alias,
        publicEnabled: user.publicProfile.enabled,
        history: user.history,
        stats: user.stats,
        karma: karmaForUser(user.id),
        sessions: sessions.length,
        status: realtime.statusOf(user.id),
        limits: user.limits,
        storageBytes: Object.values(store.db.files).filter((f) => f.ownerId === user.id).reduce((sum, f) => sum + f.size, 0),
      },
      items: [],
    };
  }
  throw h.fail(400, 'Unknown node type.', 'bad_request');
};

// ------------------------------------------------------------------ events & karma
route['GET /api/admin/events'] = async (ctx) => {
  h.requireAdmin(ctx);
  const since = clampNumber(ctx.query.since, 0, now(), 0);
  const limit = clampNumber(ctx.query.limit, 1, 500, 120);
  const events = store.db.events
    .filter((event) => event.at > since)
    .slice(-limit)
    .map(eventSummary);
  return { events, lastMessageAt: Math.max(0, ...store.allUsers().map((u) => u.history.lastMessageAt || 0)) };
};

route['GET /api/admin/karma'] = async (ctx) => {
  h.requireAdmin(ctx);
  const rows = store.allUsers().map((user) => ({
    id: user.id,
    label: user.displayName,
    handle: user.username,
    avatarId: user.avatarId,
    verified: user.verified,
    karma: karmaForUser(user.id),
  })).sort((a, b) => b.karma.score - a.karma.score);
  return { karma: rows };
};

route['GET /api/admin/stories'] = async (ctx) => {
  h.requireAdmin(ctx);
  const stories = Object.values(store.db.stories).map((story) => {
    const user = store.userById(story.userId);
    const file = store.db.files[story.fileId];
    return {
      id: story.id,
      kind: story.kind,
      createdAt: story.createdAt,
      expiresAt: story.expiresAt,
      views: story.views.length,
      size: file ? file.size : 0,
      author: user ? { id: user.id, label: user.displayName, handle: user.username, avatarId: user.avatarId, verified: user.verified } : null,
      expired: story.expiresAt <= now(),
    };
  }).sort((a, b) => b.createdAt - a.createdAt);
  return {
    stories,
    totals: {
      active: stories.filter((s) => !s.expired).length,
      bytes: stories.reduce((sum, s) => sum + s.size, 0),
      count: stories.length,
    },
    note: 'Story storage is tracked separately from messaging, community and drive uploads.',
  };
};

/**
 * Privacy-preserving owner label for the operator views.  Everything the
 * operator sees in these panels is attached to a stable pseudonym instead of a
 * handle, so a screenshot of the console never reveals who uploaded what.
 * The mapping is stable per user and per server run.
 */
function pseudonym(userId, index) {
  if (!userId) return 'system';
  const users = Object.keys(store.db.users).sort();
  const position = users.indexOf(userId);
  const n = position >= 0 ? position + 1 : (index || 0) + 1;
  return `Member ${String(n).padStart(2, '0')}`;
}

// ------------------------------------------------- all uploads, anonymised
route['DELETE /api/admin/messages/:id'] = async (ctx) => {
  const admin = h.requireAdmin(ctx);
  const message = store.db.messages[ctx.params.id];
  if (!message) throw h.fail(404, 'Message not found.', 'not_found');
  message.deleted = true;
  message.deletedAt = Date.now();
  message.deletedBy = admin.id;
  // the realtime notice needs the channel the message actually lives in
  const channelId = message.convId || message.conversationId || message.forumId || null;
  message.payload = null;
  message.attachments = [];
  store.audit(admin.id, 'moderation.message_deleted', { messageId: message.id, channel: channelId });
  store.touch();
  // Its own event name: clients that treat every 'message' event as a new
  // message must not be handed a removal notice.
  realtime.broadcast({ kind: 'message.deleted', id: message.id, conversationId: channelId, forumId: message.forumId || null }, 'message.deleted', {});
  return { ok: true };
};

route['GET /api/admin/storage'] = async (ctx) => {
  h.requireAdmin(ctx);
  const limit = clampNumber(ctx.query.limit, 1, 500, 200);
  const kind = String(ctx.query.kind || '').trim();
  const search = String(ctx.query.q || '').trim().toLowerCase();

  const files = Object.values(store.db.files)
    .filter((file) => (kind ? file.kind === kind : true))
    .filter((file) => {
      if (!search) return true;
      const owner = store.userById(file.ownerId);
      return String(file.id).toLowerCase().includes(search)
        || String(file.kind).toLowerCase().includes(search)
        || (owner && owner.username.toLowerCase().includes(search));
    })
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const rows = files.slice(0, limit).map((file) => {
    const owner = store.userById(file.ownerId);
    return {
      id: file.id,
      kind: file.kind,
      bytes: file.size || 0,
      createdAt: file.createdAt,
      chunks: file.chunks || 0,
      // who: a pseudonym only. The real handle stays behind /api/admin/users.
      owner: owner ? pseudonym(owner.id) : 'deleted account',
      ownerId: file.ownerId,
      conversationId: file.conversationId || (file.ref && file.ref.conversationId) || null,
      forumId: (file.ref && file.ref.forumId) || null,
      metaKeys: Object.keys(file.meta || {}),
      mime: (file.meta && (file.meta.type || file.meta.mime)) || '',
      editor: !!(file.meta && file.meta.editor),
      // The envelope the uploading device sealed for the operator identity:
      // with the operator's private key this opens the file, and without it the
      // row is exactly as opaque as before.
      operatorWrap: (file.meta && file.meta.operatorWrap) || null,
      sealedName: (file.meta && file.meta.nameWrapped) || null,
    };
  });

  const byKind = {};
  for (const file of Object.values(store.db.files)) {
    byKind[file.kind] = byKind[file.kind] || { files: 0, bytes: 0 };
    byKind[file.kind].files += 1;
    byKind[file.kind].bytes += file.size || 0;
  }
  return { uploads: rows, total: files.length, byKind };
};

// ------------------------------------------------- all messages, anonymised
route['GET /api/admin/messages'] = async (ctx) => {
  h.requireAdmin(ctx);
  const limit = clampNumber(ctx.query.limit, 1, 300, 100);
  const messages = Object.values(store.db.messages)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, limit)
    .map((message) => {
      // Direct and group messages store their channel as `convId`; forum posts
      // carry `forumId`.  Resolving both is what makes the channel name and the
      // operator envelope findable from the feed.
      const channelId = message.convId || message.conversationId || message.forumId || null;
      const conversation = channelId ? store.db.conversations[channelId] : null;
      const forum = !conversation && message.forumId ? store.db.forums[message.forumId] : null;
      return {
        id: message.id,
        // The body stays encrypted end to end: the operator sees metadata only.
        author: pseudonym(message.authorId),
        authorId: message.authorId,
        channel: conversation ? conversation.type : (forum ? (forum.isPublic ? 'public forum' : 'private forum') : 'unknown'),
        conversationId: channelId || message.threadId || null,
        createdAt: message.createdAt,
        editedAt: message.editedAt || null,
        deleted: !!message.deleted || !!message.deletedAt,
        // The ciphertext itself, plus the envelope that opens the channel it
        // was posted in.  Only an operator signed in with the identity the
        // envelope was sealed for can do anything with either.
        payload: message.payload || null,
        operatorWrap: (conversation && conversation.operatorWrap) || (forum && forum.operatorWrap) || null,
        // a public community is readable by anyone signed in, so its seed is
        // no more of a secret here than it is inside the community itself
        forumId: (forum && forum.id) || null,
        publicSeed: (forum && forum.isPublic && forum.publicSeed) || null,
        attachments: (message.attachments || []).map((file) => ({
          fileId: file.fileId, size: file.size || 0, mime: file.mime || '', type: file.type || 'file',
          keyWrap: file.keyWrap || null,
        })),
        reactions: Object.values(message.reactions || {}).reduce((n, list) => n + (list.length || 0), 0),
        bytes: (message.attachments || []).reduce((n, f) => n + (f.size || 0), 0),
      };
    });
  return { messages, total: Object.keys(store.db.messages).length };
};

route['GET /api/admin/audit'] = async (ctx) => {
  h.requireAdmin(ctx);
  const limit = clampNumber(ctx.query.limit, 1, 500, 150);
  const actions = store.db.audit.slice(-limit).reverse().map((entry) => {
    const actor = store.userById(entry.actorId);
    return {
      id: entry.id,
      at: entry.at,
      action: entry.action,
      detail: entry.detail,
      actor: actor ? { id: actor.id, label: actor.displayName, handle: actor.username, role: actor.role } : null,
    };
  });
  return { audit: actions };
};

module.exports = { routes: route, adminUserRow, karmaForUser, eventSummary };
