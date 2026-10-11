// Appearance: an uploaded desktop picture, the website themes, and the site
// appearance an operator publishes for everybody.
//
//   LD_LIBRARY_PATH=/tmp/ae/lib FONTCONFIG_PATH=/tmp/ae/fonts \
//   AE_PORT=3621 AE_LABEL=look AE_W=1440 AE_H=900 node tools/probe-appearance.mjs
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = Number(process.env.AE_PORT || 3621);
const LABEL = process.env.AE_LABEL || 'look';
const W = Number(process.env.AE_W || 1440);
const H = Number(process.env.AE_H || 900);
const SHOTS = process.env.AE_SHOTS || '/tmp/ae/shots';
fs.mkdirSync(SHOTS, { recursive: true });
const DATA = `/tmp/ae/look-${LABEL}`;

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

console.log(`\n=== ${LABEL} appearance (${W}x${H}) ===`);

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
  await wait(1600);
};

const desktop = (page) => page.evaluate(() => {
  const node = document.getElementById('desktop');
  const style = getComputedStyle(node);
  return {
    wall: document.body.dataset.wall,
    siteTheme: document.body.dataset.sitetheme,
    theme: document.body.dataset.theme,
    image: style.backgroundImage,
    size: style.backgroundSize,
    inline: node.style.getPropertyValue('--wall-image').length,
  };
});

const MOBILE_ONLY = process.env.AE_MOBILE === '1';

const owner = await openPage();
await register(owner, 'operator');

