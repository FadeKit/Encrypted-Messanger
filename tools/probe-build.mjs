// The "did my patch land?" check, both ways:
//   · a page served by this build says so, in the console and in Settings → About
//   · a page that came from an older copy is told it is behind, and offered a reload
//
//   LD_LIBRARY_PATH=/tmp/ae/lib FONTCONFIG_PATH=/tmp/ae/fonts \
//   AE_PORT=3563 AE_LABEL=build node tools/probe-build.mjs
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = Number(process.env.AE_PORT || 3563);
const LABEL = process.env.AE_LABEL || 'build';
const SHOTS = '/tmp/ae/shots';
fs.mkdirSync(SHOTS, { recursive: true });
const DATA = `/tmp/ae/build-${LABEL}`;
fs.rmSync(DATA, { recursive: true, force: true });

const busy = await new Promise((resolve) => {
  const socket = createConnection({ port: PORT, host: '127.0.0.1' });
  socket.on('connect', () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(false));
  setTimeout(() => { socket.destroy(); resolve(false); }, 800);
});
if (busy) { console.error(`port ${PORT} is already serving — pick another`); process.exit(2); }

const server = spawn('node', ['server/index.js'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), AE_DATA_DIR: DATA }, stdio: 'ignore',
});
const stop = () => { try { server.kill('SIGTERM'); } catch { /* ignore */ } };
process.on('exit', stop);
process.on('uncaughtException', (error) => { stop(); throw error; });
process.on('unhandledRejection', (error) => { stop(); throw error; });
await new Promise((r) => setTimeout(r, 1400));

const { build } = await import(`file://${ROOT.replace(/\/$/, '')}/server/build.js`).then((m) => m.default || m);
const browser = await puppeteer.launch({
  executablePath: '/tmp/chromium', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  defaultViewport: { width: 390, height: 844, isMobile: true, hasTouch: true },
});

let passes = 0;
let fails = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passes += 1; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fails += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const register = async (page) => {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
  await page.evaluate(() => [...document.querySelectorAll('.auth-tabs button')].find((b) => /create account/i.test(b.textContent)).click());
  await wait(300);
  const inputs = await page.$$('.auth-panel input');
  await inputs[0].type('operator');
  await inputs[2].type('correct-horse-battery-staple-9');
  await inputs[3].type('correct-horse-battery-staple-9');
  await page.evaluate(() => document.querySelector('.auth-panel form .btn.primary').click());
  for (let i = 0; i < 60; i += 1) {
    await wait(300);
    const done = await page.evaluate(() => {
      const box = document.querySelector('#modal-layer input[type=checkbox]');
      if (!box) return false;
      box.click();
      const go = [...document.querySelectorAll('#modal-layer button')].find((b) => /continue to ae secure/i.test(b.textContent));
      if (go) { go.click(); return true; }
      return false;
    });
    if (done) break;
  }
  await wait(2200);
};

// ------------------------------------------------------ the page it serves now
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.split('\n')[0]));
await register(page);
const stamp = await page.evaluate(() => ({
  page: document.documentElement.dataset.build || '',
  at: document.documentElement.dataset.buildAt || '',
  server: (State.get('boot') || {}).build || {},
}));
check('the served page is stamped', stamp.page === build.id, `page=${stamp.page} module=${build.id}`);
check('bootstrap reports the same build', stamp.server.id === build.id, `bootstrap=${stamp.server.id || 'none'}`);
check('the stamp carries when it was built', !!stamp.at, stamp.at);

const consoleText = await page.evaluate(() => {
  ConsoleLog.open();
  const text = document.querySelector('.console-log')?.innerText || '';
  ConsoleLog.close();
  return text;
});
check('the console names the build', new RegExp(`build ${build.id}`).test(consoleText), consoleText.split('\n').find((l) => /build /.test(l)) || 'no line');
check('no reload warning on a current page', !/newer version is on this server/i.test(await page.evaluate(() => document.body.innerText)));

await page.evaluate(() => Apps.open('settings', { section: 'about' }));
await wait(1400);
const about = await page.evaluate(() => document.querySelector('.window[data-win="settings"]')?.innerText.replace(/\s+/g, ' ') || '');
check('About names the build', new RegExp(`Build ${build.id}`).test(about), about.slice(about.indexOf('Build'), about.indexOf('Build') + 90));
check('About says the page is current', /this page is up to date/i.test(about));
await page.screenshot({ path: `${SHOTS}/${LABEL}-about.png` });

// --------------------------------------------- a page that came from a patch ago
// Its own context: a second page in the same profile would already carry the
// session and skip the sign-in screen entirely.
const staleContext = await browser.createBrowserContext();
const stale = await staleContext.newPage();
await stale.setRequestInterception(true);
stale.on('request', (request) => {
  if (request.resourceType() === 'document') {
    // the HTML a browser would have kept from before the patch: same app files,
    // an older stamp on the page itself
    request.respond({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      headers: { 'Cache-Control': 'no-cache' },
      body: fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
        .replace('<html lang="en"', '<html lang="en" data-build="old0000"'),
    });
    return;
  }
  request.continue();
});
await stale.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
await wait(1800);
const warned = await stale.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
const staleConsole = await stale.evaluate(() => {
  ConsoleLog.open();
  const text = document.querySelector('.console-log')?.innerText || '';
  ConsoleLog.close();
  return text;
});
check('a page behind the server is told to reload', /newer version is on this server/i.test(warned), warned.slice(warned.search(/newer version/i) - 30, warned.search(/newer version/i) + 60));
check('the notice offers the reload', /reload now/i.test(warned));
check('the console says which page it is', new RegExp(`this page is build old0000, the server has ${build.id}`).test(staleConsole));
await stale.screenshot({ path: `${SHOTS}/${LABEL}-behind.png` });

check('no runtime errors', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(`\n### ${passes} ok, ${fails} failed`);
await browser.close();
server.kill('SIGTERM');
