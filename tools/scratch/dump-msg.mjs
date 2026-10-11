import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const PORT = 3551, DATA = '/tmp/ae/dump-msg';
fs.rmSync(DATA, { recursive: true, force: true });
const server = spawn('node', ['server/index.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), AE_DATA_DIR: DATA }, stdio: 'ignore' });
process.on('exit', () => { try { server.kill('SIGTERM'); } catch {} });
await new Promise((r) => setTimeout(r, 1400));
const browser = await puppeteer.launch({ executablePath: '/tmp/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.split('\n')[0]));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE:', m.text().slice(0, 160)); });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
await page.evaluate(() => [...document.querySelectorAll('.auth-tabs button')].find((b) => /create account/i.test(b.textContent)).click());
await new Promise((r) => setTimeout(r, 250));
const inputs = await page.$$('.auth-panel input');
await inputs[0].type('operator'); await inputs[2].type('correct-horse-battery-staple-9'); await inputs[3].type('correct-horse-battery-staple-9');
await page.evaluate(() => document.querySelector('.auth-panel form .btn.primary').click());
for (let i = 0; i < 40; i += 1) {
  await new Promise((r) => setTimeout(r, 250));
  const ok = await page.evaluate(() => {
    const box = document.querySelector('#modal-layer input[type=checkbox]');
    if (!box) return false;
    box.click();
    const go = [...document.querySelectorAll('#modal-layer button')].find((b) => /continue to ae secure/i.test(b.textContent));
    if (go) { go.click(); return true; }
    return false;
  });
  if (ok) break;
}
await new Promise((r) => setTimeout(r, 1800));

const plate = await page.evaluate(() => {
  Apps.open('messages');
  const out = { records: Windows.list().map((r) => ({ id: r.id, title: r.title, minimized: r.minimized })) };
  out.cells = [...document.querySelectorAll('#taskbar-stack .tb-btn')].map((b) => ({
    win: b.dataset.win || null,
    title: b.title,
    label: b.querySelector('.tb-label')?.textContent || '',
    glyph: !!b.querySelector('svg'),
    width: Math.round(b.getBoundingClientRect().width),
    minimized: b.classList.contains('minimized'),
    html: b.outerHTML.replace(/\s+/g, ' ').slice(0, 200),
  }));
  return out;
});
console.log('PLATES:', JSON.stringify(plate, null, 1));

const report = await page.evaluate(() => {
  const out = {};
  out.before = document.querySelectorAll('.window').length;
  Apps.open('messages');
  out.after = document.querySelectorAll('.window').length;
  const win = document.querySelector('.window[data-win="messages"]');
  if (!win) return { ...out, missing: true };
  const cs = getComputedStyle(win);
  const rect = win.getBoundingClientRect();
  return {
    ...out,
    html: win.outerHTML.replace(/\s+/g, ' ').slice(0, 400),
    style: { display: cs.display, visibility: cs.visibility, opacity: cs.opacity, zIndex: cs.zIndex, position: cs.position, transform: cs.transform, top: cs.top, left: cs.left, width: cs.width, height: cs.height, filter: cs.filter, clipPath: cs.clipPath },
    rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    parentClass: win.parentElement.className,
    parentStyle: (() => { const p = getComputedStyle(win.parentElement); return { display: p.display, opacity: p.opacity, visibility: p.visibility }; })(),
    inlineStyle: win.getAttribute('style'),
  };
});
console.log(JSON.stringify(report, null, 2));
await new Promise((r) => setTimeout(r, 600));
await page.screenshot({ path: '/tmp/ae/shots/dump-messages.png' });
const shot2 = await page.evaluate(() => {
  const win = document.querySelector('.window[data-win="messages"]');
  return { rect: win ? win.getBoundingClientRect().toJSON() : null, focused: document.activeElement?.className };
});
console.log('after 600ms:', JSON.stringify(shot2));
await browser.close(); server.kill('SIGTERM');
