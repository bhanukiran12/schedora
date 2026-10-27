// End-to-end browser verification without dependencies: drives headless Chrome or Edge over the
// DevTools protocol against a fresh in-process server and database.
// Checks every page for runtime errors and horizontal overflow at 320/375/768/1280 px in light
// and dark themes, then runs the core journeys: sign up, publish an event type, book, manage,
// build/publish/submit a form (both presentations), create a flow, and billing.
// Usage: CHROME_PATH=<browser executable> npm run browser-check [-- --screenshots <dir>]
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
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
const app = createApp({ databasePath: join(workDir, 'test.db'), configOverrides: { workerIntervalMs: 500, rateLimitPerMinute: 100000 }, log: () => {} });
await app.start();
await new Promise(resolve => app.server.close(resolve));
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
app.config.baseUrl = base; // links in emails and payment redirects point at this test server

const port = 9300 + Math.floor(Math.random() * 500);
const browser = spawn(browserPath, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(workDir, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', 'about:blank'], { stdio: 'ignore' });
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
// Browser-check fixture: when enabled, the SDK module request is answered with a stand-in Room.
const fakeRoomModule = Buffer.from(readFileSync(new URL('./browser-fixtures/livekit-fake-room.mjs', import.meta.url), 'utf8')).toString('base64');
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === 'Fetch.requestPaused') send('Fetch.fulfillRequest', { requestId: message.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/javascript; charset=utf-8' }, { name: 'Cache-Control', value: 'no-store' }], body: fakeRoomModule }).catch(() => {});
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
// CI parity: CI runs in UTC with an en-US browser. Set BROWSER_TIMEZONE / BROWSER_LOCALE to reproduce it locally.
if (process.env.BROWSER_TIMEZONE) await send('Emulation.setTimezoneOverride', { timezoneId: process.env.BROWSER_TIMEZONE });
if (process.env.BROWSER_LOCALE) await send('Emulation.setLocaleOverride', { locale: process.env.BROWSER_LOCALE });

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
  catch (error) {
    const seen = await evaluate("location.pathname + ' | ' + (document.querySelector('#main')?.innerText || '').split(String.fromCharCode(10)).join(' ').slice(0, 160)").catch(() => '');
    steps.push(`✗ ${name}: ${error.message}`);
    problems.push(`${name}: ${error.message} [page: ${seen}]`);
  }
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
    await waitFor("/^\\/meet\\/event-types\\/[0-9a-f-]{36}$/.test(location.pathname) && document.querySelector('#slug')", 'saved event type');
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
    await open('/meet?tab=meetings', "document.querySelector('#tab-panel .list, #tab-panel .empty')");
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
    await waitFor("/^\\/flow\\/[0-9a-f-]{36}$/.test(location.pathname) && document.querySelector('#simulate')", 'saved flow');
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
  await step('account page and settings', async () => {
    await open('/account', "document.querySelector('#members .list') && document.querySelector('#brand-form')");
    await layoutCheck('account');
    await fill('#k-name', 'Laptop'); await click('#key-form [type="submit"]');
    await waitFor("document.querySelector('#new-key input')?.value.startsWith('sch_')", 'new API key shown');
  });
  for (const tab of ['meetings', 'video', 'polls', 'contacts', 'workflows', 'analytics', 'integrations', 'insights']) {
    await step(`Meet tab: ${tab}`, async () => { await open(`/meet?tab=${tab}`, "document.querySelector('#tab-panel') && !document.querySelector('#tab-panel > .loading')"); await layoutCheck(`meet ${tab}`); });
  }
  await step('Meet navigation: every section reachable on mobile, keyboard menu, quiet cancel still confirms', async () => {
    await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 1, mobile: true });
    await open('/meet?tab=meetings', "document.querySelector('.tab-more summary') && !document.querySelector('#tab-panel > .loading')");
    const shown = await evaluate("[...document.querySelectorAll('.meet-tabs > a')].filter(a => a.getClientRects().length).map(a => a.textContent).join()");
    if (shown !== 'Event types,Meetings,Video') throw new Error('unexpected visible tabs: ' + shown);
    if ((await evaluate('document.documentElement.scrollWidth - innerWidth')) > 0) throw new Error('mobile navigation overflows');
    await click('.tab-more summary');
    const menu = await evaluate("[...document.querySelectorAll('.tab-more li a')].filter(a => a.getClientRects().length).map(a => a.getAttribute('href').split('tab=')[1]).join()");
    if (menu !== 'polls,contacts,workflows,analytics,integrations,insights,emails') throw new Error('menu is missing sections: ' + menu);
    await evaluate("document.querySelector('.tab-more li a').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    if (await evaluate("document.querySelector('.tab-more').open || !document.activeElement.matches('.tab-more summary')")) throw new Error('Escape did not close the menu and return focus');
    await click('[data-cancel]');
    await waitFor("document.querySelector('dialog[open]')?.innerText.includes('Cancel this meeting?')", 'cancel confirmation');
    await click('dialog[open] button[value=cancel]');
    await open('/meet?tab=analytics', "document.querySelector('.tab-more summary[aria-current=page]')");
    if (!(await evaluate("document.querySelector('.tab-more summary').innerText.includes('More: Analytics') && document.querySelector('h1').innerText === 'Analytics'"))) throw new Error('active section not shown in the menu or heading');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  });
  await step('poll: create, vote, view results', async () => {
    await open('/meet?tab=polls', "document.querySelector('#new-poll')");
    await click('#new-poll');
    await fill('#poll-title', 'Planning');
    await evaluate("{ const input = document.querySelector('[data-option]'); input.value = '2026-11-03T10:00'; input.dispatchEvent(new Event('change', { bubbles: true })); }");
    await click('#add-option');
    await evaluate("{ const input = document.querySelectorAll('[data-option]')[1]; input.value = '2026-11-04T10:00'; input.dispatchEvent(new Event('change', { bubbles: true })); }");
    await click('#create-poll [type="submit"]');
    await waitFor("document.querySelector('[data-open]')", 'poll listed');
    const pollPath = await evaluate("new URL(document.querySelector('[data-copy]').dataset.copy).pathname");
    await open(pollPath, "document.querySelector('#vote')");
    await layoutCheck('public poll');
    await evaluate("document.querySelector('#vote input[type=checkbox]').checked = true");
    await fill('#v-name', 'Ana'); await fill('#v-email', 'ana@example.com');
    await click('#vote [type="submit"]');
    await waitFor("document.body.innerText.includes('Responded: Ana')", 'vote recorded');
  });
  await step('team round-robin event via editor', async () => {
    await open('/meet/event-types/new?kind=round_robin', "document.querySelector('#event-form')");
    await layoutCheck('event editor team');
    await fill('#title', 'Team demo');
    await click('#event-form [type="submit"]');
    await waitFor("/^\\/meet\\/event-types\\/[0-9a-f-]{36}$/.test(location.pathname) && document.querySelector('#slug')", 'saved team event');
  });
  await step('public workspace page and embedded booking', async () => {
    await open(`/meet/${workspaceSlug}`, "document.querySelector('.event-grid')");
    await layoutCheck('workspace page');
    await open(`/embed/meet/${workspaceSlug}/${eventSlug}`, "document.querySelector('.day[data-available]')");
    if (!(await evaluate("document.body.dataset.embed === '1' && getComputedStyle(document.querySelector('.site-header')).display === 'none'"))) throw new Error('embed mode not applied');
  });
  await step('paid booking with test checkout', async () => {
    await open('/meet/event-types/new', "document.querySelector('#event-form')");
    await fill('#title', 'Paid session'); await fill('#min_notice_hours', '0'); await fill('#price', '499');
    await evaluate("document.querySelector('[name=published]').checked = true");
    await click('#event-form [type="submit"]');
    await waitFor("/^\\/meet\\/event-types\\/[0-9a-f-]{36}$/.test(location.pathname) && document.querySelector('#slug')", 'saved paid event');
    const paidSlug = await evaluate("document.querySelector('#slug').value");
    await open(`/meet/${workspaceSlug}/${paidSlug}`, "document.querySelector('.day[data-available]')");
    await evaluate("[...document.querySelectorAll('.day[data-available]')].pop().click()");
    await click('.slot');
    await fill('#name', 'Payer'); await fill('#email', 'payer@example.com');
    await click('#invitee-form [type="submit"]');
    await waitFor("location.pathname.startsWith('/meet/pay/') && document.querySelector('#simulate-pay')", 'test checkout');
    await layoutCheck('test checkout');
    await click('#simulate-pay');
    await waitFor("document.body.innerText.includes('Payment received')", 'payment confirmed');
  });
  // Create → book → join for a Schedora Meet event (fake provider, isolated test server only).
  let videoManage;
  await step('video booking: create event, book, exact join instructions, email and join link', async () => {
    await open('/meet/event-types/new', "document.querySelector('#new-location')");
    if (!(await evaluate("document.querySelector('#new-location').closest('section').querySelector('#title') !== null"))) throw new Error('location is not in the details section');
    await fill('#title', 'Video consult'); await fill('#min_notice_hours', '0');
    await evaluate("document.querySelector('[name=published]').checked = true");
    await evaluate("const s = document.querySelector('#new-location'); s.value = 'schedora_meet'; s.dispatchEvent(new Event('change', { bubbles: true }))");
    if (!(await evaluate("document.querySelector('#location-help').innerText.includes('personal join link')"))) throw new Error('location help missing');
    await layoutCheck('event editor location');
    await click('#add-location');
    await click('#event-form [type="submit"]');
    await waitFor("/^\\/meet\\/event-types\\/[0-9a-f-]{36}$/.test(location.pathname) && document.querySelector('#slug')", 'saved video event');
    const videoSlug = await evaluate("document.querySelector('#slug').value");
    await open(`/meet/${workspaceSlug}/${videoSlug}`, "document.querySelector('.day[data-available]')");
    const zoneText = await evaluate("document.querySelector('#invitee-zone').selectedOptions[0].textContent");
    if (!/\(UTC[+-]\d\d:\d\d\)/.test(zoneText)) throw new Error('zone option is not friendly: ' + zoneText);
    await evaluate("[...document.querySelectorAll('.day[data-available]')].pop().click()");
    await evaluate("[...document.querySelectorAll('.slot')].pop().click()");
    await waitFor("document.querySelector('#invitee-form')", 'details form');
    if (!(await evaluate("/\\(UTC[+-]\\d\\d:\\d\\d\\)/.test(document.querySelector('#selection-summary').innerText)"))) throw new Error('selection summary lacks a friendly zone');
    await fill('#name', 'Vid Invitee'); await fill('#email', 'vid@example.com');
    await click('#invitee-form [type="submit"]');
    await waitFor("document.body.innerText.includes('You are scheduled') && document.querySelector('.join-block a')", 'video confirmation');
    await layoutCheck('video booking confirmation');
    const page = await evaluate("({ text: document.querySelector('#booking-main').innerText, href: document.querySelector('.join-block a').getAttribute('href') })");
    for (const expected of ['Starts', 'Link opens', 'How to join the video meeting', 'If you arrive before the host']) if (!page.text.includes(expected)) throw new Error('confirmation missing: ' + expected);
    if (/a few minutes/i.test(page.text) || /Asia\/Calcutta/.test(page.text)) throw new Error('vague or raw-zone wording remains');
    const booking = app.db.get("SELECT id, starts_at FROM bookings WHERE invitee_email = 'vid@example.com'");
    const room = app.db.get('SELECT r.join_opens_at FROM video_rooms r JOIN bookings b ON b.meeting_id = r.meeting_id WHERE b.id = ?', booking.id);
    if (room.join_opens_at !== booking.starts_at - app.config.video.joinEarlyMinutes * 60000) throw new Error('room window does not match the configured policy');
    const email = app.db.get("SELECT body FROM emails WHERE kind = 'confirmation' AND to_address = 'vid@example.com'").body;
    if (!email.includes(page.href) || !/The link opens .*\(UTC[+-]\d\d:\d\d\)/.test(email)) throw new Error('email join link or opening time missing');
    videoManage = await evaluate("[...document.querySelectorAll('a')].find(a => a.textContent.includes('Reschedule')).getAttribute('href')");
    await open(new URL(page.href, base).pathname, "document.querySelector('#main h1')");
    await waitFor("document.body.innerText.includes('Opens at') || document.querySelector('#join-form')", 'join page shows its opening time or prejoin');
    await layoutCheck('video join page before opening');
  });
  await step('video booking: video switched off shows no join link (isolated server setting)', async () => {
    app.config.video.enabled = false;
    try {
      await open(videoManage, "document.querySelector('.confirm-facts')");
      if (await evaluate("Boolean(document.querySelector('.join-block a'))")) throw new Error('join link offered while video is off');
      if (!(await text()).includes('video link for this appointment is not available right now')) throw new Error('no explanation while video is off');
      await open('/meet/event-types/new', "document.querySelector('#new-location')");
      if (!(await evaluate("document.querySelector('#new-location option[disabled]')?.textContent.includes('not available yet') && document.querySelector('#video-unavailable')"))) throw new Error('disabled video option or explanation missing');
    } finally { app.config.video.enabled = true; }
  });
  // Schedora Meet video with the fake provider: real prejoin, devices (fake camera/microphone),
  // headers and cleanup. The fake provider has no media server, so connecting must fail cleanly.
  const expectedConnectionNoise = /livekit|websocket|ws:\/\/127\.0\.0\.1:7880|Refused to connect|signal|could not establish|connection/i;
  let roomPath;
  await step('video: instant meeting prejoin with camera preview', async () => {
    await open('/meet?tab=video', "document.querySelector('#instant')");
    await fill('#instant-title', 'Browser check meeting');
    await click('#instant [type="submit"]');
    await waitFor("location.pathname.startsWith('/meet/room/') && document.querySelector('#join-form')", 'prejoin');
    roomPath = await evaluate('location.pathname');
    await waitFor("document.querySelector('#preview')?.srcObject?.getVideoTracks().length === 1", 'camera preview', 10000);
    const headers = await evaluate("fetch(location.href).then(r => [r.headers.get('permissions-policy'), r.headers.get('referrer-policy'), r.headers.get('content-security-policy')].join(' | '))");
    if (!/camera=\(self\)/.test(headers) || !/no-referrer/.test(headers) || !/media-src/.test(headers)) throw new Error('meeting headers missing: ' + headers);
    const strict = await evaluate("fetch('/meet').then(r => r.headers.get('permissions-policy'))");
    if (!/camera=\(\)/.test(strict)) throw new Error('camera allowed outside meetings');
    await layoutCheck('video prejoin');
    await click('#toggle-camera');
    await waitFor("!document.querySelector('#preview-off').hidden && document.querySelector('#toggle-camera').textContent === 'Turn camera on' && document.querySelector('#media-state').textContent.includes('Camera off')", 'camera off');
    await click('#toggle-camera');
    await waitFor("document.querySelector('#preview')?.srcObject?.getVideoTracks()[0]?.readyState === 'live'", 'camera back on', 10000);
  });
  await step('video: join reaches the provider and fails cleanly without a media server', async () => {
    const before = problems.length;
    await fill('#display-name', 'Asha');
    await click('#join-form [type="submit"]');
    await waitFor("document.body.innerText.includes('could not connect to the video service') || document.body.innerText.includes('You were disconnected')", 'connection failure state', 20000);
    if (await evaluate("document.body.innerText.includes('paused or not set up')")) throw new Error('failure screen guesses a cause');
    if (await evaluate("Boolean(document.querySelector('#preview'))")) throw new Error('prejoin still mounted');
    problems.splice(before, problems.length - before, ...problems.slice(before).filter(problem => !expectedConnectionNoise.test(problem)));
    await layoutCheck('video connection failed');
  });
  await step('video: guest link waits for the host; leaving releases devices', async () => {
    const invitePath = roomPath.replace('/meet/room/', '/api/meet-video/rooms/') + '/invites';
    const url = await evaluate(`(async () => { const me = await (await fetch('/api/me')).json(); const response = await fetch(${JSON.stringify(invitePath)}, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: '{}' }); return (await response.json()).url; })()`);
    await open(new URL(url).pathname, "document.querySelector('#join-form')");
    await layoutCheck('guest prejoin');
    await fill('#display-name', 'Guest');
    await click('#join-form [type="submit"]');
    await waitFor("document.body.innerText.includes('Waiting for the host')", 'waiting for host');
    await open('/meet', "document.querySelector('.tabs')");
  });
  // Meeting room UI with a fake-connected Room (fixture above): layout, controls, devices, recovery.
  // Synthetic camera/microphone and no media server: this checks the interface, not real media.
  const pageApi = (path, body) => evaluate(`(async () => { const me = await (await fetch('/api/me')).json(); const response = await fetch(${JSON.stringify(path)}.replace(':ws', me.workspaces[0].id), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: ${JSON.stringify(JSON.stringify(body ?? {}))} }); return response.status === 204 ? null : response.json(); })()`);
  const inView = selector => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1; })()`);
  const viewport = (width, height = 800) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 });
  const shot = async name => {
    if (!shotsDir) return;
    for (const width of [375, 1440]) {
      await viewport(width, width < 768 ? 800 : 900);
      await new Promise(resolve => setTimeout(resolve, 150));
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(shotsDir, `task4-${name}-${width}.png`), Buffer.from(data, 'base64'));
    }
  };
  const withFakeRoom = async fn => {
    await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Fetch.enable', { patterns: [{ urlPattern: '*/vendor/livekit-client.esm.mjs', requestStage: 'Request' }] });
    try { await fn(); } finally {
      await send('Fetch.disable'); await send('Network.setCacheDisabled', { cacheDisabled: false });
      await viewport(1280, 900);
    }
  };
  const enterRoom = async () => {
    await click('#join-form [type="submit"]');
    await waitFor("document.querySelector('#video-room') && document.querySelector('#connection')?.dataset.state === 'connected'", 'meeting room connected', 15000);
  };
  await step('video room (fake-connected fixture): prejoin labels, meter, full-viewport room, controls, devices, share guidance, recovery, end', async () => {
    await withFakeRoom(async () => {
      await viewport(375);
      const room = await pageApi('/api/workspaces/:ws/meet-video/rooms', { title: 'Room check' });
      await open(new URL(room.host_url).pathname, "document.querySelector('#join-form')");
      await waitFor("document.body.dataset.micMeter === 'on' && document.querySelector('#preview')?.srcObject", 'microphone meter running', 10000);
      if ((await evaluate("[document.querySelector('#toggle-camera').textContent, document.querySelector('#toggle-mic').textContent].join()")) !== 'Turn camera off,Mute microphone') throw new Error('prejoin labels');
      if (!(await evaluate("document.querySelector('#mic-level') && document.querySelector('label[for=mic-level]').textContent === 'Microphone level'"))) throw new Error('meter has no label');
      for (const height of [800, 667]) { // includes a small phone; fonts differ between platforms
        await viewport(375, height);
        if (!(await inView('#join-button'))) throw new Error(`Join is not visible without scrolling at 375×${height}`);
      }
      await viewport(375);
      await click('#toggle-mic');
      await waitFor("document.querySelector('#toggle-mic').textContent === 'Unmute microphone' && document.querySelector('#media-state').textContent.includes('Microphone muted') && !document.body.dataset.micMeter", 'mic muted and meter stopped');
      await click('#toggle-mic');
      await waitFor("document.body.dataset.micMeter === 'on'", 'meter restarted');
      await shot('prejoin');
      await layoutCheck('prejoin with meter');
      await enterRoom();
      if (await evaluate('Boolean(document.body.dataset.micMeter)')) throw new Error('meter still running after joining');
      for (const width of [375, 1440]) {
        await viewport(width, width < 768 ? 800 : 900);
        await new Promise(resolve => setTimeout(resolve, 100));
        const layout = await evaluate("({ header: getComputedStyle(document.querySelector('#site-header')).display, scroll: document.documentElement.scrollHeight - innerHeight, wide: document.documentElement.scrollWidth - innerWidth })");
        if (layout.header !== 'none' || layout.scroll > 0 || layout.wide > 0) throw new Error(`room is not a full-viewport surface at ${width}: ${JSON.stringify(layout)}`);
        for (const control of ['#mic', '#cam', '#share', '#devices-toggle', '#people-toggle', '#leave', '#end-all']) if (!(await inView(control))) throw new Error(`${control} not visible at ${width}px`);
      }
      if (!(await evaluate("Boolean(document.querySelector('.video-bar #end-all')) && !document.querySelector('.video-controls #end-all') && document.querySelector('#leave').closest('.video-controls')"))) throw new Error('Leave and End for everyone are not separated');
      if ((await evaluate("getComputedStyle(document.querySelector('#enable-audio')).display")) !== 'none') throw new Error('sound prompt shown while playback is allowed');
      await evaluate("window.__fakeRoom.addRemote('Ravi')");
      await waitFor("document.querySelectorAll('.video-tile').length === 2", 'remote tile');
      await shot('room');
      await viewport(375);
      await click('#mic');
      await waitFor("document.querySelector('#mic').textContent === 'Unmute microphone' && document.querySelector('#room-media-state').textContent.includes('Microphone muted')", 'muted in room');
      // Device menu: switching keeps the muted microphone muted; Escape returns focus.
      await click('#devices-toggle');
      await waitFor("!document.querySelector('#devices-panel').hidden && document.querySelector('#devices-panel').contains(document.activeElement)", 'devices panel focused');
      await waitFor("document.querySelector('#dev-audioinput').options.length > 1", 'microphones listed');
      await evaluate("{ const s = document.querySelector('#dev-audioinput'); s.value = s.options[s.options.length - 1].value; s.dispatchEvent(new Event('change', { bubbles: true })) }");
      await waitFor("document.querySelector('#device-message').innerText.includes('Switched microphone')", 'switched');
      const switched = await evaluate('window.__fakeSwitches.at(-1)');
      if (switched[0] !== 'audioinput' || switched[2] !== false || switched[3] !== true) throw new Error('switch did not preserve state: ' + JSON.stringify(switched));
      if ((await evaluate("document.querySelector('#mic').textContent")) !== 'Unmute microphone') throw new Error('mute state lost after switching');
      if (!(await evaluate("Boolean(document.querySelector('#dev-audiooutput') || document.querySelector('#no-output'))"))) throw new Error('speaker choice or explanation missing');
      await evaluate("{ const s = document.querySelector('#dev-videoinput'); s.add(new Option('Broken camera', 'fail')); s.value = 'fail'; s.dispatchEvent(new Event('change', { bubbles: true })) }");
      await waitFor("document.querySelector('#device-message').innerText.includes('could not start')", 'switch failure explained');
      if (await evaluate("/join with/i.test(document.querySelector('#device-message').innerText)")) throw new Error('prejoin wording shown inside the meeting');
      await shot('devices');
      await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      if (!(await evaluate("document.querySelector('#devices-panel').hidden && document.activeElement.id === 'devices-toggle'"))) throw new Error('Escape did not close the panel and return focus');
      // Screen sharing: OS block and cancelled picker get different guidance.
      await evaluate("window.__fakeShareError = { name: 'NotAllowedError', message: 'Permission denied by system' }");
      await click('#share');
      await waitFor("document.querySelector('#room-alerts').innerText.includes('Screen Recording')", 'system share guidance');
      await shot('share-blocked');
      await evaluate("window.__fakeShareError = { name: 'NotAllowedError', message: 'Permission denied' }");
      await click('#share');
      await waitFor("document.querySelector('#room-alerts').innerText.includes('If you chose Cancel')", 'cancelled picker guidance');
      await evaluate('window.__fakeShareError = null');
      await click('#share');
      await waitFor("document.querySelector('#share').textContent === 'Stop sharing'", 'sharing');
      await click('#share');
      // Reconnecting, then a recoverable drop: the server still lists us, so Rejoin is offered.
      await evaluate("window.__fakeRoom.emit('reconnecting')");
      await waitFor("document.querySelector('#connection').textContent === 'Reconnecting…' && document.querySelector('#room-alerts').innerText.includes('Reconnecting')", 'reconnecting state');
      await evaluate("window.__fakeRoom.emit('reconnected')");
      await waitFor("document.querySelector('#connection').textContent === 'Connected'", 'reconnected');
      await evaluate("window.__fakeRoom.drop('UNKNOWN_REASON')");
      await waitFor("document.body.innerText.includes('You were disconnected') && document.querySelector('#rejoin')", 'recoverable disconnect with rejoin');
      if (await evaluate("Boolean(document.body.dataset.inMeeting) || getComputedStyle(document.querySelector('#site-header')).display === 'none'")) throw new Error('room chrome not restored');
      await shot('disconnected');
      // Rejoin goes through admission again, then the host ends the meeting for everyone.
      await click('#rejoin');
      await waitFor("document.querySelector('#join-form')", 'prejoin after rejoin');
      await enterRoom();
      await click('#end-all');
      await waitFor("document.querySelector('dialog[open]')?.innerText.includes('End the meeting for everyone?')", 'end confirmation');
      await click('dialog[open] button[value=ok]');
      await waitFor("document.body.innerText.includes('You ended the meeting for everyone')", 'ended');
      if (await evaluate("Boolean(document.querySelector('#rejoin'))")) throw new Error('rejoin offered after the meeting ended');
    });
  });
  await step('video room (fake-connected fixture): removal is named only when the server confirms it; no rejoin', async () => {
    await withFakeRoom(async () => {
      const room = await pageApi('/api/workspaces/:ws/meet-video/rooms', { title: 'Removal check' });
      const invite = await pageApi(`/api/meet-video/rooms/${room.public_id}/invites`, { seats: 2 });
      app.db.run('UPDATE video_rooms SET host_joined_at = ? WHERE public_id = ?', Date.now(), room.public_id);
      await open(new URL(invite.url).pathname, "document.querySelector('#join-form')");
      await fill('#display-name', 'Removable guest');
      await enterRoom();
      const guest = app.db.get("SELECT id FROM video_participants WHERE display_name = 'Removable guest'");
      await pageApi(`/api/meet-video/rooms/${room.public_id}/participants/${guest.id}/remove`);
      await evaluate("window.__fakeRoom.drop('PARTICIPANT_REMOVED')");
      await waitFor("document.body.innerText.includes('A host removed you from this meeting')", 'confirmed removal');
      if (await evaluate("Boolean(document.querySelector('#rejoin'))")) throw new Error('rejoin offered after removal');
      await shot('removed');
    });
  });
  await step('video prejoin: denied camera and microphone give guidance and still allow joining', async () => {
    const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', { source: "navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));" });
    try {
      await withFakeRoom(async () => {
        await viewport(375);
        const room = await pageApi('/api/workspaces/:ws/meet-video/rooms', { title: 'Denied check' });
        await open(new URL(room.host_url).pathname, "document.querySelector('#join-form')");
        await waitFor("document.querySelector('#device-status').innerText.includes('blocking the camera') && document.querySelector('#device-status').innerText.includes('blocking the microphone')", 'denial guidance');
        if ((await evaluate("[document.querySelector('#toggle-camera').textContent, document.querySelector('#toggle-mic').textContent].join()")) !== 'Turn camera on,Unmute microphone') throw new Error('toggles do not show media off');
        await shot('permission-denied');
        await enterRoom();
        if ((await evaluate("document.querySelector('#room-media-state').textContent")) !== 'Camera off · Microphone muted') throw new Error('joined with unexpected media state');
        await click('#leave');
        await waitFor("document.body.innerText.includes('You left the meeting') && document.querySelector('#rejoin')", 'left');
      });
    } finally { await send('Page.removeScriptToEvaluateOnNewDocument', { identifier }); }
  });
  await step('video: pending media permission cannot submit the prejoin page as a GET', async () => {
    const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', { source: "navigator.mediaDevices.getUserMedia = () => new Promise(() => {});" });
    const before = problems.length;
    try {
      await open(roomPath, "document.querySelector('#join-form')");
      await fill('#display-name', 'Pending permission');
      await click('#toggle-camera');
      await click('#toggle-mic');
      await click('#join-form [type="submit"]');
      await waitFor("document.querySelector('#video-room') || document.body.innerText.includes('could not connect to the video service')", 'join without media permission');
      if (await evaluate("location.search.includes('display_name')")) throw new Error('prejoin submitted the name in the URL');
      await waitFor("document.body.innerText.includes('could not connect to the video service') || document.body.innerText.includes('You were disconnected')", 'connection failure state', 20000);
    if (await evaluate("document.body.innerText.includes('paused or not set up')")) throw new Error('failure screen guesses a cause');
      problems.splice(before, problems.length - before, ...problems.slice(before).filter(problem => !expectedConnectionNoise.test(problem)));
    } finally { await send('Page.removeScriptToEvaluateOnNewDocument', { identifier }); }
  });
  await step('video: credits, calculator and simulated recharge', async () => {
    await open('/billing', "document.querySelector('#credits-title')");
    await fill('#calc-people', '3'); await fill('#calc-minutes', '45');
    await click('#calculator [type="submit"]');
    await waitFor("document.querySelector('#calc-result').innerText.includes('135 participant-minutes')", 'calculator result');
    await click('[data-buy="small"]');
    await waitFor("document.querySelector('[data-test-pay]')", 'pending purchase');
    await click('[data-test-pay]');
    await waitFor("[...document.querySelectorAll('.credit-figure')][1]?.innerText === '500'", 'purchased credits shown');
    await waitFor("document.querySelector('#ledger tr')", 'ledger rows');
    await layoutCheck('billing credits');
  });
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
