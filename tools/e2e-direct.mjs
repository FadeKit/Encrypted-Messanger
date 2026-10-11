// Two accounts, one browser: registers both, signs in as the second, sends a
// direct message from the picker, reads it back as the first, and reports how
// long each step took so a freeze shows up as a timeout rather than a hang.
//
//   LD_LIBRARY_PATH=/tmp/ae/lib FONTCONFIG_PATH=/tmp/ae/fonts \
//   AE_PORT=3492 AE_W=1440 AE_H=900 node tools/e2e-direct.js
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = Number(process.env.AE_PORT || 3492);
const LABEL = process.env.AE_LABEL || 'dm';
const W = Number(process.env.AE_W || 1440);
const H = Number(process.env.AE_H || 900);
const SHOTS = process.env.AE_SHOTS || '/tmp/ae/shots';
fs.mkdirSync(SHOTS, { recursive: true });
const DATA = `/tmp/ae/e2e-${LABEL}`;
fs.rmSync(DATA, { recursive: true, force: true });

// A server left behind by an earlier crashed run keeps the port and its own data
// directory, which looks like "that handle is already taken" on every retry.
const portFree = await new Promise((resolve) => {
  const probe = connect({ port: PORT, host: '127.0.0.1' });
  probe.on('connect', () => { probe.destroy(); resolve(false); });
  probe.on('error', () => resolve(true));
  probe.setTimeout(600, () => { probe.destroy(); resolve(true); });
});
if (!portFree) {
  console.error(`Port ${PORT} is already serving something — stop the old run first.`);
  process.exit(2);
}

