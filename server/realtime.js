'use strict';

const { store } = require('./store');
const { now } = require('./util');

const ONLINE_WINDOW = 3 * 60 * 1000;      // active user
const IDLE_WINDOW = 5 * 60 * 1000;        // idle fallback when client stops pinging
const PRESENCE_TIMEOUT = 75 * 1000;       // consider the tab closed after this silence

/**
 * Server-Sent Events hub.
 *
 * Each connection registers a channel: "user" for personal notifications and
 * "neural" for the admin live graph. The neural channel is only open while an
 * administrator is actually looking at the visualiser, so an idle admin panel
 * costs the phone nothing.
 */
class Realtime {
  constructor() {
    this.clients = new Map();      // id -> { res, userId, channels:Set, ip, openedAt }
    this.presence = new Map();     // userId -> { lastPing, mode, custom, sockets }
    this.neuralSubscribers = 0;
    this._seq = 0;
    this._hb = setInterval(() => this.heartbeat(), 25000);
    if (this._hb.unref) this._hb.unref();
  }

  addClient(res, { userId, channels = ['user'] }) {
    const id = `c_${++this._seq}`;
    const entry = { id, res, userId, channels: new Set(channels), openedAt: now() };
    this.clients.set(id, entry);
    if (channels.includes('neural')) this.neuralSubscribers += 1;
    this.markPresence(userId, { mode: null });
    return id;
  }

  removeClient(id) {
    const entry = this.clients.get(id);
    if (!entry) return;
    if (entry.channels.has('neural')) this.neuralSubscribers = Math.max(0, this.neuralSubscribers - 1);
    this.clients.delete(id);
    const user = store.userById(entry.userId);
    if (user) {
      user.status.lastActive = now();
      store.touch();
    }
  }

  write(entry, payload, eventName = 'message') {
    try {
      entry.res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch {
      this.removeClient(entry.id);
    }
  }

  send(userId, payload, eventName = 'message') {
    for (const entry of this.clients.values()) {
      if (entry.userId === userId && entry.channels.has('user')) this.write(entry, payload, eventName);
    }
  }

  sendMany(userIds, payload, eventName = 'message') {
    const set = new Set(userIds);
    for (const entry of this.clients.values()) {
      if (set.has(entry.userId) && entry.channels.has('user')) this.write(entry, payload, eventName);
    }
  }

  broadcast(payload, eventName = 'message', { channel = 'user', skipUser = null } = {}) {
    for (const entry of this.clients.values()) {
      if (!entry.channels.has(channel)) continue;
      if (skipUser && entry.userId === skipUser) continue;
      this.write(entry, payload, eventName);
    }
  }

  /** Push admin-only telemetry to open visualiser sockets. */
  neural(payload) {
    const recipients = new Set();
    for (const entry of this.clients.values()) {
      if (!entry.channels.has('neural')) continue;
      const user = store.userById(entry.userId);
      if (user && (user.role === 'owner' || user.role === 'admin')) {
        recipients.add(entry.userId);
        this.write(entry, payload, 'neural');
      }
    }
    return recipients.size;
  }

  adminEvent(payload) {
    for (const entry of this.clients.values()) {
      const user = store.userById(entry.userId);
      if (user && (user.role === 'owner' || user.role === 'admin')) this.write(entry, payload, 'admin');
    }
  }

  heartbeat() {
    const t = now();
    for (const entry of this.clients.values()) {
      // first a no-op flush so dead sockets surface as write errors, then a comment ping
      this.write(entry, { t, kind: 'ping' }, 'ping');
    }
    for (const [userId, record] of this.presence.entries()) {
      if (t - record.lastPing > PRESENCE_TIMEOUT * 4) this.presence.delete(userId);
    }
  }

  markPresence(userId, patch = {}) {
    const record = this.presence.get(userId) || { lastPing: 0, mode: 'online', custom: '', sockets: 0 };
    record.lastPing = now();
    if (patch.mode) {
      const allowed = ['online', 'idle', 'dnd', 'invisible', 'offline', 'purple'];
      if (allowed.includes(patch.mode)) record.mode = patch.mode;
    }
    if (typeof patch.custom === 'string') record.custom = patch.custom.slice(0, 120);
    if (patch.manual !== undefined) record.manual = !!patch.manual;
    this.presence.set(userId, record);
    const user = store.userById(userId);
    if (user) {
      user.status.mode = record.mode;
      user.status.custom = record.custom;
      user.status.manual = !!record.manual;
      user.status.lastActive = now();
      store.touch();
    }
    return record;
  }

  /** Effective, privacy-aware status as seen by other users. */
  statusOf(userId) {
    const user = store.userById(userId);
    if (!user) return { key: 'offline', label: 'Offline', custom: '' };
    const record = this.presence.get(userId);
    const lastActive = Math.max(user.status.lastActive || 0, record ? record.lastPing : 0);
    const idleFor = now() - lastActive;
    let mode = (record && record.mode) || user.status.mode || 'online';
    if (mode === 'offline' || mode === 'invisible') return { key: 'offline', label: 'Offline', custom: record ? record.custom : user.status.custom };
    if (mode === 'dnd') return { key: 'dnd', label: 'Do Not Disturb', custom: record ? record.custom : user.status.custom };
    if (mode === 'purple' && user.purpleAllowed) {
      return { key: idleFor < ONLINE_WINDOW ? 'purple' : 'offline', label: idleFor < ONLINE_WINDOW ? 'Online' : 'Offline', custom: record ? record.custom : user.status.custom };
    }
    if (idleFor < ONLINE_WINDOW) return { key: 'online', label: 'Online', custom: record ? record.custom : user.status.custom };
    if (idleFor < IDLE_WINDOW) return { key: 'idle', label: 'Idle', custom: record ? record.custom : user.status.custom };
    return { key: 'offline', label: 'Offline', custom: record ? record.custom : user.status.custom };
  }

  isReachable(userId) {
    return this.statusOf(userId).key === 'online' || this.statusOf(userId).key === 'purple' || this.statusOf(userId).key === 'dnd';
  }

  presenceSnapshot() {
    const out = {};
    for (const user of store.allUsers()) out[user.id] = this.statusOf(user.id);
    return out;
  }

  onlineUserIds() {
    const out = [];
    for (const user of store.allUsers()) {
      const status = this.statusOf(user.id).key;
      if (status === 'online' || status === 'purple' || status === 'dnd' || status === 'idle') out.push(user.id);
    }
    return out;
  }

  /** Fan an event out to a set of users, plus the admin telemetry channel. */
  fanout(userIds, payload, { neural = null, eventName = 'message' } = {}) {
    const unique = [...new Set(userIds.filter(Boolean))];
    this.sendMany(unique, payload, eventName);
    if (neural) this.neural(neural);
    return unique.length;
  }
}

const realtime = new Realtime();

module.exports = { realtime, ONLINE_WINDOW, IDLE_WINDOW };
