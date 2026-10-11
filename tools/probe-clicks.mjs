// Walks the surfaces the way a person on a phone does — the dock icons, the
// start menu, and the taskbar tabs — instead of calling Apps.open() directly.
// Runs with a Galaxy S8 user agent so anything gated on a phone browser shows up.
//
//   LD_LIBRARY_PATH=/tmp/ae/lib FONTCONFIG_PATH=/tmp/ae/fonts \
//   AE_PORT=3560 AE_LABEL=s8 node tools/probe-clicks.mjs
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = Number(process.env.AE_PORT || 3560);
const LABEL = process.env.AE_LABEL || 'clicks';
const W = Number(process.env.AE_W || 360);
const H = Number(process.env.AE_H || 740);
const SHOTS = '/tmp/ae/shots';
fs.mkdirSync(SHOTS, { recursive: true });
const DATA = `/tmp/ae/clicks-${LABEL}`;

// the browser a Galaxy S8 reports
const UA = 'Mozilla/5.0 (Linux; Android 9; SM-G950F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const busy = await new Promise((resolve) => {
  const socket = createConnection({ port: PORT, host: '127.0.0.1' });
  socket.on('connect', () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(false));
  setTimeout(() => { socket.destroy(); resolve(false); }, 800);
});
if (busy) { console.error(`port ${PORT} is already serving — pick another`); process.exit(2); }

