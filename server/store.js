'use strict';

const fs = require('fs');
const path = require('path');
const { randomId, now } = require('./util');

const DATA_DIR = process.env.AE_DATA_DIR || path.join(__dirname, '..', 'data');
const BLOB_DIR = path.join(DATA_DIR, 'blobs');
const DB_FILE = path.join(DATA_DIR, 'ae-secure.json');
const BACKUP_FILE = path.join(DATA_DIR, 'ae-secure.backup.json');

const DEFAULT_LIMITS = {
  dmUploadBytes: 15 * 1024 * 1024,           // 15 MB per message attachment
  driveQuotaBytes: 1024 * 1024 * 1024,       // 1 GB personal drive
  storyQuotaBytes: 1024 * 1024 * 1024,       // 1 GB per story item
};

function emptyDatabase() {
  return {
    version: 1,
    createdAt: now(),
    counters: { clicks: 0, clickWeeks: {}, signups: 0 },
    users: {},
    usersByName: {},
    sessions: {},
    conversations: {},
    messages: {},
    convMessages: {},
    forums: {},
    forumThreads: {},
    threads: {},
    posts: {},
    threadPosts: {},
    airdrops: {},
    publicPosts: {},
    publicFeed: [],
    clicksByUser: {},
    files: {},
    stories: {},
    events: [],
    requests: {},
    dmCodes: {},
    recovery: {},
    audit: [],
    metrics: { minutes: [] },
    global: {
      registrationOpen: true,
      maintenance: false,
      notice: '',
      maxUploadBytes: 2 * 1024 * 1024 * 1024,
      termsVersion: '1.0',
      // The look the operator publishes for the whole site: a site theme, a
      // colour ramp and a signal.  Accounts that have not chosen their own
      // appearance follow it, and it is applied live when it changes.
      appearance: null,
    },
    counters24: {},
  };
}

class Store {
  constructor() {
    this.db = emptyDatabase();
    this.dirty = false;
    this.lastSave = 0;
    this._timer = null;
    this.blobDir = BLOB_DIR;
    this.dataDir = DATA_DIR;
    this.loaded = false;
  }

  init() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(BLOB_DIR, { recursive: true });
    if (fs.existsSync(DB_FILE)) {
      try {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        this.db = Object.assign(emptyDatabase(), parsed);
        this.db.users = parsed.users || {};
        this.db.sessions = parsed.sessions || {};
        this.db.metrics = parsed.metrics || { minutes: [] };
        this.db.global = Object.assign(emptyDatabase().global, parsed.global || {});
      } catch (error) {
        console.error('[store] database unreadable, attempting backup restore:', error.message);
        if (fs.existsSync(BACKUP_FILE)) {
          this.db = Object.assign(emptyDatabase(), JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8')));
        } else {
          const broken = `${DB_FILE}.broken-${Date.now()}`;
          try { fs.renameSync(DB_FILE, broken); } catch { /* ignore */ }
        }
      }
    }
    this.loaded = true;
    this.backfillUsers();
    this.pruneSessions();
    return this;
  }

  /**
   * Accounts created before a field existed must still work: this fills in the
   * defaults a newer version reads, without touching anything already set.
   */
  backfillUsers() {
    let changed = false;
    for (const user of Object.values(this.db.users || {})) {
      if (!Array.isArray(user.avatarHistory)) { user.avatarHistory = user.avatarId ? [user.avatarId] : []; changed = true; }
      if (user.statusMessage === undefined) { user.statusMessage = null; changed = true; }
    }
    for (const message of Object.values(this.db.messages || {})) {
      if (message.attachments === undefined) { message.attachments = []; changed = true; }
      if (message.reactions === undefined) { message.reactions = {}; changed = true; }
    }
    if (changed) this.touch();
    return changed;
  }

