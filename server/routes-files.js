'use strict';

const fs = require('fs');
const { store } = require('./store');
const { realtime } = require('./realtime');
const h = require('./helpers');
const { now, clampNumber, formatBytes, sanitizeText, RateLimiter } = require('./util');

const CHUNK_SIZE = 512 * 1024;
const MAX_CHUNK_OVERHEAD = 4096;
const MAX_BACKGROUND_FILES = 6;

function backgroundCount(ownerId) {
  return Object.values(store.db.files).filter((file) => file.ownerId === ownerId && file.kind === 'background' && file.complete).length;
}
const uploadLimiter = new RateLimiter({ points: 240, windowMs: 60000 });
const route = {};

const KINDS = {
  dm: { scope: 'upload' },
  forum: { scope: 'upload' },
  airdrop: { scope: 'upload' },
  avatar: { scope: 'upload' },
  // a desktop picture: private, encrypted, and its own small cap so a big
  // photograph cannot be smuggled in through the wallpaper control
  background: { scope: 'upload' },
  drive: { scope: 'drive' },
  story: { scope: 'upload' },
  public: { scope: 'upload' },
};

/** Returns the size limit enforced for a prepared upload. */
function limitFor(user, kind, size) {
  if (kind === 'drive') {
    h.checkDriveUpload(user, size);
    return user.limits.driveQuotaBytes;
  }
  if (kind === 'story') {
    h.checkStoryUpload(user, size);
    return user.limits.storyQuotaBytes;
  }
  if (kind === 'background') {
    h.checkDmUpload(user, size);
    return Math.min(user.limits.dmUploadBytes, 12 * 1024 * 1024);
  }
  h.checkDmUpload(user, size);
  return user.limits.dmUploadBytes;
}

route['POST /api/files/init'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const limit = uploadLimiter.hit(`init:${user.id}`);
  if (!limit.allowed) throw h.fail(429, 'Too many uploads at once.', 'rate_limited');
  const body = ctx.body || {};
  const kind = KINDS[body.kind] ? body.kind : null;
  if (!kind) throw h.fail(400, 'Unknown upload target.', 'bad_kind');
  if (kind === 'background' && backgroundCount(user.id) >= MAX_BACKGROUND_FILES) {
    throw h.fail(409, `Your desktop picture library is full (${MAX_BACKGROUND_FILES}). Delete one before adding another.`, 'background_library_full');
  }
  const size = clampNumber(body.size, 1, store.db.global.maxUploadBytes * 4, 0);
  if (!size) throw h.fail(400, 'File size missing.', 'bad_size');
  if (body.userSettings && user.settings) {
    /* settings are applied client side; nothing to store here */
  }
  if (user.settings && user.settings.disabledFeatures && user.settings.disabledFeatures.uploads === true && kind !== 'drive') {
    throw h.fail(403, 'File uploads are disabled for your account in Settings.', 'feature_disabled');
  }
  limitFor(user, kind, size);

  const fileId = store.nextId('f_');
  const chunks = Math.max(1, Math.ceil(size / CHUNK_SIZE));
  if (chunks > 8192) throw h.fail(413, 'That file is too large to upload in chunks.', 'too_many_chunks');
  const file = {
    id: fileId,
    ownerId: user.id,
    kind,
    size,
    chunks,
    chunkSize: CHUNK_SIZE,
    keyWrap: body.keyWrap ? String(body.keyWrap).slice(0, 4096) : null,
    ref: body.ref && typeof body.ref === 'object' ? body.ref : {},
    meta: body.meta && typeof body.meta === 'object' ? {
      type: sanitizeText(body.meta.type, 48),
      width: clampNumber(body.meta.width, 0, 100000, 0),
      height: clampNumber(body.meta.height, 0, 100000, 0),
      duration: clampNumber(body.meta.duration, 0, 1000000, 0),
      hasPoster: !!body.meta.hasPoster,
      // A file made in the editor carries its name as ciphertext sealed with
      // its own file key, so the drive can list it without the server ever
      // learning what it is called.
      nameWrapped: typeof body.meta.nameWrapped === 'string' ? body.meta.nameWrapped.slice(0, 8192) : null,
      // The same file key, sealed a second time for the operator's identity so
      // the person running the server can review an upload they are asked
      // about.  Nested JSON built by the uploading client, never a raw key.
      operatorWrap: typeof body.meta.operatorWrap === 'string' ? body.meta.operatorWrap.slice(0, 4096) : null,
      editor: !!body.meta.editor,
    } : null,
    complete: false,
    uploadedChunks: [],
    createdAt: now(),
    completedAt: null,
    audience: kind === 'story' || kind === 'public' ? 'public' : kind === 'avatar' ? 'public' : 'private',
    // a wallpaper is private to the account that uploaded it; only its owner
    // (and the operator, through the envelope) can read it back
  };
  store.db.files[fileId] = file;
  store.touch();
  return {
    fileId,
    chunkSize: CHUNK_SIZE,
    chunks,
    uploaded: [],
    maxBytes: limitFor(user, kind, size),
    drive: { quota: user.limits.driveQuotaBytes, used: user.driveUsed },
  };
};

