// Walks the auth screen and every authenticated surface at a given viewport and
// reports: blank surfaces, clipped text, line-box collisions, text leaving its
// container and intersecting siblings.
//
//   LD_LIBRARY_PATH=/tmp/ae/lib FONTCONFIG_PATH=/tmp/ae/fonts \
//   AE_LABEL=pc AE_W=1440 AE_H=900 AE_PORT=3470 node tools/visual-audit.mjs
//
// Spawns its own server on AE_PORT with a fresh data directory.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = Number(process.env.AE_PORT || 3460);
const LABEL = process.env.AE_LABEL || 'desktop';
const W = Number(process.env.AE_W || 1440);
const H = Number(process.env.AE_H || 900);
const SHOTS = process.env.AE_SHOTS || '/tmp/ae/shots';
fs.mkdirSync(SHOTS, { recursive: true });
fs.rmSync(`/tmp/ae/va-${LABEL}`, { recursive: true, force: true });

const server = spawn('node', ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), AE_DATA_DIR: `/tmp/ae/va-${LABEL}` },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 1200));
const browser = await puppeteer.launch({
  executablePath: '/tmp/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', ...(process.env.AE_EXTRA_ARGS ? process.env.AE_EXTRA_ARGS.split(',') : [])],
  defaultViewport: { width: W, height: H, isMobile: W < 800, hasTouch: W < 800 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERROR:', m.text().slice(0, 200)); });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });

const PROBE = `(() => {
  const out = { clipped: [], lineOverlaps: [], outsideParent: [], siblingOverlaps: [] };
  const txt = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('');
  const nm = (el) => el.tagName.toLowerCase() + '.' + String(el.className || '').split(' ').filter(Boolean).slice(0, 2).join('.');
  const hidden = (el) => { const c = getComputedStyle(el); return c.display === 'none' || c.visibility === 'hidden' || Number(c.opacity) === 0; };
  const clippedBy = (node) => {
    for (let cur = node; cur && cur !== document.body; cur = cur.parentElement) {
      const cs = getComputedStyle(cur);
      if (['hidden', 'clip', 'auto', 'scroll'].includes(cs.overflowX)) return true;
    }
    return false;
  };

  for (const el of document.querySelectorAll('body *')) {
    if (hidden(el) || !el.getClientRects().length) continue;
    // shapes inside an <svg> are a drawing, not boxes
    if (el.closest('svg')) continue;
    const cs = getComputedStyle(el);
    if (cs.position === 'absolute' || cs.position === 'fixed') continue;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const text = txt(el);
    if (text.length > 1) {
      if (el.scrollWidth > el.clientWidth + 1 && cs.overflowX === 'visible' && cs.whiteSpace !== 'nowrap') {
        out.clipped.push({ el: nm(el), text: text.slice(0, 30), over: Math.round(el.scrollWidth - el.clientWidth) });
      }
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
      for (let i = 1; i < rects.length; i++) {
        const a = rects[i - 1], b = rects[i];
        const v = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (Math.abs(a.top - b.top) > 1 && v > 1) out.lineOverlaps.push({ el: nm(el), text: text.slice(0, 30), px: Math.round(v) });
      }
      const p = el.parentElement;
      if (p && !hidden(p) && !clippedBy(p)) {
        const ps = getComputedStyle(p);
        const pr = p.getBoundingClientRect();
        const l = pr.left + (parseFloat(ps.paddingLeft) || 0), r = pr.right - (parseFloat(ps.paddingRight) || 0);
        if (rect.right > r + 1.5 || rect.left < l - 1.5) out.outsideParent.push({ el: nm(el), parent: nm(p), text: text.slice(0, 26), right: Math.round(rect.right - r), left: Math.round(l - rect.left) });
      }
    }
  }

  // sibling boxes that intersect while both carry text: real visual collisions
  const textish = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
  for (const parent of document.querySelectorAll('body *')) {
    if (hidden(parent) || parent.closest('svg') || !parent.getClientRects().length) continue;
    const kids = [...parent.children].filter((k) => !hidden(k) && k.getClientRects().length && textish(k));
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 2 && oy > 2) out.siblingOverlaps.push({ parent: nm(parent), a: nm(kids[i]), b: nm(kids[j]), ox: Math.round(ox), oy: Math.round(oy) });
      }
    }
  }
  return out;
})()`;

const collect = async (label) => {
  const report = await page.evaluate(PROBE);
  const lines = [];
  for (const [kind, list] of Object.entries(report)) for (const item of list.slice(0, 6)) lines.push(`${kind}: ${JSON.stringify(item)}`);
  const total = Object.values(report).reduce((n, l) => n + l.length, 0);
  console.log(`\n--- ${LABEL} :: ${label} :: ${total} problem(s)`);
  for (const line of lines) console.log('   ', line);
  return total;
};

let total = 0;
total += await collect('auth');
await page.screenshot({ path: `${SHOTS}/${LABEL}-auth.png` });

// register, then walk every surface
await page.evaluate(() => [...document.querySelectorAll('.auth-tabs button')].find((b) => /create account/i.test(b.textContent)).click());
await new Promise((r) => setTimeout(r, 250));
const inputs = await page.$$('.auth-panel input');
await inputs[0].type('operator'); await inputs[2].type('correct-horse-battery-staple-9'); await inputs[3].type('correct-horse-battery-staple-9');
await page.evaluate(() => document.querySelector('.auth-panel form .btn.primary').click());
await new Promise((r) => setTimeout(r, 2800));
total += await collect('recovery-codes');
await page.screenshot({ path: `${SHOTS}/${LABEL}-codes.png` });
await page.evaluate(() => document.querySelector('#modal-layer input[type=checkbox]')?.click());
await new Promise((r) => setTimeout(r, 150));
await page.evaluate(() => [...document.querySelectorAll('#modal-layer button')].find((b) => /continue to ae secure/i.test(b.textContent))?.click());
await new Promise((r) => setTimeout(r, 1600));
total += await collect('desktop');
await page.screenshot({ path: `${SHOTS}/${LABEL}-desktop.png` });

for (const id of await page.evaluate(() => Apps.all().map((a) => a.id))) {
  await page.evaluate((s) => Apps.open(s), id);
  await new Promise((r) => setTimeout(r, 900));
  const content = await page.evaluate((surface) => {
    // A surface may be a window, or a modal (the editor's file-type picker and
    // the console flyout are both legitimate surfaces).
    const win = document.querySelector(`.window[data-win="${surface}"]`) || document.querySelector('#modal-layer.open .modal');
    const body = win ? (win.querySelector('.window-body') || win.querySelector('.modal-body') || win) : null;
    const text = body ? body.innerText.replace(/\s+/g, ' ').trim() : '';
    return { window: !!win, nodes: body ? body.querySelectorAll('*').length : 0, textLength: text.length };
  }, id);
  // The console is a flyout panel, not a window: it has no .window node.
  const popover = [].includes(id);
  if (!popover && (!content.window || content.nodes < 6 || content.textLength < 8)) {
    console.log(`\n--- ${LABEL} :: surface:${id} :: BLANK (window=${content.window}, nodes=${content.nodes}, text=${content.textLength})`);
    total += 1;
  }
  total += await collect(`surface:${id}`);
  await page.screenshot({ path: `${SHOTS}/${LABEL}-${id}.png` });
  await page.evaluate(() => { Windows.closeAll && Windows.closeAll(); });
  await new Promise((r) => setTimeout(r, 200));
}
// the standalone certificate page a device opens to stop the warning
await page.goto(`http://127.0.0.1:${PORT}/trust`, { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 600));
const trustText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
if (trustText.length < 40) { console.log(`\n--- ${LABEL} :: trust :: BLANK`); total += 1; }
total += await collect('trust');
await page.screenshot({ path: `${SHOTS}/${LABEL}-trust.png` });

console.log(`\n### ${LABEL} total problems: ${total}`);
await browser.close();
server.kill('SIGTERM');
