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
    __events: [],
    addEventListener(type) { this.__events.push(type); }, removeEventListener() {}, dispatchEvent() {},
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
const expectedGlobals = ['AE', 'API', 'UI', 'Windows', 'State', 'Media', 'Apps', 'Terms', 'ConversationClient', 'Viewer', 'Profile', 'CommunityClient', 'DriveClient', 'StoriesClient', 'AirdropClient', 'Clicker', 'Help', 'Settings', 'AdminClient', 'ConsoleLog', 'Shell'];
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

// ------------------------------------------------- design language guardrails
// The identity is deliberately not a generic AI look: ink on paper — flat plates
// bounded by hairlines, monochrome by default, no gradients, no glow, no glass,
// no rounded corners. These checks keep that intent from eroding in later edits.
const sheets = Object.fromEntries(['tokens', 'base', 'windows', 'app'].map((name) => [name, fs.readFileSync(path.join(PUBLIC, 'css', `${name}.css`), 'utf8')]));
const tokensCss = sheets.tokens;
const allCss = Object.values(sheets).join('\n');

const THEMES = ['nox', 'acid', 'sector', 'ice', 'chrome'];
const ACCENTS = ['ink', 'phosphor', 'lime', 'sodium', 'plasma', 'crimson', 'magenta', 'cyan', 'teal', 'violet'];
for (const theme of THEMES) check(`token block defines theme ${theme}`, tokensCss.includes(`[data-theme="${theme}"]`));
for (const accent of ACCENTS) check(`token block defines signal accent ${accent}`, tokensCss.includes(`[data-accent="${accent}"]`));

// accents must stay rgb-composable and every theme must define the chrome vars
for (const accent of ACCENTS) {
  const block = new RegExp(`\\[data-accent="${accent}"\\]\\s*\\{([^}]*)\\}`).exec(tokensCss);
  // the monochrome signal borrows the theme's ink channels; every other signal
  // must declare its own so rgba(var(--accent-rgb), x) keeps working.
  check(`accent ${accent} declares --accent-rgb`, !!block && /--accent-rgb:\s*(\d+,\s*\d+,\s*\d+|var\(--ink-rgb\))/.test(block[1]));
}
for (const theme of THEMES) {
  const block = new RegExp(`\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`).exec(tokensCss);
  const body = block ? block[1] : '';
  for (const token of ['--surface-solid', '--line-strong', '--ink:', '--fill-input']) {
    check(`theme ${theme} defines ${token.replace(/[:-]/g, '')}`, body.includes(token));
  }
}

// plates are square: the only permitted radius in the whole interface is a
// spinner's 50%, and nothing else may round a corner at all.
const radiusValues = [...allCss.matchAll(/border-radius:\s*([^;]+);/g)].map((m) => m[1].trim());
const roundedOffenders = radiusValues.filter((value) => !/50%/.test(value) && parseFloat(value) > 0);
check(`no rounded-corner styling remains (${radiusValues.length} radius rules)`, roundedOffenders.length === 0, roundedOffenders.join(' | '));
check('tokens keep every radius at zero', /--radius-pill:\s*0px/.test(tokensCss) && /--radius-window:\s*0px/.test(tokensCss));
check('tokens default the chamfer to zero', /--chamfer:\s*0px/.test(tokensCss));

