// The operator's side of the same data: a member sends a picture and stores a
// file, and the operator opens both from the console — the message body through
// the channel envelope, the upload through the file envelope.
//
//   LD_LIBRARY_PATH=/tmp/ae/lib FONTCONFIG_PATH=/tmp/ae/fonts \
//   AE_PORT=3617 AE_LABEL=op AE_W=1440 AE_H=900 node tools/probe-operator.mjs
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = Number(process.env.AE_PORT || 3617);
const LABEL = process.env.AE_LABEL || 'op';
const W = Number(process.env.AE_W || 1440);
const H = Number(process.env.AE_H || 900);
const SHOTS = process.env.AE_SHOTS || '/tmp/ae/shots';
fs.mkdirSync(SHOTS, { recursive: true });
const DATA = `/tmp/ae/op-${LABEL}`;

const busy = await new Promise((resolve) => {
  const socket = connect({ port: PORT, host: '127.0.0.1' });
  socket.on('connect', () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(false));
  socket.setTimeout(600, () => { socket.destroy(); resolve(false); });
});
if (busy) { console.error(`port ${PORT} is already serving — pick another`); process.exit(2); }

fs.rmSync(DATA, { recursive: true, force: true });
const server = spawn('node', ['server/index.js'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), AE_DATA_DIR: DATA }, stdio: 'ignore',
});
const stop = () => { try { server.kill('SIGTERM'); } catch { /* ignore */ } };
process.on('exit', stop);
process.on('uncaughtException', (error) => { console.error(error); stop(); process.exit(1); });
process.on('unhandledRejection', (error) => { console.error(error); stop(); process.exit(1); });
await new Promise((r) => setTimeout(r, 1300));

const browser = await puppeteer.launch({
  executablePath: '/tmp/chromium', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  defaultViewport: { width: W, height: H },
});
const failures = [];
const notes = [];
const check = (name, ok, detail = '') => {
  if (ok) notes.push(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else failures.push(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
process.on('exit', () => {
  if (process.__reported) return;
  process.__reported = true;
  for (const line of notes) console.log(line);
  for (const line of failures) console.log(line);
});

console.log(`\n=== ${LABEL} operator visibility (${W}x${H}) ===`);

const openPage = async () => {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.split('\n')[0]));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 140)); });
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
    if (await page.evaluate(() => !!document.querySelector('#modal-layer.open') || !!(window.State && State.user))) break;
    if (Date.now() > deadline) throw new Error(`register(${handle}) stalled`);
    await wait(400);
  }
  await wait(900);
  await page.evaluate(() => document.querySelector('#modal-layer input[type=checkbox]')?.click());
  await wait(150);
  await page.evaluate(() => [...document.querySelectorAll('#modal-layer button')].find((b) => /continue to ae secure/i.test(b.textContent))?.click());
  await wait(1500);
};

const adminSection = async (page, label) => {
  await page.evaluate((text) => {
    const button = [...document.querySelectorAll('.admin-nav button')].find((b) => b.innerText.trim().toLowerCase().includes(text.toLowerCase()));
    if (button) button.click();
  }, label);
  await wait(1800);
};

const owner = await openPage();
await register(owner, 'operator');
const member = await openPage();
await register(member, 'fadehelper');

// ---- the operator opens a direct channel and says hello
await owner.evaluate(() => Apps.open('messages'));
await wait(1200);
await owner.evaluate(() => [...document.querySelectorAll('.window[data-win^="messages"] button')].find((b) => /new direct message/i.test(b.textContent))?.click());
await wait(900);
await owner.evaluate(() => [...document.querySelectorAll('#modal-layer .list-item')].find((r) => /fadehelper/i.test(r.innerText))?.click());
await wait(400);
await owner.evaluate(() => [...document.querySelectorAll('#modal-layer button')].find((b) => /start chatting/i.test(b.textContent))?.click());
await wait(2500);
await owner.evaluate(() => {
  const input = document.getElementById('composer-input');
  input.value = 'operator here';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  [...document.querySelectorAll('.window[data-win^="messages"] button')].find((b) => b.innerText.trim().toLowerCase() === 'send')?.click();
});
await wait(1500);