route['PUT /api/files/:id/chunk/:index'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const file = store.db.files[ctx.params.id];
  if (!file) throw h.fail(404, 'Upload session not found.', 'not_found');
  if (file.ownerId !== user.id) throw h.fail(403, 'This is not your upload.', 'forbidden');
  if (file.complete) throw h.fail(409, 'That upload is already complete.', 'already_complete');
  const index = clampNumber(ctx.params.index, 0, file.chunks - 1, -1);
  if (index < 0) throw h.fail(400, 'Chunk index out of range.', 'bad_chunk');
  const limit = uploadLimiter.hit(`chunk:${user.id}`, 1);
  if (!limit.allowed) throw h.fail(429, 'Uploading too fast — the device is throttling.', 'rate_limited');

  const written = await readRawToDisk(ctx.req, file, index);
  if (!written) throw h.fail(400, 'Empty chunk.', 'empty_chunk');
  if (!file.uploadedChunks.includes(index)) file.uploadedChunks.push(index);
  store.touch();
  ctx.handled = true;
  return h.sendJson(ctx.res, 200, { ok: true, index, bytes: written, uploaded: file.uploadedChunks.length });
};

function readRawToDisk(req, file, index) {
  return new Promise((resolve, reject) => {
    const max = file.chunkSize + MAX_CHUNK_OVERHEAD;
    const chunks = [];
    let size = 0;
    let finished = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
        if (!finished) {
          finished = true;
          reject(h.fail(413, 'Chunk exceeds the negotiated chunk size.', 'chunk_too_large'));
          req.destroy();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (finished) return;
      finished = true;
      try {
        const buffer = Buffer.concat(chunks);
        store.writeChunk(file.id, index, buffer);
        store.bumpMetrics({ bytesIn: buffer.length });
        resolve(buffer.length);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', (error) => {
      if (!finished) {
        finished = true;
        reject(error);
      }
    });
  });
}

route['GET /api/files/:id'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const file = store.db.files[ctx.params.id];
  if (!file) throw h.fail(404, 'File not found.', 'not_found');
  if (!h.canAccessFile(user, file)) throw h.fail(403, 'You do not have access to this file.', 'forbidden');
  return { file: h.fileView(file) };
};

route['POST /api/files/:id/complete'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const file = store.db.files[ctx.params.id];
  if (!file) throw h.fail(404, 'Upload session not found.', 'not_found');
  if (file.ownerId !== user.id) throw h.fail(403, 'This is not your upload.', 'forbidden');
  if (file.complete) return { file: h.fileView(file) };
  const received = file.uploadedChunks.length;
  if (received < file.chunks) {
    throw h.fail(409, `Upload incomplete — ${received}/${file.chunks} chunks received.`, 'incomplete');
  }
  // The browser limits the shelf for a clear UI; enforce the same cap here so
  // a hand-crafted client cannot turn the background library into unbounded
  // hidden server storage. Recheck at completion for simultaneous uploads.
  if (file.kind === 'background' && backgroundCount(user.id) >= MAX_BACKGROUND_FILES) {
    store.deleteFileBlobs(file.id);
    delete store.db.files[file.id];
    store.touch();
    throw h.fail(409, `Your desktop picture library is full (${MAX_BACKGROUND_FILES}). Delete one before adding another.`, 'background_library_full');
  }
  file.complete = true;
  file.completedAt = now();
  if (file.kind === 'drive') {
    user.driveUsed += file.size;
  } else {
    user.uploadUsed += file.size;
  }
  user.stats.files += 1;
  user.history.lastUploadAt = file.completedAt;
  store.touch();
  const event = store.pushEvent({ type: 'file.uploaded', userId: user.id, detail: { fileId: file.id, kind: file.kind, size: file.size, label: formatBytes(file.size) } });
  realtime.neural({ kind: 'event', event });
  realtime.send(user.id, { event: 'storage', driveUsed: user.driveUsed, uploadUsed: user.uploadUsed }, 'storage');
  realtime.adminEvent({ event: 'admin', kind: 'file.uploaded', userId: user.id, fileId: file.id, size: file.size, fileKind: file.kind, at: event.at });
  return { file: h.fileView(file), drive: { quota: user.limits.driveQuotaBytes, used: user.driveUsed } };
};

