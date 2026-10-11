'use strict';

/**
 * AE Secure — zero-knowledge messaging, community and cloud drive server.
 *
 * The server only ever stores: account metadata, SHA-256/scrypt verifiers,
 * ciphertext blobs, wrapped keys and traffic counters. Message bodies, file
 * contents and file names never arrive in a readable form.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { store } = require('./store');
const { realtime } = require('./realtime');
const h = require('./helpers');
const { now, RateLimiter } = require('./util');

const PORT = Number(process.env.PORT || process.env.AE_PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ---------------------------------------------------------------- transport
// WebCrypto — which every message, file and account key depends on — only
// exists in a secure context. Browsers grant that to https:// and to
// localhost, never to a bare http://192.168.x.x, so a phone on the network
// must be given TLS. Point AE_TLS_CERT and AE_TLS_KEY at a certificate pair
// (the Termux installer generates one) and this serves HTTPS.
const TLS_CERT = process.env.AE_TLS_CERT || '';
const TLS_KEY = process.env.AE_TLS_KEY || '';
const TLS_AVAILABLE = !!(TLS_CERT && TLS_KEY && fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY));
// The local certificate authority the installer creates.  Handing this file to
// a device once is what turns "Not secure" into a plain padlock.
const TLS_CA = process.env.AE_TLS_CA || '';
const CA_AVAILABLE = !!(TLS_CA && fs.existsSync(TLS_CA));
const FORCE_HTTPS = String(process.env.AE_FORCE_HTTPS || '') === '1';
const HTTP_PORT = Number(process.env.AE_HTTP_PORT || 0);

const globalLimiter = new RateLimiter({ points: 600, windowMs: 60000 });
const authLimiter = new RateLimiter({ points: 240, windowMs: 60000 });

// ------------------------------------------------------------------- routing
const ROUTES = new Map();

function register(module_) {
  for (const [key, handler] of Object.entries(module_)) {
    if (key === 'GET /api/health' || key.startsWith('GET /api') || /^(GET|POST|PATCH|PUT|DELETE) \/api/.test(key)) {
      ROUTES.set(key, handler);
    }
  }
}

register(require('./routes-auth').routes);
register(require('./routes-social').routes);
register(require('./routes-files').routes);
register(require('./routes-admin').routes);

ROUTES.set('GET /api/health', async () => ({
  ok: true,
  name: 'AE Secure',
  time: now(),
  uptime: process.uptime(),
  users: Object.keys(store.db.users).length,
}));

function matchRoute(method, pathname) {
  const segments = pathname.split('/').filter(Boolean);
  for (const [key, handler] of ROUTES.entries()) {
    const spaceIndex = key.indexOf(' ');
    const routeMethod = key.slice(0, spaceIndex);
    if (routeMethod !== method) continue;
    const pattern = key.slice(spaceIndex + 1).split('/').filter(Boolean);
    if (pattern.length !== segments.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pattern.length; i++) {
      const part = pattern[i];
      if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(segments[i]);
      else if (part !== segments[i]) { ok = false; break; }
    }
    if (ok) return { handler, params, key };
  }
  return null;
}

// ------------------------------------------------------------------- static
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors *",
  ].join('; '),
};

/**
 * Serves the local CA for download.  Called before the SPA fallback so
 * /ca.crt never returns index.html.
 */
function sendCaFile(res, download) {
  if (!CA_AVAILABLE) {
    res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain' }, SECURITY_HEADERS));
    res.end('No local certificate authority on this install.');
    return true;
  }
  const body = fs.readFileSync(TLS_CA);
  res.writeHead(200, Object.assign({
    'Content-Type': 'application/x-x509-ca-cert',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Content-Disposition': download ? 'attachment; filename="ae-secure-ca.crt"' : 'inline; filename="ae-secure-ca.crt"',
  }, SECURITY_HEADERS));
  res.end(body);
  return true;
}

function sendStatic(req, res, pathname) {
  let relative = pathname === '/' ? '/index.html' : pathname;
  if (!path.extname(relative) && !relative.startsWith('/api')) relative = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(relative).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return true;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    if (relative !== '/index.html') {
      // SPA fallback for in-app routes
      return sendStatic(req, res, '/index.html');
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return true;
  }
  const stat = fs.statSync(filePath);
  const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, SECURITY_HEADERS);
    res.end();
    return true;
  }
  const ext = path.extname(filePath).toLowerCase();
  const headers = Object.assign({}, SECURITY_HEADERS, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    ETag: etag,
    // Markup, styles and scripts always revalidate (304s keep it cheap) so an
    // operator editing the app on the phone sees changes on the next reload;
    // images, fonts and icons may sit in the browser cache.
    'Cache-Control': ['.html', '.css', '.js', '.webmanifest', '.json'].includes(ext) ? 'no-cache' : 'public, max-age=3600',
  });
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
  return true;
}