// ---- the member opens the channel and sends a picture: the repair path runs,
// then the upload carries its own envelope
await member.evaluate(() => Apps.open('messages'));
await wait(2200);
await member.evaluate(() => ConversationClient.refresh().catch(() => {}));
await wait(1500);
await member.evaluate(() => {
  const row = document.querySelector('.window[data-win^="messages"] .list-item');
  if (row) row.click();
});
await wait(2200);
const envelopePosted = await member.evaluate(async () => {
  const conversation = State.get('conversations')[0];
  return { id: conversation.id, stored: !!conversation.operatorWrap };
});
check('the member’s device seals the channel key for the operator', envelopePosted.stored === true, JSON.stringify(envelopePosted));

await member.evaluate(() => {
  const canvas = document.createElement('canvas');
  canvas.width = 200; canvas.height = 140;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#101010'; ctx.fillRect(0, 0, 200, 140);
  ctx.fillStyle = '#f2f2f0'; ctx.font = '22px monospace'; ctx.fillText('from a member', 12, 78);
  return new Promise((done) => canvas.toBlob((blob) => { window.__png = blob; done(blob.size); }, 'image/png'));
});
await member.evaluate(() => {
  const input = document.querySelector('.window[data-win^="messages"] input[type=file][multiple]');
  const transfer = new DataTransfer();
  transfer.items.add(new File([window.__png], 'member-snap.png', { type: 'image/png' }));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
});
for (let i = 0; i < 40; i += 1) {
  if (await member.evaluate(() => document.querySelectorAll('.chip-file').length > 0)) break;
  await wait(400);
}
await member.evaluate(() => {
  const input = document.getElementById('composer-input');
  input.value = 'this is what the member wrote';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  [...document.querySelectorAll('.window[data-win^="messages"] button')].find((b) => b.innerText.trim().toLowerCase() === 'send')?.click();
});
for (let i = 0; i < 40; i += 1) {
  if (await member.evaluate(() => !!document.querySelector('.message-list img.attachment-media'))) break;
  await wait(400);
}
check('the member’s picture posts to the channel',
  await member.evaluate(() => !!document.querySelector('.message-list img.attachment-media')));

// ---- and a file of their own in the drive
const driveFile = await member.evaluate(async () => {
  const blob = new Blob(['member drive note\n'], { type: 'text/plain' });
  const meta = { type: 'text/plain', editor: true };
  const result = await API.uploadEncrypted({
    kind: 'drive', blob, meta,
    wrapFileKey: async (raw) => {
      meta.nameWrapped = await AE.sealJson(raw, { name: 'member-note.txt' });
      return AE.wrapKey(State.masterKey(), raw);
    },
    onProgress: () => {},
  });
  return result.fileId;
});
check('the member stores a file of their own', typeof driveFile === 'string', String(driveFile).slice(0, 12));

// ---- the operator console
await owner.evaluate(() => Apps.open('admin'));
await wait(2500);
await adminSection(owner, 'messages');
const feed = await owner.evaluate(() => {
  const rows = [...document.querySelectorAll('.admin-main tbody tr')];
  return {
    rows: rows.length,
    readable: rows.filter((row) => /read/i.test(row.innerText)).length,
    sample: rows.slice(0, 3).map((row) => row.innerText.replace(/\s+/g, ' ').slice(0, 90)),
  };
});
check('the console lists the channel traffic', feed.rows >= 2, JSON.stringify(feed).slice(0, 200));
check('the rows carry a read action', feed.readable >= 2, `${feed.readable} of ${feed.rows}`);

