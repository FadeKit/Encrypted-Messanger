import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const PORT = 3553, DATA = '/tmp/ae/dump-tabs';
const W = Number(process.env.AE_W || 390), H = Number(process.env.AE_H || 844);
fs.rmSync(DATA, { recursive: true, force: true });
const server = spawn('node', ['server/index.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), AE_DATA_DIR: DATA }, stdio: 'ignore' });
process.on('exit', () => { try { server.kill('SIGTERM'); } catch {} });
await new Promise((r) => setTimeout(r, 1400));
const browser = await puppeteer.launch({ executablePath: '/tmp/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], defaultViewport: { width: W, height: H, isMobile: W < 800, hasTouch: W < 800 } });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.split('\n')[0]));
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

const dump = async (label) => {
  const cells = await page.evaluate(() => {
    const read = (b) => {
      const glyph = b.querySelector('.tb-glyph');
      const rect = b.getBoundingClientRect();
      const gs = glyph ? getComputedStyle(glyph) : null;
      return {
        win: b.dataset.win || null,
        title: b.title,
        label: b.querySelector('.tb-label')?.textContent || '',
        cls: b.className,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        glyphSize: glyph ? Math.round(glyph.getBoundingClientRect().width) : 0,
        glyphVisible: !!gs && gs.display !== 'none' && gs.visibility !== 'hidden' && Number(gs.opacity) > 0,
        svg: !!b.querySelector('svg'),
      };
    };
    return {
      stack: [...document.querySelectorAll('#taskbar-stack .tb-btn')].map((b) => Object.assign(read(b), { parent: b.parentElement.id || b.parentElement.className, app: b.dataset.app || null, name: b.querySelector('.tb-name')?.textContent || '' })),
      dock: [...document.querySelectorAll('#dock .dock-btn, #dock button')].map(read),
      bar: (() => { const r = document.querySelector('#taskbar').getBoundingClientRect(); const t = document.querySelector('#taskbar-tabs').getBoundingClientRect(); const s = document.querySelector('#taskbar-stack'); return { bar: [Math.round(r.x), Math.round(r.width)], tabs: [Math.round(t.x), Math.round(t.width)], stackScroll: [s.scrollLeft, s.scrollWidth, Math.round(s.clientWidth)], visible: t.right <= r.right }; })(),
    };
  });
  console.log(`\n== ${label} (${W}x${H})`);
  for (const c of cells.stack) console.log(' stack', JSON.stringify(c));
  for (const c of cells.dock) console.log(' dock ', JSON.stringify(c));
};

await page.evaluate(() => { Apps.open('messages'); Apps.open('settings'); Apps.open('drive'); });
await new Promise((r) => setTimeout(r, 900));
await dump('three open');
const bar = await page.evaluate(() => { const r = document.querySelector('#taskbar')?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; });
if (bar) await page.screenshot({ path: `/tmp/ae/shots/tabs-open-${W}.png`, clip: { x: 0, y: Math.max(0, bar.y - 4), width: W, height: Math.min(H - Math.max(0, bar.y - 4), bar.h + 8) } });
await page.evaluate(() => Windows.minimize('settings'));
await new Promise((r) => setTimeout(r, 700));
await dump('settings minimized');
if (bar) await page.screenshot({ path: `/tmp/ae/shots/tabs-min-${W}.png`, clip: { x: 0, y: Math.max(0, bar.y - 4), width: W, height: Math.min(H - Math.max(0, bar.y - 4), bar.h + 8) } });
// open a second window of an app while another is minimized, and a fresh app
await page.evaluate(() => { Apps.open('communities'); Apps.open('airdrop'); });
await new Promise((r) => setTimeout(r, 900));
await dump('two more open');
if (bar) await page.screenshot({ path: `/tmp/ae/shots/tabs-more-${W}.png`, clip: { x: 0, y: Math.max(0, bar.y - 4), width: W, height: Math.min(H - Math.max(0, bar.y - 4), bar.h + 8) } });
await browser.close(); server.kill('SIGTERM');
