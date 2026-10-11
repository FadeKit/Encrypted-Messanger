// Opens every surface the desktop can launch and reports, per surface, whether a
// window actually appeared and how much of it is real content.  A screenshot
// that matches the desktop shot byte-for-byte means the window never opened.
//
//   LD_LIBRARY_PATH=/tmp/ae/lib FONTCONFIG_PATH=/tmp/ae/fonts \
//   AE_LABEL=s-pc AE_W=1440 AE_H=900 AE_PORT=3540 node tools/probe-surfaces.mjs
//
// Spawns its own server with a fresh data directory and removes it on the way out.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = Number(process.env.AE_PORT || 3540);
const LABEL = process.env.AE_LABEL || 'surfaces';
const W = Number(process.env.AE_W || 1440);
const H = Number(process.env.AE_H || 900);
const DATA = `/tmp/ae/ps-${LABEL}`;
const SHOTS = '/tmp/ae/shots';
fs.mkdirSync(SHOTS, { recursive: true });

const busy = await new Promise((resolve) => {
  const socket = createConnection({ port: PORT, host: '127.0.0.1' });
  socket.on('connect', () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(false));
  setTimeout(() => { socket.destroy(); resolve(false); }, 800);
});
if (busy) { console.error(`port ${PORT} is already serving — pick another`); process.exit(2); }

fs.rmSync(DATA, { recursive: true, force: true });
const server = spawn('node', ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), AE_DATA_DIR: DATA },
  stdio: 'ignore',
});
const stop = () => { try { server.kill('SIGTERM'); } catch {} };
process.on('exit', stop);
process.on('uncaughtException', (error) => { stop(); throw error; });
process.on('unhandledRejection', (error) => { stop(); throw error; });
await new Promise((r) => setTimeout(r, 1400));

const browser = await puppeteer.launch({
  executablePath: '/tmp/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  defaultViewport: { width: W, height: H, isMobile: W < 800, hasTouch: W < 800 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.split('\n')[0]}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`); });
page.on('response', (r) => { if (r.status() === 404) errors.push(`404: ${r.url().replace(`http://127.0.0.1:${PORT}`, '')}`); });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });

await page.evaluate(() => [...document.querySelectorAll('.auth-tabs button')].find((b) => /create account/i.test(b.textContent)).click());
await new Promise((r) => setTimeout(r, 250));
const inputs = await page.$$('.auth-panel input');
await inputs[0].type(process.env.AE_USER || 'operator');
await inputs[2].type('correct-horse-battery-staple-9');
await inputs[3].type('correct-horse-battery-staple-9');
await page.evaluate(() => document.querySelector('.auth-panel form .btn.primary').click());
// the one-time recovery codes stand between the form and the desktop
for (let i = 0; i < 40; i += 1) {
  await new Promise((r) => setTimeout(r, 250));
  const ok = await page.evaluate(() => {
    if (!document.querySelector('#modal-layer input[type=checkbox]')) return false;
    document.querySelector('#modal-layer input[type=checkbox]').click();
    const go = [...document.querySelectorAll('#modal-layer button')].find((b) => /continue to ae secure/i.test(b.textContent));
    if (go) { go.click(); return true; }
    return false;
  });
  if (ok) break;
}
await new Promise((r) => setTimeout(r, 1800));

const shot = async (name) => page.screenshot({ path: `${SHOTS}/${LABEL}-${name}.png` });
// The session opens on Messages, so the plain desktop has to be photographed
// with every window closed or the first surface would look identical to it.
await page.evaluate(() => Windows.closeAll && Windows.closeAll());
await new Promise((r) => setTimeout(r, 500));
await shot('desktop');

const ids = await page.evaluate(() => Apps.all().map((a) => a.id));
console.log(`surfaces: ${ids.join(' ')}`);
let problems = 0;
for (const id of ids) {
  errors.length = 0;
  await page.evaluate((surface) => {
    Windows.closeAll && Windows.closeAll();
    ConsoleLog.close && ConsoleLog.close();
    for (const layer of document.querySelectorAll('#modal-layer.open')) {
      layer.classList.remove('open');
      const list = layer.querySelector('.modal-list');
      if (list) list.innerHTML = '';
    }
    Apps.open(surface);
  }, id);
  await new Promise((r) => setTimeout(r, 1100));
  const info = await page.evaluate((surface) => {
    // The console is a flyout panel and the editor opens on a file-type picker
    // before it has a window of its own: both are legitimate surfaces.
    const win = document.querySelector(`.window[data-win="${surface}"]`)
      || (surface === 'console' ? document.querySelector('#console-panel') : null)
      || document.querySelector('#modal-layer.open .modal');
    const body = win ? (win.querySelector('.window-body') || win) : null;
    const text = body ? body.innerText.replace(/\s+/g, ' ').trim() : '';
    return {
      open: !!win,
      nodes: body ? body.querySelectorAll('*').length : 0,
      text: text.length,
      sample: text.slice(0, 90),
      buttons: body ? body.querySelectorAll('button').length : 0,
    };
  }, id);
  await shot(id);
  const blank = !info.open || info.nodes < 6 || info.text < 8;
  const flag = blank || errors.length ? 'BAD ' : 'ok  ';
  if (flag === 'BAD ') problems += 1;
  console.log(`${flag}${id.padEnd(12)} open=${info.open} nodes=${String(info.nodes).padEnd(4)} text=${String(info.text).padEnd(5)} buttons=${String(info.buttons).padEnd(3)}`);
  if (info.sample) console.log(`         ${info.sample}`);
  for (const error of errors.slice(0, 4)) console.log(`         ! ${error}`);
}
console.log(`\n### ${problems} surface problem(s) at ${W}x${H}`);
await browser.close();
server.kill('SIGTERM');
