// End-to-end browser verification without dependencies: drives headless Chrome or Edge over the
// DevTools protocol against a fresh in-process server and database.
// Checks every page for runtime errors and horizontal overflow at 320/375/768/1280 px in light
// and dark themes, then runs the core journeys: sign up, publish an event type, book, manage,
// build/publish/submit a form (both presentations), create a flow, and billing.
// Usage: CHROME_PATH=<browser executable> npm run browser-check [-- --screenshots <dir>]
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';

const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
const browserPath = candidates.find(path => existsSync(path));
if (!browserPath) { console.error('No Chrome/Edge found. Set CHROME_PATH.'); process.exit(2); }
const shotsIndex = process.argv.indexOf('--screenshots');
const shotsDir = shotsIndex > 0 ? process.argv[shotsIndex + 1] : null;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

const workDir = mkdtempSync(join(tmpdir(), 'schedora-browser-'));
const app = createApp({ databasePath: join(workDir, 'test.db'), configOverrides: { workerIntervalMs: 500 }, log: () => {} });
await app.start();
await new Promise(resolve => app.server.close(resolve));
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;

const port = 9300 + Math.floor(Math.random() * 500);
const browser = spawn(browserPath, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(workDir, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
let target;
for (let attempt = 0; attempt < 50 && !target; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 200));
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page'); } catch { /* starting */ }
}
if (!target) throw new Error('Browser did not start.');

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
let nextId = 0;
const pending = new Map();
const problems = [];
let currentLabel = '';
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data);
  if (message.id && pending.has(message.id)) { const { resolve, reject } = pending.get(message.id); pending.delete(message.id); message.error ? reject(new Error(message.error.message)) : resolve(message.result); }
  if (message.method === 'Runtime.exceptionThrown') problems.push(`${currentLabel}: exception ${message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text}`);
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') problems.push(`${currentLabel}: console.error ${message.params.args.map(arg => arg.value ?? arg.description).join(' ')}`);
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error' && !/status of 4\d\d/.test(message.params.entry.text)) problems.push(`${currentLabel}: ${message.params.entry.text} ${message.params.entry.url || ''}`);
});
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(`Evaluation failed: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
  return result.result.value;
};
const waitFor = async (expression, label, timeout = 8000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(`Boolean(${expression})`)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
};
await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');

async function open(path, ready = "document.querySelector('#main h1')") {
  currentLabel = path;
  await send('Page.navigate', { url: base + path });
  await waitFor(`document.readyState === 'complete' && ${ready}`, `${path} to render`);
}
const fill = (selector, value) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('missing ${selector}'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const click = selector => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('missing ${selector}'); el.click(); })()`);
const text = () => evaluate('document.querySelector("#main").innerText');