route['GET /api/files/:id/chunk/:index'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const file = store.db.files[ctx.params.id];
  if (!file) throw h.fail(404, 'File not found.', 'not_found');
  if (!h.canAccessFile(user, file)) throw h.fail(403, 'You do not have access to this file.', 'forbidden');
  const index = clampNumber(ctx.params.index, 0, file.chunks - 1, -1);
  if (index < 0) throw h.fail(400, 'Chunk index out of range.', 'bad_chunk');
  const buffer = store.readChunk(file.id, index);
  if (!buffer) throw h.fail(404, 'That chunk is missing.', 'not_found');
  ctx.handled = true;
  ctx.res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': buffer.length,
    'Cache-Control': 'private, max-age=0, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  ctx.res.end(buffer);
  store.bumpMetrics({ bytesOut: buffer.length });
  return undefined;
};

route['DELETE /api/files/:id'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const file = store.db.files[ctx.params.id];
  if (!file) throw h.fail(404, 'File not found.', 'not_found');
  if (file.ownerId !== user.id && !h.isAdmin(user)) throw h.fail(403, 'You cannot delete this file.', 'forbidden');
  h.releaseFile(file, file.kind);
  return { ok: true };
};

route['GET /api/files'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const kind = ctx.query.kind ? String(ctx.query.kind) : null;
  const files = Object.values(store.db.files)
    .filter((f) => f.ownerId === user.id && f.complete)
    .filter((f) => (kind ? f.kind === kind : true))
    .sort((a, b) => (b.completedAt || b.createdAt) - (a.completedAt || a.createdAt))
    .slice(0, 500)
    .map((f) => h.fileView(f));
  return {
    files,
    storage: {
      drive: { used: user.driveUsed, quota: user.limits.driveQuotaBytes },
      uploads: { used: user.uploadUsed, quota: user.limits.dmUploadBytes },
    },
  };
};

// ---------------------------------------------------------------- folders
route['GET /api/drive/folders'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  user.driveFolders = user.driveFolders || [];
  return { folders: user.driveFolders.map(({ id, parentId, payload, createdAt, updatedAt }) => ({ id, parentId, payload, createdAt, updatedAt })) };
};

route['POST /api/drive/folders'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  user.driveFolders = user.driveFolders || [];
  if (user.driveFolders.length >= 400) throw h.fail(413, 'Folder limit reached (400).', 'too_many_folders');
  const folder = {
    id: store.nextId('d_'),
    parentId: ctx.body.parentId ? String(ctx.body.parentId) : null,
    payload: ctx.body.payload && ctx.body.payload.ct ? ctx.body.payload : null,
    createdAt: now(),
    updatedAt: now(),
  };
  user.driveFolders.push(folder);
  store.touch();
  return { folder };
};

route['PATCH /api/drive/folders/:id'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  const folder = (user.driveFolders || []).find((entry) => entry.id === ctx.params.id);
  if (!folder) throw h.fail(404, 'Folder not found.', 'not_found');
  if (ctx.body.payload && ctx.body.payload.ct) folder.payload = ctx.body.payload;
  if (ctx.body.parentId !== undefined) folder.parentId = ctx.body.parentId ? String(ctx.body.parentId) : null;
  folder.updatedAt = now();
  store.touch();
  return { folder };
};

route['DELETE /api/drive/folders/:id'] = async (ctx) => {
  const user = h.requireAuth(ctx);
  user.driveFolders = user.driveFolders || [];
  const folder = user.driveFolders.find((entry) => entry.id === ctx.params.id);
  if (!folder) throw h.fail(404, 'Folder not found.', 'not_found');
  user.driveFolders = user.driveFolders.filter((entry) => entry.id !== folder.id);
  for (const child of user.driveFolders) if (child.parentId === folder.id) child.parentId = null;
  for (const file of Object.values(store.db.files)) {
    if (file.ownerId === user.id && file.ref && file.ref.folderId === folder.id) file.ref.folderId = null;
  }
  store.touch();
  return { ok: true, movedToRoot: true };
};

module.exports = { routes: route, CHUNK_SIZE, KINDS, limitFor };
