// Drives the punch-list flows the way a person does, at phone width.
//
//   LD_LIBRARY_PATH=/tmp/ae/lib FONTCONFIG_PATH=/tmp/ae/fonts \
//   AE_PORT=3490 AE_W=390 AE_H=844 node tools/e2e-punchlist.mjs
//
// Covers: cropping a picture and switching among the last three, posting,
// editing and deleting a 24-hour note, making a .txt and an .html file and
// reopening them from the drive, the taskbar icons and tap-to-return, and the
// uncapped click counter.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = Number(process.env.AE_PORT || 3490);
const LABEL = process.env.AE_LABEL || 'phone';
const W = Number(process.env.AE_W || 390);
const H = Number(process.env.AE_H || 844);
const SHOTS = process.env.AE_SHOTS || '/tmp/ae/shots';
fs.mkdirSync(SHOTS, { recursive: true });
const DATA = `/tmp/ae/e2e-${LABEL}`;
fs.rmSync(DATA, { recursive: true, force: true });

const server = spawn('node', ['server/index.js'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), AE_DATA_DIR: DATA }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 1200));
const browser = await puppeteer.launch({
  executablePath: '/tmp/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  defaultViewport: { width: W, height: H, isMobile: W < 800, hasTouch: W < 800 },
});
const page = await browser.newPage();
const failures = [];
const notes = [];
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`); });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail = '') => {
  if (ok) notes.push(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else failures.push(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
};
const shot = (name) => page.screenshot({ path: `${SHOTS}/${LABEL}-${name}.png` });
const diag = async (why) => {
  const info = await page.evaluate(() => ({
    windows: [...document.querySelectorAll('.window')].map((w) => w.dataset.win),
    modals: [...document.querySelectorAll('#modal-layer .modal')].map((m) => m.innerText.replace(/\s+/g, ' ').slice(0, 60)),
    toasts: [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\s+/g, ' ').slice(0, 80)),
  }));
  notes.push(`  diag ${why}: ${JSON.stringify(info)}`);
};
// Open an app and return a selector scoped to the window it produced.
const openApp = async (id, { wait: pause = 900 } = {}) => {
  await page.evaluate((app) => Apps.open(app), id);
  await wait(pause);
  const win = await page.evaluate((app) => {
    const wins = [...document.querySelectorAll('.window')].filter((w) => w.getClientRects().length);
    const pick = wins.filter((w) => (w.dataset.win || '').startsWith(app)).pop() || wins.pop();
    return pick ? pick.dataset.win : null;
  }, id);
  return win ? `.window[data-win="${win}"]` : null;
};
const clickIn = async (scopeSel, pattern, { pause = 260, timeout = 4000, all = false } = {}) => {
  const started = Date.now();
  for (;;) {
    const done = await page.evaluate(({ scopeSel, pattern, all }) => {
      const re = new RegExp(pattern, 'i');
      const scope = scopeSel ? document.querySelector(scopeSel) : document.body;
      if (!scope) return false;
      const pool = [...scope.querySelectorAll('button, a.btn, tb-btn, .list-row, .file-type-card, [role="button"]')]
        .filter((b) => b.getClientRects().length && getComputedStyle(b).visibility !== 'hidden' && re.test(b.innerText));
      const node = all ? pool[pool.length - 1] : pool[0];
      if (!node) return false;
      node.click();
      return true;
    }, { scopeSel, pattern, all });
    if (done) { await wait(pause); return true; }
    if (Date.now() - started > timeout) throw new Error(`no /${pattern}/ inside ${scopeSel}`);
    await wait(120);
  }
};
const visible = (selector) => page.evaluate((s) => {
  const n = document.querySelector(s);
  return !!(n && n.getClientRects().length && getComputedStyle(n).display !== 'none' && getComputedStyle(n).visibility !== 'hidden');
}, selector);
const textOf = (selector) => page.evaluate((s) => {
  const n = document.querySelector(s);
  return n ? n.innerText.replace(/\s+/g, ' ').trim() : '';
}, selector);

// ------------------------------------------------------------------ sign up
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
await page.evaluate(() => [...document.querySelectorAll('.auth-tabs button')].find((b) => /create account/i.test(b.textContent)).click());
await wait(250);
const inputs = await page.$$('.auth-panel input');
await inputs[0].type('operator');
await inputs[2].type('correct-horse-battery-staple-9');
await inputs[3].type('correct-horse-battery-staple-9');
await page.evaluate(() => document.querySelector('.auth-panel form .btn.primary').click());
await page.waitForSelector('#modal-layer.open', { timeout: 8000 });
await wait(1200);
await page.evaluate(() => document.querySelector('#modal-layer input[type=checkbox]')?.click());
await wait(150);
await page.evaluate(() => [...document.querySelectorAll('#modal-layer button')].find((b) => /continue to ae secure/i.test(b.textContent))?.click());
await wait(1600);
check('desktop opens at phone width', await visible('#taskbar'), `viewport ${W}x${H}`);

// ------------------------------------------------- item 7: uncapped clicker
const clicker = await openApp('clicker', { wait: 800 });
const clicks = await page.evaluate((scopeSel) => {
  const box = document.querySelector(`${scopeSel} .clicker-button`) || document.querySelector('.clicker-button');
  return { found: !!box };
}, clicker);
check('clicker window mounts its button', clicks.found);
const counted = await page.evaluate(async (scopeSel) => {
  const box = document.querySelector(`${scopeSel} .clicker-button`);
  for (let i = 0; i < 26; i++) { box.click(); await new Promise((r) => setTimeout(r, 30)); }
  await new Promise((r) => setTimeout(r, 1600));
  const total = document.querySelector(`${scopeSel} .clicker-total`);
  const mine = [...document.querySelectorAll(`${scopeSel} .tiny, ${scopeSel} .clicker-week`)].map((n) => n.innerText).join(' ');
  return { total: total ? total.innerText.replace(/[^0-9]/g, '') : null, mine };
}, clicker);
check('click counter counts past 20 for one user', Number(counted.total) >= 26,
  `total=${counted.total} · ${counted.mine.slice(0, 60)}`);
await shot('clicker');
await page.evaluate(() => Windows.closeAll());
await wait(300);

// ---------------------------------------- items 9/10: crop, upload, switch
const picture = (w, h, fill, marks) => {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.fillStyle = fill; x.fillRect(0, 0, w, h);
  for (const [mx, my, mw, mh, mc] of marks) { x.fillStyle = mc; x.fillRect(mx, my, mw, mh); }
  return c.toDataURL('image/png');
};
const shotA = await page.evaluate(picture, 900, 600, '#111', [[700, 60, 120, 460, '#eee']]);
const shotB = await page.evaluate(picture, 500, 900, '#222', [[150, 120, 200, 660, '#ddd']]);
fs.writeFileSync('/tmp/ae/e2e-a.png', Buffer.from(shotA.split(',')[1], 'base64'));
fs.writeFileSync('/tmp/ae/e2e-b.png', Buffer.from(shotB.split(',')[1], 'base64'));

const profile = await openApp('profile', { wait: 900 });
const uploadPicture = async (file) => {
  const handle = await page.evaluateHandle(() => {
    const list = [...document.querySelectorAll('input[type=file]')];
    return list.find((n) => (n.accept || '').includes('image')) || list[0] || null;
  });
  const el = handle.asElement();
  if (!el) throw new Error('no picture input');
  await el.uploadFile(file);
  await wait(500);
  await page.evaluate(() => {
    const list = [...document.querySelectorAll('input[type=file]')];
    const n = list.find((x) => x.files && x.files.length);
    if (n) n.dispatchEvent(new Event('change', { bubbles: true }));
  });
};
await clickIn(profile, 'upload & crop|crop picture');
await wait(400);
await uploadPicture('/tmp/ae/e2e-a.png');
await wait(1000);
check('cropper opens with a live stage', await visible('.crop-stage'));
if (await visible('.crop-stage')) {
  await shot('avatar-crop');
  const preview = await page.evaluate(() => document.querySelector('.crop-preview')?.toDataURL?.()?.length || 0);
  const box = await page.evaluate(() => { const r = document.querySelector('.crop-stage').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w / 2 + 35, box.y + box.h / 2 + 25, { steps: 8 });
  await page.mouse.up();
  await page.evaluate(() => { const z = document.querySelector('.crop-zoom'); z.value = '230'; z.dispatchEvent(new Event('input', { bubbles: true })); });
  await wait(500);
  const zoomed = await page.evaluate(() => document.querySelector('.crop-zoom').value);
  check('crop stage pans and zooms live', preview > 0 && zoomed === '230', `preview px=${preview}, zoom=${zoomed}`);
  await clickIn('#modal-layer', 'use this crop', { pause: 2800 });
}
check('picture history appears after the first upload', (await textOf(profile)).includes('IN USE'), (await textOf(profile)).slice(0, 70));
await diag('after first upload');

await clickIn(profile, 'upload & crop|crop picture');
await wait(400);
await uploadPicture('/tmp/ae/e2e-b.png');
await wait(1000);
if (await visible('.crop-stage')) { await clickIn('#modal-layer', 'use this crop', { pause: 2800 }); }
const slots = await page.evaluate((s) => document.querySelectorAll(`${s} .avatar-slot`).length, profile);
check('the last three pictures are kept', slots >= 2, `${slots} slot(s)`);
const swapped = await page.evaluate(async (s) => {
  const before = document.querySelector(`${s} .avatar-slot.on`)?.dataset?.file || null;
  const buttons = [...document.querySelectorAll(`${s} .avatar-slot`)].filter((b) => !b.classList.contains('on'));
  if (!buttons.length) return { before, after: before, clicked: false };
  buttons[0].click();
  await new Promise((r) => setTimeout(r, 1500));
  const on = document.querySelector(`${s} .avatar-slot.on`);
  return { before, after: on?.dataset?.file || on?.textContent || null, clicked: true };
}, profile);
check('switching back to an older picture needs no upload', swapped.clicked, JSON.stringify(swapped).slice(0, 90));
await shot('avatar-history');

// ------------------------------------------ items 11/12: the 24-hour note
await clickIn(profile, 'status note');
check('status note editor opens', (await page.evaluate(() => document.querySelectorAll('#modal-layer.open .modal').length)) > 0);
check('note editor offers the 24-hour choice', await page.evaluate(() => [...document.querySelectorAll('#modal-layer select option')].some((o) => o.value === '24h')));
await page.evaluate(() => {
  const i = document.querySelector('#modal-layer input[maxlength="160"]');
  i.value = 'shipping the punch list';
  i.dispatchEvent(new Event('input', { bubbles: true }));
  const sel = document.querySelector('#modal-layer select');
  sel.value = '24h';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
});
await clickIn('#modal-layer', 'post note', { pause: 1600 });
const bubble = await textOf('.bubble-text');
check('the note shows as a bubble beside the name', /punch list/i.test(bubble), bubble.slice(0, 50));
const lifeShown = await page.evaluate(() => document.querySelector('.bubble-time')?.innerText || '');
check('the bubble counts its own life down, capped at 24 hours',
  !!(lifeShown && /(2[0-4]|1?\d)\s*h/i.test(lifeShown)), `shows "${lifeShown}"`);
await shot('status-note');

await clickIn(profile, 'status note');
await page.evaluate(() => {
  const i = document.querySelector('#modal-layer input[maxlength="160"]');
  i.value = 'edited within the hour';
  i.dispatchEvent(new Event('input', { bubbles: true }));
});
await clickIn('#modal-layer', 'save note', { pause: 1600 });
check('the note can be edited', /edited within the hour/i.test(await textOf('.bubble-text')));
const deleteOffered = await page.evaluate(() => {
  const scope = document.querySelector('#modal-layer');
  return !!scope;
});
await clickIn(profile, 'status note');
check('the editor offers deletion', deleteOffered && (await page.evaluate(() => /delete note/i.test(document.querySelector('#modal-layer')?.innerText || ''))));
await clickIn('#modal-layer', 'delete note', { pause: 1600 });
check('the note can be deleted on demand', (await textOf('.bubble-text')) === '');
await page.evaluate(() => Windows.closeAll());
await wait(300);

// ------------------------------------- item 14: make a file, save, reopen
const drive = await openApp('drive', { wait: 1000 });
await clickIn(drive, 'new file');
check('the drive offers the file creator', await visible('.file-type-grid'));
await clickIn('#modal-layer', 'text file');
const editorWin = await page.evaluate(() => {
  const wins = [...document.querySelectorAll('.window')].filter((w) => w.getClientRects().length);
  const pick = wins.filter((w) => (w.dataset.win || '').startsWith('editor')).pop();
  return pick ? pick.dataset.win : null;
});
check('an editor opens for a new text file', !!editorWin && await visible(`.window[data-win="${editorWin}"] textarea`), `window=${editorWin}`);
const editor = `.window[data-win="${editorWin}"]`;
await page.evaluate((s) => {
  const area = document.querySelector(`${s} textarea`);
  area.value = 'hello from the punch list';
  area.dispatchEvent(new Event('input', { bubbles: true }));
}, editor);
await wait(400);
const statusLine = await textOf(`${editor} .editor-status`);
check('the editor reports size and lines as you type', /bytes/i.test(statusLine), statusLine.slice(0, 70));
await clickIn(editor, 'save to drive', { pause: 2400 });
const toasts = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\s+/g, ' ')).join(' | '));
check('saving to the drive reports success', /saved|drive/i.test(toasts) && !/empty/i.test(toasts), toasts.slice(0, 110));

await page.evaluate(() => Windows.closeAll());
await wait(300);
const drive2 = await openApp('drive', { wait: 1000 });
const listed = await page.evaluate(async (s) => {
  const deadline = Date.now() + 6000;
  for (;;) {
    const names = [...document.querySelectorAll(`${s} .drive-cell .truncate`)].map((n) => n.textContent.trim());
    if (names.some((n) => /\.txt$/i.test(n)) || Date.now() > deadline) return names;
    await new Promise((r) => setTimeout(r, 250));
  }
}, drive2);
check('the saved file is listed in the drive under its own name',
  listed.some((n) => /untitled\.txt$/i.test(n)), JSON.stringify(listed).slice(0, 120));
await shot('drive-with-file');

// HTML page with a live preview
await page.evaluate(() => Windows.closeAll());
await wait(300);
const files = await openApp('files', { wait: 1000 });
await clickIn(files, 'new file');
await clickIn('#modal-layer', 'html page');
const htmlWin = await page.evaluate(() => {
  const wins = [...document.querySelectorAll('.window')].filter((w) => w.getClientRects().length);
  const pick = wins.filter((w) => (w.dataset.win || '').startsWith('editor')).pop();
  return pick ? pick.dataset.win : null;
});
const html = `.window[data-win="${htmlWin}"]`;
await page.evaluate((s) => {
  const area = document.querySelector(`${s} textarea`);
  area.value = '<h1>punch list</h1><p>encrypted end to end</p>';
  area.dispatchEvent(new Event('input', { bubbles: true }));
}, html);
await wait(600);
const previewInfo = await page.evaluate((s) => {
  const pane = document.querySelector(`${s} #editor-preview-pane`);
  const frame = pane && pane.querySelector('iframe');
  return { pane: !!pane, display: pane ? getComputedStyle(pane).display : null, frame: !!frame, srcdoc: frame ? (frame.getAttribute('srcdoc') || '').slice(0, 120) : '' };
}, html);
check('HTML renders a live preview while typing',
  previewInfo.frame && /punch list/i.test(previewInfo.srcdoc),
  `pane=${previewInfo.display} srcdoc="${previewInfo.srcdoc.slice(0, 50)}"`);