  touch() {
    this.dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.save();
    }, 400);
    if (this._timer.unref) this._timer.unref();
  }

  save(force = false) {
    if (!this.dirty && !force) return;
    const payload = JSON.stringify(this.db);
    const tmp = `${DB_FILE}.tmp`;
    try {
      fs.writeFileSync(tmp, payload);
      fs.renameSync(tmp, DB_FILE);
      if (Date.now() - this.lastSave > 60000) {
        try { fs.copyFileSync(DB_FILE, BACKUP_FILE); } catch { /* ignore */ }
      }
      this.lastSave = Date.now();
      this.dirty = false;
    } catch (error) {
      console.error('[store] save failed:', error.message);
    }
  }

  // ---------------------------------------------------------------- ids
  nextId(prefix = '') {
    return prefix + randomId(12);
  }

  // -------------------------------------------------------------- users
  createUser(data) {
    const id = this.nextId('u_');
    const user = Object.assign({
      id,
      username: '',
      displayName: '',
      role: 'member',
      createdAt: now(),
      serverSalt: randomId(16),
      authHashStored: '',
      kdf: { salt: '', iterations: 310000 },
      identityPublic: null,
      wrappedMaster: null,
      wrappedIdentity: null,
      avatarId: null,
      // The three most recent profile pictures, newest first.
      avatarHistory: [],
      // The 24-hour status bubble: { text, emoji, createdAt, expiresAt }.
      statusMessage: null,
      bio: '',
      verified: false,
      purpleAllowed: false,
      banned: false,
      disabled: false,
      terms: { accepted: false, at: null, version: '' },
      limits: Object.assign({}, DEFAULT_LIMITS),
      driveUsed: 0,
      uploadUsed: 0,
      publicProfile: { enabled: false, alias: '', bio: '', images: [], audienceKey: null, updatedAt: null },
      status: { mode: 'online', custom: '', lastActive: now(), manual: false },
      settings: {},
      backup: { codes: [], generatedAt: null },
      stats: { messages: 0, files: 0, posts: 0, reactions: 0 },
      history: { lastMessageAt: 0, lastUploadAt: 0, lastPostAt: 0, lastAuthAt: 0 },
    }, data);
    this.db.users[id] = user;
    this.db.usersByName[user.username.toLowerCase()] = id;
    this.db.counters.signups += 1;
    this.touch();
    return user;
  }

  userByName(username) {
    if (!username) return null;
    const id = this.db.usersByName[String(username).toLowerCase()];
    return id ? this.db.users[id] : null;
  }

  userById(id) {
    return this.db.users[id] || null;
  }

  allUsers() {
    return Object.values(this.db.users);
  }

  removeUser(id) {
    const user = this.db.users[id];
    if (!user) return;
    delete this.db.usersByName[user.username.toLowerCase()];
    delete this.db.users[id];
    for (const [token, session] of Object.entries(this.db.sessions)) {
      if (session.userId === id) delete this.db.sessions[token];
    }
    this.touch();
  }

  // ----------------------------------------------------------- sessions
  createSession(userId, meta = {}) {
    const token = require('./util').randomToken(32);
    const session = {
      id: this.nextId('s_'),
      token,
      userId,
      device: meta.device || 'Unknown device',
      platform: meta.platform || '',
      ip: meta.ip || '',
      ua: meta.ua || '',
      createdAt: now(),
      lastSeenAt: now(),
      revoked: false,
      recovered: !!meta.recovered,
    };
    this.db.sessions[token] = session;
    this.touch();
    return session;
  }

  sessionByToken(token) {
    return token ? this.db.sessions[token] || null : null;
  }

  revokeSession(token) {
    const session = this.db.sessions[token];
    if (!session) return false;
    session.revoked = true;
    delete this.db.sessions[token];
    this.touch();
    return true;
  }

  revokeUserSessions(userId, exceptToken = null) {
    let count = 0;
    for (const [token, session] of Object.entries(this.db.sessions)) {
      if (session.userId === userId && token !== exceptToken) {
        delete this.db.sessions[token];
        count += 1;
      }
    }
    if (count) this.touch();
    return count;
  }

  userSessions(userId) {
    return Object.values(this.db.sessions).filter((s) => s.userId === userId).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  pruneSessions() {
    const cutoff = now() - 1000 * 60 * 60 * 24 * 30;
    let removed = 0;
    for (const [token, session] of Object.entries(this.db.sessions)) {
      if (session.lastSeenAt < cutoff) {
        delete this.db.sessions[token];
        removed += 1;
      }
    }
    if (removed) this.dirty = true;
    return removed;
  }

  // ---------------------------------------------------------------- files
  filePath(fileId, index) {
    return path.join(BLOB_DIR, fileId, `${index}.bin`);
  }

  writeChunk(fileId, index, buffer) {
    const dir = path.join(BLOB_DIR, fileId);
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, `${index}.bin`);
    const tmp = `${finalPath}.part`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, finalPath);
    return buffer.length;
  }

  readChunk(fileId, index) {
    const p = this.filePath(fileId, index);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p);
  }

  deleteFileBlobs(fileId) {
    const dir = path.join(BLOB_DIR, fileId);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // --------------------------------------------------------------- events
  pushEvent(event) {
    const record = Object.assign({ id: this.nextId('e_'), at: now() }, event);
    this.db.events.push(record);
    if (this.db.events.length > 8000) this.db.events.splice(0, this.db.events.length - 8000);
    this.touch();
    return record;
  }

  audit(actorId, action, detail = {}) {
    this.db.audit.push({ id: this.nextId('a_'), at: now(), actorId, action, detail });
    if (this.db.audit.length > 4000) this.db.audit.splice(0, this.db.audit.length - 4000);
    this.touch();
  }

  // -------------------------------------------------------------- metrics
  bumpMetrics(patch) {
    const minute = Math.floor(Date.now() / 60000);
    const list = this.db.metrics.minutes;
    let bucket = list[list.length - 1];
    if (!bucket || bucket.t !== minute) {
      bucket = { t: minute, req: 0, bytesIn: 0, bytesOut: 0, msgs: 0, uploads: 0, users: {} };
      list.push(bucket);
      if (list.length > 240) list.splice(0, list.length - 240);
    }
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'user') bucket.users[value] = 1;
      else bucket[key] = (bucket[key] || 0) + value;
    }
    if (list.length > 1) {
      // keep the object small across restarts
      for (const b of list) {
        if (b.users && Object.keys(b.users).length > 512) b.users = {};
      }
    }
    this.dirty = true;
  }

  metricsSeries(minutes = 60) {
    const current = Math.floor(Date.now() / 60000);
    const list = this.db.metrics.minutes.filter((b) => b.t > current - minutes);
    const out = [];
    for (let i = minutes - 1; i >= 0; i--) {
      const t = current - i;
      const found = list.find((b) => b.t === t);
      out.push(found ? { t, req: found.req, bytesIn: found.bytesIn, bytesOut: found.bytesOut, msgs: found.msgs, uploads: found.uploads } : { t, req: 0, bytesIn: 0, bytesOut: 0, msgs: 0, uploads: 0 });
    }
    return out;
  }

  // -------------------------------------------------------- housekeeping
  pruneExpired() {
    const t = now();
    let changed = false;
    for (const [id, story] of Object.entries(this.db.stories)) {
      if (story.expiresAt <= t) {
        delete this.db.stories[id];
        changed = true;
      }
    }
    for (const [code, record] of Object.entries(this.db.dmCodes)) {
      if (record.expiresAt && record.expiresAt <= t) {
        delete this.db.dmCodes[code];
        changed = true;
      }
    }
    for (const [id, request] of Object.entries(this.db.requests)) {
      if (request.status === 'open' && request.expiresAt && request.expiresAt <= t) {
        request.status = 'expired';
        changed = true;
      }
    }
    const week = require('./util').isoWeek();
    this.db.counters.lastWeek = week;
    if (changed) this.touch();
    return changed;
  }

  stats() {
    const db = this.db;
    const bytesFor = (kind) => Object.values(db.files)
      .filter((f) => f.kind === kind)
      .reduce((sum, f) => sum + (f.size || 0), 0);
    const dbBytes = (() => {
      try { return fs.statSync(DB_FILE).size; } catch { return 0; }
    })();
    return {
      users: Object.keys(db.users).length,
      sessions: Object.keys(db.sessions).length,
      conversations: Object.keys(db.conversations).length,
      messages: Object.keys(db.messages).length,
      forums: Object.keys(db.forums).length,
      threads: Object.keys(db.threads).length,
      posts: Object.keys(db.posts).length,
      stories: Object.values(db.stories).filter((s) => s.expiresAt > now()).length,
      files: Object.keys(db.files).length,
      storage: {
        dm: bytesFor('dm'),
        drive: bytesFor('drive'),
        story: bytesFor('story'),
        forum: bytesFor('forum'),
        airdrop: bytesFor('airdrop'),
        avatar: bytesFor('avatar'),
        publicProfile: bytesFor('public'),
        total: Object.values(db.files).reduce((sum, f) => sum + (f.size || 0), 0),
        database: dbBytes,
      },
      clicks: db.counters.clicks,
      signups: db.counters.signups,
      events: db.events.length,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    };
  }
}

const store = new Store();

module.exports = { store, DEFAULT_LIMITS, DATA_DIR, BLOB_DIR, DB_FILE };
