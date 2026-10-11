import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import fs from 'node:fs';
const ROOT = '/home/user/Encrypted-Messanger';
const PORT = 3531;
fs.rmSync('/tmp/ae/probe-dm', { recursive: true, force: true });
const busy = await new Promise((res) => { const s = createConnection({ port: PORT, host: '127.0.0.1' }, () => { s.destroy(); res(true); }); s.on('error', () => res(false)); });
if (busy) { console.error('port busy'); process.exit(2); }
const server = spawn('node', ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), AE_DATA_DIR: '/tmp/ae/probe-dm' }, stdio: 'ignore' });
process.on('exit', () => server.kill('SIGTERM'));
await new Promise((r) => setTimeout(r, 1200));
const browser = await puppeteer.launch({ executablePath: '/tmp/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], defaultViewport: { width: 1200, height: 800 } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const make = async (handle) => {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`${handle} PAGEERROR: ${e.message.slice(0, 140)}`));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
  await page.evaluate(() => [...document.querySelectorAll('.auth-tabs button')].find((b) => /create account/i.test(b.textContent)).click());
  await wait(300);
  const inputs = await page.$$('.auth-panel input');
  await inputs[0].type(handle); await inputs[2].type('correct-horse-battery-staple-9'); await inputs[3].type('correct-horse-battery-staple-9');
  await page.evaluate(() => document.querySelector('.auth-panel form .btn.primary').click());
  await wait(3000);
  await page.evaluate(() => document.querySelector('#modal-layer input[type=checkbox]')?.click());
  await wait(200);
  await page.evaluate(() => [...document.querySelectorAll('#modal-layer button')].find((b) => /continue to ae secure/i.test(b.textContent))?.click());
  await wait(1800);
  return page;
};
const a = await make('operator');
const b = await make('fadehelper');
await a.evaluate(() => Apps.open('messages'));
await wait(1200);
await a.evaluate(() => [...document.querySelectorAll('.window[data-win^="messages"] button')].find((x) => /new direct message/i.test(x.innerText))?.click());
await wait(1000);
await a.evaluate(() => [...document.querySelectorAll('#modal-layer .list-item')].find((r) => /fadehelper/i.test(r.innerText))?.click());
await wait(400);
await a.evaluate(() => [...document.querySelectorAll('#modal-layer button')].find((x) => /start chatting/i.test(x.innerText))?.click());
await wait(2600);
console.log(await a.evaluate(async () => {
  const conv = State.get('conversations')[0];
  const raw = await API.get('/api/conversations');
  const server = raw.conversations[0];
  const report = {
    hasKey: !!conv.key,
    keyType: conv.key ? Object.prototype.toString.call(conv.key) : null,
    isCryptoKey: conv.key instanceof CryptoKey,
    keyWrap: String(conv.keyWrap || '').slice(0, 60),
    serverKeyWrap: String(server.keyWrap || '').slice(0, 60),
    members: (conv.members || []).map((m) => ({ id: m.id, self: m.id === State.user.id, hasPub: !!m.identityPublic })),
    selfId: State.user.id,
  };
  try {
    const parsed = JSON.parse(conv.keyWrap);
    report.wrapBy = parsed.by;
    report.wrapByIsSelf = parsed.by === State.user.id;
    report.pubMatchesSelf = parsed.pub === State.vault.identityPublic;
    report.wLength = String(parsed.w || '').length;
    const context = `conv:${conv.id}`;
    const shared = await AE.deriveSharedKey(State.vault.identityPrivate, State.vault.identityPublic, context);
    report.sharedIsKey = shared instanceof CryptoKey;
    try {
      const raw = await AE.unwrapKey(shared, parsed.w);
      report.unwrapped = !!raw && raw.length;
    } catch (e) { report.unwrapError = String(e.message).slice(0, 90); }
    // round-trip a fresh wrap with the same inputs
    const rawKey = await AE.generateAesRaw();
    const fresh = await State.wrapChannelKey('conv', conv.id, rawKey, State.vault.identityPublic);
    const shared2 = await AE.deriveSharedKey(State.vault.identityPrivate, State.vault.identityPublic, context);
    try {
      const raw2 = await AE.unwrapKey(shared2, JSON.parse(fresh).w);
      report.roundTrip = !!raw2 && raw2.length === rawKey.length;
    } catch (e) { report.roundTripError = String(e.message).slice(0, 90); }
    const viaSelf = await State.channelKey(conv, 'conv');
    report.viaCache = !!viaSelf;
  } catch (e) { report.wrapError = String(e.message).slice(0, 90); }
  return report;
}));
await browser.close(); server.kill('SIGTERM');