fs.rmSync(DATA, { recursive: true, force: true });
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
  defaultViewport: { width: W, height: H, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
await page.setUserAgent(UA);
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.split('\n')[0]}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 140)}`); });
page.on('response', (r) => { if (r.status() === 404) errors.push(`404: ${r.url().replace(`http://127.0.0.1:${PORT}`, '')}`); });
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
await new Promise((r) => setTimeout(r, 2000));
const ready = await page.evaluate(() => !!(window.State && State.user));
console.log(`signed in: ${ready} · viewport ${W}x${H} · ${UA.slice(0, 46)}…`);
if (!ready) { console.error('the account never finished creating'); await browser.close(); server.kill('SIGTERM'); process.exit(2); }

// What a surface is: a window, the console flyout, or an editor's file picker.
const surfaceState = (id) => page.evaluate((surface) => {
  const win = document.querySelector(`.window[data-win="${surface}"]`)
    || (surface === 'console' ? document.querySelector('#console-panel') : null)
    || document.querySelector('#modal-layer.open .modal');
  if (!win) return { open: false };
  const body = win.querySelector('.window-body') || win.querySelector('.modal-body') || win;
  const text = (body.innerText || '').replace(/\s+/g, ' ').trim();
  return { open: true, nodes: body.querySelectorAll('*').length, text: text.length, sample: text.slice(0, 60) };
}, id);

const closeEverything = () => page.evaluate(() => {
  Windows.closeAll && Windows.closeAll();
  ConsoleLog.close && ConsoleLog.close();
  for (const layer of document.querySelectorAll('#modal-layer.open')) {
    layer.classList.remove('open');
    const list = layer.querySelector('.modal-list');
    if (list) list.innerHTML = '';
  }
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ through the dock
const dock = await page.evaluate(() => [...document.querySelectorAll('#desktop-icons .desk-icon')].map((b, i) => ({ i, label: b.innerText.replace(/\s+/g, ' ').trim() })));
const dockApps = await page.evaluate(() => Apps.all().map((a) => a.id));
console.log(`dock icons: ${dock.map((d) => d.label).join(' / ')}`);

let problems = 0;
for (let index = 0; index < dock.length; index += 1) {
  await closeEverything();
  await wait(250);
  errors.length = 0;
  const clicked = await page.evaluate((i) => {
    const buttons = [...document.querySelectorAll('#desktop-icons .desk-icon')];
    if (!buttons[i]) return false;
    buttons[i].click();
    return true;
  }, index);
  await wait(1300);
  // which surface did it open?
  const opened = await page.evaluate(() => {
    // a window names itself; the console and an editor's picker do not, so they
    // are recognised by where they live
    const win = document.querySelector('.window');
    if (win) return win.dataset.win;
    if (document.querySelector('#console-panel:not([hidden])')) return 'console';
    if (document.querySelector('#modal-layer.open .modal')) return ':modal';
    return null;
  });
  const info = opened ? await surfaceState(opened) : { open: false };
  const bad = !clicked || !info.open || info.nodes < 6 || info.text < 8 || errors.length;
  if (bad) problems += 1;
  console.log(`${bad ? 'BAD ' : 'ok  '} dock:${dock[index].label.padEnd(14)} → ${opened || 'nothing'} nodes=${info.nodes ?? 0} text=${info.text ?? 0}${errors.length ? ` ! ${errors[0]}` : ''}`);
  if (info.sample) console.log(`       ${info.sample}`);
}

// -------------------------------------------------------- through the start menu
await closeEverything();
await wait(300);
await page.evaluate(() => document.querySelector('#taskbar-stack .tb-btn[title^="Start"]').click());
await wait(600);
// The tiles are the apps; the footer carries the account, a Settings icon and
// Sign out.  Sign out reloads the page on purpose, so it is inspected rather
// than clicked.
const menuApps = await page.evaluate(() => [...document.querySelectorAll('#start-menu .start-tile')].map((b) => b.innerText.replace(/\s+/g, ' ').slice(0, 24)));
console.log(`start menu tiles: ${menuApps.length}`);
const footer = await page.evaluate(() => [...document.querySelectorAll('#start-menu .start-footer button')].map((b) => {
  const rect = b.getBoundingClientRect();
  return { title: b.title, glyph: !!b.querySelector('svg'), text: b.innerText.trim(), box: `${Math.round(rect.width)}x${Math.round(rect.height)}` };
}));
for (const button of footer) {
  const bad = !button.glyph && !button.text;
  if (bad) problems += 1;
  console.log(`${bad ? 'BAD ' : 'ok  '} menu footer:${(button.title || '?').padEnd(10)} ${button.box} glyph=${button.glyph} text="${button.text}"`);
}
for (let index = 0; index < menuApps.length; index += 1) {
  await closeEverything();
  await wait(250);
  errors.length = 0;
  // re-open the menu for each row: opening a surface closes it
  const opened = await page.evaluate((i) => {
    const start = document.querySelector('#taskbar-stack .tb-btn[title^="Start"]');
    if (start) start.click();
    return new Promise((resolve) => setTimeout(() => {
      const rows = [...document.querySelectorAll('#start-menu .start-tile')];
      if (rows[i]) rows[i].click();
      setTimeout(() => {
        const win = document.querySelector('.window');
        if (win) { resolve(win.dataset.win); return; }
        if (document.querySelector('#console-panel:not([hidden])')) { resolve('console'); return; }
        if (document.querySelector('#modal-layer.open .modal')) { resolve(':modal'); return; }
        resolve(null);
      }, 1100);
    }, 350));
  }, index);
  const info = opened ? await surfaceState(opened) : { open: false };
  const bad = !info.open || info.nodes < 6 || info.text < 8 || errors.length;
  if (bad) problems += 1;
  console.log(`${bad ? 'BAD ' : 'ok  '} menu:${String(menuApps[index]).padEnd(16)} → ${opened || 'nothing'} nodes=${info.nodes ?? 0} text=${info.text ?? 0}${errors.length ? ` ! ${errors[0]}` : ''}`);
}

// ---------------------------------------------------------------- through tabs
await closeEverything();
await wait(300);
await page.evaluate(() => { Apps.open('messages'); Apps.open('drive'); Apps.open('airdrop'); });
await wait(1400);
const tabs = await page.evaluate(() => [...document.querySelectorAll('#taskbar-tabs .tb-btn')].map((b) => {
  const rect = b.getBoundingClientRect();
  const svg = b.querySelector('.tb-glyph svg');
  return {
    app: b.dataset.app || null,
    win: b.dataset.win || null,
    title: b.title,
    icon: !!(svg && svg.querySelector('path, rect, circle, line, polyline, polygon')),
    box: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
    visible: rect.width > 0 && rect.height > 0 && rect.right <= window.innerWidth + 1,
  };
}));
console.log(`tabs: ${tabs.length}`);
for (const tab of tabs) {
  const bad = !tab.icon || !tab.visible || tab.box.split('x').some((n) => Number(n) < 30);
  if (bad) problems += 1;
  console.log(`${bad ? 'BAD ' : 'ok  '} tab:${(tab.app || tab.win || '?').padEnd(12)} ${tab.box} icon=${tab.icon} visible=${tab.visible} title="${tab.title}"`);
}
await page.screenshot({ path: `${SHOTS}/${LABEL}-tabs.png` });

// minimise each tab and come back by tapping it: the whole point of item 2
for (const tab of tabs.slice(0, 3)) {
  const selector = tab.app ? `.tb-btn[data-app="${tab.app}"]` : `.tb-btn[data-win="${tab.win}"]`;
  // a tab that is not the focused window brings it forward first; the second
  // tap on a focused tab is what puts the window away
  const wasFocused = await page.evaluate((sel) => document.querySelector(sel).classList.contains('focused'), selector);
  if (!wasFocused) { await page.evaluate((sel) => document.querySelector(sel).click(), selector); await wait(600); }
  await page.evaluate((sel) => document.querySelector(sel).click(), selector);
  await wait(600);
  const hidden = await page.evaluate((t) => {
    const win = document.querySelector(`.window[data-win="${t.app || t.win}"]`);
    return !win || win.classList.contains('minimized') || !win.getClientRects().length;
  }, tab);
  const stillThere = await page.evaluate((sel) => {
    const b = document.querySelector(sel);
    if (!b) return false;
    const rect = b.getBoundingClientRect();
    return rect.width > 0 && rect.right <= window.innerWidth + 1;
  }, selector);
  await page.evaluate((sel) => document.querySelector(sel).click(), selector);
  await wait(700);
  const back = await page.evaluate((t) => {
    const win = document.querySelector(`.window[data-win="${t.app || t.win}"]`);
    return !!(win && !win.classList.contains('minimized') && win.getClientRects().length);
  }, tab);
  const bad = !hidden || !stillThere || !back;
  if (bad) problems += 1;
  console.log(`${bad ? 'BAD ' : 'ok  '} tab round-trip ${(tab.app || tab.win).padEnd(12)} minimised=${hidden} tab-stayed-visible=${stillThere} came-back=${back}`);
  if (bad) await page.screenshot({ path: `${SHOTS}/${LABEL}-roundtrip-${tab.app || tab.win}.png` });
}

// a screenshot of the bar itself, whichever viewport we are on
await closeEverything();
await wait(300);
await page.evaluate(() => { Apps.open('messages'); Apps.open('settings'); });
await wait(1000);
await page.evaluate(() => Windows.minimize('settings'));
await wait(500);
const bar = await page.evaluate(() => { const r = document.querySelector('#taskbar').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await page.screenshot({ path: `${SHOTS}/${LABEL}-bar.png`, clip: { x: 0, y: Math.max(0, bar.y - 4), width: W, height: Math.min(H - Math.max(0, bar.y - 4), bar.h + 8) } });

console.log(`\n### ${problems} click-path problem(s) at ${W}x${H}`);
const unique = [...new Set(errors)];
if (unique.length) { console.log('runtime errors:'); for (const e of unique.slice(0, 6)) console.log(`  ${e}`); }
await browser.close();
server.kill('SIGTERM');