// ------------------------------------------------------- ink-on-paper rules
// No luminosity effects may creep back in: no text glow, and no box-shadow with
// a blur radius (hard offset sheets and inset hairlines only).
const textShadows = [...allCss.matchAll(/text-shadow:\s*([^;]+);/g)].map((m) => m[1].trim()).filter((v) => v !== 'none');
check(`no text glow anywhere (${textShadows.length} text-shadow rules)`, textShadows.length === 0, textShadows.join(' | '));
const blurryShadows = [];
for (const [name, sheet] of Object.entries(sheets)) {
  for (const decl of sheet.matchAll(/box-shadow:\s*([^;]+);/g)) {
    const value = decl[1];
    if (value.includes('var(--shadow')) continue; // checked below, in the token file
    // third length in a shadow is its blur radius; unitless zeroes are lengths too
    for (const m of value.matchAll(/(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?/gi)) {
      if (parseFloat(m[3]) !== 0) blurryShadows.push(`${name}: ${value.trim()}`);
    }
  }
}
check(`no blurred shadows anywhere (${blurryShadows.length} offenders)`, blurryShadows.length === 0, blurryShadows.join(' | '));
const tokenShadows = [...tokensCss.matchAll(/--shadow-[\w-]+:\s*([^;]+);/g)].map((m) => m[1]);
const tokenBlur = tokenShadows.filter((value) => [...value.matchAll(/(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?/gi)].some((m) => parseFloat(m[3]) !== 0));
check(`theme shadows are hard offsets (${tokenShadows.length} definitions)`, tokenBlur.length === 0, tokenBlur.join(' | '));

// Transparency and fill effects stay opt-in and wall-scoped.
for (const [name, sheet] of Object.entries(sheets)) {
  for (const rule of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [selector, body] = [rule[1], rule[2]];
    if (body.includes('backdrop-filter')) {
      check(`${name}: backdrop blur only for the acrylic opt-in`, selector.includes('data-glass="acrylic"'), selector.trim().slice(0, 60));
    }
    if (body.includes('radial-gradient')) {
      check(`${name}: radial gradients only in wall patterns`, /dots|wallpaper-choice/.test(selector), selector.trim().slice(0, 60));
    }
  }
}

check('chamfer geometry token exists', /--chamfer:/.test(tokensCss) && /--cut:/.test(tokensCss));
check('display font is a heavy grotesque', /--font-display:[^;]*Archivo Black/.test(tokensCss));
check('mono HUD font stack is declared', /--font-mono:[^;]*JetBrains Mono/.test(tokensCss));

// chrome stays typographic: no emoji in any glyph field
const emojiGlyphs = [];
for (const file of order) {
  const src = fs.readFileSync(path.join(PUBLIC, 'js', file), 'utf8');
  for (const m of src.matchAll(/glyph:\s*'([^']*)'/g)) {
    if (/[\u{1F000}-\u{1FAFF}\u{2705}\u{274C}\u{26A0}\u{2757}\u{2753}\u{2B50}\u{2764}\u{FE0F}]/u.test(m[1])) emojiGlyphs.push(`${file}: ${m[1]}`);
  }
}
check(`chrome glyphs are typographic (${emojiGlyphs.length} emoji found)`, emojiGlyphs.length === 0, emojiGlyphs.join(' | '));

// the document shell boots on a theme we actually ship
const htmlTheme = /<html[^>]*data-theme="([^"]+)"/.exec(html);
const htmlAccent = /<html[^>]*data-accent="([^"]+)"/.exec(html);
check('index.html boots on a shipped theme', !!htmlTheme && THEMES.includes(htmlTheme[1]), htmlTheme && htmlTheme[1]);
check('index.html boots on a shipped accent', !!htmlAccent && ACCENTS.includes(htmlAccent[1]), htmlAccent && htmlAccent[1]);
// The default experience is monochrome: the shell boots on the ink signal and
// the picker leads with it.
check('index.html boots the monochrome signal', !!htmlAccent && htmlAccent[1] === 'ink', htmlAccent && htmlAccent[1]);

