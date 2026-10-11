'use strict';

/**
 * AE Secure — client static suite.
 *
 * Loads every browser script in exactly the order public/index.html declares,
 * against a minimal DOM shim. This catches mistakes that only surface in a real
 * browser: syntax errors, duplicate top-level bindings, a missing surface
 * registration, an app id opened but never registered, or a feature module that
 * assumes a DOM node the shell has not built yet.
 *
 *   node tests/client.js [--verbose]
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const VERBOSE = process.argv.includes('--verbose');

let pass = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass += 1; if (VERBOSE) console.log('  ✓', name); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log('  ✗', name, detail); }
}

const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const order = [...html.matchAll(/<script defer src="\/js\/([^"]+)"><\/script>/g)].map((m) => m[1]);
console.log(`\nAE Secure — client static suite (${order.length} scripts)\n`);

// ---------------------------------------------------------------- assets exist
const cssFiles = [...html.matchAll(/href="\/(css\/[^"]+)"/g)].map((m) => m[1]);
for (const asset of [...cssFiles.map((f) => path.join(PUBLIC, f)), ...order.map((f) => path.join(PUBLIC, 'js', f)), path.join(PUBLIC, 'manifest.webmanifest'), path.join(PUBLIC, 'icon.svg')]) {
  check(`asset present: ${path.relative(PUBLIC, asset)}`, fs.existsSync(asset));
}
check('index.html declares the AE Secure title', /<title>AE Secure/.test(html));
check('index.html links the manifest', html.includes('/manifest.webmanifest'));

// ------------------------------------------------- duplicate top-level bindings
const declared = new Map();
let duplicates = 0;
for (const file of order) {
  const src = fs.readFileSync(path.join(PUBLIC, 'js', file), 'utf8');
  for (const m of src.matchAll(/^(?:const|let|var|function|class|async function)\s+([A-Za-z_$][\w$]*)/gm)) {
    const name = m[1];
    if (declared.has(name)) { duplicates += 1; failures.push(`duplicate top-level "${name}" in ${file} (also ${declared.get(name)})`); }
    else declared.set(name, file);
  }
}
check(`no duplicate top-level bindings (${declared.size} total)`, duplicates === 0);

// ------------------------------------------------------------------ DOM shim
function makeEl(tag = 'div') {
  const node = {
    tagName: String(tag).toUpperCase(), children: [], style: {}, dataset: {}, attributes: {},
    parentNode: null, get firstChild() { return this.children[0] || null; }, get lastChild() { return this.children[this.children.length - 1] || null; }, get childNodes() { return this.children; },
    classList: { _s: new Set(), add(...c) { c.forEach((x) => this._s.add(x)); }, remove(...c) { c.forEach((x) => this._s.delete(x)); }, toggle(c) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); }, contains(c) { return this._s.has(c); } },
    textContent: '', innerHTML: '', value: '', checked: false, disabled: false, hidden: false,
    append(...kids) { for (const kid of kids) { if (kid && typeof kid === 'object') kid.parentNode = this; this.children.push(kid); } },
    appendChild(n) { if (n && typeof n === 'object') n.parentNode = this; this.children.push(n); return n; },
    prepend(...kids) { this.children.unshift(...kids); }, removeChild(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); return n; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }, before() {}, after() {}, replaceWith() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    setAttribute(k, v) { this.attributes[k] = v; }, getAttribute(k) { return this.attributes[k]; }, removeAttribute(k) { delete this.attributes[k]; },
    querySelector: (sel) => elements(sel)[0] || null, querySelectorAll: (sel) => elements(sel), closest: () => null, contains: () => false,
    set className(v) { this.attributes.class = v; }, get className() { return this.attributes.class || ''; },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    focus() {}, select() {}, click() {}, insertAdjacentHTML() {}, scrollTo() {}, scrollIntoView() {},
    getContext: () => null, toDataURL: () => '', animate: () => ({ finished: Promise.resolve() }),
  };
  return node;
}

const storage = () => { const map = new Map(); return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), clear: () => map.clear() }; };

// a lookup table so selectors resolve like they do in a real document
const registry = new Map();
function elements(selector) {
  const key = String(selector).trim();
  if (!key) return [];
  const idMatch = /^#([\w-]+)$/.exec(key);
  if (idMatch) {
    const id = idMatch[1];
    if (!registry.has(id)) { const node = makeEl('div'); node.id = id; registry.set(id, node); }
    return [registry.get(id)];
  }
  if (/^[.#\[\w-]+$/.test(key)) {
    if (!registry.has(key)) registry.set(key, makeEl('div'));
    return [registry.get(key)];
  }
  return [];
}

const shim = {
  document: Object.assign(makeEl('body'), {
    documentElement: makeEl('html'), head: makeEl('head'),
    createElement: (tag) => makeEl(tag), createTextNode: (t) => ({ textContent: t }),
    createDocumentFragment: () => makeEl('fragment'),
    getElementById: (id) => elements(`#${id}`)[0] || null,
    querySelector: (sel) => elements(sel)[0] || null,
    querySelectorAll: (sel) => elements(sel),
    hidden: false, visibilityState: 'visible', readyState: 'loading', title: '', cookie: '',
  }),
  navigator: { userAgent: 'ae-secure-tests', platform: 'test', language: 'en', clipboard: { writeText: async () => {} } },
  crypto: webcrypto, TextEncoder, TextDecoder, console, setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: (fn) => setTimeout(() => fn(1), 0), cancelAnimationFrame: clearTimeout,
  queueMicrotask, structuredClone, Math, Date, JSON, Promise, Map, Set, Number, String, Object, Array, RegExp, Error, Boolean,
  localStorage: storage(), sessionStorage: storage(),
  location: { href: 'http://localhost/', search: '', origin: 'http://localhost', reload() {}, assign() {} },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  addEventListener() {}, removeEventListener() {}, getComputedStyle: () => ({ getPropertyValue: () => '' }),
  EventSource: class { constructor() {} addEventListener() {} close() {} },
  Notification: class { static permission = 'denied'; static requestPermission = async () => 'denied'; constructor() {} },
  URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
  Blob: class { constructor(parts) { this.parts = parts; this.size = 0; } }, File: class {}, FormData: class {},
  AbortController,
  fetch: async () => ({
    ok: false, status: 404, statusText: 'shim', url: 'http://localhost/api',
    json: async () => ({}), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0), blob: async () => new Blob([]),
    headers: { get: () => null, has: () => false, entries: () => [] },
  }),
  performance: { now: () => Date.now() },
  ResizeObserver: class { observe() {} disconnect() {} }, IntersectionObserver: class { observe() {} disconnect() {} },
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
  alert() {}, confirm: () => false, prompt: () => null, getSelection: () => ({ toString: () => '' }),
  innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1, screen: { width: 1280, height: 800 },
};
shim.window = shim; shim.self = shim; shim.globalThis = shim;
vm.createContext(shim);

// asynchronous surface paints run against the stub network; they must never take
// the suite down, so their rejections are recorded but not fatal
const asyncNoise = [];
process.on('unhandledRejection', (error) => { asyncNoise.push(error && error.message ? error.message : String(error)); });

let booted = 0;
for (const file of order) {
  try { vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'js', file), 'utf8'), shim, { filename: file }); booted += 1; }
  catch (error) { failures.push(`${file}: ${error.message}`); console.log(`  ✗ ${file} — ${error.message}`); }
}
check(`every script loads (${booted}/${order.length})`, booted === order.length);

// ------------------------------------------------------------------ globals
const expectedGlobals = ['AE', 'API', 'UI', 'Windows', 'State', 'Media', 'Apps', 'Terms', 'ConversationClient', 'Viewer', 'Profile', 'CommunityClient', 'DriveClient', 'StoriesClient', 'AirdropClient', 'Clicker', 'Help', 'Settings', 'AdminClient', 'Shell'];
for (const name of expectedGlobals) check(`global ${name} is exported`, !!shim[name]);

// ------------------------------------------------------------------ app registry
const apps = shim.Apps ? shim.Apps.all() : [];
const appIds = apps.map((a) => a.id);
check(`surfaces registered (${appIds.length})`, appIds.length >= 10, appIds.join(', '));
for (const required of ['messages', 'communities', 'stories', 'drive', 'files', 'airdrop', 'profile', 'settings', 'clicker', 'admin']) {
  check(`surface registered: ${required}`, appIds.includes(required));
}

// every Apps.open('id') target must exist
const opened = new Set();
for (const file of order) {
  const src = fs.readFileSync(path.join(PUBLIC, 'js', file), 'utf8');
  for (const m of src.matchAll(/Apps\.open\(['"]([a-z]+)['"]/g)) opened.add(m[1]);
}
for (const id of opened) check(`Apps.open('${id}') resolves to a registered surface`, appIds.includes(id));

// window ids opened through the window manager must be registered too
const windowIds = new Set();
for (const file of order) {
  const src = fs.readFileSync(path.join(PUBLIC, 'js', file), 'utf8');
  for (const m of src.matchAll(/Windows\.open\(\{\s*id:\s*['"]([a-z]+)['"]/g)) windowIds.add(m[1]);
}
for (const id of windowIds) check(`Windows.open id '${id}' matches a surface`, appIds.includes(id));

// --------------------------------------- client calls resolve to server routes
const routeMap = new Map();
for (const module of ['routes-auth.js', 'routes-social.js', 'routes-files.js', 'routes-admin.js']) {
  const loaded = require(path.join(ROOT, 'server', module));
  const table = loaded && loaded.routes ? loaded.routes : loaded;
  for (const key of Object.keys(table || {})) {
    if (/^(GET|POST|PATCH|DELETE|PUT) \/api\//.test(key)) routeMap.set(key, module);
  }
}
const routePatterns = [...routeMap.keys()].map((key) => {
  const [method, pattern] = key.split(' ');
  const regex = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z_]+/g, '[^/]+')}$`);
  return { method, pattern, regex, module: routeMap.get(key) };
});
check(`server exposes ${routePatterns.length} API routes`, routePatterns.length > 60, String(routePatterns.length));

const calls = new Map();
for (const file of order) {
  const src = fs.readFileSync(path.join(PUBLIC, 'js', file), 'utf8');
  for (const m of src.matchAll(/(?:API\.(get|post|patch|del)|fetch)\(?[^\n]{0,20}?['"`](\/api\/[^'"`]*)/g)) {
    const method = { get: 'GET', post: 'POST', patch: 'PATCH', del: 'DELETE', fetch: 'GET' }[m[1]] || 'GET';
    const url = m[2].replace(/\$\{[^}]*\}/g, '1').split('?')[0];
    if (url.includes('/api/files/') && url.match(/\$\{/)) continue;
    calls.set(`${method} ${url}`, file);
  }
}
let unresolved = 0;
for (const [call, file] of calls) {
  const [method, url] = call.split(' ');
  const hit = routePatterns.some((route) => route.method === method && route.regex.test(url));
  if (!hit) { unresolved += 1; failures.push(`${file}: ${call} has no matching server route`); }
}
check(`every client API call resolves (${calls.size} calls, ${routePatterns.length} routes)`, unresolved === 0);

// help articles must be non-empty and searchable
if (shim.Help) {
  check('help centre ships articles', shim.Help.ARTICLES.length >= 20, `count=${shim.Help.ARTICLES.length}`);
  check('help search finds a setting by name', shim.Help.search('backup codes').length > 0);
  check('help search is empty for nonsense', shim.Help.search('zzzzqqq').length === 0);
}

// every setting row that asks for help must name a real article
if (shim.Help) {
  const titles = shim.Help.ARTICLES.map((a) => a.title.toLowerCase());
  const asked = new Set();
  for (const file of order) {
    const src = fs.readFileSync(path.join(PUBLIC, 'js', file), 'utf8');
    for (const m of src.matchAll(/Help\.open\(([^)]*)\)/g)) {
      const literal = /^['"]([^'"]+)['"]$/.exec(m[1].trim());
      if (literal) asked.add(literal[1]);
    }
  }
  for (const title of asked) check(`help article exists for “${title}”`, titles.includes(title.toLowerCase()));
}

// ------------------------------------------- every surface builds without throwing
if (shim.State && shim.Apps) {
  // minimal session so the surfaces have data to read
  shim.State.set('boot', { server: { uptime: 1, counts: { users: 1 }, notice: '' }, version: '1.0.0' });
  shim.State.set('user', {
    id: 'u_test', username: 'tester', displayName: 'Tester', role: 'owner', verified: false, purpleAllowed: true,
    createdAt: Date.now(), limits: { dmUploadBytes: 15728640, driveQuotaBytes: 1073741824, storyQuotaBytes: 1073741824 },
    driveUsed: 0, uploadUsed: 0, kdf: { authSalt: 'AA==', vaultSalt: 'AA==', iterations: 210000 },
    publicProfile: { enabled: false, alias: '', bio: '', images: [], audienceKey: null },
    backup: { count: 5, generatedAt: Date.now() }, settings: shim.State.DEFAULT_SETTINGS,
  });
  // the window manager swallows render errors and paints a placeholder, so watch
  // the console for its report and fail the surface when that happens
  const renderErrors = [];
  const realConsole = shim.console;
  for (const app of shim.Apps.all()) {
    let failure = null;
    shim.console = Object.assign({}, realConsole, {
      warn: (...args) => { const line = args.join(' '); if (/render failed/i.test(line)) failure = line; else if (VERBOSE) realConsole.warn(...args); },
      error: (...args) => { const line = args.join(' '); if (/render failed/i.test(line)) failure = line; else if (VERBOSE) realConsole.error(...args); },
      log: (...args) => { if (VERBOSE) realConsole.log(...args); },
    });
    try {
      app.run({ section: 'general' });
    } catch (error) {
      failure = error.message;
    }
    shim.console = realConsole;
    if (failure) renderErrors.push(failure);
    check(`surface builds: ${app.id}`, !failure, failure || '');
  }

  // every settings section must paint on its own
  const settingsSections = ['general', 'appearance', 'accessibility', 'notifications', 'privacy', 'requests', 'public', 'account', 'tutorial', 'about'];
  for (const section of settingsSections) {
    let failure = null;
    shim.console = Object.assign({}, realConsole, {
      warn: (...args) => { const line = args.join(' '); if (/render failed/i.test(line)) failure = line; },
      error: (...args) => { const line = args.join(' '); if (/render failed/i.test(line)) failure = line; },
      log: () => {},
    });
    try {
      shim.Windows.close('settings');
      shim.Apps.open('settings', { section });
    } catch (error) { failure = error.message; }
    shim.console = realConsole;
    check(`settings section paints: ${section}`, !failure, failure || '');
  }
  if (shim.Help) {
    try { shim.Help.search('status').forEach(() => {}); check('help search executes', true); } catch (error) { check('help search executes', false, error.message); }
  }
}

if (VERBOSE && asyncNoise.length) console.log(`  (async stub-network noise: ${asyncNoise.length})`);
console.log(`\n${pass} checks passed, ${failures.length} failed\n`);
if (failures.length) for (const f of failures) console.log(' -', f);
// surfaces leave timers behind (clocks, graph ticks); exit explicitly instead of waiting
process.exit(failures.length ? 1 : 0);
