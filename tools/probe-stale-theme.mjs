// Reproduces what an account saved by an older build sees: a theme or accent
// name that the shipped stylesheet no longer defines.  Writes those names onto
// the account, reloads, and reports whether the windows still have a readable
// palette — an undefined theme leaves every surface transparent, which reads as
// a blank screen.
//
//   LD_LIBRARY_PATH=/tmp/ae/lib FONTCONFIG_PATH=/tmp/ae/fonts \
//   AE_PORT=3562 AE_LABEL=stale node tools/probe-stale-theme.mjs
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = Number(process.env.AE_PORT || 3562);
const LABEL = process.env.AE_LABEL || 'stale';
const W = Number(process.env.AE_W || 390);
const H = Number(process.env.AE_H || 844);
const SHOTS = '/tmp/ae/shots';
fs.mkdirSync(SHOTS, { recursive: true });
const DATA = `/tmp/ae/stale-${LABEL}`;
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

const browser = await puppeteer.launch({
  executablePath: '/tmp/chromium', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  defaultViewport: { width: W, height: H, isMobile: true, hasTouch: true },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
await page.evaluate(() => [...document.querySelectorAll('.auth-tabs button')].find((b) => /create account/i.test(b.textContent)).click());
await new Promise((r) => setTimeout(r, 300));
const inputs = await page.$$('.auth-panel input');
await inputs[0].type('operator');
await inputs[2].type('correct-horse-battery-staple-9');
await inputs[3].type('correct-horse-battery-staple-9');
await page.evaluate(() => document.querySelector('.auth-panel form .btn.primary').click());
for (let i = 0; i < 60; i += 1) {
  await new Promise((r) => setTimeout(r, 300));
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
await new Promise((r) => setTimeout(r, 2200));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// how does a surface read right now?
const readSurface = async (id) => {
  await page.evaluate((surface) => Apps.open(surface), id);
  await wait(1200);
  return page.evaluate((surface) => {
    const win = document.querySelector(`.window[data-win="${surface}"]`);
    if (!win) return { open: false };
    const body = win.querySelector('.window-body') || win;
    const winStyle = getComputedStyle(win);
    const textNode = body.querySelector('.body-strong, .card .row, .list-item, h1, h2, .title, .meta') || body;
    const textStyle = getComputedStyle(textNode);
    const root = getComputedStyle(document.documentElement);
    return {
      open: true,
      theme: document.body.dataset.theme,
      accent: document.body.dataset.accent,
      windowBg: winStyle.backgroundColor,
      windowText: winStyle.color,
      bodyText: textStyle.color,
      ink: root.getPropertyValue('--ink').trim(),
      fill: root.getPropertyValue('--fill-card').trim(),
      sample: (body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 50),
      textLength: (body.innerText || '').trim().length,
    };
  }, id);
};

let passes = 0;
let fails = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passes += 1; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fails += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\n--- an account whose settings are current');
const fresh = await readSurface('settings');
check('a current theme defines the ink and surface colours', fresh.ink !== '' && fresh.fill !== '', `ink=${fresh.ink} fill=${fresh.fill}`);
check('the window paints a background', fresh.windowBg !== 'rgba(0, 0, 0, 0)' && fresh.windowBg !== 'transparent', fresh.windowBg);
await page.screenshot({ path: `${SHOTS}/${LABEL}-current.png` });

// what an older build could have left behind
const stale = ['signal', 'paper', 'mono', 'nebula'];
console.log(`\n--- stored names this build does not define (${stale.join(', ')})`);
for (const name of stale) {
  const applied = await page.evaluate(async (theme) => {
    Windows.closeAll && Windows.closeAll();
    await State.saveSettings({ theme, accent: 'phosphor' });
    return true;
  }, name).catch(() => false);
  if (!applied) { check(`the account accepts the stale name "${name}"`, false, 'the settings call did not resolve'); continue; }
  await page.reload({ waitUntil: 'networkidle2' });
  await wait(2600);
  const view = await readSurface('settings');
  const readable = view.ink !== '' && view.windowBg !== 'rgba(0, 0, 0, 0)' && view.textLength >= 8;
  check(`the interface is still readable with a stored theme of "${name}"`, readable,
    `theme=${view.theme} ink="${view.ink}" bg=${view.windowBg} text=${view.textLength}`);
  if (!readable) await page.screenshot({ path: `${SHOTS}/${LABEL}-broken-${name}.png` });
}

// and a stale accent on its own
await page.evaluate(() => State.saveSettings({ theme: 'nox', accent: 'ultraviolet' }));
await page.reload({ waitUntil: 'networkidle2' });
await wait(2500);
const accentView = await readSurface('drive');
check('a stored accent this build does not define still renders', accentView.ink !== '' && accentView.windowBg !== 'rgba(0, 0, 0, 0)',
  `accent=${accentView.accent} ink="${accentView.ink}" bg=${accentView.windowBg}`);

console.log(`\n### ${passes} ok, ${fails} failed`);
await browser.close();
server.kill('SIGTERM');