const WIDTHS = [320, 375, 768, 1280];
let checks = 0;
async function layoutCheck(name) {
  for (const theme of ['light', 'dark']) {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
    for (const width of WIDTHS) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 768 });
      await new Promise(resolve => setTimeout(resolve, 60));
      const overflow = await evaluate('document.documentElement.scrollWidth - window.innerWidth');
      checks++;
      if (overflow > 0) {
        const culprits = await evaluate("[...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > innerWidth + 1).slice(0, 6).map(el => el.tagName.toLowerCase() + '.' + String(el.className) + ':' + getComputedStyle(el).position + ':' + Math.round(el.getBoundingClientRect().right)).join(' | ') + ' sw=' + document.documentElement.scrollWidth + ' iw=' + innerWidth");
        problems.push(`${name}: horizontal overflow of ${overflow}px at ${width}px (${theme}) from ${culprits || 'unknown'}`);
      }
      const images = await evaluate('[...document.querySelectorAll("img")].filter(img => img.getBoundingClientRect().width > 64 && img.closest(".lockup")).length');
      if (images) problems.push(`${name}: oversized logo at ${width}px`);
      if (shotsDir && (width === 375 || width === 1280)) {
        const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        writeFileSync(join(shotsDir, `${name.replace(/[^a-z0-9]+/gi, '_')}-${width}-${theme}.png`), Buffer.from(data, 'base64'));
      }
    }
  }
  await send('Emulation.setEmulatedMedia', { features: [] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
}

const steps = [];
async function step(name, fn) {
  try { await fn(); steps.push(`✓ ${name}`); }
  catch (error) { steps.push(`✗ ${name}: ${error.message}`); problems.push(`${name}: ${error.message}`); }
}

try {
  for (const path of ['/', '/meet', '/forms', '/flow', '/billing', '/account', '/privacy', '/terms', '/missing-page']) {
    await step(`render ${path}`, async () => { await open(path); await layoutCheck(path); });
  }
  await step('dismiss consent', async () => { await click('.cookie-banner [data-choice="rejected"]'); });
  let workspaceSlug;
  await step('sign up', async () => {
    await open('/account?mode=signup&next=/meet');
    await fill('#su-name', 'Asha Host'); await fill('#su-email', 'asha@example.com'); await fill('#su-password', 'a long test password'); await fill('#su-workspace', 'Asha Studio');
    await click('#signup [type="submit"]');
    await waitFor("location.pathname === '/meet' && document.querySelector('.tabs')", 'Meet dashboard');
    workspaceSlug = await evaluate("fetch('/api/me').then(r => r.json()).then(d => d.workspaces[0].slug)");
  });
  let eventSlug;
  await step('create and publish event type', async () => {
    await open('/meet/event-types/new', "document.querySelector('#event-form')");
    await layoutCheck('event type editor');
    await fill('#title', 'Intro call'); await fill('#min_notice_hours', '0');
    await evaluate("document.querySelector('[name=published]').checked = true");
    await click('#event-form [type="submit"]');
    await waitFor("/^\\/meet\\/event-types\\/[0-9a-f-]{36}$/.test(location.pathname)", 'saved event type');
    eventSlug = await evaluate("document.querySelector('#slug').value");
    if (eventSlug !== 'intro-call') throw new Error('unexpected slug ' + eventSlug);
  });
  let manageHref;
  await step('book as invitee', async () => {
    await open(`/meet/${workspaceSlug}/${eventSlug}`, "document.querySelector('.day[data-available]')");
    await layoutCheck('public booking');
    await click('.day[data-available]');
    await click('.slot');
    await waitFor("document.querySelector('#invitee-form')", 'details form');
    await layoutCheck('booking details');
    await fill('#name', 'Ravi Invitee'); await fill('#email', 'ravi@example.com');
    await click('#invitee-form [type="submit"]');
    await waitFor("document.body.innerText.includes('You are scheduled')", 'confirmation');
    await layoutCheck('booking confirmation');
    manageHref = await evaluate("[...document.querySelectorAll('a')].find(a => a.textContent.includes('Reschedule')).getAttribute('href')");
  });
  await step('manage booking and reschedule', async () => {
    await open(manageHref, "document.querySelector('#reschedule')");
    await layoutCheck('manage booking');
    await click('#reschedule');
    await waitFor("document.querySelector('#new-picker .day[data-available]')", 'reschedule picker');
    await evaluate("[...document.querySelectorAll('#new-picker .day[data-available]')].pop().click()");
    await click('#new-picker .slot');
    await click('#confirm-new');
    await waitFor("location.search.includes('done=rescheduled')", 'rescheduled');
  });
  await step('host sees booking and email delivery', async () => {
    await open('/meet?tab=upcoming', "document.querySelector('.list, .empty')");
    if (!(await text()).includes('Ravi Invitee')) throw new Error('booking not listed');
    await open('/meet?tab=emails', "document.querySelector('table')");
    await layoutCheck('email delivery');
  });
  let formSlug;
  await step('build and publish form', async () => {
    await open('/forms', "document.querySelector('#new-form')");
    await click('#new-form');
    await waitFor("document.querySelector('#publish') && document.querySelector('#preview form')", 'builder');
    await layoutCheck('form builder');
    await fill('#f-title', 'Project intake');
    await click('#publish');
    await waitFor("document.querySelector('#share-link')", 'published share link');
    formSlug = (await evaluate("document.querySelector('#share-link').value")).split('/f/')[1];
  });
  for (const mode of ['classic', 'conversational']) {
    await step(`submit form (${mode})`, async () => {
      await open(`/f/${formSlug}?mode=${mode}`, "document.querySelector('#form-root form')");
      await layoutCheck(`public form ${mode}`);
      const answer = async (selector, value) => { await fill(selector, value); if (mode === 'conversational') await click('#form-root [type="submit"]'); };
      await click('#form-root [type="submit"]'); // empty submit must show an error, not advance
      await waitFor("document.querySelector('#form-root .field-error')", 'required error');
      await answer('#q-name', 'Mia');
      await waitFor("document.querySelector('#q-email')", 'email question');
      const piped = await evaluate("document.querySelector('label[for=q-email]').innerText");
      if (!piped.includes('Mia')) throw new Error('answer piping missing: ' + piped);
      await answer('#q-email', 'mia@example.com');
      await waitFor("document.querySelector('[name=topic]')", 'choice question');
      await evaluate("const o = document.querySelector('[name=topic][value=other]'); o.checked = true; o.dispatchEvent(new Event('change', { bubbles: true }))");
      if (mode === 'conversational') await click('#form-root [type="submit"]');
      await waitFor("document.querySelector('#q-details')", 'conditional question');
      await fill('#q-details', 'A garden redesign');
      await click('#form-root [type="submit"]');
      await waitFor("document.body.innerText.includes('Thank you')", 'thank-you');
    });
  }
  await step('responses inbox and CSV', async () => {
    await open('/forms', "document.querySelector('.list')");
    await evaluate("[...document.querySelectorAll('a')].find(a => a.textContent === 'Responses').click()");
    await waitFor("document.querySelector('table')", 'responses table');
    await layoutCheck('responses');
    const csv = await evaluate("fetch(document.querySelector('a[download]').href).then(r => r.text())");
    if (!csv.includes('A garden redesign')) throw new Error('CSV missing answer');
  });
  await step('create and enable flow', async () => {
    await open('/flow/new', "document.querySelector('#flow-form')");
    await layoutCheck('flow editor');
    await fill('#name', 'Prep task');
    await fill('#status', 'enabled');
    await click('#flow-form [type="submit"]');
    await waitFor("/^\\/flow\\/[0-9a-f-]{36}$/.test(location.pathname)", 'saved flow');
    await click('#simulate');
    await waitFor("document.querySelector('#simulation h2')", 'simulation');
  });
  await step('flow runs after a booking', async () => {
    await open(`/meet/${workspaceSlug}/${eventSlug}`, "document.querySelector('.day[data-available]')");
    await click('.day[data-available]'); await click('.slot');
    await fill('#name', 'Lee'); await fill('#email', 'lee@example.com');
    await click('#invitee-form [type="submit"]');
    await waitFor("document.body.innerText.includes('You are scheduled')", 'second booking');
    await new Promise(resolve => setTimeout(resolve, 1500));
    await open('/flow/tasks', "document.querySelector('.list, .empty')");
    if (!(await text()).includes('Prepare for Lee')) throw new Error('task not created');
    await open('/flow/runs', "document.querySelector('table')");
    await layoutCheck('flow runs');
  });
  await step('billing test checkout', async () => {
    await open('/billing', "document.querySelector('[data-action=checkout]')");
    await layoutCheck('billing');
    await click('[data-action="checkout"][data-plan="suite"]');
    await waitFor("document.body.innerText.includes('Suite plan')", 'subscription listed');
  });
  await step('account page', async () => { await open('/account', "document.querySelector('#members .list')"); await layoutCheck('account'); });
} finally {
  socket.close();
  browser.kill();
  await app.stop();
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* browser may still hold the profile */ }
}

console.log(steps.join('\n'));
console.log(`\n${checks} layout checks across ${WIDTHS.join('/')} px in light and dark themes.`);
if (problems.length) { console.log('\nProblems:\n- ' + [...new Set(problems)].join('\n- ')); process.exit(1); }
console.log('No runtime errors, overflow or failed journeys.');