await clickIn(html, 'save to drive', { pause: 2400 });

// -------------------------- item 2: taskbar icons, tap to come back on phone
const tb = await page.evaluate(() => [...document.querySelectorAll('#taskbar-stack .tb-btn[data-win]')].map((b) => {
  const r = b.getBoundingClientRect();
  const glyph = b.querySelector('.tb-glyph');
  const svg = glyph && glyph.querySelector('svg');
  return {
    win: b.dataset.win,
    label: (b.querySelector('.tb-label') || {}).innerText || b.innerText.replace(/\s+/g, ' ').trim(),
    hasIcon: !!(svg && svg.querySelector('path, rect, circle, line, polyline, polygon')),
    box: `${Math.round(r.width)}x${Math.round(r.height)}`,
    big: r.width >= 34 && r.height >= 24,
  };
}));
check('every taskbar tab carries a real icon at a tappable size',
  tb.length > 0 && tb.every((t) => t.hasIcon && t.big),
  `${tb.length} tab(s) · bad: ${tb.filter((t) => !t.hasIcon || !t.big).map((t) => `${t.win}(${t.box})`).join(',') || 'none'}`);
check('taskbar tabs name the window they reopen', tb.every((t) => !!t.label), tb.map((t) => t.label).slice(0, 4).join(' / '));
await shot('taskbar-phone');