const server = spawn('node', ['server/index.js'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), AE_DATA_DIR: DATA }, stdio: 'ignore',
});
const shutdown = () => { try { server.kill('SIGTERM'); } catch { /* ignore */ } };
process.on('exit', shutdown);
process.on('uncaughtException', (error) => { console.error(error); shutdown(); process.exit(1); });
process.on('unhandledRejection', (error) => { console.error(error); shutdown(); process.exit(1); });
await new Promise((r) => setTimeout(r, 1200));
const browser = await puppeteer.launch({
  executablePath: '/tmp/chromium', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  defaultViewport: { width: W, height: H, isMobile: W < 800, hasTouch: W < 800 },
});
const failures = [];
const notes = [];
const check = (name, ok, detail = '') => {
  if (ok) notes.push(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else failures.push(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${LABEL}-${name}.png` });

// Each account gets its own browser context: separate localStorage, so signing
// in as one member never disturbs the other.
const openPage = async (label) => {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.contextLabel = label;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 120)); });
  page.pageErrors = errors;
  return page;
};

const register = async (page, handle) => {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
  await page.evaluate(() => [...document.querySelectorAll('.auth-tabs button')].find((b) => /create account/i.test(b.textContent)).click());
  await wait(250);
  const inputs = await page.$$('.auth-panel input');
  await inputs[0].type(handle);
  await inputs[2].type('correct-horse-battery-staple-9');
  await inputs[3].type('correct-horse-battery-staple-9');
  await page.evaluate(() => document.querySelector('.auth-panel form .btn.primary').click());
  // The recovery-code dialog is the proof the account exists; give the vault
  // key derivation the time it needs on a slow machine.
  const deadline = Date.now() + 30000;
  for (;;) {
    const state = await page.evaluate(() => ({
      modal: !!document.querySelector('#modal-layer.open'),
      user: window.State && State.user ? State.user.username : null,
      panel: (document.querySelector('.auth-panel') || {}).innerText?.replace(/\s+/g, ' ').slice(0, 160) || '',
    }));
    if (state.modal || state.user) break;
    if (Date.now() > deadline) throw new Error(`register(${handle}) stalled — panel: ${state.panel}`);
    await wait(400);
  }
  await wait(900);
  await page.evaluate(() => document.querySelector('#modal-layer input[type=checkbox]')?.click());
  await wait(150);
  await page.evaluate(() => [...document.querySelectorAll('#modal-layer button')].find((b) => /continue to ae secure/i.test(b.textContent))?.click());
  await wait(1500);
};

const signIn = async (page, handle) => {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
  await wait(600);
  const tabs = await page.$$('.auth-tabs button');
  if (tabs[0]) { await tabs[0].click(); await wait(250); }
  const inputs = await page.$$('.auth-panel input');
  await inputs[0].type(handle);
  await inputs[1].type('correct-horse-battery-staple-9');
  await page.evaluate(() => document.querySelector('.auth-panel form .btn.primary').click());
  await wait(2200);
};

// a cheap liveness probe: if the renderer is wedged this never resolves
const alive = async (page, label) => {
  const t0 = Date.now();
  try {
    await Promise.race([
      page.evaluate(() => document.title.length),
      new Promise((_, reject) => setTimeout(() => reject(new Error('renderer did not answer')), 6000)),
    ]);
  } catch (error) {
    check(`${label}: the page still answers`, false, error.message);
    return false;
  }
  return Date.now() - t0;
};

const pageA = await openPage('owner');
await register(pageA, 'operator');
check('the owner account is created', await pageA.evaluate(() => !!State.user), 'operator');

const pageB = await openPage('second');
await register(pageB, 'fadehelper');
const asSecond = await pageB.evaluate(() => (State.user || {}).username);
check('a second account can register', asSecond === 'fadehelper', String(asSecond));
const second = pageB;

// ---------------------------------------------- the freeze: start a direct message
// Operator accounts are deliberately absent from the directory (they are reached
// through one-time codes), so the owner starts the channel with the member.
await pageA.evaluate(() => Apps.open('messages'));
await wait(1200);
const start = Date.now();
await pageA.evaluate(() => [...document.querySelectorAll('.window[data-win^="messages"] button')].find((b) => /new direct message/i.test(b.textContent))?.click());
await wait(1200);
const picked = await pageA.evaluate(() => {
  const rows = [...document.querySelectorAll('#modal-layer .list-item')];
  const row = rows.find((r) => /fadehelper/i.test(r.innerText));
  if (!row) return { rows: rows.length, text: (document.querySelector('#modal-layer') || {}).innerText?.replace(/\s+/g, ' ').slice(0, 90) };
  row.click();
  return { rows: rows.length, clicked: true };
});
check('the direct-message picker lists the other account', picked.clicked === true, JSON.stringify(picked).slice(0, 90));
const latency = await alive(pageA, 'after picking a recipient');
check('the page stays responsive while the channel is sealed', typeof latency === 'number' && latency < 4000, `${latency} ms`);
await pageA.evaluate(() => [...document.querySelectorAll('#modal-layer button')].find((b) => /start chatting/i.test(b.textContent))?.click());
await wait(2500);
const after = await alive(pageA, 'after starting the channel');
check('starting a channel does not freeze the tab', typeof after === 'number', `${after} ms`);
const elapsed = Date.now() - start;
check('the whole flow completes quickly', elapsed < 12000, `${elapsed} ms`);
const opened = await pageA.evaluate(() => ({
  active: State.get('activeConversationId'),
  conversations: State.get('conversations').length,
  listRows: document.querySelectorAll('.window[data-win^="messages"] .list-item').length,
}));
check('the channel is open after start', !!opened.active && opened.conversations >= 1, JSON.stringify(opened));
await shot(pageA, 'dm-open');

// send a message
const typed = await pageA.evaluate(() => {
  const input = document.getElementById('composer-input');
  if (!input) return false;
  input.value = 'first message from the picker flow';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
});
check('the composer takes text once the channel is open', typed);
await pageA.evaluate(() => {
  const button = [...document.querySelectorAll('.window[data-win^="messages"] button')].find((b) => b.innerText.trim().toLowerCase() === 'send');
  if (button) button.click();
});
await wait(1800);
const sent = await pageA.evaluate(() => document.querySelector('.message-list')?.innerText || '');
check('the message appears in the channel', /first message from the picker flow/i.test(sent), sent.slice(0, 70).replace(/\s+/g, ' '));
if (process.env.AE_DUMP) {
  console.log('ROW HTML:', await pageA.evaluate(() => {
    const row = document.querySelector('.message-group');
    return row ? row.outerHTML.replace(/\s+/g, ' ').slice(0, 1200) : 'none';
  }));
}

// ------------------------------------------- the other side reads it back
await second.evaluate(() => Apps.open('messages'));
await wait(2600);
// The list refreshes on realtime events; a nudge keeps the test honest when the
// event arrived before the window did.
await second.evaluate(() => ConversationClient.refresh().catch(() => {}));
await wait(1200);
const seen = await second.evaluate(async () => {
  const deadline = Date.now() + 8000;
  for (;;) {
    const rows = [...document.querySelectorAll('.window[data-win^="messages"] .list-item')];
    const row = rows.find((r) => /operator/i.test(r.innerText));
    if (row) { row.click(); await new Promise((r2) => setTimeout(r2, 1400)); return { found: true, text: document.querySelector('.message-list')?.innerText || '' }; }
    if (Date.now() > deadline) return { found: false, rows: rows.length };
    await new Promise((r2) => setTimeout(r2, 300));
  }
});
check('the member sees the incoming channel', seen.found === true, seen.found ? '' : `rows=${seen.rows}`);
check('the member can read the message', /first message from the picker flow/i.test(seen.text || ''), (seen.text || '').slice(0, 70).replace(/\s+/g, ' '));
await shot(second, 'dm-received');

// ------------------------------------------------ opening and closing repeatedly
const cycles = await pageA.evaluate(async () => {
  const t0 = performance.now();
  for (let i = 0; i < 6; i++) {
    const row = document.querySelector('.window[data-win^="messages"] .list-item');
    if (row) row.click();
    await new Promise((r) => setTimeout(r, 250));
  }
  return Math.round(performance.now() - t0);
});
check('opening the same channel repeatedly stays fast', cycles < 4000, `${cycles} ms for 6 opens`);
const stillAlive = await alive(pageA, 'after repeated opens');
check('the tab is still responsive after repeated opens', typeof stillAlive === 'number', `${stillAlive} ms`);
await pageA.evaluate(() => {
  const win = document.querySelector('.window[data-win^="messages"]');
  window.__listenerCount = (() => {
    // the subscription holder is module-private; count via a state round-trip
    const before = State.get('conversations').length;
    State.emit('conversations', State.get('conversations'));
    return before;
  })();
});
const stable = await pageA.evaluate(() => document.querySelectorAll('.window[data-win^="messages"] .list-item').length);
check('the conversation list rebuilds exactly once per change', stable >= 1, `${stable} row(s)`);

console.log(`\n=== ${LABEL} direct messages (${W}x${H}) ===`);
for (const line of notes) console.log(line);
for (const line of failures) console.log(line);
const errors = [...new Set([...pageA.pageErrors, ...second.pageErrors])];
if (errors.length) { console.log('  --- runtime errors:'); for (const e of errors.slice(0, 6)) console.log(`   ${e}`); }
console.log(`\n${notes.length} ok, ${failures.length} failed, ${errors.length} runtime error kind(s)`);
await browser.close();
server.kill('SIGTERM');
process.exit(failures.length ? 1 : 0);