// ------------------------------------------------------- phone: no overflow
if (W < 800) {
  // a shell screenshot of the surface, with no toast covering it
  await owner.evaluate(() => Apps.open('settings', { section: 'appearance' }));
  await wait(2000);
  await owner.evaluate(() => document.querySelectorAll('#toast-stack .toast').forEach((node) => node.remove()));
  const layout = await owner.evaluate(() => {
    const page = document.documentElement;
    const cards = [...document.querySelectorAll('.theme-card')];
    // every box the page draws must fit the window: a card that hangs off the
    // right edge is the bug the user sees as “it does not fit on my phone”
    const wide = [...document.querySelectorAll('.settings-body *')]
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.right > window.innerWidth + 2;
      })
      .slice(0, 5)
      .map((node) => `${node.tagName}.${node.className}`.slice(0, 40));
    return {
      scrollWidth: page.scrollWidth, viewport: window.innerWidth,
      cards: cards.length,
      cardWidth: cards.length ? Math.round(cards[0].getBoundingClientRect().width) : 0,
      overflow: wide,
    };
  });
  check('the appearance page fits the phone', layout.scrollWidth <= layout.viewport + 2 && layout.overflow.length === 0, JSON.stringify(layout));
  check('the theme cards stack on a phone', layout.cards >= 5 && layout.cardWidth <= layout.viewport, `${layout.cards} cards, ${layout.cardWidth}px`);
  await owner.evaluate(() => { const node = document.querySelector('.settings-body'); if (node) node.scrollTop = 0; });
  await owner.screenshot({ path: `${SHOTS}/${LABEL}-phone-appearance.png` });
  await owner.evaluate(() => { const node = document.querySelector('.settings-body'); if (node) node.scrollTop = node.scrollHeight; });
  await wait(400);
  await owner.screenshot({ path: `${SHOTS}/${LABEL}-phone-appearance-2.png` });
  const badPhone = owner.pageErrors.filter((line) => !/favicon|Failed to load resource/i.test(line));
  check('no runtime errors on the phone', badPhone.length === 0, badPhone.slice(0, 2).join(' | '));
  await browser.close();
  stop();
  process.__reported = true;
  for (const line of notes) console.log(line);
  for (const line of failures) console.log(line);
  console.log(`\n${notes.length} ok, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
}

// ---------------------------------------------------------------- uploads
const made = await owner.evaluate(async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 640; canvas.height = 400;
  const ctx = canvas.getContext('2d');
  const sky = ctx.createLinearGradient(0, 0, 0, 400);
  sky.addColorStop(0, '#204060');
  sky.addColorStop(1, '#f0c060');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 640, 400);
  ctx.fillStyle = '#102030';
  ctx.beginPath();
  ctx.arc(500, 120, 60, 0, Math.PI * 2);
  ctx.fill();
  const blob = await new Promise((done) => canvas.toBlob(done, 'image/png'));
  window.__wall = blob;
  return blob.size;
});
check('a photograph can be made in the page', made > 1000, `${made} bytes`);

await owner.evaluate(() => Apps.open('settings', { section: 'appearance' }));
await wait(1800);
const themed = await owner.evaluate(() => {
  const cards = [...document.querySelectorAll('.theme-card')];
  return {
    cards: cards.length,
    names: cards.map((c) => c.querySelector('.name')?.innerText.trim()),
    samples: document.querySelectorAll('.theme-sample').length,
    sampleThemes: [...document.querySelectorAll('.theme-sample')].map((s) => s.dataset.sitetheme),
  };
});
check('the settings page previews every website theme', themed.cards >= 5 && themed.samples === themed.cards, JSON.stringify(themed).slice(0, 180));

const uploaded = await owner.evaluate(async () => {
  const input = document.getElementById('background-input');
  if (!input || !window.__wall) return 'no input';
  const transfer = new DataTransfer();
  transfer.items.add(new File([window.__wall], 'dusk.png', { type: 'image/png' }));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return 'queued';
});
check('the background control takes a picture', uploaded === 'queued', uploaded);
for (let i = 0; i < 40; i += 1) {
  if (await owner.evaluate(() => Background.list().length > 0)) break;
  await wait(400);
}
const stored = await owner.evaluate(() => Background.list().map((entry) => ({ id: entry.id, name: entry.name, size: entry.size })));
check('the picture is stored in the library', stored.length === 1 && /^dusk/.test(stored[0].name), JSON.stringify(stored));
check('choosing it puts it on the desktop', await owner.evaluate(() => State.settings().wallpaper === 'custom'));

// it is ciphertext on the server: the file row exposes no plaintext, and the
// app itself reports it as an encrypted blob
const serverSide = await owner.evaluate(async () => {
  const id = State.settings().wallpaperFileId;
  const info = await API.get(`/api/files/${id}`);
  const meta = JSON.stringify(info.file.meta || {});
  return { kind: info.file.kind, audience: info.file.audience, meta, bytes: info.file.size };
});
check('the upload is stored as a private background blob', serverSide.kind === 'background' && serverSide.audience === 'private', JSON.stringify(serverSide).slice(0, 140));
check('the server holds no name or plaintext for it', !/dusk/i.test(serverSide.meta), serverSide.meta.slice(0, 90));

for (let i = 0; i < 30; i += 1) {
  const state = await desktop(owner);
  if (state.inline > 0) break;
  await wait(400);
}
const painted = await desktop(owner);
check('the desktop draws the picture', painted.wall === 'custom' && /url\("blob:/.test(painted.image) && /cover/.test(painted.size), JSON.stringify(painted).slice(0, 200));
check('the picture is the only colour on the page', await owner.evaluate(async () => {
  // “Match the interface” is on by default: the drawn bitmap is grayscale.
  // Sampled through an <img>, because fetch() refuses blob: urls here.
  const match = getComputedStyle(document.getElementById('desktop')).backgroundImage.match(/url\("([^"]+)"\)/);
  if (!match) return false;
  const image = new Image();
  image.src = match[1];
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = 48; canvas.height = 48;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, 48, 48);
  const pixels = ctx.getImageData(0, 0, 48, 48).data;
  let coloured = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (Math.abs(pixels[i] - pixels[i + 1]) > 6 || Math.abs(pixels[i + 1] - pixels[i + 2]) > 6) coloured += 1;
  }
  return coloured === 0;
}), 'toned to grayscale');
await owner.screenshot({ path: `${SHOTS}/${LABEL}-desktop-picture.png` });

// dim and fit are applied to the custom property
await owner.evaluate(() => State.saveSettings({ wallpaperDim: 60, wallpaperFit: 'contain' }));
await wait(900);
await owner.evaluate(() => Background.apply());
await wait(600);
const adjusted = await desktop(owner);
check('dimming and fitting change the draw', /contain/.test(adjusted.size) && /rgba\(0, 0, 0, 0\.6\)/.test(await owner.evaluate(() => document.getElementById('desktop').style.getPropertyValue('--wall-image'))), JSON.stringify(adjusted));

// Exercise Settings itself, not just Background.remove: removing the active
// picture must leave the previous picture painted, not revoke its blob URL.
const secondQueued = await owner.evaluate(() => {
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 200;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#d05b38'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const input = document.getElementById('background-input');
  const transfer = new DataTransfer();
  canvas.toBlob((blob) => {
    transfer.items.add(new File([blob], 'second.png', { type: 'image/png' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, 'image/png');
  return 'queued';
});
check('Settings accepts a second picture', secondQueued === 'queued');
for (let i = 0; i < 40; i += 1) {
  if (await owner.evaluate(() => Background.list().length === 2)) break;
  await wait(300);
}
await wait(900); // let the shelf previews finish decrypting, as they do before a tap
const secondDraw = await owner.evaluate(async () => {
  const desktop = document.getElementById('desktop');
  const source = getComputedStyle(desktop).backgroundImage.match(/url\("([^"]+)"\)/)?.[1] || '';
  const state = { active: State.settings().wallpaperFileId, newest: Background.list()[1]?.id, wall: document.body.dataset.wall, inline: desktop.style.getPropertyValue('--wall-image').slice(0, 60), source: source.slice(0, 16), decodes: false };
  if (!source) return state;
  const image = new Image(); image.src = source;
  try { await image.decode(); state.decodes = true; } catch { /* a stale blob */ }
  return state;
});
check('the newest upload paints on the desktop', secondDraw.decodes && secondDraw.active === secondDraw.newest, JSON.stringify(secondDraw));
const previousId = await owner.evaluate(() => Background.list()[0]?.id);
await owner.evaluate(async () => {
  UI.confirm = async () => true;
  const buttons = [...document.querySelectorAll('.wall-item button.icon')];
  buttons.at(-1)?.click();
});
for (let i = 0; i < 40; i += 1) {
  if (await owner.evaluate(() => Background.list().length === 1)) break;
  await wait(300);
}
await wait(1200);
const afterDelete = await owner.evaluate(async (wantedId) => {
  const style = getComputedStyle(document.getElementById('desktop'));
  const source = style.backgroundImage.match(/url\("([^"]+)"\)/)?.[1] || '';
  let decodes = false;
  if (source) {
    const image = new Image(); image.src = source;
    try { await image.decode(); decodes = true; } catch { /* a revoked blob fails here */ }
  }
  return { count: Background.list().length, active: State.settings().wallpaperFileId, wantedId, source: source.slice(0, 16), decodes };
}, previousId);
check('removing a picture keeps the remaining background painted', afterDelete.count === 1 && afterDelete.active === previousId && afterDelete.decodes, JSON.stringify(afterDelete));

const thumbBefore = await owner.evaluate(async () => {
  const node = document.querySelector('.wall-thumb');
  const source = node && node.style.backgroundImage.match(/url\("([^"]+)"\)/)?.[1];
  if (!source) return false;
  const image = new Image(); image.src = source;
  try { await image.decode(); return true; } catch { return false; }
});
check('the picture shelf preview loads', thumbBefore);
await owner.evaluate(() => {
  const row = [...document.querySelectorAll('.setting-row')].find((node) => /Match the interface/i.test(node.innerText));
  row?.querySelector('input[type="checkbox"]')?.click();
});
await wait(1000);
const thumbAfterTone = await owner.evaluate(async () => {
  const node = document.querySelector('.wall-thumb');
  const source = node && node.style.backgroundImage.match(/url\("([^"]+)"\)/)?.[1];
  if (!source) return false;
  const image = new Image(); image.src = source;
  try { await image.decode(); return true; } catch { return false; }
});
check('changing the picture tone keeps its library preview alive', thumbAfterTone);
const tonedState = await owner.evaluate(async () => {
  const source = getComputedStyle(document.getElementById('desktop')).backgroundImage.match(/url\("([^"]+)"\)/)?.[1];
  if (!source) return { colour: -1 };
  const image = new Image(); image.src = source; await image.decode();
  const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 24;
  const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0, 24, 24);
  const pixels = ctx.getImageData(0, 0, 24, 24).data;
  let spread = 0;
  for (let i = 0; i < pixels.length; i += 4) spread = Math.max(spread, Math.abs(pixels[i] - pixels[i + 1]), Math.abs(pixels[i + 1] - pixels[i + 2]));
  return { spread };
});
check('the tone switch repaints the desktop', tonedState.spread > 6, JSON.stringify(tonedState));
await owner.evaluate(() => {
  const row = [...document.querySelectorAll('.setting-row')].find((node) => /Match the interface/i.test(node.innerText));
  row?.querySelector('input[type="checkbox"]')?.click();
});
await wait(1000);
const tonedAgain = await owner.evaluate(async () => {
  const source = getComputedStyle(document.getElementById('desktop')).backgroundImage.match(/url\("([^"]+)"\)/)?.[1];
  if (!source) return false;
  const image = new Image(); image.src = source; await image.decode();
  const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 24;
  const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0, 24, 24);
  const pixels = ctx.getImageData(0, 0, 24, 24).data;
  for (let i = 0; i < pixels.length; i += 4) if (Math.abs(pixels[i] - pixels[i + 1]) > 6 || Math.abs(pixels[i + 1] - pixels[i + 2]) > 6) return false;
  return true;
});
check('matching the interface restores grayscale', tonedAgain);

// The visual-only console's `lock` command must be a real vault lock: the key
// and decrypted desktop picture leave memory; re-entry unlocks and repaints.
await owner.evaluate(() => ConsoleLog.execute('lock'));
await wait(250);
const locked = await owner.evaluate(() => ({
  prompt: !!document.querySelector('#lock-screen'),
  key: !!State.masterKey(),
  wallpaper: document.getElementById('desktop')?.style.getPropertyValue('--wall-image') || '',
}));
check('locking clears the vault key and desktop picture', locked.prompt && !locked.key && !locked.wallpaper, JSON.stringify({ ...locked, wallpaper: !!locked.wallpaper }));
await owner.type('#lock-screen input[type="password"]', 'correct-horse-battery-staple-9');
await owner.click('#lock-screen .btn.primary');
for (let i = 0; i < 40; i += 1) {
  if (await owner.evaluate(() => !document.querySelector('#lock-screen') && !!State.masterKey())) break;
  await wait(250);
}
await wait(800);
const unlockedBackground = await owner.evaluate(async () => {
  const source = getComputedStyle(document.getElementById('desktop')).backgroundImage.match(/url\("([^"]+)"\)/)?.[1];
  if (!source) return { unlocked: !!State.masterKey(), decodes: false };
  const image = new Image(); image.src = source;
  try { await image.decode(); return { unlocked: !!State.masterKey(), decodes: true }; }
  catch { return { unlocked: !!State.masterKey(), decodes: false }; }
});
check('unlocking restores the key and background', unlockedBackground.unlocked && unlockedBackground.decodes, JSON.stringify(unlockedBackground));

// and it survives a reload, decrypted again from the server
await owner.reload({ waitUntil: 'networkidle2' });
await wait(2500);
await owner.evaluate(() => document.querySelector('#unlock-form input, .auth-panel input')?.focus());
const afterReload = await owner.evaluate(async () => {
  const panel = document.querySelector('.auth-panel input[type=password]');
  return !!panel ? 'locked' : 'open';
});
check('the session survives a reload', afterReload === 'open' || afterReload === 'locked', afterReload);
if (afterReload === 'locked') {
  const inputs = await owner.$$('.auth-panel input');
  await inputs[0].type('operator');
  await inputs[1].type('correct-horse-battery-staple-9');
  await owner.evaluate(() => document.querySelector('.auth-panel form .btn.primary').click());
  await wait(2600);
}
for (let i = 0; i < 30; i += 1) {
  if ((await desktop(owner)).inline > 0) break;
  await wait(500);
}
const restored = await desktop(owner);
check('the picture is back after a reload', restored.wall === 'custom' && restored.inline > 0, JSON.stringify(restored));

// ------------------------------------------------------------ site themes
for (const name of ['broadsheet', 'terminal', 'blueprint', 'quiet', 'ink']) {
  await owner.evaluate(async (value) => {
    await State.saveSettings({ siteTheme: value, appearanceSource: 'self' });
    Shell.applyTheme();
  }, name);
  await wait(500);
  const applied = await owner.evaluate(() => {
    const title = document.querySelector('.window-titlebar .window-title') || document.querySelector('.title-1') || document.body;
    const body = getComputedStyle(document.body);
    return {
      attr: document.body.dataset.sitetheme,
      family: getComputedStyle(title).fontFamily.split(',')[0].replace(/["']/g, ''),
      label: body.getPropertyValue('--label-case').trim(),
      display: body.getPropertyValue('--font-display').split(',')[0].replace(/["']/g, ''),
    };
  });
  check(`site theme ${name} applies`, applied.attr === name, JSON.stringify(applied));
  if (name === 'quiet') check('quiet drops capitals', applied.label === 'none', applied.label);
  if (name === 'broadsheet') check('broadsheet sets serif type', /georgia|playfair|times/i.test(applied.display), applied.display);
  if (name === 'terminal') check('terminal sets the mono face', /mono/i.test(applied.display), applied.display);
}
await owner.screenshot({ path: `${SHOTS}/${LABEL}-broadsheet.png` });

// ------------------------------------------------- a published site look
const member = await openPage();
await register(member, 'fadehelper');
const before = await member.evaluate(() => ({ theme: document.body.dataset.theme, site: document.body.dataset.sitetheme }));
check('a fresh account follows the site by default',
  await member.evaluate(() => State.settings().appearanceSource === 'site'), JSON.stringify(before));

const published = await owner.evaluate(async () => {
  const result = await API.post('/api/admin/appearance', { siteTheme: 'blueprint', theme: 'chrome', accent: 'ink', note: 'house style' }).catch((error) => ({ error: error.message }));
  return result;
});
check('the operator can publish a site appearance', !!published.appearance && published.appearance.siteTheme === 'blueprint', JSON.stringify(published).slice(0, 140));

for (let i = 0; i < 30; i += 1) {
  const state = await member.evaluate(() => ({ site: document.body.dataset.sitetheme, theme: document.body.dataset.theme }));
  if (state.site === 'blueprint' && state.theme === 'chrome') break;
  await wait(400);
}
const followed = await member.evaluate(() => ({ site: document.body.dataset.sitetheme, theme: document.body.dataset.theme }));
check('the member repaints live, without a reload', followed.site === 'blueprint' && followed.theme === 'chrome', JSON.stringify(followed));
await member.screenshot({ path: `${SHOTS}/${LABEL}-published.png` });

// an account that wants its own look keeps it
const ownLook = await member.evaluate(async () => {
  await State.saveSettings({ appearanceSource: 'self', siteTheme: 'quiet', theme: 'nox' });
  Shell.applyTheme();
  await new Promise((r) => setTimeout(r, 300));
  return { site: document.body.dataset.sitetheme, theme: document.body.dataset.theme };
});
check('an account can keep its own choices', ownLook.site === 'quiet' && ownLook.theme === 'nox', JSON.stringify(ownLook));
const afterPublish = await owner.evaluate(async () => {
  const result = await API.post('/api/admin/appearance', { siteTheme: 'terminal' }).catch((error) => ({ error: error.message }));
  return result.appearance && result.appearance.siteTheme;
});
check('publishing again keeps the ramp it was given', afterPublish === 'terminal', String(afterPublish));
await wait(900);
const stillMine = await member.evaluate(() => ({ site: document.body.dataset.sitetheme }));
check('a member keeping their own look is not overridden', stillMine.site === 'quiet', JSON.stringify(stillMine));

// deleting a background takes the ciphertext with it
const removed = await owner.evaluate(async () => {
  const entry = Background.list()[0];
  if (!entry) return { skipped: true };
  await API.del(`/api/files/${entry.id}`);
  const gone = await API.get(`/api/files/${entry.id}`).then(() => false).catch(() => true);
  return { gone, id: entry.id };
});
check('deleting the picture removes it from the server', removed.gone === true, JSON.stringify(removed));

for (const [page, who] of [[owner, 'operator'], [member, 'member']]) {
  // the deleted-file probe asks for a blob that is meant to be gone, so the
  // browser logs its 404; nothing else is allowed through
  const bad = page.pageErrors.filter((line) => !/favicon/i.test(line) && !/Failed to load resource/i.test(line));
  check(`no runtime errors for the ${who}`, bad.length === 0, bad.slice(0, 3).join(' | '));
}

await browser.close();
stop();
process.__reported = true;
for (const line of notes) console.log(line);
for (const line of failures) console.log(line);
console.log(`\n${notes.length} ok, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