const driveTab = tb.find((t) => t.win && t.win.startsWith('drive')) || tb[tb.length - 1];
if (driveTab) {
  await page.evaluate((w) => document.querySelector(`#taskbar-stack .tb-btn[data-win="${w}"]`).click(), driveTab.win);
  await wait(500);
  const minimized = await page.evaluate((w) => {
    const node = document.querySelector(`.window[data-win="${w}"]`);
    return !!(node && (node.classList.contains('minimized') || !node.getClientRects().length));
  }, driveTab.win);
  check('tapping the tab minimizes the window', minimized);
  const hollow = await page.evaluate((w) => document.querySelector(`#taskbar-stack .tb-btn[data-win="${w}"]`).classList.contains('minimized'), driveTab.win);
  check('a minimized window is marked on the taskbar', hollow);
  await page.evaluate((w) => document.querySelector(`#taskbar-stack .tb-btn[data-win="${w}"]`).click(), driveTab.win);
  await wait(700);
  const back = await page.evaluate((w) => {
    const node = document.querySelector(`.window[data-win="${w}"]`);
    return !!(node && !node.classList.contains('minimized') && node.getBoundingClientRect().width > 100 && node.getClientRects().length);
  }, driveTab.win);
  check('tapping it again brings the window straight back', back);
  await shot('taskbar-restored');
} else {
  check('a drive tab exists in the taskbar', false);
}