// the settings picker must not offer a theme or accent that does not exist
const settingsSrc = fs.readFileSync(path.join(PUBLIC, 'js', 'settings.js'), 'utf8');
const themeList = /const themes = \[([^;]+)\];/.exec(settingsSrc);
const accentList = /const accents = \[([^;]+)\];/.exec(settingsSrc);
const listedThemes = themeList ? [...themeList[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).filter((v) => v !== 'theme') : [];
const listedAccents = accentList ? [...accentList[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]) : [];
check('picker offers every shipped theme', THEMES.every((t) => listedThemes.includes(t)), listedThemes.join(','));
check('picker offers every shipped accent', ACCENTS.every((a) => listedAccents.includes(a)), listedAccents.join(','));
check('picker offers no phantom theme', listedThemes.every((t) => THEMES.includes(t)), listedThemes.join(','));
check('picker offers no phantom accent', listedAccents.every((a) => ACCENTS.includes(a)), listedAccents.join(','));

// the client-side defaults must match the server-side defaults
const stateSrc = fs.readFileSync(path.join(PUBLIC, 'js', 'state.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server', 'routes-auth.js'), 'utf8');
for (const [label, src] of [['client', stateSrc], ['server', serverSrc]]) {
  check(`${label} defaults boot on the shipped theme`, /theme:\s*'nox'/.test(src));
  check(`${label} defaults to the monochrome signal`, /accent:\s*'ink'/.test(src));
  check(`${label} defaults to opaque panels`, /glass:\s*100/.test(src) && /blur:\s*0/.test(src));
  check(`${label} defaults to square plates`, /cornerRadius:\s*0/.test(src));
}
check('picker leads with the monochrome signal', listedAccents[0] === 'ink', listedAccents.join(','));

// Signing in must hand the client the session it stores.  The login payload once
// shipped without it ("Cannot read properties of undefined (reading 'id')") and
// the desktop never appeared after a correct passphrase.
const appSrc = fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8');
check('sign-in guards the session it stores', /result\.session \? \{ id: result\.session\.id, device: result\.session\.device \} : null/.test(appSrc));
check('no bare result.session dereference on the sign-in path', !/S\.set\('session', \{ id: result\.session\.id/.test(appSrc));
// boot data lives in the state store (State.get('boot')); S.boot is undefined,
// so reading it there silently drops whatever was being looked for
check('boot data is read through the state store', !/S\.boot\b/.test(appSrc), (appSrc.match(/S\.boot\b[^\n]*/g) || []).join(' | ').slice(0, 120));

// A window's toolbar must never be built by clearing the window body: the render
// target lives there, and every surface that set a toolbar came up blank.
const windowsSrc = fs.readFileSync(path.join(PUBLIC, 'js', 'windows.js'), 'utf8');
check('setting a toolbar never clears the window body',
  /function ensureToolbar/.test(windowsSrc) && !/UI\.clear\(entry\.record\.toolbar \|\| entry\.record\.body\)/.test(windowsSrc));

// Icons are inline SVG: unicode symbol glyphs are invisible whenever the device
// font lacks them (which is what made every surface icon a blank square).
const iconSrc = fs.readFileSync(path.join(PUBLIC, 'js', 'icons.js'), 'utf8');
check('an icon set ships with the client', /const Icons/.test(iconSrc) && /function svg/.test(iconSrc));
check('the icon set is loaded before the interface', html.indexOf('/js/icons.js') < html.indexOf('/js/ui.js') && html.indexOf('/js/icons.js') > 0);
check('app surfaces draw SVG icons, not unicode glyphs', !/class: 'glyph', text: app\.(glyph|label)/.test(appSrc) && /UI\.icon\(app\.id/.test(appSrc));
check('taskbar window buttons carry an icon and a label', /tb-glyph/.test(windowsSrc) && /tb-label/.test(windowsSrc));
// The taskbar iterates registry *entries*: reading `record.title` off the entry
// itself left every tab labelled "" with a tooltip of "undefined".
check('taskbar reads the window record, not the registry entry',
  /for \(const \[id, entry\] of registry\)/.test(windowsSrc) && /const record = entry\.record;/.test(windowsSrc));
check('the LINK_UP chip is gone', !/LINK_UP/.test(appSrc) && !/tb-link/.test(appSrc));

// the click counter is a gag: no per-user ceiling
const clicker = fs.readFileSync(path.join(ROOT, 'server', 'routes-auth.js'), 'utf8');
check('clicking is not capped at twenty a minute', /clickLimiter/.test(clicker) && !/actionLimiter\.hit\(`click:/.test(clicker));

// A file saved by the editor keeps its name sealed with the file's own key.  It
// has to leave this device as a string, because the server drops anything that
// is not one, and it has to be opened by importing the key rather than passing
// raw bytes to WebCrypto.
const crypto2 = fs.readFileSync(path.join(PUBLIC, 'js', 'crypto.js'), 'utf8');
const editorSrc = fs.readFileSync(path.join(PUBLIC, 'js', 'editor.js'), 'utf8');
const driveSrc = fs.readFileSync(path.join(PUBLIC, 'js', 'drive.js'), 'utf8');
check('sealed names are produced and opened through one pair of helpers',
  /async function sealJson/.test(crypto2) && /async function openSealedJson/.test(crypto2)
  && /AE\.sealJson\(/.test(editorSrc) && /openSealedJson|Media\.fileName/.test(driveSrc));
check('the name a file was saved under is resolved, never invented',
  /entry\.name \|\| await Media\.fileName\(entry\)/.test(editorSrc));
check('the sealed name is a string on the wire',
  /sealJson[\s\S]{0,220}return `\$\{sealed\.iv\}\.\$\{sealed\.ct\}`/.test(crypto2));

// `value` on a <textarea> is a property: setting the attribute left the editor
// showing an empty file after it had just loaded one.
const uiSrc = fs.readFileSync(path.join(PUBLIC, 'js', 'ui.js'), 'utf8');
check('the element helper assigns value as a property', /key === 'value' && 'value' in node/.test(uiSrc));

// The console is a flyout panel, not a window: the surface audit and the deep
// links both look for it by id.
const consoleSrc = fs.readFileSync(path.join(PUBLIC, 'js', 'console.js'), 'utf8');
check('the console registers a flyout a link can open',
  /id: 'console-panel'/.test(consoleSrc) && /Apps\.register\(\{[\s\S]{0,200}id: 'console'/.test(consoleSrc));

// A direct channel has to be sealed under the id the server actually stored,
// otherwise the wrap lands nowhere and the channel can never be decrypted.
{
  const social = fs.readFileSync(path.join(ROOT, 'server', 'routes-social.js'), 'utf8');
  const dmBranch = social.slice(social.indexOf("conversation.type === 'dm'"), social.indexOf("conversation.type === 'dm'") + 400);
  check('the server adopts the client id for a direct channel', /ensureDirectConversation\([^)]*id:\s*ctx\.body\.id/.test(social.replace(/\s+/g, ' ')), dmBranch.slice(0, 80));
  const messageSource = fs.readFileSync(path.join(PUBLIC, 'js', 'messages.js'), 'utf8');
  check('the client wraps for the stored channel id', /async function wrapForConversation\(conversationId, peer, rawKey\)/.test(messageSource));
  check('the client opens a direct channel through it', /async function openDirectChannel\(peerId\)/.test(messageSource) && /openDirectChannel\s*[,}]/.test(messageSource));
}

// The DOM turns a null argument into the visible text "null": a message header
// once read "operator null null" because two optional nodes were passed to
// append() as null.  Every such call goes through UI.append(), which drops them.
{
  const offenders = [];
  for (const file of fs.readdirSync(path.join(PUBLIC, 'js'))) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(PUBLIC, 'js', file), 'utf8');
    for (let index = src.indexOf('.append('); index !== -1; index = src.indexOf('.append(', index + 1)) {
      // UI.append() is the filtered entry point and takes the optionals on purpose.
      if (src.slice(Math.max(0, index - 2), index) === 'UI') continue;
      const open = index + '.append'.length;
      let depth = 0;
      let end = open;
      for (; end < src.length; end += 1) {
        if (src[end] === '(') depth += 1;
        else if (src[end] === ')') { depth -= 1; if (!depth) break; }
      }
      const args = src.slice(open + 1, end);
      let inner = 0;
      let current = '';
      const parts = [];
      for (const character of args) {
        if ('([{'.includes(character)) inner += 1;
        else if (')]}'.includes(character)) inner -= 1;
        if (character === ',' && !inner) { parts.push(current); current = ''; } else current += character;
      }
      parts.push(current);
      const risky = parts.filter((part) => /:\s*null\b/.test(part) || /^\s*null\s*$/.test(part));
      if (risky.length) offenders.push(`${file}:${src.slice(0, index).split('\n').length}`);
    }
  }
  check('no call passes a null node to append()', offenders.length === 0, offenders.slice(0, 4).join(' '));
  check('the append helper drops empty entries', /function append\(node, \.\.\.children\)/.test(uiSrc));
}

// The certificate the phone installs is described by a public, read-only route:
// a page that guesses at it logs a failed request on every visit.
const indexSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
const trustSrc = fs.readFileSync(path.join(PUBLIC, 'js', 'trust.js'), 'utf8');
check('the trust page asks the server before offering a certificate',
  /ROUTES\.set\('GET \/api\/ca'/.test(indexSrc) && /fetch\('\/api\/ca'/.test(trustSrc));
check('the fingerprint is the certificate\'s own SHA-256',
  /createHash\('sha256'\)\.update\(der\)/.test(indexSrc) && /info\.fingerprint/.test(trustSrc));

// An installer drill once ran with the repository as its home and a watchdog,
// pid file and self-signed key landed in the checkout.  The layout the
// installer writes belongs next to the install, never in git.
{
  const ignoreText = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  for (const rel of ['bin/', 'run/', 'tls/', 'logs/', 'config.env']) {
    check(`.gitignore excludes the installer's ${rel}`, ignoreText.includes(`/${rel}`), ignoreText.split('\n').slice(-8).join(' | '));
  }
  const leaked = ['bin/watchdog', 'bin/ae-secure', 'run/supervisor.pid', 'tls/server.key', 'tls/server.crt', 'config.env']
    .filter((rel) => fs.existsSync(path.join(ROOT, rel)));
  check('no installer output is present in the checkout', leaked.length === 0, leaked.join(', '));
}
const sessionPayloads = (serverSrc.match(/session: \{ id: session\.id, device: session\.device \}/g) || []).length;
check('every sign-in payload carries its session', sessionPayloads >= 3, `${sessionPayloads} of 3 (register, login, recovery)`);

// every css custom property that is used must also be defined (typo guard:
// var(--text-10) once shipped without a definition and silently fell back)
const definedTokens = new Set();
for (const sheet of Object.values(sheets)) {
  for (const m of sheet.matchAll(/(--[\w-]+)\s*:/g)) definedTokens.add(m[1]);
}
const undefinedTokens = new Map();
const scanFiles = [...Object.values(sheets), html];
for (const file of order) scanFiles.push(fs.readFileSync(path.join(PUBLIC, 'js', file), 'utf8'));
for (const src of scanFiles) {
  for (const m of src.matchAll(/var\((--[\w-]+)([\w-]*)/g)) {
    const tail = m[2] || '';
    // var(--status-${key}) is a runtime-composed name: skip when the match runs into an interpolation
    if (tail.length === 0 && src.slice(m.index + m[0].length).startsWith('${')) continue;
    const name = m[1];
    if (!definedTokens.has(name)) undefinedTokens.set(name, (undefinedTokens.get(name) || 0) + 1);
  }
}
check(`every var(--token) is defined (${definedTokens.size} tokens)`, undefinedTokens.size === 0,
  [...undefinedTokens.entries()].map(([k, v]) => `${k} x${v}`).join(' '));

// every class the client renders must be styled somewhere (catch drift)
const rendered = new Set();
for (const file of order) {
  const src = fs.readFileSync(path.join(PUBLIC, 'js', file), 'utf8');
  for (const m of src.matchAll(/class:\s*[`'"]([^`'"]+)[`'"]/g)) {
    for (const token of m[1].split(/\s+/)) {
      if (!token || token.includes('$') || token.includes('{')) continue;
      if (!/^[a-zA-Z][\w-]*$/.test(token)) continue;
      rendered.add(token);
    }
  }
}
const styled = new Set([...allCss.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
const unstyled = [...rendered].filter((token) => !styled.has(token) && !token.startsWith('icon-'));
check(`every rendered class is styled (${rendered.size} classes, ${unstyled.length} bare)`, unstyled.length === 0, unstyled.join(' '));

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

// ------------------------------------------------- mobile and touch support
{
  const windowsCss = fs.readFileSync(path.join(PUBLIC, 'css', 'windows.css'), 'utf8');
  const baseCss = fs.readFileSync(path.join(PUBLIC, 'css', 'base.css'), 'utf8');
  const appCss = fs.readFileSync(path.join(PUBLIC, 'css', 'app.css'), 'utf8');
  const windowsJs = fs.readFileSync(path.join(PUBLIC, 'js', 'windows.js'), 'utf8');

  // one phone breakpoint, agreed on by CSS and by the window manager
  const cssPhones = [...windowsCss.matchAll(/@media \(max-width: (\d+)px\)/g)].map((m) => Number(m[1]));
  const jsPhone = Number(/\(max-width: (\d+)px\)/.exec(windowsJs)[1]);
  check('phone breakpoint exists in css', cssPhones.includes(760), `found ${cssPhones.join(', ')}`);
  check('window manager agrees with the css phone breakpoint', jsPhone === 760, `js=${jsPhone}`);
  check('no stray 720px breakpoint', !/max-width: 720px/.test(windowsCss + baseCss + appCss + windowsJs));
  check('no stray 640px breakpoint', !/max-width: 640px/.test(windowsCss + baseCss + appCss));

  // the phone layer must handle the browser chrome and the home indicator
  check('windows use the dynamic viewport on phones', /100dvh/.test(windowsCss));
  check('safe-area insets are respected', /env\(safe-area-inset-bottom/.test(windowsCss) && /env\(safe-area-inset-bottom/.test(baseCss) === false || /env\(safe-area-inset-bottom/.test(windowsCss));
  check('taskbar clears the home indicator', /#taskbar \{[^}]*env\(safe-area-inset-bottom/.test(windowsCss.replace(/\n/g, ' ')) || /padding: 4px 6px calc\(4px \+ env\(safe-area-inset-bottom, 0px\)\)/.test(windowsCss));
  check('popovers become sheets on phones', /@media \(max-width: 760px\)[\s\S]*\.flyout \{[\s\S]*bottom: calc\(var\(--taskbar-height\)/.test(windowsCss));
  check('thumb-sized taskbar buttons on phones', /@media \(max-width: 760px\)[\s\S]*\.tb-btn \{ width: 46px; height: 46px; \}/.test(windowsCss));
  check('thumb-sized window controls on phones', /@media \(max-width: 760px\)[\s\S]*\.caption-btn \{ width: 46px; min-height: 44px; \}/.test(windowsCss));
  check('phone fields do not trigger ios zoom', /@media \(max-width: 760px\)[\s\S]*input, textarea, select[^{]*\{ font-size: 16px; \}/.test(baseCss));
  check('wide tables scroll on phones', /@media \(max-width: 760px\)[\s\S]*\.pane-scroll \{ overflow-x: auto; \}/.test(windowsCss) && /@media \(max-width: 760px\)[\s\S]*\.table \{ min-width:/.test(windowsCss));
  check('hover-only controls are revealed on touch', /@media \(max-width: 760px\)[\s\S]*\.message-actions \{ opacity: 1 !important; \}/.test(baseCss));

  // list ⇄ detail: the back control must exist where the panes take turns, and
  // must not be hidden by a rule meant for everything else
  const messagesJs = fs.readFileSync(path.join(PUBLIC, 'js', 'messages.js'), 'utf8');
  const communitiesJs = fs.readFileSync(path.join(PUBLIC, 'js', 'communities.js'), 'utf8');
  check('back control exists in messages', /class: 'btn icon subtle split-back'/.test(messagesJs));
  check('back control exists in communities', /class: 'btn icon subtle split-back'/.test(communitiesJs));
  check('back control is shown only in the compact layout', /\.split-back \{ display: none; \}/.test(appCss) && /@media \(max-width: 900px\)[\s\S]*\.split-back \{ display: inline-flex; \}/.test(windowsCss));
  check('the inverted mobile-hide class is gone', !/mobile-hide/.test(windowsCss + messagesJs + communitiesJs));
  check('swipe-back is wired in both list surfaces', /UI\.swipeBack\(mainNode/.test(messagesJs) && /UI\.swipeBack\(mainNode/.test(communitiesJs));
  check('swipe-back helper ships in the ui module', /function swipeBack\(node, handler\)/.test(fs.readFileSync(path.join(PUBLIC, 'js', 'ui.js'), 'utf8')));
  check('swipe-back ignores vertical scrolling', /dy < 56/.test(fs.readFileSync(path.join(PUBLIC, 'js', 'ui.js'), 'utf8')));
}

// ------------------------------------------------------------ console panel
{
  const consoleJs = fs.readFileSync(path.join(PUBLIC, 'js', 'console.js'), 'utf8');
  const consoleCss = /@media \(max-width: 760px\)[\s\S]*\.console-panel \{[\s\S]*left: 0;/.test(windowsCssForPhones());
  function windowsCssForPhones() { return fs.readFileSync(path.join(PUBLIC, 'css', 'windows.css'), 'utf8'); }

  check('console is registered as a surface', !!shim.Apps && !!shim.Apps.get('console'));
  check('console surface is reachable by deep link', !!shim.ConsoleLog);
  check('console docks above the taskbar', /\.console-panel \{[\s\S]*bottom: calc\(var\(--taskbar-height\) \+ 10px\)/.test(fs.readFileSync(path.join(PUBLIC, 'css', 'windows.css'), 'utf8')));
  check('console becomes a full-width sheet on phones', consoleCss);
  check('console ships a bounded buffer', shim.ConsoleLog.cap === 240);
  check('console labels entries by kind', shim.ConsoleLog.kindCount() >= 5, `kinds=${shim.ConsoleLog.kindCount()}`);
  check('console keyboard shortcut is bound', /Ctrl\+Shift\+O/.test(fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8')));
  check('console button sits in the taskbar', /id: 'tb-console'/.test(fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8')));

  // privacy: paths are masked, and the log can never be handed a secret
  const masked = shim.ConsoleLog.maskPath('/api/files/f_9f2c1a7b45e3/chunks');
  check('console masks record ids in paths', masked === '/api/files/•••/chunks', masked);
  check('console masks numeric ids in paths', shim.ConsoleLog.maskPath('/api/stories/42/seen') === '/api/stories/•••/seen');
  check('console keeps readable route names', shim.ConsoleLog.maskPath('/api/auth/register') === '/api/auth/register');
  check('console drops query strings', shim.ConsoleLog.maskPath('/api/files?kind=drive&q=secret') === '/api/files');

  const feedBlock = consoleJs.slice(consoleJs.indexOf('const FEED = {'), consoleJs.indexOf('function attach()'));
  const interpolations = [...feedBlock.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
  const allowedInterpolation = (expr) => {
    const compact = expr.replace(/\s+/g, '');
    return /^payload&&payload\.(method|status)\?payload\.(method|status):'[A-Z]+'$/.test(compact)
      || /^\(payload&&payload\.status\)\|\|0$/.test(compact)
      || /^maskPath\(payload&&payload\.path\)$/.test(compact);
  };
  check('console templates interpolate only masked traffic fields', interpolations.every(allowedInterpolation), interpolations.join(' | '));
  check('console never reads message bodies or secrets', !/payload\.(body|text|ciphertext|token|name|username|file|blob|key|keys|message)\b/.test(consoleJs));
  check('console records notifications by level only', /notice shown · \$\{config\.level\}/.test(fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8')));

  // the command line is local: nothing that changes server state
  const commands = shim.ConsoleLog.commands();
  check('console commands are local only', commands.every((name) => /^(help|clear|status|log|theme|accent|wall|open|lock|whoami|net|time|ver)$/.test(name)), commands.join(','));
  check('console has no destructive verbs', !/(delete|remove|kick|ban|purge|wipe|reset|admin)\b/.test(commands.join(' ')));
  check('console never posts to the api', !/API\.post|API\.delete|API\.patch|fetch\(/.test(consoleJs));

  // runtime: a real request must be logged with its identifier masked
  {
    const before = shim.ConsoleLog.entries().length;
    shim.ConsoleLog.clear();
    shim.API.get('/api/files/f_secret123456/chunks').catch(() => {});
    const lines = shim.ConsoleLog.entries().map((entry) => entry.text).join('\n');
    check('a live request is logged with a masked path', lines.includes('/api/files/•••/chunks'), lines || '(no entries)');
    check('no raw identifier reaches the log', !lines.includes('secret123456'), lines);
    const shown = shim.ConsoleLog.entries().map((entry) => `${entry.kind} ${entry.text}`).join('\n');
    check('the log carries no ciphertext or token shapes', !/[A-Za-z0-9+/]{32,}={0,2}/.test(shown), shown);
    shim.ConsoleLog.clear();
    shim.ConsoleLog.log('LINK', 'probe');
    check('entries can be cleared', shim.ConsoleLog.entries().length === 1 && before >= 0);
    shim.ConsoleLog.clear();
  }

  // the event bus itself must never carry a query string
  {
    const frames = [];
    const off = shim.API.on('api.request', (payload) => frames.push(payload));
    shim.API.get('/api/files?token=leaky&kind=drive').catch(() => {});
    off();
    check('traffic frames reach the console with the route only', frames.length === 1 && frames[0].path === '/api/files', JSON.stringify(frames));
    check('traffic frames carry no query string', frames.every((frame) => !String(frame.path).includes('?')));
  }

  // every command that touches nothing but this tab runs without throwing
  {
    const safe = ['help', 'status', 'log on', 'open', 'whoami', 'net', 'time', 'ver', 'nonsense', 'log off'];
    let thrown = null;
    try {
      for (const line of safe) shim.ConsoleLog.execute(line);
    } catch (error) { thrown = `${error.message}`; }
    check('console commands never throw', !thrown, thrown || '');
    const text = shim.ConsoleLog.entries().map((entry) => entry.text).join('\n');
    check('unknown commands are refused, not executed', /unknown command “nonsense”/.test(text), text.slice(-120));
    shim.ConsoleLog.clear();
  }

  // the traffic frames the panel listens for exist in the api client
  const apiJs = fs.readFileSync(path.join(PUBLIC, 'js', 'api.js'), 'utf8');
  check('api announces requests to the console', /emit\('api\.request'/.test(apiJs));
  check('api announces failed requests to the console', /emit\('api\.error'/.test(apiJs) && /emit\('api\.offline'/.test(apiJs));
}

// ------------------------------------------------------------------ cleanup
{
  const baseCss = fs.readFileSync(path.join(PUBLIC, 'css', 'base.css'), 'utf8');
  const deadClasses = ['term', 'scroll-shadow', 'meter-ring', 'hud-quiet', 'vdivider', 'kbd'];
  for (const name of deadClasses) {
    check(`dead class removed: .${name}`, !new RegExp(`\\.${name}[ ,{:.]`).test(baseCss));
  }
  const settingsJs = fs.readFileSync(path.join(PUBLIC, 'js', 'settings.js'), 'utf8');
  check('settings sections drop their prose blurbs', !/heading\('[A-Z0-9]+', '[^']+', '/.test(settingsJs));
  check('the component preview block is gone', !/heading\('PREV'/.test(settingsJs));
  check('section headings carry no bracketed glyphs', !/text: `\[\$\{glyph\}\]`/.test(settingsJs));
  check('auth hero lists three facts, not four', (fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8').match(/tick\('/g) || []).length === 3);
  check('empty states are one line, not essays', !/sealed on this device before it travels/.test(fs.readFileSync(path.join(PUBLIC, 'js', 'messages.js'), 'utf8')));
}

// ------------------------------------------------- renderer contract (ui.el)
{
  // Handlers passed as onClick/onKeydown must land on real, lowercase DOM event
  // types; nested arrays must be flattened instead of stringified.
  const source = fs.readFileSync(path.join(PUBLIC, 'js', 'ui.js'), 'utf8');
  check('el() lowercases event names', /key\.slice\(2\)\.toLowerCase\(\)/.test(source));
  check('el() flattens nested children', /function appendChildren\(node, children\)/.test(source) && /Array\.isArray\(child\)/.test(source));

  const uiScript = fs.readFileSync(path.join(PUBLIC, 'js', 'ui.js'), 'utf8');
  check('ui.js still exports el and frag', /^window\.UI = UI;$/m.test(uiScript) && /return \{[\s\S]*\bel\b[\s\S]*\bfrag\b/.test(uiScript));

  // runtime: a nested array must not become text
  if (shim.UI) {
    const node = shim.UI.el('div', {}, [shim.UI.el('span', { text: 'a' }), [shim.UI.el('span', { text: 'b' }), null, [shim.UI.el('span', { text: 'c' })]]]);
    const flat = JSON.stringify(node.children.map((c) => c.tagName));
    check('nested children are flattened, not stringified', flat === '["SPAN","SPAN","SPAN"]', flat);
    const texts = node.children.map((child) => child.textContent).join('');
    check('no element is ever stringified into text', !/\[object/.test(texts), texts);

    // the handler must land on a lowercase DOM event type
    let fired = 0;
    const button = shim.UI.el('button', { onClick: () => { fired += 1; }, onKeydown: () => {} });
    check('el() registers lowercase click and keydown listeners', button.__events.includes('click') && button.__events.includes('keydown'), button.__events.join(','));
    const avatar = shim.UI.avatar({ id: 'u_1', displayName: 'A B' }, { onClick: () => {} });
    check('avatar options wire a lowercase click too', !avatar.__events || avatar.__events.every((type) => /^[a-z]+$/.test(type)), (avatar.__events || []).join(','));
  }
}

// -------------------------------------------------------- termux installer
{
  const scriptPath = path.join(ROOT, 'scripts', 'termux-install.sh');
  check('termux installer ships', fs.existsSync(scriptPath));
  if (fs.existsSync(scriptPath)) {
    const script = fs.readFileSync(scriptPath, 'utf8');
    check('installer is POSIX bash with strict mode', /^#!\/usr\/bin\/env bash/.test(script) && /set -uo pipefail/.test(script));
    check('installer never stores a token in the config', !/GITHUB_TOKEN=/.test(script.split('write_config')[1] || ''));
    check('installer resets the checkout instead of merging', (script.match(/reset --hard FETCH_HEAD/g) || []).length === 2);
    check('installer writes a Termux:Boot hook', script.includes('.termux/boot') && script.includes('$boot_dir/ae-secure.sh'));
    check('installer has a session fallback', (script.match(/ae-secure autostart/g) || []).length >= 3);
    check('installer survives a missing PREFIX', /\$\{PREFIX:-\}/.test(script));
    check('watchdog restarts on exit and on hang', /health check missed/.test(script) && /server exited \(status/.test(script));
    check('watchdog backs off between restarts', script.includes('backoff="\\$AE_BACKOFF"') && script.includes('*) backoff=30'));
    check('installer keeps data outside the checkout', /AE_DATA="\$\{AE_DATA:-\$HOME\/ae-secure-data\}"/.test(script));
    check('installer prints the lan address', /on your network/.test(script));
    check('installer can back up the data directory', /backup written/.test(script));
    check('installer can point at another git remote', /AE_GIT_URL/.test(script));
    check('installer can generate its own https certificate', /install_tls/.test(script) && /AE_TLS_DIR/.test(script));
    check('installer can carry a discord invite for the credit line', /AE_DISCORD_URL/.test(script));
    check('the service command carries its own install path', /@AE_HOME_DEFAULT@/.test(script) && /sed -i "s\|@AE_HOME_DEFAULT@\|\$AE_HOME\|"/.test(script));
    check('installer fails loudly if the path is not baked in', /could not bake the install path/.test(script));
    const cliTemplate = (script.match(/<<'CLI'([\s\S]*?)\nCLI\n/) || [])[1] || '';
    check('service command template ships with a placeholder path', cliTemplate.includes('AE_HOME:-@AE_HOME_DEFAULT@'), cliTemplate.slice(0, 80));
    check('service command never guesses its directory', !cliTemplate.includes('AE_HOME:-$HOME/.ae-secure'));
    // the bootstrap people actually paste into Termux
    const bootPath = path.join(ROOT, 'scripts', 'install.sh');
    check('one-command bootstrap ships', fs.existsSync(bootPath));
    if (fs.existsSync(bootPath)) {
      const boot = fs.readFileSync(bootPath, 'utf8');
      check('bootstrap needs no token', !/GITHUB_TOKEN|Authorization/.test(boot));
      check('bootstrap fetches a public archive', /codeload\.github\.com\/\$AE_OWNER\/\$AE_REPO\/tar\.gz\/refs\/heads\/\$AE_BRANCH/.test(boot));
      check('bootstrap reuses a checkout when it is already inside one', /AE_SOURCE_DIR="\$SOURCE_DIR"/.test(boot));
      check('bootstrap cleans up its download', /rm -rf "\$CLEANUP_DIR"/.test(boot));
      check('bootstrap installs curl first', /pkg install -y curl/.test(boot));
      check('bootstrap ends with the address and the next commands', /"\$AE_CLI" url/.test(boot) && /ae-secure status \| logs \| url \| update \| backup \| stop \| start/.test(boot));
      check('bootstrap mentions Termux:Boot and Termux:API', /Termux:Boot/.test(boot) && /Termux:API/.test(boot));
    }
    check('installer can use a local checkout', script.includes('AE_SOURCE_DIR') && script.includes('fetch_local_dir() {'));
    check('local checkout copy never inherits git or data', /--exclude=\.\/node_modules --exclude=\.\/\.git --exclude=\.\/data/.test(script));
    check('installer refuses a target inside its source', /must not sit inside AE_SOURCE_DIR/.test(script));
    check('guard is idempotent by construction', script.includes('guard)') && script.includes('status_line >/dev/null && exit 0'));
    const bootHook = script.slice(script.indexOf('sleep 12'), script.indexOf('sleep 12') + 200);
    check('boot hook calls guard, not start', bootHook.includes('ae-secure" guard'));
    const shellMarker = script.indexOf('ae-secure autostart >>>');
    const shellHook = script.slice(shellMarker, shellMarker + 320);
    check('shell hook calls guard, not start', shellMarker > -1 && shellHook.includes('ae-secure" guard'));
    check('installer can toggle shell autostart', /autostart\)/.test(script) && /shell autostart enabled/.test(script));
    check('autostart block is rewritten, not duplicated', (script.match(/strip_autostart_block\(\) \{/g) || []).length >= 2 && (script.match(/strip_autostart_block "\$profile"/g) || []).length >= 2);
    check('periodic guard job targets the health-check command', /termux-job-scheduler --job-id 9421 --period-ms 900000/.test(script) && /exec "\$AE_BIN_DIR\/ae-secure" guard/.test(script));
    check('periodic job can be skipped', /AE_NO_JOB/.test(script));
    check('boot hooks can be skipped', /AE_NO_BOOT/.test(script));
    check('url prints a qr code when available', /qrencode -t ANSIUTF8/.test(script));

    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    check('readme documents the installer and its commands', /scripts\/termux-install\.sh/.test(readme) && /ae-secure update/.test(readme) && /ae-secure backup/.test(readme));
    check('readme names the branch the app lives on', readme.includes('arena/442b6c1e-encrypted-messanger'));
    check('readme carries the copy-paste one-liner', /codeload\.github\.com\/FadeKit\/Encrypted-Messanger\/tar\.gz/.test(readme) && /scripts\/install\.sh/.test(readme));
    check('installer default branch matches the readme', script.includes('AE_BRANCH:-arena/442b6c1e-encrypted-messanger'));
  }
}

if (VERBOSE && asyncNoise.length) console.log(`  (async stub-network noise: ${asyncNoise.length})`);
console.log(`\n${pass} checks passed, ${failures.length} failed\n`);
if (failures.length) for (const f of failures) console.log(' -', f);
// surfaces leave timers behind (clocks, graph ticks); exit explicitly instead of waiting
process.exit(failures.length ? 1 : 0);