const openedMessage = await owner.evaluate(async () => {
  const rows = [...document.querySelectorAll('.admin-main tbody tr')];
  // the member's message is the one with the newest text and an attachment
  const row = rows.find((r) => /read/i.test(r.innerText) && !/^0/.test(r.innerText.split('\t').slice(-3, -2)[0] || ''));
  const button = row ? [...row.querySelectorAll('button')].find((b) => /read/i.test(b.innerText)) : null;
  if (!button) return { clicked: false };
  button.click();
  await new Promise((r) => setTimeout(r, 1800));
  const dialog = document.querySelector('#modal-layer.open');
  return {
    clicked: true,
    text: dialog ? dialog.innerText.replace(/\s+/g, ' ').slice(0, 220) : '',
    attachments: dialog ? dialog.querySelectorAll('button').length : 0,
  };
});
check('the operator reads the member’s message', openedMessage.clicked && /member wrote/i.test(openedMessage.text), JSON.stringify(openedMessage).slice(0, 200));

// the attachment in that message opens in the viewer
const attachmentViewer = await owner.evaluate(async () => {
  const dialog = document.querySelector('#modal-layer.open');
  const button = dialog ? [...dialog.querySelectorAll('button')].find((b) => /open attachment/i.test(b.innerText)) : null;
  if (!button) return { clicked: false };
  button.click();
  for (let i = 0; i < 40; i += 1) {
    const image = document.querySelector('.window[data-win="viewer"] img.viewer-image');
    if (image && image.naturalWidth) return { clicked: true, width: image.naturalWidth };
    await new Promise((r) => setTimeout(r, 400));
  }
  return { clicked: true, width: 0, text: (document.querySelector('.window[data-win="viewer"]') || {}).innerText?.slice(0, 120) || '' };
});
check('the operator opens the picture from that message', attachmentViewer.clicked && attachmentViewer.width === 200, JSON.stringify(attachmentViewer));
await owner.screenshot({ path: `${SHOTS}/${LABEL}-admin-message.png` });

// and the member's drive upload from the uploads table
await owner.evaluate(() => { if (window.Viewer) Windows.close('viewer'); });
await wait(400);
await owner.evaluate(() => document.querySelector('#modal-layer .modal')?.remove());
await adminSection(owner, 'uploads');
const upload = await owner.evaluate(async () => {
  const rows = [...document.querySelectorAll('.admin-main tbody tr')];
  const row = rows.find((r) => /drive/i.test(r.innerText) && /open/i.test(r.innerText));
  if (!row) return { found: false, rows: rows.length, sample: rows.slice(0, 2).map((r) => r.innerText.replace(/\s+/g, ' ').slice(0, 80)) };
  const sealed = /sealed/i.test(row.innerText);
  const button = [...row.querySelectorAll('button')].find((b) => /open/i.test(b.innerText));
  button.click();
  const deadline = Date.now() + 25000;
  for (;;) {
    const text = (document.querySelector('.window[data-win="viewer"]') || {}).innerText || '';
    if (/member-note\.txt/i.test(text)) return { found: true, sealed, decrypted: true, text: text.replace(/\s+/g, ' ').slice(0, 140) };
    if (Date.now() > deadline) return { found: true, sealed, decrypted: false, text: text.replace(/\s+/g, ' ').slice(0, 140) };
    await new Promise((r) => setTimeout(r, 500));
  }
});
check('the uploads table finds the member’s drive file', upload.found === true, JSON.stringify(upload).slice(0, 200));
check('the operator opens it and reads the sealed name', upload.decrypted === true, JSON.stringify(upload).slice(0, 200));
await owner.screenshot({ path: `${SHOTS}/${LABEL}-admin-upload.png` });

// a member's own files are still theirs: no envelope, no read
const memberView = await member.evaluate(async () => {
  const rows = await API.get('/api/auth/me').catch(() => null);
  return !!rows;
});
check('the member account still works normally', memberView === true);

const bad = [...owner.pageErrors, ...member.pageErrors].filter((line) => !/favicon/i.test(line));
check('no runtime errors on either side', bad.length === 0, bad.slice(0, 3).join(' | '));

await browser.close();
stop();
process.__reported = true;
for (const line of notes) console.log(line);
for (const line of failures) console.log(line);
console.log(`\n${notes.length} ok, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
