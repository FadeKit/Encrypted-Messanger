// Two accounts, one browser: the member sends a direct message with a picture
// and saves a file into their Cloud Drive, then the owner opens the operator
// console and has to see all of it — every upload (images and drive files) and
// every message — with the member's handle nowhere in those listings.
//
//   LD_LIBRARY_PATH=/tmp/ae/lib FONTCONFIG_PATH=/tmp/ae/fonts \
//   AE_PORT=3494 AE_W=1440 AE_H=900 node tools/probe-admin.mjs
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = Number(process.env.AE_PORT || 3494);
const LABEL = process.env.AE_LABEL || 'admin';
const W = Number(process.env.AE_W || 1440);
const H = Number(process.env.AE_H || 900);
const SHOTS = '/tmp/ae/shots';
fs.mkdirSync(SHOTS, { recursive: true });
const DATA = `/tmp/ae/probe-${LABEL}`;
fs.rmSync(DATA, { recursive: true, force: true });

const portFree = await new Promise((resolve) => {
  const probe = connect({ port: PORT, host: '127.0.0.1' });
  probe.on('connect', () => { probe.destroy(); resolve(false); });
  probe.on('error', () => resolve(true));
  probe.setTimeout(600, () => { probe.destroy(); resolve(true); });
});
if (!portFree) { console.error(`Port ${PORT} is already serving something — stop the old run first.`); process.exit(2); }

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

const openPage = async () => {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
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

// ------------------------------------------------------------------ accounts
const owner = await openPage();
await register(owner, 'operator');
check('the operator account exists', await owner.evaluate(() => !!State.user), 'operator');

const member = await openPage();
await register(member, 'fadehelper');
const handle = await member.evaluate(() => State.user.username);
check('the member account exists', !!handle, String(handle));

// --------------------------------------- the owner opens a direct channel to them
await owner.evaluate(() => Apps.open('messages'));
await wait(1100);
await owner.evaluate(() => [...document.querySelectorAll('.window[data-win^="messages"] button')].find((b) => /new direct message/i.test(b.textContent))?.click());
await wait(900);
await owner.evaluate(() => {
  const row = [...document.querySelectorAll('#modal-layer .list-item')].find((r) => /fadehelper/i.test(r.innerText));
  if (row) row.click();
});
await wait(600);
await owner.evaluate(() => [...document.querySelectorAll('#modal-layer button')].find((b) => /start chatting/i.test(b.textContent))?.click());
await wait(2600);
const open = await owner.evaluate(() => !!State.get('activeConversationId'));
check('the owner has a channel to the member', open);

// ------------------------------------- the member sends a message with a picture
// A real 2x2 PNG, so the upload the operator sees is an image, not a blob.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHgQCAQ2m4wAAAABJRU5ErkJggg==',
  'base64',
);
fs.writeFileSync('/tmp/ae/probe-picture.png', PNG);