// ------------------------------------------------------------------- helpers
function parseQuery(url) {
  const query = {};
  for (const [key, value] of url.searchParams.entries()) query[key] = value;
  return query;
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return (req.socket.remoteAddress || '').replace('::ffff:', '');
}

function readToken(req, url) {
  const header = req.headers['x-ae-token'] || req.headers['authorization'];
  if (header) {
    const value = String(header).replace(/^Bearer\s+/i, '').trim();
    if (value) return value;
  }
  if (url && url.searchParams.get('token')) return url.searchParams.get('token');
  return null;
}

function setCommonHeaders(res) {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    if (key === 'Content-Security-Policy') continue;
    res.setHeader(key, value);
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-AE-Token, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
}

function maintenancePage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>AE Secure — Maintenance</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root { color-scheme: dark; }
    body { margin:0; min-height:100vh; display:grid; place-items:center; font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
      background: radial-gradient(1200px 600px at 20% 0%, #12305c 0%, #0a1626 45%, #060b13 100%); color:#eaf2ff; }
    .card { width:min(520px, 90vw); padding:34px; border-radius:18px; background: rgba(255,255,255,.07);
      border:1px solid rgba(255,255,255,.14); backdrop-filter: blur(28px) saturate(160%); box-shadow: 0 30px 80px rgba(0,0,0,.55); }
    h1 { font-size:22px; margin:0 0 8px; letter-spacing:.2px; }
    p { margin:0; opacity:.75; line-height:1.6; font-size:14px; }
    .bar { height:3px; margin:0 0 18px; border-radius:3px; background:linear-gradient(90deg,#4fc3f7,#7c4dff); }
  </style></head><body><div class="card"><div class="bar"></div><h1>AE Secure is in maintenance mode</h1>
  <p>The operator has paused the service for maintenance. Please try again shortly.</p></div></body></html>`;
}

// ------------------------------------------------------------------- SSE
function handleStream(req, res, url, session) {
  if (!session) {
    h.sendJson(res, 401, { error: 'Sign in required', code: 'unauthorized' });
    return true;
  }
  const user = store.userById(session.userId);
  if (!user || user.banned || user.disabled) {
    h.sendJson(res, 403, { error: 'Account unavailable', code: 'forbidden' });
    return true;
  }
  const channels = (url.searchParams.get('channels') || 'user').split(',').map((c) => c.trim()).filter(Boolean);
  const allowed = channels.filter((c) => {
    if (c === 'neural' || c === 'admin') return h.isAdmin(user);
    return ['user', 'presence', 'feed', 'click', 'public', 'global'].includes(c);
  });
  res.writeHead(200, Object.assign({}, SECURITY_HEADERS, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  }));
  res.write(`retry: 3000\n\n`);
  const id = realtime.addClient(res, { userId: user.id, channels: allowed });
  const status = realtime.statusOf(user.id);
  res.write(`event: ready\ndata: ${JSON.stringify({ channels: allowed, status, at: now() })}\n\n`);
  realtime.broadcast({ kind: 'presence.changed', userId: user.id, status }, 'presence', { skipUser: user.id });

  const keepAlive = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); } catch { clearInterval(keepAlive); }
  }, 20000);
  if (keepAlive.unref) keepAlive.unref();

  req.on('close', () => {
    clearInterval(keepAlive);
    realtime.removeClient(id);
    const after = realtime.statusOf(user.id);
    realtime.broadcast({ kind: 'presence.changed', userId: user.id, status: after }, 'presence', { skipUser: user.id });
  });
  return true;
}

// ------------------------------------------------------------------- server
async function handleRequest(req, res) {
  const started = process.hrtime.bigint();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  const pathname = decodeURIComponent(url.pathname);
  setCommonHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const ip = clientIp(req);
  const limited = globalLimiter.hit(`ip:${ip}`, 1);
  if (!limited.allowed) {
    h.sendJson(res, 429, { error: 'Too many requests. Slow down.', code: 'rate_limited' });
    return;
  }

  const token = readToken(req, url);
  let session = token ? store.sessionByToken(token) : null;
  let user = session ? store.userById(session.userId) : null;
  if (session && (!user || session.revoked)) {
    store.revokeSession(session.token);
    session = null;
    user = null;
  }
  if (session) {
    session.lastSeenAt = now();
    if (user) {
      user.status.lastActive = now();
      realtime.markPresence(user.id, {});
    }
  }

  // -------- event stream
  if (pathname === '/api/stream') {
    handleStream(req, res, url, session);
    return;
  }

  const isApi = pathname.startsWith('/api');
  if (isApi && store.db.global.maintenance && !(user && h.isAdmin(user)) && pathname !== '/api/bootstrap' && pathname !== '/api/health' && pathname !== '/api/auth/login' && pathname !== '/api/auth/salt') {
    h.sendJson(res, 503, { error: 'Server is in maintenance mode.', code: 'maintenance' });
    return;
  }

  const matched = isApi ? matchRoute(req.method, pathname) : null;
  if (isApi && !matched) {
    h.sendJson(res, 404, { error: `No route for ${req.method} ${pathname}`, code: 'not_found' });
    return;
  }

  if (!isApi) {
    if (pathname === '/ca.crt') { sendCaFile(res, true); return; }
    if (pathname === '/ca.pem' || pathname === '/ae-secure-ca.crt') { sendCaFile(res, true); return; }
    // /trust is a real page, not an app route: the single-page fallback would
    // otherwise hand back index.html.
    if (pathname === '/trust' || pathname === '/trust/') { sendStatic(req, res, '/trust.html'); return; }
    sendStatic(req, res, pathname);
    return;
  }

  const isRawUpload = pathname.includes('/chunk/');
  const ctx = {
    req,
    res,
    params: matched.params,
    query: parseQuery(url),
    body: {},
    user,
    session,
    ip,
    handled: false,
    route: matched.key,
  };

  try {
    const authSensitive = /\/api\/auth\//.test(pathname);
    const check = authLimiter.hit(`${authSensitive ? 'auth' : 'api'}:${ip}`);
    if (!check.allowed) {
      h.sendJson(res, 429, { error: 'Rate limit reached for this device.', code: 'rate_limited' });
      return;
    }
    if (!isRawUpload && ['POST', 'PATCH', 'PUT'].includes(req.method)) {
      const limit = pathname === '/api/files/init' ? 4 * 1024 * 1024 : 1024 * 1024;
      ctx.body = await h.readJson(req, limit);
    } else if (req.method === 'DELETE' || req.method === 'GET') {
      ctx.body = {};
    }

    const result = await matched.handler(ctx);
    if (ctx.handled) return;
    h.sendJson(res, 200, result === undefined ? { ok: true } : result);
  } catch (error) {
    if (ctx.handled) {
      try { ctx.res.end(); } catch { /* ignore */ }
      return;
    }
    h.sendError(res, error);
  } finally {
    const microseconds = Number(process.hrtime.bigint() - started) / 1000;
    if (!isRawUpload || req.method === 'GET') {
      store.bumpMetrics({ req: 1, ...(microseconds > 25000 ? { slow: 1 } : {}) });
    } else {
      store.bumpMetrics({ req: 1 });
    }
  }
}

// ------------------------------------------------------------------- boot
store.init();
if (!Object.keys(store.db.users).length) {
  console.log('[ae] fresh installation detected — the first registered account becomes the owner.');
}

setInterval(() => {
  store.pruneSessions();
  store.pruneExpired();
}, 60000).unref?.();

setInterval(() => store.save(), 15000).unref?.();

// A plain-http listener exists only to push browsers onto https, where the
// crypto API lives. It never serves the application.
const redirectServer = TLS_AVAILABLE && HTTP_PORT ? http.createServer((req, res) => {
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  res.writeHead(301, { Location: `https://${host}:${PORT}${req.url}` });
  res.end();
}) : null;

const server = TLS_AVAILABLE
  ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, handleRequest)
  : http.createServer(handleRequest);

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

server.listen(PORT, HOST, () => {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const list of Object.values(interfaces)) {
    for (const entry of list || []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  console.log('');
  const scheme = TLS_AVAILABLE ? 'https' : 'http';
  console.log('  AE Secure — encrypted messaging, communities and cloud drive');
  console.log(`  listening on ${scheme}://${HOST}:${PORT}`);
  for (const address of addresses) console.log(`  network       ${scheme}://${address}:${PORT}`);
  if (!TLS_AVAILABLE) {
    const insecure = addresses.some(Boolean);
    console.log('  transport     plain http — browsers only expose WebCrypto on');
    console.log('                https:// or localhost, so phones cannot create');
    console.log('                accounts or decrypt anything on this address.');
    console.log('                Run scripts/termux-install.sh (or pass');
    console.log('                AE_TLS_CERT/AE_TLS_KEY) to serve https instead.');
    if (insecure) console.log('');
  }
  console.log(`  data directory ${path.dirname(require('./store').DB_FILE)}`);
  console.log('');
});

function shutdown(signal) {
  console.log(`[ae] ${signal} received — flushing database`);
  store.save(true);
  if (redirectServer) redirectServer.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error) => console.error('[ae] uncaught exception:', error));
process.on('unhandledRejection', (error) => console.error('[ae] unhandled rejection:', error));

if (redirectServer) redirectServer.listen(HTTP_PORT, HOST, () => {
  console.log(`  redirect      http://${HOST}:${HTTP_PORT} -> https://…:${PORT}`);
});

module.exports = { server, PORT, TLS_AVAILABLE, CA_AVAILABLE, FORCE_HTTPS };
