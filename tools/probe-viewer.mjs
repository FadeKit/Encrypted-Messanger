// The viewer and the navigation around it: a picture sent in a direct message,
// a file opened from the drive, sound, maximise, the taskbar tab and the phone's
// back step.  Two accounts, one browser.
//
//   LD_LIBRARY_PATH=/tmp/ae/lib FONTCONFIG_PATH=/tmp/ae/fonts \
//   AE_PORT=3614 AE_LABEL=viewer AE_W=1440 AE_H=900 node tools/probe-viewer.mjs
//
// AE_MOBILE=1 runs the phone pass only.  Spawns its own server on AE_PORT with a
// fresh data directory and removes it on the way out.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = Number(process.env.AE_PORT || 3614);
const LABEL = process.env.AE_LABEL || 'viewer';
const W = Number(process.env.AE_W || 1440);
const H = Number(process.env.AE_H || 900);
const MOBILE_ONLY = process.env.AE_MOBILE === '1';
const SHOTS = process.env.AE_SHOTS || '/tmp/ae/shots';
fs.mkdirSync(SHOTS, { recursive: true });
const DATA = `/tmp/ae/vw-${LABEL}`;

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
  executablePath: '/tmp/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: W, height: H, isMobile: W < 800, hasTouch: W < 800 },
});

