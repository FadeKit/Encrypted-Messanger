import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const ROOT = '/home/user/Encrypted-Messanger';
const PORT = 3530;
fs.rmSync('/tmp/ae/probe-two', { recursive: true, force: true });
const server = spawn('node', ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), AE_DATA_DIR: '/tmp/ae/probe-two' }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1200));
const browser = await puppeteer.launch({ executablePath: '/tmp/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], defaultViewport: { width: 1200, height: 800 } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const make = async (handle) => {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const reg = [];
  page.on('response', async (r) => {
    if (r.url().includes('/api/auth/register')) reg.push({ status: r.status(), body: (await r.text().catch(() => '')).slice(0, 160) });
  });
  page.on('pageerror', (e) => console.log(`${handle} PAGEERROR:`, e.message.slice(0, 120)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
  await page.evaluate(() => [...document.querySelectorAll('.auth-tabs button')].find((b) => /create account/i.test(b.textContent)).click());
  await wait(300);
  const inputs = await page.$$('.auth-panel input');
  console.log(handle, '-> auth inputs:', inputs.length);
  await inputs[0].type(handle);
  await inputs[2].type('correct-horse-battery-staple-9');
  await inputs[3].type('correct-horse-battery-staple-9');
  await page.evaluate(() => document.querySelector('.auth-panel form .btn.primary').click());
  await wait(3500);
  console.log(handle, '-> register responses:', JSON.stringify(reg));
  console.log(handle, '-> modal open?', await page.evaluate(() => !!document.querySelector('#modal-layer.open')));
  console.log(handle, '-> panel text:', await page.evaluate(() => (document.querySelector('.auth-panel') || {}).innerText?.replace(/\s+/g, ' ').slice(0, 200)));
  console.log(handle, '-> user?', await page.evaluate(() => (window.State && State.user) ? State.user.username : null));
  return page;
};
const a = await make('operator');
const b = await make('fadehelper');
await browser.close(); server.kill('SIGTERM');