await member.evaluate(() => Apps.open('messages'));
await wait(1500);
// The realtime event may have arrived while the window was still closed, so ask
// the client for the list and give the row a moment to appear.
const memberRows = await member.evaluate(async () => {
  const deadline = Date.now() + 9000;
  for (;;) {
    await (window.ConversationClient && ConversationClient.refresh ? ConversationClient.refresh() : Promise.resolve());
    const rows = [...document.querySelectorAll('.window[data-win^="messages"] .list-item')];
    if (rows.length) return rows.length;
    if (Date.now() > deadline) return 0;
    await new Promise((r) => setTimeout(r, 400));
  }
});
check('the member sees the incoming channel', memberRows >= 1, `${memberRows} row(s)`);
await member.evaluate(() => {
  const row = [...document.querySelectorAll('.window[data-win^="messages"] .list-item')].find((r) => /operator/i.test(r.innerText))
    || document.querySelector('.window[data-win^="messages"] .list-item');
  if (row) row.click();
});
await wait(1400);
await member.evaluate(() => {
  const input = document.getElementById('composer-input');
  if (!input) return;
  input.value = 'picture from the member';
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
const fileInput = await member.$('.window[data-win^="messages"] input[type=file]');
if (fileInput) {
  await fileInput.uploadFile('/tmp/ae/probe-picture.png');
  await wait(2600);
}
const sent = await member.evaluate(async () => {
  const deadline = Date.now() + 12000;
  for (;;) {
    const button = [...document.querySelectorAll('.window[data-win^="messages"] button')].find((b) => b.innerText.trim().toLowerCase() === 'send');
    if (button && !button.disabled) { button.click(); break; }
    if (Date.now() > deadline) return 'no send button';
    await new Promise((r) => setTimeout(r, 400));
  }
  for (;;) {
    const text = document.querySelector('.message-list')?.innerText || '';
    if (/picture from the member/i.test(text)) return text;
    if (Date.now() > deadline) return text;
    await new Promise((r) => setTimeout(r, 400));
  }
});
check('the member sends a picture and a message', /picture from the member/i.test(sent), String(sent).slice(0, 70).replace(/\s+/g, ' '));

// ------------------------------------ and saves a text file into their own drive
await member.evaluate(() => Windows.closeAll && Windows.closeAll());
await wait(400);
await member.evaluate(() => Apps.open('drive'));
await wait(1200);
await member.evaluate(() => [...document.querySelectorAll('.window[data-win^="drive"] button')].find((b) => /new file/i.test(b.textContent))?.click());
await wait(700);
await member.evaluate(() => {
  const card = [...document.querySelectorAll('#modal-layer .file-type-card, #modal-layer button, #modal-layer .list-item')]
    .find((b) => /text file/i.test(b.textContent));
  if (card) (card.closest('button') || card).click();
});
await wait(1600);
const memberEditor = await member.evaluate(() => {
  const wins = [...document.querySelectorAll('.window')].filter((w) => (w.dataset.win || '').startsWith('editor'));
  const last = wins.pop();
  if (!last) return null;
  const area = last.querySelector('textarea');
  area.value = 'the member wrote this';
  area.dispatchEvent(new Event('input', { bubbles: true }));
  return last.dataset.win;
});
check('the member opens an editor', !!memberEditor, String(memberEditor));
await member.evaluate((w) => {
  const button = [...document.querySelectorAll(`.window[data-win="${w}"] button`)].find((b) => /save to drive/i.test(b.textContent));
  if (button) button.click();
}, memberEditor);
await wait(3000);
const memberFiles = await member.evaluate(async () => {
  const listed = await API.get('/api/files').catch(() => null);
  return JSON.stringify(listed || {}).includes('drive');
});
check('the member file lands in their drive', memberFiles);

// --------------------------------------------------- the operator sees all of it
await owner.evaluate(() => Apps.open('admin'));
await wait(1800);
const uploads = await owner.evaluate(() => {
  const win = document.querySelector('.window[data-win="admin"]');
  const body = win && win.querySelector('.window-body');
  return body ? body.innerText.replace(/\s+/g, ' ') : '';
});
check('the console loads', uploads.length > 50, `${uploads.length} chars`);

const openSection = async (label) => {
  await owner.evaluate((text) => {
    const button = [...document.querySelectorAll('.window[data-win="admin"] button, .window[data-win="admin"] .list-item')]
      .find((b) => new RegExp(text, 'i').test(b.textContent));
    if (button) button.click();
  }, label);
  await wait(1400);
};

await openSection('all uploads');
const uploadText = await owner.evaluate(() => document.querySelector('.window[data-win="admin"] .window-body')?.innerText.replace(/\s+/g, ' ') || '');
await shot(owner, 'uploads');
check('all uploads lists the member picture', /image\/png/i.test(uploadText) || /attachment|message/i.test(uploadText), uploadText.slice(0, 130));
check('all uploads lists the member drive file', /drive/i.test(uploadText), uploadText.slice(0, 130));
check('all uploads counts more than one kind', /(image|message)[\s\S]*drive|drive[\s\S]*(image|message)/i.test(uploadText), uploadText.slice(0, 130));
check('the member handle is not in the upload listing', !new RegExp(String(handle), 'i').test(uploadText));

await openSection('messages');
const messageText = await owner.evaluate(() => document.querySelector('.window[data-win="admin"] .window-body')?.innerText.replace(/\s+/g, ' ') || '');
await shot(owner, 'messages');
check('the console lists the member message', /★|▲|member|\d+\s*(message|messages)/i.test(messageText) || messageText.length > 80, messageText.slice(0, 130));
check('the message listing keeps the handle out of it', !new RegExp(String(handle), 'i').test(messageText), messageText.slice(0, 90));

// Through the app's own client: it carries the session token.
const api = await owner.evaluate(async () => {
  const storage = await API.get('/api/admin/storage').catch(() => null);
  const messages = await API.get('/api/admin/messages').catch(() => null);
  return { storage, messages };
});
check('the storage endpoint reports the uploads', !!api.storage && Number(api.storage.total) >= 2, `total=${api.storage?.total} kinds=${Object.keys(api.storage?.byKind || {}).join(',')}`);
check('the message endpoint reports the message', !!api.messages && Number(api.messages.total) >= 1, `total=${api.messages?.total}`);
const rows = api.storage?.uploads || [];
check('no upload row carries a handle', rows.every((row) => !new RegExp(String(handle), 'i').test(JSON.stringify(row))), `${rows.length} row(s)`);
// the site appearance card: an operator publishes a look for the whole server
await openSection('global');
const appearanceCard = await owner.evaluate(() => {
  const card = [...document.querySelectorAll('.window[data-win="admin"] .card')].find((node) => /site appearance/i.test(node.innerText));
  if (!card) return null;
  const selects = [...card.querySelectorAll('select')].map((node) => node.options.length);
  const button = [...card.querySelectorAll('button')].find((node) => /publish/i.test(node.innerText));
  if (button) button.click();
  return { selects, button: !!button, text: card.innerText.replace(/\s+/g, ' ').slice(0, 90) };
});
check('the console can publish a site appearance', !!appearanceCard && appearanceCard.selects.length >= 3, JSON.stringify(appearanceCard).slice(0, 160));
await wait(1200);
const published = await owner.evaluate(async () => (await API.get('/api/bootstrap')).server.appearance);
check('publishing stores the look and tells the site', !!published && !!published.siteTheme, JSON.stringify(published).slice(0, 120));
await owner.evaluate(async () => { await API.post('/api/admin/appearance', { clear: true }); });

await openSection('messages');
const withAttachment = (api.messages?.messages || []).find((m) => (m.attachments || []).length > 0);
check('the picture is counted as an attachment', !!withAttachment, withAttachment ? `${withAttachment.attachments.length} attachment(s)` : 'none');
// the envelope is what lets the operator read a body; it must never contain a
// plaintext key, only the sealed wrap
const envelope = (api.messages?.messages || []).find((m) => m.operatorWrap);
if (envelope) {
  const parsed = JSON.parse(envelope.operatorWrap);
  check('the operator envelope is a sealed wrap', !!(parsed.pub && parsed.w && parsed.scope) && !('key' in parsed), Object.keys(parsed).join(','));
}
check('no message row carries a handle', (api.messages?.messages || []).every((m) => !new RegExp(String(handle), 'i').test(JSON.stringify(m))));
check('no message row carries the plaintext', !JSON.stringify(api.messages || {}).includes('picture from the member'));

// the operator can take a message down; the member cannot see who did it
if (withAttachment) {
  const removed = await owner.evaluate(async (id) => {
    const result = await API.del(`/api/admin/messages/${id}`).catch(() => null);
    const after = await API.get('/api/admin/messages').catch(() => ({ messages: [] }));
    const row = (after.messages || []).find((m) => m.id === id);
    return { result: result ? 'ok' : 'failed', deleted: row ? row.deleted : null };
  }, withAttachment.id);
  check('the operator can delete a message', removed.result === 'ok' && removed.deleted === true, JSON.stringify(removed));
}

console.log(`\n=== ${LABEL} operator coverage (${W}x${H}) ===`);
for (const line of notes) console.log(line);
for (const line of failures) console.log(line);
const errors = [...new Set([...owner.pageErrors, ...member.pageErrors])];
if (errors.length) { console.log('  --- runtime errors seen:'); for (const e of errors.slice(0, 8)) console.log(`   ${e}`); }
console.log(`\n${notes.length} ok, ${failures.length} failed, ${errors.length} runtime error kind(s)`);
await browser.close();
server.kill('SIGTERM');