const failures = [];
const notes = [];
const check = (name, ok, detail = '') => {
  if (ok) notes.push(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else failures.push(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// a throw half way through is still worth the evidence gathered so far
process.on('exit', () => {
  if (process.__reported) return;
  process.__reported = true;
  for (const line of notes) console.log(line);
  for (const line of failures) console.log(line);
});
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${LABEL}-${name}.png` });

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
    const ready = await page.evaluate(() => !!document.querySelector('#modal-layer.open') || !!(window.State && State.user));
    if (ready) break;
    if (Date.now() > deadline) throw new Error(`register(${handle}) stalled`);
    await wait(400);
  }
  await wait(900);
  await page.evaluate(() => document.querySelector('#modal-layer input[type=checkbox]')?.click());
  await wait(150);
  await page.evaluate(() => [...document.querySelectorAll('#modal-layer button')].find((b) => /continue to ae secure/i.test(b.textContent))?.click());
  await wait(1500);
};

const alive = async (page) => {
  try {
    return await Promise.race([
      page.evaluate(() => Date.now()),
      new Promise((_, reject) => setTimeout(() => reject(new Error('renderer did not answer')), 6000)),
    ]);
  } catch { return null; }
};

// ------------------------------------------------------------------ desktop
if (!MOBILE_ONLY) {
  console.log(`\n=== ${LABEL} viewer and navigation (${W}x${H}) ===`);
  const pageA = await openPage();
  await register(pageA, 'operator');
  const pageB = await openPage();
  await register(pageB, 'fadehelper');

  // a real PNG, made in the page so the test needs no fixture on disk
  const makePng = () => `(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 240; canvas.height = 160;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#111'; ctx.fillRect(0, 0, 240, 160);
    ctx.fillStyle = '#eee'; ctx.font = '28px monospace'; ctx.fillText('AE SECURE', 18, 88);
    const blob = await new Promise((done) => canvas.toBlob(done, 'image/png'));
    window.__png = blob;
    return blob.size;
  })()`;

  // ---- a direct message with a picture in it
  await pageA.evaluate(() => Apps.open('messages'));
  await wait(1200);
  await pageA.evaluate(() => [...document.querySelectorAll('.window[data-win^="messages"] button')].find((b) => /new direct message/i.test(b.textContent))?.click());
  await wait(1000);
  await pageA.evaluate(() => [...document.querySelectorAll('#modal-layer .list-item')].find((r) => /fadehelper/i.test(r.innerText))?.click());
  await wait(400);
  await pageA.evaluate(() => [...document.querySelectorAll('#modal-layer button')].find((b) => /start chatting/i.test(b.textContent))?.click());
  await wait(2500);
  const pngSize = await pageA.evaluate(makePng());
  check('a png fixture can be made in the page', pngSize > 200, `${pngSize} bytes`);

  const queued = await pageA.evaluate(() => {
    const input = document.querySelector('.window[data-win^="messages"] input[type=file][multiple]');
    if (!input || !window.__png) return 'no input';
    const transfer = new DataTransfer();
    transfer.items.add(new File([window.__png], 'operator-snap.png', { type: 'image/png' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return 'queued';
  });
  check('the composer accepts an attachment', queued === 'queued', queued);
  for (let i = 0; i < 40; i += 1) {
    if (await pageA.evaluate(() => document.querySelectorAll('.window[data-win^="messages"] .chip-file').length > 0)) break;
    await wait(400);
  }
  const chip = await pageA.evaluate(() => (document.querySelector('.window[data-win^="messages"] .chip-file') || {}).innerText || '');
  check('the attachment is sealed and listed before sending', /operator-snap/.test(chip), chip.replace(/\s+/g, ' ').slice(0, 60));

  await pageA.evaluate(() => {
    const input = document.getElementById('composer-input');
    input.value = 'a picture for the viewer';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.window[data-win^="messages"] button')].find((b) => b.innerText.trim().toLowerCase() === 'send')?.click();
  });
  for (let i = 0; i < 40; i += 1) {
    if (await pageA.evaluate(() => !!document.querySelector('.message-list img.attachment-media'))) break;
    await wait(400);
  }
  const bubble = await pageA.evaluate(() => {
    const img = document.querySelector('.message-list img.attachment-media');
    return img ? { src: img.src.slice(0, 12), w: img.naturalWidth, h: img.naturalHeight } : null;
  });
  check('the picture draws in the bubble', !!bubble && bubble.w > 0, JSON.stringify(bubble));
  await shot(pageA, 'dm-bubble');

  await pageA.evaluate(() => document.querySelector('.message-list img.attachment-media').click());
  await wait(700);
  const viewer = await pageA.evaluate(() => {
    const win = document.querySelector('.window[data-win="viewer"]');
    if (!win) return null;
    const image = win.querySelector('img.viewer-image');
    return {
      title: win.querySelector('.window-title')?.innerText.trim() || '',
      image: !!image, w: image ? image.naturalWidth : 0,
      strip: win.querySelectorAll('.viewer-thumb').length,
      toolbar: win.querySelectorAll('.toolbar button').length,
      immersive: win.classList.contains('immersive'),
    };
  });
  check('a tap opens the viewer as a real window', !!viewer && viewer.image === true, JSON.stringify(viewer));
  check('the picture is decoded in the viewer', !!viewer && viewer.w === 240, `natural width ${viewer && viewer.w}`);
  check('the viewer names the file in its title bar', !!viewer && /operator-snap/i.test(viewer.title), viewer ? viewer.title.replace(/\s+/g, ' ') : '');

  // ---- maximise, minimise, and the tab that brings it back
  await pageA.evaluate(() => document.querySelector('.window[data-win="viewer"] .caption-btn[title="Maximize"]').click());
  await wait(400);
  const maxed = await pageA.evaluate(() => {
    const win = document.querySelector('.window[data-win="viewer"]');
    const record = Windows.get('viewer');
    return { state: !!record.maximized, w: Math.round(win.getBoundingClientRect().width), viewport: window.innerWidth };
  });
  check('the viewer maximises like any window', maxed.state === true && maxed.w > maxed.viewport - 24, JSON.stringify(maxed));
  await pageA.evaluate(() => document.querySelector('.window[data-win="viewer"] .caption-btn[title="Maximize"]').click());
  await wait(300);

  await pageA.evaluate(() => document.querySelector('.window[data-win="viewer"] .caption-btn[title="Minimize"]').click());
  await wait(500);
  const tabled = await pageA.evaluate(() => ({
    hidden: !!Windows.get('viewer').minimized,
    tabs: [...document.querySelectorAll('#taskbar-stack [data-win]')].map((n) => n.dataset.win),
  }));
  check('minimising leaves a tab on the taskbar', tabled.hidden && tabled.tabs.includes('viewer'), JSON.stringify(tabled));
  await shot(pageA, 'viewer-tab');
  await pageA.evaluate(() => {
    const tab = [...document.querySelectorAll('#taskbar-stack [data-win]')].find((n) => n.dataset.win === 'viewer');
    if (tab) tab.click();
  });
  await wait(600);
  const back = await pageA.evaluate(() => !!document.querySelector('.window[data-win="viewer"]'));
  check('the tab brings the window back', back === true);

  // ---- the switcher plate
  const badge = await pageA.evaluate(() => {
    const plate = document.querySelector('#tb-apps');
    return plate ? { text: plate.innerText.trim(), badge: !!plate.querySelector('.tb-badge'), running: plate.classList.contains('running') } : null;
  });
  check('the taskbar shows a switcher plate with a count', !!badge && badge.badge, JSON.stringify(badge));
  await pageA.evaluate(() => document.querySelector('#tb-apps').click());
  await wait(500);
  const sheet = await pageA.evaluate(() => {
    const node = document.querySelector('#app-sheet');
    return node ? { open: node.classList.contains('open'), text: node.innerText.replace(/\s+/g, ' ').slice(0, 200), rows: node.querySelectorAll('.sheet-row').length } : null;
  });
  check('the switcher sheet opens and lists the open window', !!sheet && sheet.open && sheet.rows >= 1 && /operator-snap/i.test(sheet.text), JSON.stringify(sheet).slice(0, 160));
  await shot(pageA, 'app-sheet');
  await pageA.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  await wait(300);

  // ---- the other side opens the same picture
  await pageB.evaluate(() => Apps.open('messages'));
  await wait(2000);
  await pageB.evaluate(() => ConversationClient.refresh().catch(() => {}));
  await wait(1500);
  await pageB.evaluate(() => {
    const row = document.querySelector('.window[data-win^="messages"] .list-item');
    if (row) row.click();
  });
  for (let i = 0; i < 30; i += 1) {
    if (await pageB.evaluate(() => !!document.querySelector('.message-list img.attachment-media'))) break;
    await wait(400);
  }
  const other = await pageB.evaluate(() => {
    const img = document.querySelector('.message-list img.attachment-media');
    return img ? { w: img.naturalWidth } : null;
  });
  check('the member can read the picture too', !!other && other.w > 0, JSON.stringify(other));
  await pageB.evaluate(() => document.querySelector('.message-list img.attachment-media')?.click());
  await wait(800);
  check('the member can open it in the viewer as well',
    await pageB.evaluate(() => !!(document.querySelector('.window[data-win="viewer"] img.viewer-image') || {}).complete),
    await pageB.evaluate(() => (document.querySelector('.window[data-win="viewer"]') || { innerText: 'no window' }).innerText.slice(0, 60).replace(/\s+/g, ' ')));

  // ---- a file from the drive, and the arrow keys through the folder
  const stored = await pageA.evaluate(async () => {
    const blob = new Blob(['AE Secure encrypted note\nsecond line\n'], { type: 'text/plain' });
    const meta = { type: 'text/plain', editor: true };
    const result = await API.uploadEncrypted({
      kind: 'drive', blob, meta,
      wrapFileKey: async (raw) => {
        // the name travels sealed with the file key, as the editor writes it
        meta.nameWrapped = await AE.sealJson(raw, { name: 'viewer-note.txt' });
        return AE.wrapKey(State.masterKey(), raw);
      },
      onProgress: () => {},
    });
    return result.fileId;
  });
  check('a file can be put in the drive', typeof stored === 'string' && stored.length > 4, String(stored).slice(0, 12));
  await pageA.evaluate(() => { Windows.close('viewer'); Apps.open('drive'); });
  await wait(2200);
  const cells = await pageA.evaluate(() => {
    const cell = document.querySelector('.drive-cell');
    if (cell) cell.click();
    return document.querySelectorAll('.drive-cell').length;
  });
  check('the drive lists the file', cells >= 1, `${cells} cell(s)`);
  await wait(900);
  const plate = await pageA.evaluate(() => {
    const win = document.querySelector('.window[data-win="viewer"]');
    if (!win) return null;
    return {
      text: win.innerText.replace(/\s+/g, ' ').slice(0, 160),
      loading: !!win.querySelector('.viewer-frame.loading'),
      file: !!win.querySelector('.viewer-frame.file'),
    };
  });
  check('a drive cell opens the viewer straight away', !!plate, plate ? plate.text.slice(0, 70) : 'no window');
  for (let i = 0; i < 30; i += 1) {
    const done = await pageA.evaluate(() => !!document.querySelector('.window[data-win="viewer"] .viewer-file'));
    if (done) break;
    await wait(400);
  }
  const decrypted = await pageA.evaluate(() => {
    const win = document.querySelector('.window[data-win="viewer"]');
    return {
      text: win ? win.innerText.replace(/\s+/g, ' ').slice(0, 220) : '',
      actions: win ? [...win.querySelectorAll('.viewer-file button')].map((b) => b.innerText.trim()) : [],
    };
  });
  check('the file plate offers the actions', /download/i.test(decrypted.text) || decrypted.actions.some((a) => /download/i.test(a)), JSON.stringify(decrypted).slice(0, 200));
  check('the sealed name is read back', /viewer-note\.txt/i.test(decrypted.text), decrypted.text.slice(0, 90));
  await shot(pageA, 'drive-viewer');

  // ---- sound: a synthesised wav and, when the browser will record, a video
  const audio = await pageA.evaluate(async () => {
    const sampleRate = 8000;
    const seconds = 1;
    const frames = sampleRate * seconds;
    const buffer = new ArrayBuffer(44 + frames * 2);
    const view = new DataView(buffer);
    const write = (offset, text) => { for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)); };
    write(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); write(8, 'WAVE'); write(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data');
    view.setUint32(40, frames * 2, true);
    for (let i = 0; i < frames; i += 1) view.setInt16(44 + i * 2, Math.sin((i / sampleRate) * 2 * Math.PI * 440) * 8000, true);
    const url = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
    Viewer.open([{ url, name: 'tone.wav', mime: 'audio/wav', size: buffer.byteLength }]);
    await new Promise((r) => setTimeout(r, 700));
    const node = document.querySelector('.window[data-win="viewer"] audio.viewer-audio');
    return { audio: !!node, volume: node ? node.volume : 0, controls: node ? node.controls : false, duration: node ? node.duration : 0 };
  });
  check('audio opens with a transport and its own sound', audio.audio && audio.volume === 1 && audio.controls, JSON.stringify(audio));

  const video = await pageA.evaluate(async () => {
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return { skipped: 'no recorder' };
    const canvas = document.createElement('canvas');
    canvas.width = 160; canvas.height = 120;
    const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(12);
    const chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const stopped = new Promise((r) => { recorder.onstop = r; });
    recorder.start();
    for (let i = 0; i < 12; i += 1) {
      ctx.fillStyle = i % 2 ? '#eee' : '#111';
      ctx.fillRect(0, 0, 160, 120);
      await new Promise((r) => setTimeout(r, 60));
    }
    recorder.stop();
    await stopped;
    const blob = new Blob(chunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    Viewer.open([{ url, name: 'clip.webm', mime: 'video/webm', size: blob.size }]);
    await new Promise((r) => setTimeout(r, 1200));
    const node = document.querySelector('.window[data-win="viewer"] video.viewer-video');
    return { bytes: blob.size, video: !!node, controls: node ? node.controls : false, muted: node ? node.muted : null, cover: !!document.querySelector('.viewer-play') };
  });
  check('video opens as a player with sound', video.skipped ? true : (video.video === true && video.controls === true && video.muted === false), JSON.stringify(video));
  if (video.skipped) notes.push(`  note  video fixture skipped — ${video.skipped}`);
  await shot(pageA, 'viewer-audio-video');

  pickErrors(pageA, 'owner');
  pickErrors(pageB, 'member');
}

// ------------------------------------------------------------------- phone
if (MOBILE_ONLY) {
  console.log(`\n=== ${LABEL} viewer on a phone (${W}x${H}) ===`);
  const page = await openPage();
  await register(page, 'handheld');
  await page.evaluate(async () => {
    const blob = new Blob(['hello from the drive\n'], { type: 'text/plain' });
    await API.uploadEncrypted({
      kind: 'drive', blob, meta: { type: 'text/plain' },
      wrapFileKey: (raw) => AE.wrapKey(State.masterKey(), raw), onProgress: () => {},
    });
  });
  await page.evaluate(() => Apps.open('drive'));
  await wait(2000);
  await page.evaluate(() => document.querySelector('.drive-cell')?.click());
  await wait(1000);
  const full = await page.evaluate(() => {
    const win = document.querySelector('.window[data-win="viewer"]');
    if (!win) return null;
    const rect = win.getBoundingClientRect();
    const back = win.querySelector('.window-back');
    return {
      w: Math.round(rect.width), h: Math.round(rect.height),
      backVisible: back ? getComputedStyle(back).display !== 'none' : false,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
    };
  });
  check('the viewer covers the phone screen', !!full && full.w >= W - 4, JSON.stringify(full));
  check('the back control is on the title bar', !!full && full.backVisible === true, JSON.stringify(full));
  await shot(page, 'phone-viewer');
  await page.evaluate(() => document.querySelector('.window[data-win="viewer"] .window-back').click());
  await wait(600);
  const stepped = await page.evaluate(() => ({
    viewer: Windows.get('viewer').minimized,
    drive: Windows.get('drive') ? Windows.get('drive').minimized : null,
    visible: [...document.querySelectorAll('.window')].filter((w) => !w.classList.contains('minimized')).map((w) => w.dataset.win),
  }));
  check('back leaves the viewer for what was underneath',
    stepped.viewer === true && stepped.drive === false, JSON.stringify(stepped));

  // and again by thumb: a swipe in from the left edge
  await page.evaluate(() => document.querySelector('.drive-cell')?.click());
  await wait(900);
  const swiped = await page.evaluate(async () => {
    const target = document.querySelector('.window[data-win="viewer"]');
    if (!target) return { skipped: 'no window' };
    const fire = (type, x, y) => {
      const touch = { identifier: 1, clientX: x, clientY: y, pageX: x, pageY: y, target, screenX: x, screenY: y };
      target.dispatchEvent(new TouchEvent(type, {
        bubbles: true, cancelable: true,
        touches: type === 'touchend' ? [] : [new Touch(touch)],
        changedTouches: [new Touch(touch)],
        targetTouches: type === 'touchend' ? [] : [new Touch(touch)],
      }));
    };
    fire('touchstart', 6, 400);
    for (let x = 6; x <= 140; x += 18) { fire('touchmove', x, 402); await new Promise((r) => setTimeout(r, 16)); }
    fire('touchend', 140, 402);
    await new Promise((r) => setTimeout(r, 500));
    return { gone: Windows.get('viewer').minimized };
  });
  check('a swipe from the edge is the same back step', swiped.gone === true, JSON.stringify(swiped));

  await page.evaluate(() => document.querySelector('#tb-apps').click());
  await wait(500);
  const sheet = await page.evaluate(() => {
    const node = document.querySelector('#app-sheet');
    return node ? { open: node.classList.contains('open'), text: node.innerText.replace(/\s+/g, ' ').slice(0, 160) } : null;
  });
  check('the switcher plate works on the phone', !!sheet && sheet.open, JSON.stringify(sheet).slice(0, 140));
  await shot(page, 'phone-sheet');
  pickErrors(page, 'phone');
}

function pickErrors(page, who) {
  const bad = page.pageErrors.filter((line) => !/favicon|Download the React/i.test(line));
  check(`${who}: no runtime errors`, bad.length === 0, bad.slice(0, 3).join(' | '));
}

await browser.close();
stop();
process.__reported = true;
for (const line of notes) console.log(line);
for (const line of failures) console.log(line);
console.log(`\n${notes.length} ok, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
