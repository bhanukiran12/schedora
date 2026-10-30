// End-to-end browser verification without dependencies: drives headless Chrome or Edge over the
// DevTools protocol against a fresh in-process server and database.
// Checks every page for runtime errors and horizontal overflow at 320/375/768/1280 px in light
// and dark themes, then runs the core journeys: sign up, publish an event type, book, manage,
// build/publish/submit a form (both presentations, save conflicts, lost replies, Meet handoff),
// create a flow, and billing.
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
const app = createApp({ databasePath: join(workDir, 'test.db'), configOverrides: { port: 0, workerIntervalMs: 500, rateLimitPerMinute: 100000 }, log: () => {} });
await app.start();
await new Promise(resolve => app.server.close(resolve));
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
app.config.baseUrl = base; // links in emails and payment redirects point at this test server

const port = 9300 + Math.floor(Math.random() * 500);
const browser = spawn(browserPath, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(workDir, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let browserDiagnostic = '';
let browserSpawnError;
browser.stderr.setEncoding('utf8');
browser.stderr.on('data', chunk => { browserDiagnostic = (browserDiagnostic + chunk).slice(-8192); });
browser.on('error', error => { browserSpawnError = error; });
let target;
for (let attempt = 0; attempt < 150 && !target; attempt++) {
  if (browserSpawnError || browser.exitCode !== null || browser.signalCode !== null) break;
  await new Promise(resolve => setTimeout(resolve, 200));
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page'); } catch { /* starting */ }
}
if (!target) {
  browser.kill();
  await app.stop();
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* browser may still be closing */ }
  throw new Error(`Browser did not start: ${browserPath}; exit=${browser.exitCode}; signal=${browser.signalCode}; ${browserSpawnError?.message || ''}\n${browserDiagnostic || 'No browser diagnostic output.'}`);
}

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
  await send('Page.navigate', { url: /^https?:/.test(path) ? path : base + path });
  await waitFor(`document.readyState === 'complete' && ${ready}`, `${path} to render`);
}
const fill = (selector, value) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('missing ${selector}'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const click = selector => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('missing ${selector}'); el.click(); })()`);
const text = () => evaluate('document.querySelector("#main").innerText');

const WIDTHS = [320, 375, 768, 1280];
let checks = 0;
async function layoutCheck(name, screenshotAnchor) {
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
        if (screenshotAnchor) await evaluate(`document.querySelector(${JSON.stringify(screenshotAnchor)})?.scrollIntoView({block:'start'})`);
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
  await step('Suite split-screen authentication and safe switching', async () => {
    await open('/signup', "document.querySelector('#signup')");
    if ((await evaluate("document.querySelectorAll('.auth-layout .ds-signup-benefit').length")) !== 3) throw new Error('Suite auth must show three products');
    if (await evaluate("document.querySelector('.auth-layout').innerText.includes('DEMO SETUP')")) throw new Error('real auth uses demo copy');
    await layoutCheck('Suite signup');
    await open('/login?next=%2F%2Fevil.example', "document.querySelector('#signin')");
    if (await evaluate("Boolean(document.querySelector('#signup'))")) throw new Error('login shows competing signup form');
    await layoutCheck('Suite login');
  });
  for (const path of ['/', '/meet', '/forms', '/flow', '/billing', '/account', '/privacy', '/terms', '/missing-page']) {
  await step(`render ${path}`, async () => { await open(path); await layoutCheck(path); });
  }
  await step('dismiss consent', async () => { await click('.cookie-banner [data-choice="rejected"]'); });
  let workspaceSlug;
  await step('sign up', async () => {
    await open('/account?mode=signup&next=/meet');
    await fill('#su-name', 'Asha Host'); await fill('#su-email', 'asha@example.com'); await fill('#su-password', 'a long test password'); await fill('#su-workspace', 'Asha Studio');
    await click('#signup [type="submit"]');
    await waitFor("location.pathname === '/meet' && document.querySelector('.side-nav')", 'Meet dashboard');
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
    // Local outbox, provider acceptance and mail-server delivery are named separately; nothing claims an inbox.
    if (!(await text()).includes('This server uses the local outbox: messages are recorded here and never sent.')) throw new Error('delivery levels not explained');
    if (!(await evaluate("document.querySelector('table').innerText.includes('Recorded in the local outbox; not delivered to an inbox.')"))) throw new Error('sent outbox email shown without its transport');
    if (await evaluate("/Delivered to the recipient|Accepted by the email provider/.test(document.querySelector('table').innerText)")) throw new Error('outbox email described as provider-accepted or delivered');
    await layoutCheck('email delivery');
  });
  await step('Meet readiness: saved-state summary, unsaved edits, fix links; preview and copy change nothing', async () => {
    const typeId = app.db.get("SELECT id FROM event_types WHERE slug = 'intro-call'").id;
    const hostApi = (method, path, body) => evaluate(`(async () => { const me = await (await fetch('/api/me')).json(); const r = await fetch('/api/workspaces/' + me.workspaces[0].id + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: ${JSON.stringify(JSON.stringify(body))} }); return r.status === 204 ? null : r.json(); })()`);
    const sideEffects = () => JSON.stringify(app.db.get('SELECT (SELECT COUNT(*) FROM bookings) AS bookings, (SELECT COUNT(*) FROM emails) AS emails, (SELECT COUNT(*) FROM meetings) AS meetings, (SELECT published FROM event_types WHERE id = ?) AS published', typeId));
    const areaText = key => evaluate(`document.querySelector('#ready-${key}').closest('details').textContent.replace(/\\s+/g, ' ')`);
    const ready = "document.querySelector('#readiness .readiness-areas')";

    await open('/meet/event-types/' + typeId, ready);
    const titles = await evaluate("[...document.querySelectorAll('.readiness-area > summary')].map(h => h.textContent.replace(/\\s+/g, ' ').trim())");
    if (titles.length !== 4 || !['Event details', 'Availability', 'Calendar and conflicts', 'Sharing'].every((title, index) => titles[index].includes(title))) throw new Error('unexpected areas: ' + titles.join('|'));
    const summary = await evaluate("document.querySelector('#readiness').innerText");
    if (/\d\s*%/.test(summary)) throw new Error('readiness shows a percentage');
    if (!(await areaText('availability')).includes('open start time')) throw new Error('slot check missing');
    if (!(await areaText('calendar')).includes('Needs attention · Optional') || await evaluate("document.querySelector('#ready-calendar').closest('details').dataset.blocking") !== 'false') throw new Error('an optional calendar is not shown as optional');
    if (!(await areaText('details')).includes('Needs attention · Optional: No location is set')) throw new Error('missing location not flagged');
    await layoutCheck('meet readiness (published)');
    // Real Tab key presses: every stop in the card shows the focus indicator.
    await evaluate("document.querySelector('#main a[href=\"/meet\"]').focus()");
    const stops = [];
    for (let index = 0; index < 30; index++) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      const stop = await evaluate("(() => { const el = document.activeElement; const style = getComputedStyle(el); const rect = el.getBoundingClientRect(); return { inCard: Boolean(el.closest('#readiness')), shown: el.matches(':focus-visible') && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2 && rect.bottom > 0 && rect.top < innerHeight, name: el.textContent.trim().slice(0, 30) || el.id }; })()");
      if (!stop.inCard) { if (stops.length) break; continue; }
      stops.push(stop);
    }
    if (stops.length < 3 || stops.some(stop => !stop.shown)) throw new Error('keyboard focus not visible in the readiness card: ' + JSON.stringify(stops));

    // Unsaved edits are named, and the summary keeps describing the saved title.
    await fill('#title', 'Intro call (edited, not saved)');
    await waitFor("document.querySelector('#readiness-unsaved .notice')", 'unsaved notice');
    if ((await areaText('details')).includes('edited, not saved')) throw new Error('summary shows unsaved values');
    // A fix link moves focus to the matching editor section.
    await evaluate("document.querySelector('#readiness [data-goto=\"details\"]').click()");
    if (!(await evaluate("document.activeElement === document.querySelector('#section-details h2')"))) throw new Error('fix link did not focus the Details section');
    await evaluate("delete document.body.dataset.dirty");

    // A draft: required blocker pointing to Visibility, no Copy, Preview separate and harmless.
    await hostApi('PATCH', `/event-types/${typeId}`, { published: false });
    await open('/meet/event-types/' + typeId, ready);
    const sharing = await areaText('sharing');
    if (!sharing.includes('Needs attention · Required: Not published')) throw new Error('draft not flagged as a required blocker: ' + sharing);
    if (await evaluate("Boolean(document.querySelector('#copy-share'))")) throw new Error('copy offered for an unpublished link');
    await evaluate("document.querySelector('#readiness [data-goto=\"visibility\"]').click()");
    if (!(await evaluate("document.activeElement === document.querySelector('#section-visibility h2') && !document.querySelector('[name=published]').checked"))) throw new Error('Visibility fix link wrong or publish pre-ticked');
    const before = sideEffects();
    const preview = await evaluate("(() => { const a = [...document.querySelectorAll('#readiness .share-row a')].find(link => link.textContent.includes('Preview')); return [a.getAttribute('href'), a.target, a.rel]; })()");
    if (!preview[0].endsWith(`/meet/${workspaceSlug}/intro-call`) || preview[1] !== '_blank' || !preview[2].includes('noopener')) throw new Error('preview link wrong: ' + preview);
    const previewPage = await fetch(base + `/api/public/meet/${workspaceSlug}/intro-call`);
    if (previewPage.status !== 404) throw new Error('an anonymous visitor can see the draft');
    if (sideEffects() !== before) throw new Error('preview changed data');
    await layoutCheck('meet readiness (draft)');

    // Published again: Copy reports its outcome and changes nothing.
    await hostApi('PATCH', `/event-types/${typeId}`, { published: true });
    await open('/meet/event-types/' + typeId, ready);
    try { await send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: base }); } catch { /* the failure message is checked instead */ }
    const published = sideEffects();
    await click('#copy-share');
    await waitFor("document.querySelector('#copy-status').textContent.length > 0", 'copy feedback');
    const copied = await evaluate("document.querySelector('#copy-status').textContent");
    if (!/^(Link copied\. This does not test booking, email or video\.|Copy failed\. The link is selected)/.test(copied)) throw new Error('unexpected copy feedback: ' + copied);
    await click('#readiness-heading + [data-recheck]');
    await waitFor("document.querySelector('#readiness-status').textContent.length > 0 && document.querySelector('#readiness .readiness-areas')", 'recheck announcement');
    if (sideEffects() !== published) throw new Error('copy or recheck changed data');

    // Native video selected while the server's feature gate is off is a required blocker.
    const video = await hostApi('POST', '/event-types', { title: 'Video consult', timezone: 'Asia/Kolkata', published: true, min_notice_min: 0, locations: [{ type: 'schedora_meet' }] });
    app.config.video.enabled = false;
    try {
      await open('/meet/event-types/' + video.id, ready);
      if (!(await areaText('details')).includes('Needs attention · Required: Schedora Meet built-in video is selected, but built-in video is turned off on this server')) throw new Error('video gate not reported');
    } finally { app.config.video.enabled = true; }
    await open('/meet/event-types/' + video.id, ready);
    if (!(await areaText('details')).includes('Not verified · Unknown: Schedora Meet built-in video is selected and switched on')) throw new Error('enabled video shown as more than selected');
    await hostApi('DELETE', `/event-types/${video.id}`);
  });
  let formSlug;
  let formId;
  const responseCount = () => app.db.get('SELECT COUNT(*) AS count FROM responses').count;
  const focused = selector => evaluate(`Boolean(document.activeElement?.matches(${JSON.stringify(selector)}))`);
  await step('Forms templates: goal starting points create unpublished drafts', async () => {
    // With no forms yet, the starting points are shown directly; nothing is created by viewing them.
    await open('/forms', "document.querySelector('#form-templates:not([hidden]) [data-template]')");
    if ((await evaluate("document.querySelectorAll('#form-templates [data-template]').length")) !== 9) throw new Error('expected blank plus eight goal templates');
    const featured = await evaluate("[...document.querySelectorAll('#form-templates .template-grid')[0].querySelectorAll('h3')].map(h => h.textContent)");
    if (featured.join('|') !== 'Blank form|Sales discovery|Demo request|Client onboarding|Client review') throw new Error('unexpected featured templates: ' + featured.join('|'));
    // Preview runs the template's questions without creating a draft; Escape returns focus to its card.
    await evaluate("document.querySelector('[data-preview-template=\"client-review\"]').focus()");
    await click('[data-preview-template="client-review"]');
    await waitFor("document.querySelector('dialog.template-preview[open] .template-preview-form form')", 'template preview');
    if (!(await focused('#template-preview-title'))) throw new Error('template preview does not take focus');
    await layoutCheck('Forms template preview', 'dialog.template-preview');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor("!document.querySelector('dialog.template-preview')", 'preview closed');
    if (!(await focused('[data-preview-template="client-review"]'))) throw new Error('closing the preview loses focus');
    if (app.db.get('SELECT COUNT(*) AS count FROM forms').count !== 0) throw new Error('previewing a template created a form');
    await layoutCheck('Forms starting points');
    await click('#new-form');
    if (!(await evaluate("document.querySelector('#form-templates').hidden && document.querySelector('#new-form').getAttribute('aria-expanded') === 'false'"))) throw new Error('Create form does not toggle the picker');
    await click('#new-form');
    if (!(await evaluate("document.activeElement.id === 'templates-heading'"))) throw new Error('opening the picker does not move focus to it');
    if (app.db.get('SELECT COUNT(*) AS count FROM forms').count !== 0) throw new Error('viewing templates created a form');
    await click('[data-template="consultation"]');
    await waitFor("document.querySelector('#publish') && document.querySelector('#builder-notice').innerText.includes('Draft created from the “Consultation request” template')", 'builder with template notice');
    if (!(await evaluate("document.querySelector('#builder-status').innerText.includes('Not published') && document.querySelector('#f-title').value === 'Consultation request'"))) throw new Error('template draft is not shown as unpublished');
    const created = app.db.get("SELECT published_version FROM forms WHERE draft LIKE '%Consultation request%'");
    if (!created || created.published_version !== null || app.db.get('SELECT COUNT(*) AS count FROM form_versions').count !== 0) throw new Error('choosing a template published something');
    await layoutCheck('Forms builder from template');
  });
  await step('build and publish form', async () => {
    await open('/forms', "document.querySelector('#new-form') && document.querySelector('#form-list .list')");
    await click('#new-form');
    await click('[data-template="blank"]');
    await waitFor("document.querySelector('#publish') && document.querySelector('#preview form')", 'builder');
    const emailsBeforeShare = app.db.get('SELECT COUNT(*) AS count FROM emails').count;
    formId = await evaluate("location.pathname.split('/')[2]");
    await layoutCheck('form builder');
    if (!(await text()).includes('All changes saved')) throw new Error('initial save state missing');
    await fill('#f-title', 'Project intake');
    if (!(await text()).includes('Unsaved changes')) throw new Error('unsaved state missing');
    if (await evaluate("Boolean(document.querySelector('#share-link, #share-future, #share-panel input'))")) throw new Error('a draft offers a respondent link');
    await click('#publish');
    await waitFor("document.querySelector('#share-panel #share-link')", 'published share link');
    await waitFor("document.querySelector('#builder-status').innerText.includes('Live · version 1') && document.querySelector('#builder-status').innerText.includes('All changes saved')", 'live and saved status');
    formSlug = (await evaluate("document.querySelector('#share-link').value")).split('/f/')[1];
    // The respondent link is the first thing after publishing: focused heading, link in view at phone and desktop widths.
    if (!(await focused('#share-heading'))) throw new Error('publishing does not move focus to the respondent link');
    if (!(await evaluate("document.querySelector('#publish').textContent === 'Publish changes' && !document.querySelector('#publish').classList.contains('btn-primary')"))) throw new Error('Publish stays the main action with nothing to publish');
    for (const width of [320, 375, 768, 1280]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 768 });
      await evaluate("document.querySelector('#share-heading').scrollIntoView({ block: 'start' })");
      if (!(await evaluate("(() => { const r = document.querySelector('#share-link').getBoundingClientRect(); return r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && !document.querySelector('#share-link').closest('details:not([open])'); })()"))) throw new Error(`respondent link not visible with its heading at ${width}px`);
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    // Copy says what happened: success only when the clipboard accepted it; otherwise the link is selected.
    await send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: base }).catch(() => {});
    await evaluate("window.focus()");
    await click('[data-copy-target="share-link"]');
    await waitFor("document.querySelector('#share-status').textContent", 'copy feedback');
    const copied = await evaluate("document.querySelector('#share-status').textContent");
    if (!/^Respondent link copied\..*nothing has been sent/.test(copied) && !/^Copy failed\. The respondent link is selected/.test(copied)) throw new Error('unexpected copy feedback: ' + copied);
    await evaluate("window.realClipboard = navigator.clipboard.writeText; navigator.clipboard.writeText = () => Promise.reject(new Error('denied'))");
    await click('[data-copy-target="share-link"]');
    await waitFor("document.querySelector('#share-status').textContent.startsWith('Copy failed')", 'copy failure feedback');
    if (!(await evaluate("document.activeElement.id === 'share-link' && document.activeElement.selectionEnd - document.activeElement.selectionStart === document.activeElement.value.length"))) throw new Error('failed copy does not select the link');
    await evaluate("navigator.clipboard.writeText = window.realClipboard");
    const email = await evaluate("[document.querySelector('#share-email').getAttribute('href'), document.querySelector('#share-panel').innerText]");
    if (!email[0].startsWith('mailto:?') || !decodeURIComponent(email[0]).includes('/f/' + formSlug) || !email[1].includes('Schedora does not send it')) throw new Error('email option is not an honest mail draft: ' + email[0]);
    if (app.db.get('SELECT COUNT(*) AS count FROM emails').count !== emailsBeforeShare) throw new Error('sharing sent an email');
    await layoutCheck('form builder share panel', '#share-panel');
  });
  await step('form builder: preview stores nothing, keyboard reorder keeps focus', async () => {
    const before = responseCount();
    await fill('#preview #q-name', 'Preview person'); await fill('#preview #q-email', 'preview@example.com');
    await evaluate("const o = document.querySelector('#preview [name=topic][value=support]'); o.checked = true; o.dispatchEvent(new Event('change', { bubbles: true }))");
    await click('#preview [type="submit"]');
    await waitFor("document.querySelector('#preview').innerText.includes('Preview complete')", 'preview complete');
    if (responseCount() !== before || app.db.get('SELECT COUNT(*) AS count FROM outbox WHERE type = ?', 'forms.response.created').count !== before) throw new Error('preview created a response or event');
    await click('[data-index="0"] [data-move="1"]');
    if (!(await focused('[data-index="1"] [data-move="1"]'))) throw new Error('focus lost after moving down');
    await waitFor("document.querySelector('#builder-live').innerText.includes('position 2')", 'move announced');
    await click('[data-index="1"] [data-move="-1"]');
    if (!(await focused('[data-index="0"] [data-move="1"]'))) throw new Error('focus lost after moving to the top');
    await click('#save');
    await waitFor("document.querySelector('#builder-status').innerText.includes('All changes saved')", 'saved after reorder');
  });
  await step('form builder: one panel at a time on mobile', async () => {
    await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 1, mobile: true });
    const shown = () => evaluate("[getComputedStyle(document.querySelector('.builder-edit')).display, getComputedStyle(document.querySelector('.builder-preview')).display].join()");
    if ((await shown()) !== 'block,none') throw new Error('edit panel only expected, got ' + await shown());
    await click('.mobile-switch [data-view="preview"]');
    if ((await shown()) !== 'none,block') throw new Error('preview panel only expected, got ' + await shown());
    await click('.mobile-switch [data-view="edit"]');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  });
  await step('form builder: a conflicting save is not silent', async () => {
    app.db.run("UPDATE forms SET draft = replace(draft, 'Project intake', 'Edited elsewhere'), draft_revision = draft_revision + 1 WHERE id = ?", formId);
    await fill('#f-title', 'My local title');
    await click('#save');
    await waitFor("document.querySelector('#conflict-load')", 'conflict choice');
    if (!(await text()).includes('Not saved: changed elsewhere')) throw new Error('conflict state missing');
    if ((await evaluate("document.querySelector('#f-title').value")) !== 'My local title') throw new Error('local edits lost');
    await click('#conflict-load');
    await waitFor("document.querySelector('#f-title').value === 'Edited elsewhere' && document.querySelector('#builder-status').innerText.includes('All changes saved')", 'latest loaded');
  });
  await step('form builder: logic in plain words, keyed duplicate, first-match routing explained', async () => {
    await open(`/forms/${formId}`, "document.querySelector('#fields [data-logic-sentence]')");
    const sentence = await evaluate("document.querySelector('#fields [data-logic-sentence]').textContent");
    if (sentence !== 'Shown only when “What can we help with?” is “Something else”.') throw new Error('unexpected logic sentence: ' + sentence);
    await fill('[data-index="2"] [data-prop="label"]', 'What brings you here?');
    if (!(await evaluate("document.querySelector('#fields [data-logic-sentence]').textContent.includes('What brings you here?')"))) throw new Error('logic sentence does not follow the edited label');
    const before = await evaluate("document.querySelectorAll('#fields .field-editor').length");
    await click('[data-index="2"] [data-duplicate]');
    if (!(await focused('[data-index="3"] [data-prop="label"]'))) throw new Error('duplicate does not focus the copy');
    const keys = await evaluate("[...document.querySelectorAll('#fields [data-prop=\"id\"]')].map(input => input.value)");
    if (keys.length !== before + 1 || new Set(keys).size !== keys.length) throw new Error('duplicate did not create a uniquely keyed copy: ' + keys.join(','));
    await click('[data-index="3"] [data-remove]');
    await evaluate("document.querySelector('#routing details').open = true");
    await click('#add-rule');
    const rule = await evaluate("[document.querySelector('[data-rule-sentence=\"0\"]').textContent, document.querySelector('[data-fallback-sentence]').textContent, document.querySelector('#routing').innerText]");
    if (!rule[0].startsWith('Rule 1: when “') || rule[1] !== 'If no rule matches: show the receipt only.' || !rule[2].includes('First match wins')) throw new Error('routing is not explained in plain words: ' + rule.slice(0, 2).join(' | '));
    await layoutCheck('form builder plain-language logic', '#routing');
    await click('#save');
    await waitFor("document.querySelector('#builder-status').innerText.includes('All changes saved')", 'saved after logic checks');
  });
  await step('form builder: section index keeps edits, moves focus, marks the current section and never overlaps', async () => {
    await open(`/forms/${formId}`, "document.querySelector('#builder-index [data-section]') && document.querySelector('#fields [data-prop=label]')");
    await fill('#f-title', 'Unsaved index title');
    const path = await evaluate('location.pathname + location.search + location.hash');
    const key = async (name, code) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: code }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code }); };
    const enter = () => key('Enter', 13);
    try {
    // Real Tab presses: the index follows the builder actions and every link shows a focus ring.
    await evaluate("document.querySelector('#delete-form').focus()");
    for (const section of ['share', 'readiness', 'routing', 'settings', 'questions', 'preview']) {
      await key('Tab', 9);
      if (!(await evaluate(`document.activeElement.dataset.section === '${section}' && getComputedStyle(document.activeElement).outlineStyle !== 'none'`))) throw new Error(`Tab does not reach the ${section} index link with visible focus`);
    }
    for (const [section, heading] of [['share', '#share-heading'], ['readiness', '#readiness-heading'], ['routing', '#routing summary'], ['settings', '#settings-heading'], ['questions', '#questions-heading'], ['preview', '#preview-heading']]) {
      await evaluate(`document.querySelector('#builder-index [data-section="${section}"]').focus()`);
      await enter();
      if (!(await focused(heading))) throw new Error(`index link ${section} does not move focus to ${heading}`);
      if (!(await evaluate(`document.querySelector('#builder-index [data-section="${section}"]').getAttribute('aria-current') === 'location'`))) throw new Error(`${section} not marked current`);
    }
    if ((await evaluate('location.pathname + location.search + location.hash')) !== path || (await evaluate("document.querySelector('#f-title').value")) !== 'Unsaved index title' || !(await text()).includes('Unsaved changes')) throw new Error('the index changed the address or lost unsaved edits');
    if (!(await evaluate("document.querySelector('.builder-index-state').textContent === 'Unsaved changes'"))) throw new Error('save state not mirrored beside the index');
    // Desktop: the index stays at the top and the sticky preview starts below it.
    await click('#builder-index [data-section="questions"]');
    await evaluate('window.scrollBy(0, 400)');
    await new Promise(resolve => setTimeout(resolve, 150));
    const desk = await evaluate("(() => { const i = document.querySelector('#builder-index').getBoundingClientRect(); const p = document.querySelector('#builder-preview').getBoundingClientRect(); return { top: Math.round(i.top), clear: p.top >= i.bottom - 1, current: document.querySelector('#builder-index [aria-current]')?.dataset.section }; })()");
    if (desk.top !== 0 || !desk.clear || desk.current !== 'questions') throw new Error('sticky index overlaps or mis-marks: ' + JSON.stringify(desk));
    await layoutCheck('form builder section index', '#questions');
    // Phone: the index scrolls with the page, and Preview switches to the preview panel.
    await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 1, mobile: true });
    await click('#builder-index [data-section="preview"]');
    if (!(await evaluate("getComputedStyle(document.querySelector('.builder-edit')).display === 'none' && getComputedStyle(document.querySelector('.builder-preview')).display !== 'none'")) || !(await focused('#preview-heading'))) throw new Error('phone Preview link does not show the preview');
    await click('#builder-index [data-section="questions"]');
    if (!(await evaluate("getComputedStyle(document.querySelector('.builder-edit')).display !== 'none'")) || !(await focused('#questions-heading'))) throw new Error('phone Questions link does not return to the editor');
    if (await evaluate("getComputedStyle(document.querySelector('#builder-index')).position === 'sticky'")) throw new Error('index should not be sticky on phones');
    } finally {
      await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await evaluate('delete document.body.dataset.dirty');
    }
  });
  await step('form builder: question type changes are safe, explained, cancellable and never retype a published key', async () => {
    await open(`/forms/${formId}`, "document.querySelector('#fields [data-type]')");
    try {
    const indexOf = key => evaluate(`[...document.querySelectorAll('#fields [data-prop="id"]')].findIndex(input => input.value === '${key}')`);
    const types = () => evaluate("JSON.stringify([...document.querySelectorAll('#fields [data-type]')].map(select => select.value))");
    const choose = async (key, type) => { const i = await indexOf(key); await evaluate(`(() => { const select = document.querySelector('[data-index="${i}"] [data-type]'); select.focus(); select.value = '${type}'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`); return i; };
    const before = await types();
    // Published long text cannot become short text in place: a replacement is offered; cancelling changes nothing.
    let i = await choose('details', 'short_text');
    await waitFor("document.querySelector('dialog[open]')", 'replacement dialog');
    const dialogText = await evaluate("document.querySelector('dialog[open]').innerText");
    if (!dialogText.includes('Replace') || !dialogText.includes('cannot change type in place') || !dialogText.includes('Earlier versions, their responses and exports keep it')) throw new Error('replacement not explained: ' + dialogText);
    await layoutCheck('form builder type replacement dialog', 'dialog[open]');
    await click('dialog[open] [value="cancel"]');
    await waitFor("!document.querySelector('dialog[open]')", 'dialog closed');
    if ((await types()) !== before || !(await text()).includes('All changes saved')) throw new Error('cancelling a replacement changed the draft');
    if (!(await focused(`[data-index="${i}"] [data-type]`))) throw new Error('focus not returned to the type select');
    // A published choice question that a display rule depends on cannot be replaced until the rule changes.
    i = await choose('topic', 'short_text');
    await waitFor(`document.querySelector('[data-index="${i}"] [data-type-note]').innerText.includes('Type not changed')`, 'blocked note');
    if (!(await evaluate(`document.querySelector('[data-index="${i}"] [data-type-note]').innerText.includes('shown when')`)) || (await evaluate(`document.querySelector('[data-index="${i}"] [data-type]').value`)) !== 'single_choice') throw new Error('blocked change does not list the rule, or changed the type');
    // Single to multiple choice is allowed for a published key, after showing how the rule would read.
    await choose('topic', 'multiple_choice');
    await waitFor("document.querySelector('dialog[open]')", 'confirm dialog');
    if (!(await evaluate("document.querySelector('dialog[open]').innerText.includes('after the change')"))) throw new Error('rule meaning change not shown');
    await click('dialog[open] [value="ok"]');
    await waitFor("[...document.querySelectorAll('#fields [data-prop=\"id\"]')].some(input => input.value === 'topic' && input.closest('[data-index]').querySelector('[data-type]').value === 'multiple_choice')", 'multiple choice applied under the same key');
    if (!(await text()).includes('Unsaved changes')) throw new Error('confirmed change did not mark the draft unsaved');
    // Widening a published short text applies at once.
    i = await choose('name', 'long_text');
    await waitFor(`document.querySelector('[data-index="${i}"] [data-type]').value === 'long_text'`, 'widening applied');
    if (await evaluate('Boolean(document.querySelector("dialog[open]"))')) throw new Error('a safe widening asked for confirmation');
    if (app.db.get('SELECT COUNT(*) AS count FROM form_versions WHERE form_id = ?', formId).count !== 1) throw new Error('type editing published something');
    } finally { await evaluate('delete document.body.dataset.dirty'); }
  });
  for (const mode of ['classic', 'conversational']) {
    await step(`submit form (${mode})`, async () => {
      await open(`/f/${formSlug}?mode=${mode}`, "document.querySelector('#form-root form')");
      await layoutCheck(`public form ${mode}`);
      const answer = async (selector, value) => { await fill(selector, value); if (mode === 'conversational') await click('#form-root [type="submit"]'); };
      await click('#form-root [type="submit"]'); // empty submit must show an error, not advance
      await waitFor("document.querySelector('#form-root .field-error')", 'required error');
      if (mode === 'classic' && !(await focused('[data-error-summary]'))) throw new Error('error summary not focused');
      if (mode === 'conversational' && !(await focused('[aria-invalid="true"]'))) throw new Error('invalid field not focused');
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
      const before = responseCount();
      if (mode === 'classic') {
        // The server accepts the response but the reply is lost: the page must not claim either outcome.
        await evaluate("(() => { const original = window.fetch; let once = true; window.fetch = async (...args) => { const response = await original(...args); if (once && String(args[0]).endsWith('/responses')) { once = false; throw new TypeError('Failed to fetch'); } return response; }; })()");
        await click('#form-root [type="submit"]');
        await waitFor("document.body.innerText.includes('could not confirm that your response was received')", 'unknown outcome message');
        if (await evaluate("document.body.innerText.includes('Response received')")) throw new Error('receipt shown without confirmation');
        if ((await evaluate("document.querySelector('#q-details').value")) !== 'A garden redesign') throw new Error('answers lost after network failure');
        await layoutCheck('public form retry');
      }
      await click('#form-root [type="submit"]');
      await waitFor("document.body.innerText.includes('Response received') && document.body.innerText.includes('Receipt')", 'receipt');
      if (responseCount() !== before + 1) throw new Error(`expected exactly one new response, got ${responseCount() - before}`);
      await layoutCheck(`form receipt ${mode}`);
    });
  }
  await step('responses inbox, detail and CSV', async () => {
    await open('/forms', "document.querySelector('.list')");
    await evaluate("[...document.querySelectorAll('a')].find(a => a.textContent === 'Responses').click()");
    await waitFor("document.querySelector('table')", 'responses table');
    await layoutCheck('responses');
    await click('[data-view-response]');
    await waitFor("document.querySelector('#detail-title')", 'response detail');
    if (!(await focused('#detail-title'))) throw new Error('detail heading not focused');
    if (!(await text()).includes('Answered version')) throw new Error('version missing from detail');
    await layoutCheck('response detail');
    await click('#export');
    await waitFor("document.querySelector('#export-status').innerText.includes('Export downloaded')", 'export status');
    const csv = await evaluate(`fetch('/api/me').then(r => r.json()).then(me => fetch('/api/workspaces/' + me.workspaces[0].id + '/forms/${formId}/responses.csv')).then(r => r.text())`);
    if (!csv.includes('A garden redesign') || !csv.includes('"Form version"')) throw new Error('CSV missing answer or version column');
  });
  await step('route a response to Meet and book through the handoff', async () => {
    await open(`/forms/${formId}`, "document.querySelector('#routing details')");
    await evaluate("document.querySelector('#routing details').open = true");
    await click('#add-rule');
    await waitFor("document.querySelector('[data-rop=\"0\"]')", 'rule row');
    await evaluate("const s = document.querySelector('[data-rop=\"0\"]'); s.value = 'answered'; s.dispatchEvent(new Event('change', { bubbles: true }))");
    await waitFor("document.querySelector('[data-aevent=\"0\"]') && !document.querySelector('[data-rvalue=\"0\"]')", 'booking destination');
    await layoutCheck('form routing');
    await click('#save-routing');
    await waitFor("document.querySelector('#builder-status').innerText.includes('not yet published')", 'routing saved as draft');
    await click('#publish');
    await waitFor("document.querySelector('dialog button[value=ok]')", 'republish confirmation');
    await click('dialog button[value=ok]');
    await waitFor("document.querySelector('#builder-notice').innerText.includes('Version 2 is live')", 'version 2 live');
    await open(`/f/${formSlug}`, "document.querySelector('#form-root form')");
    await fill('#q-name', 'Lena'); await fill('#q-email', 'lena@example.com');
    await evaluate("const o = document.querySelector('[name=topic][value=support]'); o.checked = true; o.dispatchEvent(new Event('change', { bubbles: true }))");
    await click('#form-root [type="submit"]');
    await waitFor("document.body.innerText.includes('Response received — choose a time') && document.querySelector('#choose-time')", 'receipt with booking offer');
    const handoffUrl = await evaluate("document.querySelector('#choose-time').getAttribute('href')");
    if (await evaluate("document.querySelector('#choose-time').getAttribute('href').includes('lena')")) throw new Error('personal data in booking link');
    await layoutCheck('form receipt with booking');
    await click('#choose-time');
    await waitFor(`location.pathname === '/meet/${workspaceSlug}/${eventSlug}' && document.querySelector('.day[data-available]')`, 'booking page');
    if (await evaluate("location.search.includes('handoff')")) throw new Error('handoff token left in the address bar');
    if (!(await text()).includes('Your form response was received')) throw new Error('handoff notice missing');
    if ((await text()).includes('You are scheduled')) throw new Error('booking shown before booking');
    await click('.day[data-available]');
    await click('.slot');
    await waitFor("document.querySelector('#invitee-form')", 'details form');
    if ((await evaluate("document.querySelector('#name').value + '|' + document.querySelector('#email').value")) !== 'Lena|lena@example.com') throw new Error('details not pre-filled');
    await click('#invitee-form [type="submit"]');
    await waitFor("document.body.innerText.includes('You are scheduled')", 'booking confirmation');
    await open(`/forms/${formId}/responses`, "document.querySelector('table')");
    if (!(await text()).includes('Booking confirmed')) throw new Error('inbox does not show the booking');
    await open(handoffUrl, "document.body.innerText.includes('Booking link unavailable')");
    if (await evaluate("Boolean(document.querySelector('.day[data-available], #invitee-form'))")) throw new Error('used handoff still offers booking');
    if (!(await text()).includes('already booked')) throw new Error('used handoff recovery missing');
    await layoutCheck('used handoff');
    await open(`/meet/${workspaceSlug}/${eventSlug}?handoff=invalid-token-000000000000`, "document.body.innerText.includes('Booking link unavailable')");
    if (await evaluate("Boolean(document.querySelector('.day[data-available], #invitee-form'))")) throw new Error('invalid handoff still offers booking');
    await layoutCheck('invalid handoff');
  });
  await step('Forms readiness: draft vs live, logic checks, booking offer wording, preview and share change nothing', async () => {
    const formApi = (method, path, body) => evaluate(`(async () => { const me = await (await fetch('/api/me')).json(); const r = await fetch('/api/workspaces/' + me.workspaces[0].id + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: ${JSON.stringify(JSON.stringify(body))} }); return r.status === 204 ? null : r.json(); })()`);
    const areaText = key => evaluate(`document.querySelector('#ready-${key}').closest('details').textContent.replace(/\\s+/g, ' ')`);
    const ready = "document.querySelector('#readiness .readiness-areas')";
    const state = () => JSON.stringify(app.db.get('SELECT (SELECT COUNT(*) FROM responses) AS responses, (SELECT COUNT(*) FROM form_versions) AS versions, (SELECT COUNT(*) FROM bookings) AS bookings, (SELECT COUNT(*) FROM form_handoffs) AS handoffs'));
    const before = state();

    // The routed, published form from the earlier steps.
    await open(`/forms/${formId}`, ready);
    const titles = await evaluate("[...document.querySelectorAll('.readiness-area > summary')].map(s => s.textContent.replace(/\\s+/g, ' ').trim())");
    if (titles.length !== 5 || !['Draft and live', 'Questions and logic', 'Respondent preview', 'After submission', 'Sharing'].every((title, index) => titles[index].includes(title))) throw new Error('unexpected areas: ' + titles.join('|'));
    await waitFor("document.querySelector('#readiness-body').textContent.includes('Server publish checks passed for saved revision')", 'server publish validation');
    if (!(await areaText('after')).includes('Live version 2:')) throw new Error('live routing version is not distinguished from the saved draft');
    if (/\d\s*%/.test(await evaluate("document.querySelector('#readiness').innerText"))) throw new Error('readiness shows a percentage');
    const after = await areaText('after');
    if (!after.includes("only Meet's confirmation means an appointment exists") || !after.includes('The receipt means the response was received, nothing more')) throw new Error('booking offer wording: ' + after);
    if (!(await evaluate("Boolean(document.querySelector('#ready-after').closest('details').querySelector('a[href^=\"/meet/event-types/\"]'))"))) throw new Error('no link to the booking page readiness');
    if (!(await evaluate("Boolean(document.querySelector('#share-panel #share-link') && document.querySelector('#share-panel #embed') && !document.querySelector('#readiness #share-link') && document.querySelector('#readiness [data-goto=share]'))"))) throw new Error('share link and embed not in the share panel, or readiness does not point to it');
    await layoutCheck('forms readiness (live)');
    // Real Tab key presses reach every control in the card with a visible focus indicator.
    await evaluate("document.querySelector('#delete-form').focus()");
    const stops = [];
    for (let index = 0; index < 40; index++) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      const stop = await evaluate("(() => { const el = document.activeElement; const style = getComputedStyle(el); const rect = el.getBoundingClientRect(); return { inCard: Boolean(el.closest('#readiness')), shown: el.matches(':focus-visible') && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2 && rect.bottom > 0 && rect.top < innerHeight }; })()");
      if (!stop.inCard) { if (stops.length) break; continue; }
      stops.push(stop);
    }
    if (stops.length < 5 || stops.some(stop => !stop.shown)) throw new Error('keyboard focus not visible in the forms readiness card');

    // Unsaved edits are named and not assessed.
    await fill('#f-title', 'Edited but not saved');
    await waitFor("document.querySelector('#readiness-unsaved .notice')", 'unsaved notice');
    if ((await areaText('versions')).includes('Edited but not saved')) throw new Error('summary assessed unsaved edits');
    // Preview actions switch the preview presentation only.
    await evaluate("document.querySelector('#readiness [data-goto=\"preview-conversational\"]').click()");
    if (!(await evaluate("document.querySelector('#preview-mode').value === 'conversational' && document.activeElement === document.querySelector('#preview-heading')"))) throw new Error('preview action did not switch presentation and focus the preview');
    await evaluate("delete document.body.dataset.dirty");

    // A form with an unreachable required question and an unknown insertion, never published.
    const tricky = await formApi('POST', '/forms', { definition: { title: 'Workshop enquiry', description: '', presentation: 'classic', submit_label: 'Send', fields: [
      { id: 'kind', type: 'single_choice', label: 'What do you need?', required: true, options: [{ id: 'team', label: 'Team' }, { id: 'solo', label: 'Solo' }] },
      { id: 'p2', type: 'page_break', show_if: { field: 'kind', op: 'equals', value: 'team' } },
      { id: 'size', type: 'short_text', label: 'Team size', required: true, show_if: { field: 'kind', op: 'equals', value: 'solo' } },
      { id: 'notes', type: 'long_text', label: 'Anything else about {{budget}}?' }] } });
    await open(`/forms/${tricky.id}`, ready);
    const logicText = await areaText('questions');
    if (!logicText.includes('“Team size” can never be shown with these display rules, so it is never asked even though it is required')) throw new Error('unreachable required question not reported: ' + logicText);
    if (!logicText.includes('inserts {{budget}}, which is not a question in this form')) throw new Error('unknown insertion not reported');
    if (!(await areaText('versions')).includes('Needs attention · Required: Not published')) throw new Error('draft not shown as a required blocker');
    if (await evaluate("Boolean(document.querySelector('#share-link, #share-future, #share-panel input'))") || !(await evaluate("document.querySelector('#share-panel').innerText.includes('Not public yet')"))) throw new Error('an unpublished form offers a share link');
    await evaluate("document.querySelector('#readiness [data-goto=\"publish\"]').click()");
    if (!(await focused('#publish'))) throw new Error('Go to Publish did not focus the Publish button');
    if (app.db.get('SELECT published_version FROM forms WHERE id = ?', tricky.id).published_version !== null) throw new Error('readiness published the form');
    await layoutCheck('forms readiness (draft)');
    // A fresh phone render, not a desktop card merely resized after initialization.
    await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: true });
    await open(`/forms/${tricky.id}`, ready);
    if (!(await evaluate("[...document.querySelectorAll('#readiness .readiness-area')].every(area => area.open === (area.dataset.state === 'attention'))"))) throw new Error('phone readiness does not open only areas needing attention');
    if (shotsDir) {
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(join(shotsDir, 'forms-readiness-fresh-phone.png'), Buffer.from(data, 'base64'));
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await formApi('DELETE', `/forms/${tricky.id}`);
    if (state() !== JSON.stringify({ ...JSON.parse(before) })) throw new Error('readiness changed responses, versions, bookings or handoffs');
  });
  await step('Flow starters: real draft contracts, no silent enable, replace confirmation and outcome preview', async () => {
    // Empty Flows list offers the starters; opening one creates nothing.
    await open('/flow', "document.querySelector('.flow-starter-links')");
    if ((await evaluate("document.querySelectorAll('.flow-starter-links a').length")) !== 3) throw new Error('empty state does not offer the three starters');
    await layoutCheck('Flow empty state with starters');
    await click('.flow-starter-links a[href$="starter=prepare-call"]');
    await waitFor("document.querySelector('[data-starter=\\'prepare-call\\'][aria-pressed=true]') && document.querySelector('#name').value === 'Prepare for a booked call'", 'starter opened from list');
    if (app.db.get('SELECT COUNT(*) AS count FROM flows').count !== 0) throw new Error('opening a starter saved a flow');
    if (!(await evaluate("document.querySelector('#flow-outcome').innerText.includes('When an appointment is booked for any event type, create a task titled') && document.querySelector('#flow-outcome').innerText.includes('Not saved yet')"))) throw new Error('summary does not describe the starter');
    if (!(await text()).includes('Save the draft to simulate it')) throw new Error('unsaved draft does not explain simulation');
    await fill('#task-title', 'Call prep: {{invitee.name}}');
    if (!(await evaluate("document.querySelector('#flow-outcome').innerText.includes('“Call prep: {{invitee.name}}”')"))) throw new Error('summary does not follow edits');
    if (!(await evaluate('document.body.dataset.dirty === "1"'))) throw new Error('editing a starter is not tracked as unsaved');
    await evaluate('delete document.body.dataset.dirty'); // the test discards this draft deliberately
    await open('/flow/new', "document.querySelectorAll('[data-starter]').length === 3");
    await click('[data-starter="notify-host"]');
    if (!(await evaluate("document.querySelector('#to').value === 'host' && document.querySelector('#status').value === 'draft' && document.querySelector('#flow-outcome').innerText.includes('email the host') && document.querySelector('#flow-outcome').innerText.includes('local outbox') && !/delivered to an inbox\\./.test(document.querySelector('#flow-outcome').innerText.replace('It is not delivered to an inbox.', '')) && document.activeElement.id === 'name'"))) throw new Error('host email starter does not preserve draft/delivery truth');
    await click('[data-starter="review-intake"]');
    await waitFor("document.querySelector('dialog[open]')", 'replace unsaved starter confirmation');
    await click('dialog[open] button[value=ok]');
    await waitFor("document.querySelector('#trigger_type').value === 'forms.response.created' && document.querySelector('[name=action_type]:checked').value === 'task' && document.querySelector('#status').value === 'draft'", 'intake starter contract');
    await layoutCheck('Flow starter draft');
    await fill('#status', 'paused');
    if (!(await text()).includes('It is paused: new events are held and run when you resume it.')) throw new Error('outcome preview does not explain paused behaviour');
    await fill('#status', 'draft');
    await click('#flow-form [type=submit]');
    await waitFor("/^\\/flow\\/[0-9a-f-]{36}$/.test(location.pathname) && document.querySelector('#simulate')", 'saved starter draft');
    const saved = app.db.get("SELECT trigger_type, action_type, status FROM flows WHERE name = 'Review a new enquiry'");
    if (saved?.trigger_type !== 'forms.response.created' || saved.action_type !== 'task' || saved.status !== 'draft') throw new Error('starter did not persist as the supported draft');
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
    if (!(await text()).includes('Task created') || !(await evaluate("Boolean(document.querySelector('#panel a[href=\\'/flow/tasks\\']'))"))) throw new Error('run does not link to the created task');
    if (/delivered/i.test((await text()).replace(/not delivered|delivery is not tracked/gi, ''))) throw new Error('run history claims delivery');
    await layoutCheck('flow runs');
  });
  await step('Flow tasks: deadline and assignee are saved, labelled and shown; "assigned to me" filters', async () => {
    await open('/flow/new', "document.querySelector('#flow-form')");
    if (!(await evaluate("Boolean(document.querySelector('label[for=due_in_hours]') && document.querySelector('label[for=assign_to]'))"))) throw new Error('task deadline/assignee fields missing in the editor');
    if (!(await evaluate("document.querySelector('#flow-outcome').innerText.includes('with no deadline')"))) throw new Error('summary does not state the deadline');
    await open('/flow/tasks', "document.querySelector('[data-assignee]')");
    const id = await evaluate("document.querySelector('[data-assignee]').dataset.assignee");
    if (!(await evaluate(`Boolean(document.querySelector('label[for="assignee-${id}"]') && document.querySelector('label[for="due-${id}"]'))`))) throw new Error('task controls are not labelled');
    const me = await evaluate("(async () => (await (await fetch('/api/me')).json()).user.id)()");
    await evaluate(`(() => { const select = document.querySelector('[data-assignee="${id}"]'); select.focus(); select.value = ${JSON.stringify(me)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(`document.querySelector('[data-assignee="${id}"]')?.value === ${JSON.stringify(me)}`, 'assignee saved');
    if (app.db.get('SELECT assignee_id FROM tasks WHERE id = ?', id).assignee_id !== me) throw new Error('assignee not stored');
    if (!(await evaluate(`document.activeElement.id === 'assignee-${id}'`))) throw new Error('focus lost after saving the assignee');
    await evaluate(`(() => { const input = document.querySelector('[data-due="${id}"]'); input.value = '2020-01-01T09:00'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(`document.querySelector('[data-clear-due="${id}"]') && document.body.innerText.includes('Overdue')`, 'deadline saved and overdue shown');
    if (!app.db.get('SELECT due_at FROM tasks WHERE id = ?', id).due_at) throw new Error('deadline not stored');
    await layoutCheck('flow tasks with deadline');
    await open('/flow/tasks?assignee=me', "document.querySelector('.task-list, .empty')");
    if (!(await evaluate(`Boolean(document.querySelector('[data-task="${id}"]'))`))) throw new Error('assigned task missing from "assigned to me"');
    await click(`[data-clear-due="${id}"]`);
    await waitFor(`!document.querySelector('[data-clear-due="${id}"]') && document.querySelector('[data-due="${id}"]').value === ''`, 'deadline cleared');
    if (app.db.get('SELECT due_at FROM tasks WHERE id = ?', id).due_at !== null) throw new Error('deadline not cleared');
    if (!(await evaluate(`document.activeElement.id === 'due-${id}'`))) throw new Error('focus not moved to the deadline after clearing it');
  });
  await step('enquiry trail: response → booking offer → follow-up task, from real local records', async () => {
    // An enabled response flow creates a review task; the routed form offers a booking.
    const created = await evaluate(`(async () => { const me = await (await fetch('/api/me')).json(); const r = await fetch('/api/workspaces/' + me.workspaces[0].id + '/flows', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: JSON.stringify({ name: 'Review enquiry', trigger_type: 'forms.response.created', trigger_source: ${JSON.stringify(formId)}, action_type: 'task', action_config: { title: 'Review {{form.title}}', details: '' }, status: 'enabled' }) }); return r.status; })()`);
    if (created !== 201) throw new Error('could not enable the review flow: ' + created);
    const submitted = await fetch(`${base}/api/public/forms/${formSlug}/responses`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers: { name: 'Nia', email: 'nia@example.com', topic: 'support' }, submission_id: 'trail-check-000000001' }) });
    if (submitted.status !== 201) throw new Error('response not accepted: ' + submitted.status);
    await waitFor('true', 'tick'); await new Promise(resolve => setTimeout(resolve, 2000));
    if (!app.db.get("SELECT 1 FROM tasks WHERE title LIKE 'Review %' AND status = 'open'")) throw new Error('worker did not create the review task');
    await open(`/forms/${formId}/responses`, "document.querySelector('[data-filter=attention]:not([aria-disabled])')");
    const label = await evaluate("document.querySelector('[data-filter=attention]').textContent");
    if (!/Needs attention \(1\)/.test(label)) throw new Error('unexpected attention count: ' + label);
    await click('[data-filter="attention"]');
    await waitFor("document.querySelectorAll('#responses tbody tr').length === 1 && document.querySelector('#responses tbody').innerText.includes('Nia') && document.querySelector('.attention-note').innerText.includes('Open task (Review enquiry)')", 'filtered to the open task');
    if (!(await focused('[data-filter="attention"]'))) throw new Error('filter lost focus');
    await click('[data-view-response]');
    await waitFor("document.querySelector('.trail')", 'trail in detail');
    const trail = await evaluate("document.querySelector('.trail').innerText");
    for (const expected of ['Response received', 'Booking offered, not booked yet', 'Review enquiry', 'Task open: Review']) if (!trail.includes(expected)) throw new Error('trail missing: ' + expected + ' in ' + trail);
    if (/Booking confirmed/.test(trail)) throw new Error('trail claims a booking that was not made');
    await layoutCheck('responses with enquiry trail');
    // Completing the task resolves the attention item; the booking offer stays "waiting".
    const task = app.db.get("SELECT id FROM tasks WHERE title LIKE 'Review %' AND status = 'open'");
    await evaluate(`(async () => { const me = await (await fetch('/api/me')).json(); await fetch('/api/workspaces/' + me.workspaces[0].id + '/tasks/${task.id}', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: JSON.stringify({ status: 'done' }) }); })()`);
    await open(`/forms/${formId}/responses`, "document.querySelector('[data-filter=attention]:not([aria-disabled])')");
    if (!/Needs attention \(0\)/.test(await evaluate("document.querySelector('[data-filter=attention]').textContent"))) throw new Error('completed task still needs attention');
  });
  await step('Enquiries: one list across Forms, Meet and Flow, attention first, read-only', async () => {
    const records = () => JSON.stringify(app.db.get('SELECT (SELECT COUNT(*) FROM responses) AS responses, (SELECT COUNT(*) FROM bookings) AS bookings, (SELECT COUNT(*) FROM flow_runs) AS runs, (SELECT COUNT(*) FROM tasks) AS tasks'));
    const before = records();
    await open('/forms', "document.querySelector('#main a[href=\"/enquiries\"]')");
    await click('#main a[href="/enquiries"]');
    await waitFor("location.pathname === '/enquiries' && document.querySelector('.enquiry-list, #enquiries-body .empty')", 'enquiries list');
    const summary = await evaluate("({ origins: [...document.querySelectorAll('.enquiry .meta span:first-child')].map(s => s.textContent.split(':')[0]), states: [...document.querySelectorAll('.enquiry')].map(e => e.dataset.state), hint: document.querySelector('#enquiries-body .hint').textContent })");
    if (!summary.origins.includes('Form') || !summary.origins.includes('Booked directly')) throw new Error('responses and direct bookings are not both listed: ' + summary.origins.join(','));
    if (!/^All \d+ enquir(y is|ies are) loaded\./.test(summary.hint)) throw new Error('coverage note missing: ' + summary.hint);
    const firstCalm = summary.states.findIndex(state => state !== 'attention');
    if (firstCalm >= 0 && summary.states.slice(firstCalm).includes('attention')) throw new Error('needs attention is not listed first: ' + summary.states.join(','));
    if (summary.states.includes('attention') && !(await evaluate("document.querySelector('#enquiries-body .notice-warn')?.textContent.includes('need')"))) throw new Error('attention summary missing');
    if (await evaluate("(() => { const ids = [...document.querySelectorAll('[id]')].map(e => e.id); return ids.length !== new Set(ids).size; })()")) throw new Error('duplicate ids on the enquiries page');
    await evaluate("document.querySelector('.enquiry-detail').open = true");
    if (!(await evaluate("document.querySelector('.enquiry-detail .trail-steps li') !== null"))) throw new Error('trail not shown in details');
    await layoutCheck('enquiries');
    await open('/enquiries?show=attention', "document.querySelector('.enquiry-list, #enquiries-body .empty')");
    if (await evaluate("[...document.querySelectorAll('.enquiry')].some(e => e.dataset.state !== 'attention')")) throw new Error('attention filter shows other states');
    await open('/enquiries?from=booking', "document.querySelector('.enquiry-list, #enquiries-body .empty')");
    if (await evaluate("[...document.querySelectorAll('.enquiry .meta span:first-child')].some(s => !s.textContent.startsWith('Booked directly'))")) throw new Error('direct-booking filter shows responses');
    if (records() !== before) throw new Error('the enquiries page changed records');
  });
  await step('email evidence: outbox, changed setting and unverified historic sending method', async () => {
    const submitted = await evaluate(`(async () => { const me = await (await fetch('/api/me')).json(); const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }; const created = await fetch('/api/workspaces/' + me.workspaces[0].id + '/flows', { method: 'POST', headers, body: JSON.stringify({ name: 'Email evidence check', trigger_type: 'forms.response.created', trigger_source: ${JSON.stringify(formId)}, action_type: 'email', action_config: { to: 'field:email', subject: 'Evidence check', body: 'Local browser fixture only' }, status: 'enabled' }) }); if (created.status !== 201) return created.status; return (await fetch('/api/public/forms/' + ${JSON.stringify(formSlug)} + '/responses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers: { name: 'Email evidence', email: 'evidence@example.com', topic: 'support' }, submission_id: 'email-evidence-00000001' }) })).status; })()`);
    if (submitted !== 201) throw new Error('could not prepare email evidence: ' + submitted);
    await app.worker.tick();
    await open('/flow/runs', "document.querySelector('table')");
    // Change only this test page's current-provider hint: historical outcomes must ignore it.
    await evaluate("import('/js/core.mjs').then(module => { module.boot.providers.email = 'http'; })");
    await click('#refresh');
    await waitFor("document.querySelector('table').innerText.includes('Recorded in the local outbox; not delivered to an inbox.')", 'saved outbox outcome');
    await evaluate("[...document.querySelectorAll('tbody tr')].find(row => row.innerText.includes('Email evidence check'))?.scrollIntoView({ block: 'center' })");
    await layoutCheck('email saved transport');
    const message = app.db.get("SELECT id FROM emails WHERE subject = 'Evidence check'");
    if (!message) throw new Error('email fixture missing');
    app.db.run('UPDATE emails SET accepted_transport = NULL WHERE id = ?', message.id);
    // A migrated message must not get its sending method guessed from today's provider.
    await click('#refresh');
    await waitFor("document.querySelector('table').innerText.includes('sending method is not verified')", 'legacy email evidence');
    if (await evaluate("document.querySelector('table').innerText.includes('Accepted by the email provider')")) throw new Error('legacy email guessed as provider accepted');
    await evaluate("[...document.querySelectorAll('tbody tr')].find(row => row.innerText.includes('Email evidence check'))?.scrollIntoView({ block: 'center' })");
    await layoutCheck('email historic evidence');
    await open('/enquiries', "document.querySelector('.enquiry-list')");
    const emailCard = await evaluate("(() => { const cards = [...document.querySelectorAll('.enquiry')]; const card = cards.find(item => item.querySelector('.list-title').textContent === 'Email evidence'); if (!card) return null; card.querySelector('details').open = true; return card.innerText; })()");
    if (!emailCard?.includes('sending method is not verified')) throw new Error('trail lost legacy email uncertainty');
    await evaluate("[...document.querySelectorAll('.enquiry')].find(item => item.querySelector('.list-title').textContent === 'Email evidence')?.scrollIntoView({ block: 'start' })");
    await layoutCheck('enquiry historic email');
  });
  await step('enquiries: older pages load by keyboard, once each, with focus kept and coverage stated', async () => {
    // 60 stored responses push the feed past one 50-item page. Written directly: this checks paging, not submission.
    const formRow = app.db.get('SELECT id, workspace_id FROM forms WHERE id = ?', formId);
    const base = app.now() - 86400000;
    for (let i = 0; i < 60; i++) {
      app.db.run('INSERT INTO responses (id, workspace_id, form_id, form_version, answers, idempotency_key, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
        `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`, formRow.workspace_id, formRow.id, JSON.stringify({ name: `Paged ${i}` }), `paged-${i}`, base + i * 1000);
    }
    const total = app.db.get('SELECT COUNT(*) AS count FROM responses WHERE workspace_id = ?', formRow.workspace_id).count;
    await open('/enquiries', "document.querySelector('#load-older')");
    const firstCount = await evaluate("document.querySelectorAll('.enquiry').length");
    if (firstCount !== 50) throw new Error('first page should hold 50 enquiries, got ' + firstCount);
    if (!(await evaluate("document.querySelector('#enquiries-body .hint').textContent.startsWith('Showing the newest 50 enquiries.')"))) throw new Error('partial coverage not stated');
    await evaluate("document.querySelector('#load-older').focus()");
    for (let page = 0; page < 5 && (await evaluate("Boolean(document.querySelector('#load-older'))")); page++) {
      const before = await evaluate("document.querySelectorAll('.enquiry').length");
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await waitFor(`document.querySelectorAll('.enquiry').length > ${before}`, 'older enquiries');
      if (!(await evaluate("['load-older', 'enquiries-status'].includes(document.activeElement.id)"))) throw new Error('focus lost after loading older enquiries');
      if (!(await evaluate("/^Loaded \\d+ older enquir/.test(document.querySelector('#enquiries-status').textContent)"))) throw new Error('load result not announced');
    }
    const titles = await evaluate("[...document.querySelectorAll('.enquiry .list-title')].map(el => el.textContent)");
    const pagedTitles = titles.filter(title => title.startsWith('Paged '));
    if (pagedTitles.length !== 60 || new Set(pagedTitles).size !== 60) throw new Error('paged enquiries missing or duplicated: ' + pagedTitles.length);
    if (await evaluate("Boolean(document.querySelector('#load-older'))")) throw new Error('load button remains after the last page');
    const directBookings = await evaluate("[...document.querySelectorAll('.enquiry .meta span:first-child')].filter(s => s.textContent.startsWith('Booked directly')).length");
    if (titles.length !== total + directBookings) throw new Error(`expected every response and direct booking once: ${titles.length} vs ${total} + ${directBookings}`);
    if (!(await evaluate("/^All \\d+ enquiries are loaded\\./.test(document.querySelector('#enquiries-body .hint').textContent)"))) throw new Error('complete coverage not stated');
    await layoutCheck('enquiries all pages');
  });
  await step('per-form history: tied arrivals, complete follow-ups and keyboard paging under the attention filter', async () => {
    const formRow = app.db.get('SELECT workspace_id FROM forms WHERE id = ?', formId);
    const oldId = '00000000-0000-4000-9000-000000000000';
    const at = app.now() - 86400000;
    app.db.run("UPDATE responses SET created_at = ? WHERE form_id = ? AND idempotency_key LIKE 'paged-%'", at, formId);
    const flow = app.db.get("SELECT id FROM flows WHERE workspace_id = ? AND action_type = 'task' LIMIT 1", formRow.workspace_id);
    app.db.run("INSERT INTO flow_runs (id, workspace_id, flow_id, event_id, event_type, subject_id, status, attempts, next_attempt_at, result, created_at, updated_at) VALUES ('old-form-run', ?, ?, 'old-form-event', 'forms.response.created', ?, 'succeeded', 1, ?, ?, ?, ?)", formRow.workspace_id, flow.id, oldId, at, JSON.stringify({ task: 'old-form-task' }), at, at);
    app.db.run("INSERT INTO tasks (id, workspace_id, source_run_id, title, details, status, created_at) VALUES ('old-form-task', ?, 'old-form-run', 'Review the older enquiry', '', 'open', ?)", formRow.workspace_id, at);
    await open(`/forms/${formId}/responses`, "document.querySelector('#more')");
    await click('[data-filter=attention]');
    if (!(await evaluate("Boolean(document.querySelector('#more'))"))) throw new Error('filter hides access to older responses');
    await evaluate("document.querySelector('#more').focus()");
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await waitFor("document.querySelector('#responses-status').textContent.includes('all responses are loaded')", 'older response announcement');
    if (!(await focused('[data-filter=all]'))) throw new Error('paging focus lost');
    await click(`[data-view-response="${oldId}"]`);
    await waitFor("document.querySelector('#response-detail').textContent.includes('Review the older enquiry')", 'old follow-up task');
    await layoutCheck('older response follow-up');
    await click('[data-filter=all]');
    const total = app.db.get('SELECT COUNT(*) AS count FROM responses WHERE form_id = ?', formId).count;
    const seen = await evaluate("[...document.querySelectorAll('[data-view-response]')].map(el => el.dataset.viewResponse)");
    if (seen.length !== total || new Set(seen).size !== total) throw new Error('tied response history missing or duplicated');
    if (await evaluate("Boolean(document.querySelector('#more'))")) throw new Error('extra history page incorrectly offered');
  });
  await step('billing test checkout', async () => {
    await open('/billing', "document.querySelector('[data-action=checkout]')");
    await layoutCheck('billing');
    await click('[data-action="checkout"][data-plan="suite"]');
    await waitFor("document.body.innerText.includes('Suite plan')", 'subscription listed');
  });
  await step('proposed pricing prototype: labelled, not purchasable, exact annual totals, honest limits', async () => {
    await open('/pricing/proposal', "document.querySelector('.proposal-plans .proposal-plan')");
    const order = await evaluate("[document.querySelector('.proposal-label')?.textContent, document.querySelector('.proposal-banner').compareDocumentPosition(document.querySelector('#main h1')) & Node.DOCUMENT_POSITION_FOLLOWING]");
    if (order[0] !== 'Proposed pricing — not available for purchase' || !order[1]) throw new Error('proposal label missing or not shown first');
    if (!(await evaluate("document.head.querySelector('meta[name=robots][content=noindex]') !== null"))) throw new Error('proposal page is indexable');
    if (await evaluate("Boolean(document.querySelector('#main [data-action=checkout], #main form[action], #main a[href*=checkout]')) || [...document.querySelectorAll('#main button')].some(b => /buy|subscribe|checkout|upgrade/i.test(b.textContent))")) throw new Error('prototype offers a purchase control');
    const prices = await evaluate("[...document.querySelectorAll('.proposal-plan')].map(card => card.querySelector('h2').textContent + ' ' + card.querySelector('.proposal-price').textContent.replace(/\\s+/g, ' ').trim())");
    if (prices.join('|') !== 'Meet ₹399 per workspace, per month|Forms ₹499 per workspace, per month|Flow ₹699 per workspace, per month|Suite ₹1,199 per workspace, per month') throw new Error('unexpected monthly prices: ' + prices.join('|'));
    await evaluate("const r = document.querySelector('[name=billing][value=annual]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true }))");
    const annual = await evaluate("document.querySelector('.proposal-plan.meet').innerText");
    if (!annual.includes('₹3,990') || !annual.includes('paid once a year') || !annual.includes('₹332.50 a month')) throw new Error('annual view hides the full payment: ' + annual);
    await fill('#est-responses', '-5');
    await click('#estimate-form [type=submit]');
    await waitFor("document.querySelector('#est-responses[aria-invalid=true]') && document.querySelector('#estimate-form .field-error')", 'invalid estimate rejected');
    await fill('#est-responses', '1200');
    await click('#estimate-form [type=submit]');
    await waitFor("document.querySelector('#estimate-result').innerText.includes('200 would be refused')", 'estimate result');
    const estimateText = await evaluate("document.querySelector('#estimate-result').innerText");
    if (!estimateText.includes('₹4,990') || !/refused, not charged/.test(estimateText)) throw new Error('estimate does not explain cost and limit outcome: ' + estimateText);
    if (await evaluate("performance.getEntriesByType('resource').some(entry => /\\/api\\/(billing|workspaces\\/[^/]+\\/billing)/.test(entry.name))")) throw new Error('prototype called the billing API');
    await layoutCheck('proposed pricing');
    await open('/billing', "document.querySelector('#main h1')");
    if (await evaluate("Boolean(document.head.querySelector('meta[data-page-meta]'))")) throw new Error('noindex leaked to the next page');
    if ((await text()).includes('₹399')) throw new Error('proposed prices appear on the live Plans page');
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
    await open('/meet?tab=meetings', "document.querySelector('#side-open') && !document.querySelector('#tab-panel > .loading')");
    if ((await evaluate('document.documentElement.scrollWidth - innerWidth')) > 0) throw new Error('mobile navigation overflows');
    await click('#side-open');
    const menu = await evaluate("[...document.querySelectorAll('.side-nav a')].map(a => new URL(a.href).searchParams.get('tab')).join()");
    if (menu !== 'types,meetings,video,polls,contacts,workflows,analytics,insights,integrations,emails') throw new Error('drawer sections missing: ' + menu);
    if (!(await evaluate("document.querySelector('#main').inert && document.activeElement.id === 'side-close'"))) throw new Error('drawer focus/inert missing');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    if (!(await evaluate("!document.body.classList.contains('drawer-open') && !document.querySelector('#main').inert && document.activeElement.id === 'side-open'"))) throw new Error('Escape did not restore focus');
    await click('[data-cancel]');
    await waitFor("document.querySelector('dialog[open]')?.innerText.includes('Cancel this meeting?')", 'cancel confirmation');
    await click('dialog[open] button[value=cancel]');
    await open('/meet?tab=analytics', "document.querySelector('.side-nav a[aria-current=page][href*=analytics]')");
    if (!(await evaluate("document.querySelector('h1').innerText === 'Analytics'"))) throw new Error('active section heading missing');
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
    await open('/meet', "document.querySelector('.side-nav')");
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
      await waitFor("document.querySelectorAll('.video-tile').length === 3 && document.querySelector('#grid').dataset.sharing === 'true'", 'screen tile alongside two cameras');
      for (const [width, height] of [[375, 667], [375, 800], [768, 800], [1440, 900]]) {
        await viewport(width, height);
        const geometry = await evaluate("(() => { const tiles=[...document.querySelectorAll('.video-tile')].map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height}}); return {tiles,overlap:tiles.some((a,i)=>tiles.slice(i+1).some(b=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1)),pageOverflow:document.documentElement.scrollHeight-innerHeight}; })()");
        if (geometry.overlap || geometry.tiles.some(tile => tile.height < 40) || geometry.pageOverflow > 0) throw new Error(`Overlapping/collapsed share layout at ${width}x${height}: ${JSON.stringify(geometry)}`);
        for (const control of ['#mic', '#cam', '#devices-toggle', '#leave']) if (!(await inView(control))) throw new Error(`${control} hidden while sharing at ${width}`);
        await shot(`sharing-layout-${width}-${height}`);
      }
      await viewport(375);
      await click('#share');
      await waitFor("document.querySelector('#grid').dataset.sharing === 'false' && !document.querySelector('.video-tile-screen')", 'camera layout restored after sharing');
      await click('#devices-toggle');
      await click('#call-check summary');
      await click('#refresh-call-check');
      await waitFor("document.querySelector('#call-check-result').innerText.includes('Camera limit: up to') && document.querySelector('#call-check-result').innerText.includes('not available')", 'call check handles unavailable browser statistics honestly');
      await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
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
  await step('video room (fake-connected fixture): provider disconnect after server end shows ended, not removed', async () => {
    await withFakeRoom(async () => {
      const room = await pageApi('/api/workspaces/:ws/meet-video/rooms', { title: 'Server end check' });
      await open(new URL(room.host_url).pathname, "document.querySelector('#join-form')");
      await enterRoom();
      await pageApi(`/api/meet-video/rooms/${room.public_id}/end`);
      await evaluate("window.__fakeRoom.drop('PARTICIPANT_REMOVED')");
      await waitFor("document.querySelector('#main h1')?.textContent === 'The meeting has ended'", 'ended status takes precedence over participant removal');
      if (await evaluate("Boolean(document.querySelector('#rejoin'))")) throw new Error('rejoin offered after server end');
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
  await step('video validation pilot: scoped workspace sees limits; non-pilot stays unavailable', async () => {
    const previous = app.config.video;
    const workspaceId = await evaluate("fetch('/api/me').then(r=>r.json()).then(me=>me.workspaces[0].id)");
    app.config.video = { ...previous, enabled: false, pilot: { enabled: true, workspaceIds: [workspaceId], monthlyCredits: 60 }, maxParticipants: 2, maxRoomMinutes: 15, maxConcurrentRooms: 1, maxGlobalParticipants: 2, maxWorkspaceParticipants: 2 };
    try {
      await open('/meet?tab=video', "document.body.innerText.includes('Limited video pilot')");
      await waitFor("document.body.innerText.includes('15 minutes') && document.querySelector('#instant')", 'pilot controls and clear limits');
      await fill('#instant-title', 'Pilot workspace meeting');
      await click('#instant [type="submit"]');
      await waitFor("document.querySelector('#join-form')", 'pilot room reaches prejoin');
      await open('/meet?tab=video', "document.body.innerText.includes('Pilot workspace meeting')");
      await layoutCheck('video validation pilot');
      await open('/billing', "document.querySelector('#credits-title')");
      await waitFor("document.body.innerText.includes('Meet video credits')", 'pilot wallet remains visible while broad video is off');
      app.config.video.pilot.workspaceIds = [];
      await open('/meet?tab=video', "document.body.innerText.includes('Built-in video is not available yet')");
      if (await evaluate("Boolean(document.querySelector('#instant'))")) throw new Error('non-pilot workspace can start a pilot meeting');
    } finally { app.config.video = previous; }
  });
  await step('product hosts: landing, auth, account, onboarding and demo retain one product', async () => {
    const port = app.server.address().port;
    for (const product of ['meet', 'forms', 'flow']) {
      const origin = `http://${product}.localhost:${port}`;
      app.config.allowedOrigins.add(origin);
      await open(origin + '/', "document.querySelector('.product-landing')");
      if (await evaluate("Boolean(document.querySelector('.cookie-banner'))")) await click('.cookie-banner [data-choice=rejected]');
      if (!(await evaluate(`document.body.dataset.product === '${product}' && !document.querySelector('.ecosystem-switcher')`))) throw new Error('wrong product landing: ' + product);
      await layoutCheck(product + ' product landing');
      await open(origin + `/signup?next=/${product}`, "document.querySelector('#signup')");
      if (!(await evaluate(`document.querySelector('.auth-layout .ds-brand').innerText.includes('${product === 'meet' ? 'Meet' : product === 'forms' ? 'Forms' : 'Flow'}')`))) throw new Error('auth context lost');
      await layoutCheck(product + ' product signup');
      if ((await evaluate("document.querySelectorAll('.auth-layout .ds-signup-benefit').length")) !== 1) throw new Error('auth promotes another product');
      if (await evaluate("Boolean(document.querySelector('#signin'))")) throw new Error('sign-up shows competing sign-in form');
      await open(origin + '/login', "document.querySelector('#signin')");
      await fill('#si-email', 'nobody@example.com'); await fill('#si-password', 'wrong password');
      await click('#signin [type=submit]');
      await waitFor("document.querySelector('#signin [data-form-status]').textContent.trim().length > 0", 'visible login failure');
      await layoutCheck(product + ' product login error');
      await open(origin + `/signup?next=/${product}`, "document.querySelector('#signup')");
      await fill('#su-name', 'Product Host'); await fill('#su-email', product + '-host@example.com'); await fill('#su-password', 'a long test password'); await fill('#su-workspace', product + ' Workspace');
      await click('#signup [type=submit]');
      await waitFor(`location.pathname === '/${product}' && document.body.classList.contains('app-shell')`, 'product dashboard');
      if (await evaluate("Boolean(document.querySelector('#app-sidebar a.product-open'))")) throw new Error('duplicate open control');
      await layoutCheck(product + ' product dashboard');
      await open(origin + '/account', "document.querySelector('#sign-out')");
      if (!(await evaluate(`document.body.dataset.product === '${product}' && !document.querySelector('nav[aria-label="Your Schedora apps"]')`))) throw new Error('account context lost');
      await layoutCheck(product + ' product account');
      await click('#sign-out');
      await waitFor("!document.body.classList.contains('app-shell')", 'signed out product');
      await open(origin + '/login', "document.querySelector('#signin')");
      await fill('#si-email', product + '-host@example.com'); await fill('#si-password', 'a long test password');
      await click('#signin [type=submit]');
      await waitFor(`location.pathname === '/${product}' && document.body.classList.contains('app-shell')`, 'password login returns to product');
      await open(origin + '/signup?next=/login', "document.querySelector('.side-nav')");
      await waitFor(`location.pathname === '/${product}'`, 'signed-in auth route does not loop');
      await open(origin + '/start', "document.querySelector('#demo-welcome')");
      if ((await evaluate("document.querySelectorAll('.ds-signup-benefit').length")) !== 1) throw new Error('onboarding promotes other products');
      await click('#demo-welcome button[type=submit], #demo-welcome button.btn-primary');
      if (product === 'meet') {
        await waitFor("location.pathname === '/start/calendar'", 'Meet-only calendar setup');
        await click('a[href="/start/availability"]');
        await waitFor("document.querySelector('#setup-availability')", 'availability setup');
        await click('#setup-availability button[type=submit], #setup-availability button.btn-primary');
      } else {
        await waitFor("document.querySelector('#focused-setup')", 'focused product setup');
        await click('#focused-setup button');
      }
      await waitFor("location.pathname === '/start/share'", 'setup outcome');
      if ((await text()).includes('Everything is in place')) throw new Error('setup overclaims verification');
      await layoutCheck(product + ' setup outcome');
      await open(origin + '/demo', "document.querySelector('.ds-workspace')");
      if ((await evaluate(`document.querySelectorAll('nav[aria-label="Workspace products"] a').length`)) !== 1) throw new Error('demo shows other product navigation');
      await layoutCheck(product + ' scoped demo');
    }
    await open('/start/products', "document.querySelector('#product-selection')");
    if ((await evaluate("document.querySelectorAll('#product-selection input[type=checkbox]').length")) !== 3) throw new Error('Suite must retain all product choices');
  });
  await step('live calendar setup: failed first sync stays unverified; valid feed advances and records success', async () => {
    const originalFetch = app.fetchCalendar;
    let fail = true;
    app.fetchCalendar = async () => { if (fail) throw new Error('Synthetic calendar unavailable'); return 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'; };
    try {
      await open('/setup/meet?step=calendar', "document.querySelector('#live-calendar-form')");
      await fill('#live-ics-url', 'https://calendar.example.com/setup.ics');
      await fill('#live-ics-label', 'Setup calendar');
      await click('#live-calendar-form [type=submit]');
      await waitFor("document.querySelector('#live-calendar-form') && document.querySelector('#live-setup')?.textContent.includes('successful check not verified') || document.querySelector('#live-calendar-form') && document.body.textContent.includes('successful check not verified')", 'failed sync remains unverified');
      if (await evaluate("Boolean(document.querySelector('#live-meet-form'))")) throw new Error('failed sync advanced onboarding');
      await layoutCheck('calendar first sync failed');
      fail = false;
      await fill('#live-ics-url', 'https://calendar.example.com/setup.ics');
      await fill('#live-ics-label', 'Setup calendar');
      await click('#live-calendar-form [type=submit]');
      await waitFor("document.querySelector('#live-meet-form')", 'successful sync advances');
      const stored = app.db.get("SELECT status,last_synced_at,last_success_at FROM calendar_connections WHERE label = 'Setup calendar'");
      if (stored.status !== 'active' || !stored.last_success_at || stored.last_synced_at !== stored.last_success_at) throw new Error('success not persisted separately');
      await open('/meet?tab=integrations', "document.querySelector('#calendar-form')");
      if (!(await text()).includes('Last successful check')) throw new Error('calendar settings hide success evidence');
      await layoutCheck('calendar success evidence');
      await open('/setup/meet?step=calendar', "document.querySelector('#disconnect-live-calendar')");
      await click('#disconnect-live-calendar');
      await waitFor("!document.querySelector('#disconnect-live-calendar')", 'test calendar disconnected');
    } finally { app.fetchCalendar = originalFetch; }
  });
  await step('persisted live onboarding: Suite product choice, optional calendar skip, draft records, simulation and refresh persistence', async () => {
    await open('/setup?step=products', "document.querySelector('#live-product-selection')");
    await layoutCheck('live onboarding products');
    await click('#select-all-live-products');
    await click('#live-product-selection button[type=submit]');
    await waitFor("document.querySelector('#skip-live-calendar')", 'live calendar step');
    await click('#skip-live-calendar');
    await waitFor("document.querySelector('#live-meet-form')", 'live availability step');
    await fill('#live-event-title', 'Live Onboarding Call');
    await click('#live-meet-form button[type=submit]');
    await waitFor("document.querySelector('#live-forms-form')", 'live form step');
    await fill('#live-form-title', 'Live Onboarding Form');
    await click('#live-forms-form button[type=submit]');
    await waitFor("document.querySelector('#live-flow-form')", 'live flow step');
    await fill('#live-flow-name', 'Live Onboarding Flow');
    await click('#live-flow-form button[type=submit]');
    await waitFor("document.querySelector('#live-ready-meet') && document.querySelector('#live-ready-forms') && document.querySelector('#live-ready-flow')", 'live readiness review');
    const reviewText = await text();
    if (!reviewText.includes('Optional calendar step skipped (not verified)') || !reviewText.includes('Draft (not published)') || !reviewText.includes('draft (not enabled)')) {
      throw new Error('live onboarding readiness did not report draft/skipped states honestly: ' + reviewText.slice(0, 300));
    }
    await click('#live-simulate-flow');
    await waitFor("document.querySelector('#live-simulation-result')", 'live flow simulation');
    await open('/setup', "document.querySelector('#live-ready-meet')");
    if (!(await text()).includes('Live Onboarding Call') || !(await text()).includes('Live Onboarding Form') || !(await text()).includes('Live Onboarding Flow')) {
      throw new Error('live onboarding progress did not persist across refresh');
    }
    await layoutCheck('live onboarding review');
  });
  await step('independent accessibility checks: drawer focus trap, form labels, error announcements, contrast and 200% zoom reflow', async () => {
    await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 1, mobile: true });
    await open('/meet', "document.querySelector('#side-open')");
    await click('#side-open');
    await waitFor("document.activeElement?.id === 'side-close' && document.querySelector('#app-sidebar')?.getAttribute('aria-modal') === 'true'", 'drawer opened');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', modifiers: 8, windowsVirtualKeyCode: 9 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', modifiers: 8, windowsVirtualKeyCode: 9 });
    if (!(await evaluate("Boolean(document.activeElement?.closest('#app-sidebar')) && document.activeElement?.id !== 'side-close'"))) throw new Error('Shift+Tab did not wrap inside drawer');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    if (!(await evaluate("document.activeElement?.id === 'side-close'"))) throw new Error('Tab did not wrap back to #side-close');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    if (!(await evaluate("document.activeElement?.id === 'side-open' && !document.body.classList.contains('drawer-open')"))) throw new Error('Escape did not restore focus to #side-open');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

    await open('/setup?step=products', "document.querySelector('#live-product-selection')");
    const unlabeled = await evaluate("[...document.querySelectorAll('#main input:not([type=hidden]), #main select, #main textarea')].filter(el => !(el.labels?.length || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'))).length");
    if (unlabeled > 0) throw new Error('unlabeled form controls on /setup: ' + unlabeled);
    await evaluate("document.querySelectorAll('#live-product-selection input[type=checkbox]').forEach(b => { b.checked = false; })");
    await click('#live-product-selection button[type=submit]');
    await waitFor("document.querySelector('#live-product-selection [data-form-status] [role=alert]')", 'validation alert');
    if (!(await evaluate("document.querySelector('#live-product-selection [data-form-status] [role=alert]').innerText.includes('Choose at least one product')"))) throw new Error('validation error not announced');

    const contrastOk = await evaluate(`(() => {
      const lum = rgb => { const [r, g, b] = rgb.match(/\\d+/g).slice(0, 3).map(n => { const c = n / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
      const bodyStyle = getComputedStyle(document.body);
      const btn = document.querySelector('.btn-primary');
      const btnStyle = getComputedStyle(btn);
      return ratio(bodyStyle.color, bodyStyle.backgroundColor) >= 4.5 && ratio(btnStyle.color, btnStyle.backgroundColor) >= 4.5;
    })()`);
    if (!contrastOk) throw new Error('contrast ratio below 4.5:1 on body or .btn-primary');

    for (const width of [640, 320]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 2, mobile: width < 640 });
      await evaluate("document.documentElement.style.setProperty('line-height', '1.5'); document.documentElement.style.setProperty('letter-spacing', '0.12em'); document.documentElement.style.setProperty('word-spacing', '0.16em');");
      await new Promise(resolve => setTimeout(resolve, 60));
      const zoomOverflow = await evaluate('document.documentElement.scrollWidth - window.innerWidth');
      await evaluate("document.documentElement.style.removeProperty('line-height'); document.documentElement.style.removeProperty('letter-spacing'); document.documentElement.style.removeProperty('word-spacing');");
      if (zoomOverflow > 0) throw new Error('200% zoom / text-spacing overflow at ' + width + 'px: ' + zoomOverflow);
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  });

  await step('Team host setup: private summaries, keyboard disclosure, role changes and failed refresh', async () => {
    const me = await evaluate("fetch('/api/me').then(r=>r.json())");
    const ws = me.workspaces[0].id;
    const host = me.user.id;
    const peer = crypto.randomUUID();
    app.db.run('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', peer, peer + '@example.com', 'Ravi — training and consultation team', 'test-only-unused-password', app.now());
    app.db.run("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)", ws, peer, app.now());
    const request = (method, path, body) => evaluate(`(async()=>{const me=await(await fetch('/api/me')).json();const r=await fetch(${JSON.stringify('/api/workspaces/' + ws + path)},{method:${JSON.stringify(method)},headers:{'Content-Type':'application/json','X-CSRF-Token':me.csrf_token},body:${JSON.stringify(body ? JSON.stringify(body) : undefined)}});return r.json()})()`);
    const type = await request('POST', '/event-types', { title: 'Team readiness verification', kind: 'collective', timezone: 'Asia/Kolkata', published: false, hosts: [{ user_id: host }, { user_id: peer }], use_host_schedules: true, locations: [{ type: 'zoom' }] });
    if (!type.id) throw new Error('team fixture was not created: ' + JSON.stringify(type));
    const sentinel = 'DO_NOT_SHOW_PRIVATE_CALENDAR';
    app.db.run('INSERT INTO calendar_connections (id, workspace_id, user_id, provider, feed_url, label, status, last_error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', crypto.randomUUID(), ws, peer, 'ics', 'https://example.com/' + sentinel, sentinel, 'error', sentinel, app.now());
    const effects = () => JSON.stringify(app.db.get('SELECT (SELECT COUNT(*) FROM bookings) AS bookings, (SELECT COUNT(*) FROM emails) AS emails, (SELECT COUNT(*) FROM busy_blocks) AS blocks, (SELECT COUNT(*) FROM outbox) AS outbox'));
    const before = effects();
    const ready = "document.querySelector('[data-host-readiness]')";
    await open('/meet/event-types/' + type.id, ready);
    if (await evaluate("document.querySelector('[data-host-readiness]').open")) throw new Error('host breakdown should start collapsed');
    await evaluate("document.querySelector('[data-host-readiness] summary').focus()");
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    if (!(await evaluate("document.querySelector('[data-host-readiness]').open && document.activeElement.matches('[data-host-readiness] summary') && getComputedStyle(document.activeElement).outlineStyle !== 'none'"))) throw new Error('keyboard disclosure/focus failed');
    const text = await evaluate("document.querySelector('[data-host-readiness]').innerText");
    if (!text.includes('latest calendar check failed') || !text.includes('Needs setup: not connected') || !text.includes('event schedule as a fallback') || text.includes(sentinel)) throw new Error('wrong or private host evidence: ' + text);
    await evaluate("document.querySelector('[data-host-readiness]').scrollIntoView({block:'start'})");
    await layoutCheck('team host setup owner', '[data-host-readiness]');
    // A stale client role must not defeat the server's fresh scope decision.
    app.db.run("UPDATE memberships SET role = 'member' WHERE workspace_id = ? AND user_id = ?", ws, host);
    try {
      await click('[data-recheck]');
      await waitFor("document.querySelector('[data-host-readiness]')?.textContent.includes('only this host and workspace admins')", 'restricted cohost evidence');
      await click('[data-host-readiness] summary');
      const restricted = await evaluate("document.querySelector('[data-host-readiness]').innerText");
      if (restricted.includes('latest calendar check failed') || restricted.includes(sentinel)) throw new Error('another host setup leaked after role change');
      await evaluate("document.querySelector('[data-host-readiness]').scrollIntoView({block:'start'})");
      await layoutCheck('team host setup cohost', '[data-host-readiness]');
    } finally { app.db.run("UPDATE memberships SET role = 'owner' WHERE workspace_id = ? AND user_id = ?", ws, host); }
    await evaluate("window.originalReadinessFetch=window.fetch;window.fetch=(url,...args)=>String(url).endsWith('/host-readiness')?Promise.resolve(new Response(JSON.stringify({error:{code:'unavailable',message:'Private provider error'}}),{status:503,headers:{'Content-Type':'application/json'}})):window.originalReadinessFetch(url,...args)");
    try {
      await click('[data-recheck]');
      await waitFor("document.querySelector('[data-host-evidence-error]')", 'host evidence failure');
      if (await evaluate("Boolean(document.querySelector('[data-host-readiness]')) || document.querySelector('[data-host-evidence-error]').innerText.includes('Private provider error')")) throw new Error('failed refresh retained success or leaked raw error');
    } finally { await evaluate("window.fetch=window.originalReadinessFetch;delete window.originalReadinessFetch"); }
    if (effects() !== before) throw new Error('readiness reads changed bookings, email, busy times or outbox');
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