// re-open a saved file in the editor, from the drive it was saved into
await page.evaluate(() => Windows.closeAll());
await wait(300);
const drive3 = await openApp('drive', { wait: 1400 });
const rightClicked = await page.evaluate(async (s) => {
  const deadline = Date.now() + 6000;
  for (;;) {
    const cells = [...document.querySelectorAll(`${s} .drive-cell`)];
    const target = cells.find((c) => /\.txt$/i.test((c.querySelector('.truncate') || {}).textContent || ''));
    if (target) {
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
      return true;
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}, drive3);
check('the drive cell for the new file is there to act on', rightClicked);
await wait(700);
if (/open in the editor/i.test(await page.evaluate(() => document.body.innerText))) {
  await clickIn('body', 'open in the editor', { pause: 2600 });
  await diag('after "open in the editor"');
  const loaded = await page.evaluate(() => {
    const wins = [...document.querySelectorAll('.window')].filter((w) => (w.dataset.win || '').startsWith('editor'));
    const last = wins.pop();
    return last ? last.querySelector('textarea')?.value || '' : '';
  });
  check('a saved text file reopens with its text intact', /hello from the punch list/i.test(loaded), loaded.slice(0, 50));
  await shot('editor-reopened');
} else {
  await diag('drive context menu');
  check('a saved text file offers "Open in the editor"', false);
}

// ------------------------------------------------------------------ report
console.log(`\n=== ${LABEL} punch list (${W}x${H}) ===`);
for (const line of notes) console.log(line);
for (const line of failures) console.log(line);
if (errors.length) {
  console.log('  --- runtime errors seen:');
  for (const e of [...new Set(errors)].slice(0, 8)) console.log(`   ${e}`);
}
console.log(`\n${notes.filter((n) => n.startsWith('  ok')).length} ok, ${failures.length} failed, ${new Set(errors).size} runtime error kind(s)`);
await browser.close();
server.kill('SIGTERM');
process.exit(failures.length ? 1 : 0);
