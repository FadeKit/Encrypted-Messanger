'use strict';

const crypto = require('crypto');

const B64 = 'base64';

function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Opaque, human-transcribable code groups: XXXX-XXXX-XXXX */
function humanCode(groups = 3, size = 4) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const out = [];
  for (let g = 0; g < groups; g++) {
    let part = '';
    const buf = crypto.randomBytes(size);
    for (let i = 0; i < size; i++) part += alphabet[buf[i] % alphabet.length];
    out.push(part);
  }
  return out.join('-');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(value, key) {
  return crypto.createHmac('sha256', key).update(value).digest();
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // still burn a comparison to keep timing flat
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function now() {
  return Date.now();
}

const SIZE = {
  KB: 1024,
  MB: 1024 * 1024,
  GB: 1024 * 1024 * 1024,
  TB: 1024 * 1024 * 1024 * 1024,
};

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unlimited';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function sanitizeText(value, max = 400) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
}

function sanitizeHandle(value) {
  return sanitizeText(value, 32).replace(/[^a-zA-Z0-9._-]/g, '').toLowerCase();
}

function isEmailish(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
}

function pick(object, keys) {
  const out = {};
  if (!object || typeof object !== 'object') return out;
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(object, key)) out[key] = object[key];
  return out;
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Token bucket, keyed, used for abuse protection on the login and write paths. */
class RateLimiter {
  constructor({ points, windowMs, blockMs = 0 }) {
    this.points = points;
    this.windowMs = windowMs;
    this.blockMs = blockMs;
    this.buckets = new Map();
  }

  hit(key, cost = 1) {
    const t = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.reset <= t) {
      bucket = { tokens: this.points, reset: t + this.windowMs, blockedUntil: bucket ? bucket.blockedUntil : 0 };
      this.buckets.set(key, bucket);
    }
    if (bucket.blockedUntil > t) return { allowed: false, retryAfter: bucket.blockedUntil - t };
    if (bucket.tokens < cost) {
      if (this.blockMs) bucket.blockedUntil = t + this.blockMs;
      return { allowed: false, retryAfter: bucket.reset - t };
    }
    bucket.tokens -= cost;
    return { allowed: true, retryAfter: 0 };
  }

  prune() {
    const t = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.reset <= t && bucket.blockedUntil <= t) this.buckets.delete(key);
    }
  }
}

module.exports = {
  B64,
  SIZE,
  randomId,
  randomToken,
  humanCode,
  sha256,
  hmac,
  timingSafeEqual,
  clampNumber,
  now,
  formatBytes,
  isoWeek,
  sanitizeText,
  sanitizeHandle,
  isEmailish,
  pick,
  deepMerge,
  RateLimiter,
};
