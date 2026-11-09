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
import { createRateLimiter } from '../src/http.mjs';

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
let expectedOfflineSubmitUrl = null;
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data);
  if (message.id && pending.has(message.id)) { const { resolve, reject } = pending.get(message.id); pending.delete(message.id); message.error ? reject(new Error(message.error.message)) : resolve(message.result); }
  if (message.method === 'Runtime.exceptionThrown') problems.push(`${currentLabel}: exception ${message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text}`);
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') problems.push(`${currentLabel}: console.error ${message.params.args.map(arg => arg.value ?? arg.description).join(' ')}`);
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error' && !/status of 4\d\d/.test(message.params.entry.text)) {
    const entry = message.params.entry;
    // Only the deliberately offline submission in the recovery journey is expected to fail.
    if (!(expectedOfflineSubmitUrl && entry.url === expectedOfflineSubmitUrl && /net::ERR_INTERNET_DISCONNECTED/.test(entry.text))) {
      problems.push(`${currentLabel}: ${entry.text} ${entry.url || ''}`);
    }
  }
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
  // Each journey has its own allowance: on a fast machine they would otherwise share one minute's limit.
  app.rateLimit = createRateLimiter();
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
    if ((await evaluate("document.querySelectorAll('#form-templates [data-template]').length")) !== 11) throw new Error('expected blank plus ten goal templates');
    for (const id of ['proposal-questions', 'renewal-feedback']) {
      if (!(await evaluate(`Boolean(document.querySelector('#form-templates [data-template="${id}"]'))`))) throw new Error('missing sales/client template: ' + id);
    }
    const starts = await evaluate("[...document.querySelectorAll('#form-templates .template-grid')[0].querySelectorAll('h3')].map(h => h.textContent)");
    if (starts.join('|') !== 'Blank form|Import JSON') throw new Error('unexpected own starting points: ' + starts.join('|'));
    const featured = await evaluate("[...document.querySelectorAll('#form-templates .template-grid')[1].querySelectorAll('h3')].map(h => h.textContent)");
    if (featured.join('|') !== 'Sales discovery|Demo request|Client onboarding|Client review|Proposal questions|Support and renewal feedback') throw new Error('unexpected featured templates: ' + featured.join('|'));
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
    await click('#builder-index [data-section="questions"]'); // publishing left the share surface showing
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
  // The builder shows one question at a time: choose it in the sidebar by its key. Returns its index.
  const selectQuestion = async key => {
    const index = await evaluate(`document.querySelector('[data-question-key="${key}"]').dataset.questionRow`);
    await click(`[data-question-index="${index}"]`);
    return Number(index);
  };
  const questionKeys = () => evaluate("[...document.querySelectorAll('[data-question-key]')].map(row => row.dataset.questionKey)");
  await step('form builder: three panes keep content, settings and selection apart', async () => {
    await open(`/forms/${formId}`, "document.querySelector('#fields .question-canvas') && document.querySelector('[data-question-key=\"topic\"]')");
    const i = await selectQuestion('topic');
    const placed = await evaluate(`(() => { const inPane = (selector, pane) => Boolean(document.querySelector('[data-index="${i}"] ' + selector)?.closest(pane)); return { label: inPane('[data-prop="label"]', '.question-canvas'), options: inPane('[data-option]', '.question-canvas'), media: inPane('[data-media-file]', '.question-settings'), type: inPane('[data-type]', '.question-settings'), required: inPane('[data-prop="required"]', '.question-settings'), key: inPane('[data-prop="id"]', '.question-settings'), logic: inPane('[data-logic]', '.question-settings') }; })()`);
    if (Object.values(placed).includes(false)) throw new Error('controls are in the wrong pane: ' + JSON.stringify(placed));
    const panes = await evaluate("['.question-sidebar', '.question-canvas', '.question-settings'].map(selector => { const box = document.querySelector(selector).getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top }; })");
    if (!(panes[0].right <= panes[1].left && panes[1].right <= panes[2].left)) throw new Error('panes are not side by side at 1280 px: ' + JSON.stringify(panes));
    if ((await evaluate(`document.querySelector('[data-question-index="${i}"]').getAttribute('aria-pressed')`)) !== 'true' || (await evaluate("document.querySelectorAll('[data-question-index][aria-pressed=\"true\"]').length")) !== 1) throw new Error('selection not exposed on exactly one sidebar row');
    if (!(await evaluate(`(() => { const selected = getComputedStyle(document.querySelector('[data-question-index="${i}"]').closest('.question-row')); const probe = document.createElement('i'); probe.style.color = 'var(--forms)'; document.body.append(probe); const brand = getComputedStyle(probe).color; probe.remove(); return selected.boxShadow.includes(brand) && selected.backgroundColor !== 'rgba(0, 0, 0, 0)'; })()`))) throw new Error('selected row has no neutral fill and Forms brand edge');
    // Typing on the canvas updates the sidebar and the live preview together.
    await fill(`[data-index="${i}"] [data-prop="label"]`, 'Canvas wording');
    if (!(await evaluate(`document.querySelector('[data-question-row="${i}"]').innerText.includes('Canvas wording') && document.querySelector('#preview').textContent.includes('Canvas wording')`))) throw new Error('canvas edit did not reach the sidebar and preview');
    // The live preview is one switch away at every width, and the outline collapses to icons on narrower desktops with its names intact.
    await click('.mobile-switch [data-view="preview"]');
    if (!(await evaluate("getComputedStyle(document.querySelector('.builder-preview')).display !== 'none' && getComputedStyle(document.querySelector('.builder-edit')).display === 'none'"))) throw new Error('preview not shown by the switch');
    await click('.mobile-switch [data-view="edit"]');
    await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
    const collapsed = await evaluate("(() => { const rail = document.querySelector('.question-sidebar').getBoundingClientRect(); const label = document.querySelector('.question-row-label'); return { rail: rail.width, clipped: label.getBoundingClientRect().width <= 1, name: label.closest('button').textContent }; })()");
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    if (collapsed.rail > 92 || !collapsed.clipped || !collapsed.name.trim()) throw new Error('outline did not collapse with accessible names: ' + JSON.stringify(collapsed));
    await layoutCheck('form builder three panes', '#questions');
    await evaluate('delete document.body.dataset.dirty');
  });
  await step('form builder: drag reorder matches the move buttons, can be cancelled and keeps logic honest', async () => {
    await open(`/forms/${formId}`, "document.querySelector('[data-question-key=\"details\"]')");
    const mouse = (type, x, y, buttons) => send('Input.dispatchMouseEvent', { type, x, y, buttons, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    // Scrolls only when told to: scrolling between reading two rows would leave the first position stale.
    const middle = (index, scroll = true) => evaluate(`(() => { const row = document.querySelector('[data-question-row="${index}"]'); ${scroll ? "row.scrollIntoView({ block: 'center' });" : ''} const box = row.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2, height: box.height }; })()`);
    const begin = async (from, to) => {
      const start = await middle(from);
      const end = await middle(to, false);
      const y = end.y + (to > from ? end.height / 2 - 1 : -end.height / 2 + 1);
      await mouse('mouseMoved', start.x, start.y, 0);
      await mouse('mousePressed', start.x, start.y, 1);
      await mouse('mouseMoved', start.x, start.y + Math.sign(y - start.y) * 10, 1);
      await mouse('mouseMoved', end.x, y, 1);
      return { x: end.x, y };
    };
    const original = await questionKeys();
    if (original.join() !== 'name,email,topic,details') throw new Error('unexpected starting order: ' + original.join());
    try {
      // Holding a row over another shows where it would land; nothing has moved yet.
      let at = await begin(0, 1);
      if (!(await evaluate("document.querySelector('[data-question-row=\"0\"]').classList.contains('dragging') && Boolean(document.querySelector('.drop-before, .drop-after'))")) || (await questionKeys()).join() !== original.join()) throw new Error('drag shows no drop position, or moved early');
      // Escape cancels: same order, no unsaved change, no leftovers, and a later click still selects.
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await mouse('mouseReleased', at.x, at.y, 0);
      if ((await questionKeys()).join() !== original.join() || (await text()).includes('Unsaved changes') || (await evaluate("Boolean(document.querySelector('.dragging, .drop-before, .drop-after, .is-dragging'))"))) throw new Error('Escape did not cancel the drag cleanly');
      const plain = await middle(2);
      await mouse('mouseMoved', plain.x, plain.y, 0);
      await mouse('mousePressed', plain.x, plain.y, 1);
      await mouse('mouseReleased', plain.x, plain.y, 0);
      if ((await evaluate("document.querySelector('[data-question-index=\"2\"]').getAttribute('aria-pressed')")) !== 'true') throw new Error('a plain click on a row does not select it');
      // A real drop: the moved question stays selected and focused, the draft is unsaved, the move is announced, and a rule still valid survives.
      at = await begin(0, 1);
      await mouse('mouseReleased', at.x, at.y, 0);
      if ((await questionKeys()).join() !== 'email,name,topic,details') throw new Error('drag did not reorder: ' + (await questionKeys()).join());
      if (!(await focused('[data-question-index="1"]')) || (await evaluate("document.querySelector('[data-question-index=\"1\"]').getAttribute('aria-pressed')")) !== 'true' || (await evaluate("document.querySelector('#fields [data-prop=\"id\"]').value")) !== 'name') throw new Error('moved question not selected and focused after the drop');
      await waitFor("document.querySelector('#builder-live').innerText.includes('position 2')", 'drag announced');
      if (!(await text()).includes('Unsaved changes')) throw new Error('drag did not mark the draft unsaved');
      if (!(await evaluate("document.querySelector('[data-question-row=\"3\"]').innerText.includes('Logic')"))) throw new Error('a rule that is still valid was lost');
      // The move buttons act on the same order.
      await click('[data-index="1"] [data-move="-1"]');
      if ((await questionKeys()).join() !== 'name,email,topic,details') throw new Error('move button did not undo the drag');
      // Dragging a question below the one whose rule depends on it removes the rule, visibly.
      at = await begin(2, 3);
      await mouse('mouseReleased', at.x, at.y, 0);
      if ((await questionKeys()).join() !== 'name,email,details,topic') throw new Error('second drag did not reorder: ' + (await questionKeys()).join());
      await waitFor("document.querySelector('#builder-live').innerText.includes('display rule was removed')", 'removed rule announced');
      if (await evaluate("document.querySelector('[data-question-row=\"2\"]').innerText.includes('Logic')")) throw new Error('rule pointing at a later question was kept');
      if (!(await evaluate("[...document.querySelectorAll('.toast')].some(toast => toast.innerText.includes('display rule was removed'))"))) throw new Error('removed rule not shown to sighted users');
    } finally { await evaluate('delete document.body.dataset.dirty'); }
    await open(`/forms/${formId}`, "document.querySelector('[data-question-key=\"details\"]')");
    if ((await questionKeys()).join() !== original.join()) throw new Error('an unsaved drag changed the saved order');
  });
  await step('form builder: logic in plain words, keyed duplicate, first-match routing explained', async () => {
    await open(`/forms/${formId}`, "document.querySelector('#fields [data-prop=label]') && document.querySelector('[data-question-key=\"details\"]')");
    await selectQuestion('details');
    const sentence = await evaluate("document.querySelector('#fields [data-logic-sentence]').textContent");
    if (sentence !== 'Shown only when “What can we help with?” is “Something else”.') throw new Error('unexpected logic sentence: ' + sentence);
    await selectQuestion('topic');
    await fill('[data-index="2"] [data-prop="label"]', 'What brings you here?');
    await selectQuestion('details');
    if (!(await evaluate("document.querySelector('#fields [data-logic-sentence]').textContent.includes('What brings you here?')"))) throw new Error('logic sentence does not follow the edited label');
    const before = (await questionKeys()).length;
    await selectQuestion('topic');
    await click('[data-index="2"] [data-duplicate]');
    if (!(await focused('[data-index="3"] [data-prop="label"]'))) throw new Error('duplicate does not focus the copy');
    const keys = await questionKeys();
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
  await step('form builder: top navigation keeps edits, moves focus, shows one surface and stays in view', async () => {
    await open(`/forms/${formId}`, "document.querySelector('#builder-index [data-section]') && document.querySelector('#fields [data-prop=label]')");
    await fill('#f-title', 'Unsaved index title');
    const path = await evaluate('location.pathname + location.search + location.hash');
    const key = async (name, code) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: code }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code }); };
    const enter = () => key('Enter', 13);
    const shown = selector => evaluate(`document.querySelector('${selector}').getClientRects().length > 0`);
    try {
    // Real Tab presses: the navigation follows the breadcrumb and every link shows a focus ring.
    await evaluate("document.querySelector('.builder-crumbs a').focus()");
    for (const section of ['questions', 'workflow', 'settings', 'share']) {
      await key('Tab', 9);
      if (!(await evaluate(`document.activeElement.dataset.section === '${section}' && getComputedStyle(document.activeElement).outlineStyle !== 'none'`))) throw new Error(`Tab does not reach the ${section} link with visible focus`);
    }
    for (const [section, heading, surface, hidden] of [['share', '#share-heading', '#share-panel', '.question-canvas'], ['settings', '#settings-heading', '#routing', '#share-panel'], ['questions', '#questions-heading', '.question-canvas', '#settings']]) {
      await evaluate(`document.querySelector('#builder-index [data-section="${section}"]').focus()`);
      await enter();
      if (!(await focused(heading))) throw new Error(`link ${section} does not move focus to ${heading}`);
      if (!(await evaluate(`document.querySelector('#builder-index [data-section="${section}"]').getAttribute('aria-current') === 'location'`))) throw new Error(`${section} not marked current`);
      if (!(await shown(surface)) || (await shown(hidden))) throw new Error(`${section} does not show exactly its own surface`);
    }
    if ((await evaluate('location.pathname + location.search + location.hash')) !== path || (await evaluate("document.querySelector('#f-title').value")) !== 'Unsaved index title' || !(await text()).includes('Unsaved changes')) throw new Error('the navigation changed the address or lost unsaved edits');
    if (await evaluate("document.querySelector('.builder-topbar').getBoundingClientRect().top !== 0")) throw new Error('top bar not in view on a wide screen');
    await layoutCheck('form builder top navigation', '#questions');
    // Design opens beside the canvas and closes back to its button.
    await click('#open-design');
    if (!(await shown('#design-panel')) || !(await focused('#design-heading'))) throw new Error('Design does not open its panel');
    await click('[data-design-close]');
    if (await shown('#design-panel')) throw new Error('Design does not close');
    // Phone: the bar scrolls away, and the Preview switch shows the preview.
    await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 1, mobile: true });
    await click('.mobile-switch [data-view="preview"]');
    if (!(await evaluate("getComputedStyle(document.querySelector('.builder-edit')).display === 'none' && getComputedStyle(document.querySelector('.builder-preview')).display !== 'none'"))) throw new Error('phone switch does not show the preview');
    await click('#builder-index [data-section="questions"]');
    // On phones the outline is folded into its bar, which names the selected question and takes focus.
    if (!(await evaluate("getComputedStyle(document.querySelector('.builder-edit')).display !== 'none'")) || !(await focused('#outline-toggle'))) throw new Error('phone Content link does not return to the editor');
    if (await evaluate("getComputedStyle(document.querySelector('.builder-topbar')).position === 'sticky'")) throw new Error('top bar should not be sticky on phones');
    } finally {
      await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await evaluate('delete document.body.dataset.dirty');
    }
  });
  await step('form builder: question type changes are safe, explained, cancellable and never retype a published key', async () => {
    await open(`/forms/${formId}`, "document.querySelector('#fields [data-type]') && document.querySelector('[data-question-key=\"details\"]')");
    try {
    const types = () => evaluate("JSON.stringify([...document.querySelectorAll('[data-question-type]')].map(row => row.dataset.questionType))");
    const choose = async (key, type) => { const i = await selectQuestion(key); await evaluate(`(() => { const select = document.querySelector('[data-index="${i}"] [data-type]'); select.focus(); select.value = '${type}'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`); return i; };
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
  await step('form media: upload an image with alt text, picture choices, click-to-load video, failure fallbacks, published delivery', async () => {
    // A real PNG on disk for the file inputs (64 × 48, gradient), written with the standard library.
    const { deflateSync, crc32 } = await import('node:zlib');
    const pngChunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), 8 + data.length); return out; };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(64, 0); ihdr.writeUInt32BE(48, 4); ihdr[8] = 8; ihdr[9] = 2;
    const rows = Buffer.alloc((64 * 3 + 1) * 48); for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) { const at = y * 193 + 1 + x * 3; rows[at] = x * 4; rows[at + 1] = 120; rows[at + 2] = y * 5; }
    const pngPath = join(workDir, 'room.png');
    writeFileSync(pngPath, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(rows)), pngChunk('tEXt', Buffer.from('Comment\0private camera note')), pngChunk('IEND', Buffer.alloc(0))]));
    const setFile = async selector => {
      const { root } = await send('DOM.getDocument', { depth: -1 });
      const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) throw new Error('missing file input ' + selector);
      await send('DOM.setFileInputFiles', { nodeId, files: [pngPath] });
    };
    const providerRequests = [];
    const watch = ({ data }) => { const message = JSON.parse(data); if (message.method === 'Network.requestWillBeSent' && /youtube|vimeo|ytimg/.test(message.params.request.url)) providerRequests.push(message.params.request.url); };
    socket.addEventListener('message', watch);
    await send('Network.enable');
    try {
      // A form of its own, so later steps keep their version numbers.
      await open('/forms', "document.querySelector('#new-form')");
      await click('#new-form');
      await click('[data-template="blank"]');
      await waitFor("document.querySelector('#fields [data-media-file]')", 'media form builder');
      const mediaFormId = await evaluate("location.pathname.split('/')[2]");
      const mediaSlug = app.db.get('SELECT slug FROM forms WHERE id = ?', mediaFormId).slug;
      const row = selectQuestion;
      // Image on the first question: real upload, metadata stripped on the server, alt text required.
      let i = await row('name');
      await setFile(`[data-index="${i}"] [data-media-file]`);
      await waitFor(`document.querySelector('[data-index="${i}"] [data-media-status]')?.innerText.includes('Image uploaded')`, 'image uploaded', 15000);
      if (!(await focused(`[data-index="${i}"] [data-media-alt]`))) throw new Error('alt text field not focused after upload');
      const stored = app.db.get('SELECT mime, data FROM form_assets ORDER BY created_at DESC LIMIT 1');
      if (!stored || Buffer.from(stored.data, 'base64').includes('private camera note')) throw new Error('uploaded image kept its metadata or was not stored');
      await click('#save');
      await waitFor("document.querySelector('#builder-notice').innerText.includes('description')", 'missing alt text refused');
      await fill(`[data-index="${i}"] [data-media-alt]`, 'A floor plan with two rooms');
      if (!(await evaluate("[...document.querySelectorAll('#preview [data-media-image] img')].some(img => img.alt === 'A floor plan with two rooms')"))) throw new Error('preview does not show the image with its alt text');
      // Picture on a choice option.
      i = await row('topic');
      await setFile(`[data-index="${i}"] [data-option-file="0"]`);
      await waitFor(`document.querySelector('[data-index="${i}"] .option-thumb')`, 'option picture', 15000);
      // Video on the email question: an unsupported address is refused, a YouTube link becomes a placeholder.
      i = await row('email');
      await click(`[data-index="${i}"] [data-media-video]`);
      if (!(await focused(`[data-index="${i}"] [data-video-url]`))) throw new Error('video address field not focused');
      await fill(`[data-index="${i}"] [data-video-url]`, '<iframe src="https://evil.example/embed"></iframe>');
      await click(`[data-index="${i}"] [data-video-add]`);
      if (!(await evaluate(`document.querySelector('[data-index="${i}"] [data-media-status]').innerText.includes('not a YouTube or Vimeo')`))) throw new Error('unsupported video address not refused');
      await fill(`[data-index="${i}"] [data-video-url]`, 'https://youtu.be/dQw4w9WgXcQ');
      await click(`[data-index="${i}"] [data-video-add]`);
      await waitFor(`document.querySelector('[data-index="${i}"] [data-media-title]')`, 'video added');
      await click('#save');
      await waitFor("document.querySelector('#builder-status').innerText.includes('All changes saved')", 'media saved');
      await row('name');
      await evaluate("document.querySelector('#fields [data-media-alt]').scrollIntoView({ block: 'center' })");
      await layoutCheck('form builder media editor', '#questions');
      // Image failure in the preview falls back to text. Shown first: a lazy image in a hidden panel never loads.
      await click('.mobile-switch [data-view="preview"]');
      await evaluate("document.querySelector('#preview [data-media-image] img').src = '/api/public/form-assets/' + 'f'.repeat(32)");
      await waitFor("!document.querySelector('#preview .q-media-failed').hidden", 'image fallback');
      await click('.mobile-switch [data-view="edit"]');
      await click('#publish');
      await waitFor("document.querySelector('#share-link') && document.querySelector('#builder-status').innerText.includes('Live · version 1')", 'published with media');
      // The question image and the option picture are the same file, so the server stores and records it once.
      if (app.db.get('SELECT COUNT(*) AS count FROM form_version_assets WHERE form_id = ?', mediaFormId).count !== 1 || app.db.get('SELECT COUNT(*) AS count FROM form_assets').count !== 1) throw new Error('published version does not record its deduplicated image');
      // Public form: images from this service only, no provider request until the respondent loads the video.
      providerRequests.length = 0;
      await open(`/f/${mediaSlug}`, "document.querySelector('#form-root [data-media-image] img')");
      await waitFor("[...document.querySelectorAll('#form-root img')].every(img => img.complete && img.naturalWidth > 0)", 'public images loaded');
      const publicImage = await evaluate("fetch(document.querySelector('#form-root [data-media-image] img').src, { credentials: 'omit' }).then(r => [r.status, r.headers.get('content-type')])");
      if (publicImage[0] !== 200 || publicImage[1] !== 'image/png') throw new Error('public image not served without sign-in: ' + publicImage);
      if (!(await evaluate("document.querySelector('#form-root .picture-choices .picture-choice img').alt === '' && document.querySelector('#form-root .picture-choice .choice-text').textContent.length > 0"))) throw new Error('picture choice lacks its text label');
      await evaluate("document.querySelector('#form-root [name=topic]').focus()");
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
      if (!(await evaluate("document.querySelector('#form-root [name=topic]').checked && getComputedStyle(document.querySelector('#form-root .picture-choice')).outlineStyle !== 'none'"))) throw new Error('picture choice not selectable by keyboard with visible focus');
      if (!(await evaluate("Boolean(document.querySelector('#form-root [data-load-video]')) && !document.querySelector('#form-root iframe') && document.querySelector('#form-root .q-video').innerText.includes('connects to YouTube')"))) throw new Error('video placeholder missing or loaded early');
      if (await evaluate("document.querySelector('#form-root .q-video').innerText.includes('{{')")) throw new Error('video title shows an unpiped insertion');
      await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 800, deviceScaleFactor: 1, mobile: true });
      if (!(await evaluate("(() => { const box = document.querySelector('#form-root .q-video-placeholder'); return box.scrollHeight <= box.clientHeight + 1; })()"))) throw new Error('video placeholder clips its text at 320 px');
      await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await layoutCheck('public form with media', '#form-root');
      if (providerRequests.length) throw new Error('provider contacted before the respondent chose to load the video: ' + providerRequests.join(', '));
      await click('#form-root [data-load-video]');
      const frame = await evaluate("[document.querySelector('#form-root iframe')?.getAttribute('src'), document.querySelector('#form-root iframe')?.title, document.activeElement?.tagName]");
      if (frame[0] !== 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0' || !frame[1].startsWith('YouTube video:') || frame[2] !== 'IFRAME') throw new Error('video did not load the controlled embed with a title: ' + frame);
    } finally {
      socket.removeEventListener('message', watch);
      await send('Network.disable').catch(() => {});
      await evaluate('delete document.body.dataset.dirty').catch(() => {});
    }
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
  await step('contact form acceptance: add, reorder, focus, jump, endings, preview sizes, publish, keyboard respondent, inbox and CSV', async () => {
    const press = async (name, code, modifiers = 0) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: code.startsWith('Key') || code.startsWith('Arrow') ? code : name, windowsVirtualKeyCode: name.length === 1 ? name.toUpperCase().charCodeAt(0) : Number(code.replace(/\D/g, '')) || { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38 }[name], text: name === 'Enter' ? '\r' : undefined, modifiers }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: code.startsWith('Key') || code.startsWith('Arrow') ? code : name, modifiers }); };
    const type = value => send('Input.insertText', { text: value });
    await open('/forms', "document.querySelector('#new-form')");
    await click('#new-form');
    await click('[data-template="blank"]');
    await waitFor("document.querySelector('[data-question-key=\"name\"]')", 'blank builder');
    const id = await evaluate("location.pathname.split('/')[2]");
    try {
      // Reopened, without the one-time "Draft created" notice: the question is on the first screen.
      await open(`/forms/${id}`, "document.querySelector('[data-question-key=\"name\"]')");
      if (await evaluate("getComputedStyle(document.querySelector('#app-sidebar')).display !== 'none'")) throw new Error('the workspace sidebar still shows inside the editor');
      const panes = await evaluate("(() => { const box = selector => document.querySelector(selector).getBoundingClientRect(); const rail = box('.question-sidebar'); const tools = box('.builder-toolbar'); const canvas = box('.canvas-frame'); const inspector = box('.question-settings'); const label = box('#fields [data-prop=\"label\"]'); return { top: box('.builder-topbar').height, rail: rail.width, inspector: inspector.width, toolbar: tools.height, railTop: rail.top, toolsTop: tools.top, inspectorTop: inspector.top, ratio: canvas.width / canvas.height, labelBottom: label.bottom, height: innerHeight, scrolls: document.documentElement.scrollHeight > innerHeight }; })()");
      // Measured from the reference captures at 1280 px, in CSS pixels.
      if (panes.top !== 56 || panes.rail !== 256 || panes.inspector !== 256 || panes.toolbar !== 49 || panes.railTop !== 56 || panes.toolsTop !== 56 || panes.inspectorTop !== 56 || Math.abs(panes.ratio - 16 / 9) > 0.03 || panes.labelBottom > panes.height - 100 || panes.scrolls) throw new Error('editor layout drifted: ' + JSON.stringify(panes));
      await fill('#f-title', 'Contact us');
      // The add-content picker: keyboard open, arrows, Escape returns focus; adding focuses the new question.
      await selectQuestion('name');
      await evaluate("document.querySelector('#add-field').focus()");
      await press('Enter', 'Enter');
      if ((await evaluate("document.querySelector('#add-field').getAttribute('aria-expanded')")) !== 'true' || !(await focused('[data-add-type="contact_info"]'))) throw new Error('picker did not open with focus on its first item');
      await press('ArrowDown', 'ArrowDown');
      if (!(await focused('[data-add-type="email"]'))) throw new Error('arrow key did not move through the picker');
      await press('Escape', 'Escape');
      if (!(await evaluate("document.querySelector('#add-menu').hidden")) || !(await focused('#add-field'))) throw new Error('Escape did not close the picker and return focus');
      await click('#add-field');
      await click('[data-add-type="phone"]');
      if (!(await focused('[data-index="1"] [data-prop="label"]'))) throw new Error('adding did not focus the new question');
      if ((await questionKeys())[0] !== 'name' || (await evaluate("document.querySelector('[data-question-index=\"1\"]').getAttribute('aria-pressed')")) !== 'true') throw new Error('new question not added below and selected');
      await fill('[data-index="1"] [data-prop="label"]', 'Phone number');
      const phoneKey = (await questionKeys())[1];
      await waitFor("document.querySelector('#builder-live').innerText.includes('added at position 2')", 'add announced');
      // Move, duplicate and delete keep focus on the question being worked on.
      await click('[data-index="1"] [data-move="1"]');
      if ((await questionKeys()).join() !== `name,email,${phoneKey},topic,details` || !(await focused('[data-index="2"] [data-move="1"]'))) throw new Error('move lost order or focus');
      await click('[data-index="2"] [data-duplicate]');
      if (!(await focused('[data-index="3"] [data-prop="label"]')) || (await questionKeys()).length !== 6) throw new Error('duplicate lost focus');
      await click('[data-index="3"] [data-remove]');
      if (!(await focused('[data-index="3"] [data-remove]')) || (await questionKeys()).join() !== `name,email,${phoneKey},topic,details`) throw new Error('delete lost focus');
      await selectQuestion(phoneKey);
      await click('[data-index="2"] [data-prop="required"]');
      // Endings and a jump to one: the rule reads in plain words and appears in the outline.
      await click('#add-ending');
      if (!(await focused('[data-ending-prop="title"]'))) throw new Error('adding an ending did not focus its title');
      await fill('[data-ending-prop="title"]', 'Thanks, {{name}}');
      await click('#add-ending');
      await fill('[data-ending-prop="title"]', 'Sales will call you');
      await fill('[data-ending-prop="message"]', 'Expect a reply within a day.');
      if ((await evaluate("document.querySelectorAll('[data-ending-index]').length")) !== 2 || !(await evaluate("document.querySelector('[data-ending-index=\"0\"]').innerText.includes('Default')"))) throw new Error('endings missing from the outline');
      await selectQuestion('topic');
      await click('[data-jump-add]');
      if (!(await focused('[data-jump="0"] [data-jump-field]'))) throw new Error('adding a jump did not focus it');
      const salesEnding = await evaluate("[...document.querySelectorAll('[data-jump-to] option')].find(option => option.textContent === 'Sales will call you').value");
      await evaluate(`(() => { const select = document.querySelector('[data-jump-to]'); select.value = ${JSON.stringify(salesEnding)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      if (!(await focused('[data-jump="0"] [data-jump-to]')) || !(await evaluate("document.querySelector('[data-jump-sentence]').textContent.includes('Sales will call you')"))) throw new Error('jump target not applied');
      if (!(await evaluate("document.querySelector('[data-question-key=\"topic\"]').innerText.includes('Logic')"))) throw new Error('jump not marked in the outline');
      // Preview at both sizes, in the real renderer, stores nothing.
      const responsesBefore = app.db.get('SELECT COUNT(*) AS count FROM responses WHERE form_id = ?', id).count;
      await click('.mobile-switch [data-view="preview"]');
      await click('[data-device="mobile"]');
      if (await evaluate("document.querySelector('#preview').getBoundingClientRect().width > 375")) throw new Error('mobile preview is wider than a phone');
      if ((await evaluate("document.querySelector('[data-device=\"mobile\"]').getAttribute('aria-pressed')")) !== 'true') throw new Error('device state not exposed');
      await click('[data-device="desktop"]');
      if (await evaluate("document.querySelector('#preview').getBoundingClientRect().width <= 375")) throw new Error('desktop preview did not widen');
      await click('.mobile-switch [data-view="edit"]');
      await click('#save');
      await waitFor("document.querySelector('#builder-status').innerText.includes('All changes saved')", 'contact form saved');
      if (app.db.get('SELECT published_version FROM forms WHERE id = ?', id).published_version !== null) throw new Error('saving published the form');
      await layoutCheck('form editor contact form');
      // A wider layout viewport also widens innerWidth, which hides overflow from the width check.
      await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 1, mobile: true });
      await new Promise(resolve => setTimeout(resolve, 100));
      const phoneWidth = await evaluate('window.innerWidth');
      const canvasTop = await evaluate("document.querySelector('.question-canvas').getBoundingClientRect().top");
      await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      if (phoneWidth !== 375) throw new Error(`phone layout viewport grew to ${phoneWidth}px`);
      if (canvasTop > 340) throw new Error(`the canvas starts ${canvasTop}px down on a phone`);
      await click('#publish');
      await waitFor("document.querySelector('#share-panel #share-link')", 'contact form published');
      if (!(await focused('#share-heading')) || (await evaluate("getComputedStyle(document.querySelector('#share-panel')).display === 'none'"))) throw new Error('publishing did not land on the share surface');
      const slug = app.db.get('SELECT slug FROM forms WHERE id = ?', id).slug;
      if (app.db.get('SELECT COUNT(*) AS count FROM responses WHERE form_id = ?', id).count !== responsesBefore) throw new Error('editing created a response');

      // Respondent: keyboard only, one question at a time.
      await open(`/f/${slug}?mode=conversational`, "document.querySelector('#form-root form')");
      if (!(await waitFor("document.activeElement.id === 'q-name'", 'first question focused').then(() => true, () => false))) await evaluate("document.querySelector('#q-name').focus()");
      await type('Mia');
      await press('Enter', 'Enter');
      await waitFor("document.activeElement.id === 'q-email'", 'email question after Enter');
      await type('not an address');
      await press('Enter', 'Enter');
      await waitFor("document.querySelector('.field-error') && document.activeElement.id === 'q-email'", 'email validation keeps focus');
      await evaluate("document.querySelector('#q-email').select()");
      await type('mia@example.com');
      await press('Enter', 'Enter');
      await waitFor(`document.activeElement.id === 'q-${phoneKey}'`, 'phone question');
      await click('[data-back]');
      await waitFor("document.activeElement.id === 'q-email' && document.activeElement.value === 'mia@example.com'", 'back keeps the answer and focus');
      await press('Enter', 'Enter');
      await waitFor(`document.activeElement.id === 'q-${phoneKey}'`, 'phone again');
      await type('+91 98765 43210');
      await press('Enter', 'Enter');
      await waitFor("document.querySelector('[name=topic]')", 'topic question');
      // C leads on to a follow-up question; going back to A jumps to the ending and drops that answer.
      await press('c', 'KeyC');
      await waitFor("document.querySelector('#q-details')", 'letter key chose the option and moved on');
      await type('A long story');
      await click('[data-back]');
      await waitFor("document.querySelector('[name=topic]')", 'back to topic');
      await press('a', 'KeyA');
      await waitFor("document.querySelector('[name=topic]:checked')?.value === 'new_project' && document.querySelector('#form-root [type=submit]').textContent.includes('Submit')", 'jump makes this the last question');
      await press('Enter', 'Enter');
      await waitFor("document.querySelector('.receipt')", 'receipt');
      const receipt = await evaluate("document.querySelector('.receipt').innerText");
      if (!receipt.includes('Sales will call you') || !receipt.includes('Expect a reply within a day.') || !receipt.includes('Receipt')) throw new Error('ending or receipt missing: ' + receipt);

      // Host: the stored response, the inbox and the CSV agree, with no answer from the abandoned path.
      const stored = JSON.parse(app.db.get('SELECT answers FROM responses WHERE form_id = ?', id).answers);
      if (stored.details !== undefined || stored.name !== 'Mia' || stored[phoneKey] !== '+91 98765 43210' || stored.topic !== 'new_project') throw new Error('stored answers wrong: ' + JSON.stringify(stored));
      await open(`/forms/${id}/responses`, "document.querySelector('table')");
      if (!(await text()).includes('mia@example.com')) throw new Error('response not in the inbox');
      const csv = await evaluate(`fetch('/api/me').then(r => r.json()).then(me => fetch('/api/workspaces/' + me.workspaces[0].id + '/forms/${id}/responses.csv')).then(r => r.text())`);
      if (!csv.includes('mia@example.com') || !csv.includes('Phone number') || csv.includes('A long story')) throw new Error('CSV wrong: ' + csv.slice(0, 300));
    } finally { await evaluate('delete document.body.dataset.dirty').catch(() => {}); }
  });
  await step('form themes: create, apply, preview on desktop and mobile, publish; later edits leave the published look intact', async () => {
    const paint = selector => evaluate(`(() => { const style = getComputedStyle(document.querySelector(${JSON.stringify(selector)})); return { background: style.backgroundColor, font: style.fontFamily }; })()`);
    const colour = hex => `rgb(${[1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16)).join(', ')})`;
    const setColour = (key, value) => fill(`#theme-${key}`, value);
    const clickReal = async selector => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`); await click(selector); };
    await open('/forms', "document.querySelector('#new-form')");
    await click('#new-form');
    await click('[data-template="blank"]');
    await waitFor("document.querySelector('[data-question-key=\"name\"]')", 'theme form builder');
    const id = await evaluate("location.pathname.split('/')[2]");
    const slug = app.db.get('SELECT slug FROM forms WHERE id = ?', id).slug;
    const responses = () => app.db.get('SELECT COUNT(*) AS count FROM responses WHERE form_id = ?', id).count;
    const liveDefinition = async () => (await (await fetch(`${base}/api/public/forms/${slug}`)).json()).definition;
    try {
      // The Design panel opens beside the canvas, with My themes and the Gallery.
      await clickReal('#open-design');
      await waitFor("document.querySelector('[data-theme-create]')", 'My themes');
      if (!(await focused('#design-heading')) || (await evaluate("document.querySelector('#open-design').getAttribute('aria-expanded')")) !== 'true') throw new Error('Design did not open with focus on its heading');
      if (!(await evaluate("(() => { const panel = document.querySelector('#design-panel').getBoundingClientRect(); const canvas = document.querySelector('.canvas-frame').getBoundingClientRect(); return panel.left >= canvas.right && canvas.width > 300; })()"))) throw new Error('the Design panel does not sit beside the canvas');
      await click('#design-tab-gallery');
      if ((await evaluate("document.querySelectorAll('[data-preset-apply]').length")) < 6 || !(await focused('#design-tab-gallery'))) throw new Error('Gallery has no presets, or lost focus');
      if (!(await evaluate("(() => { const mini = document.querySelector('[data-preset-id=\"harbour\"] .theme-mini'); return getComputedStyle(mini).backgroundColor === 'rgb(16, 36, 58)' && getComputedStyle(mini.querySelector('.theme-mini-button')).backgroundColor === 'rgb(244, 185, 66)'; })()"))) throw new Error('Gallery card does not show its colours');
      await layoutCheck('form design gallery');
      // A preset applies at once to the canvas and the preview, without saving or publishing anything.
      await click('[data-preset-id="harbour"] [data-preset-apply]');
      if ((await paint('.canvas-frame')).background !== colour('#10243a')) throw new Error('preset did not reach the canvas');
      if (!(await text()).includes('Unsaved changes')) throw new Error('applying a theme did not mark the draft unsaved');
      // Create a theme: every change shows on the canvas at once; the draft is what changes, not anything live.
      await click('#design-tab-mine');
      await click('[data-theme-create]');
      if (!(await focused('#theme-editor-heading'))) throw new Error('Create theme did not focus its form');
      await fill('#theme-name', 'Acme brand');
      await setColour('background', '#123456');
      await setColour('question', '#fff8e7');
      await setColour('answer', '#d9e8ff');
      await setColour('button', '#ff7a00');
      await setColour('button_text', '#111111');
      await fill('#theme-font', 'serif');
      const canvas = await paint('.canvas-frame');
      if (canvas.background !== colour('#123456') || !/serif/i.test(canvas.font)) throw new Error('theme edits did not reach the canvas: ' + JSON.stringify(canvas));
      if ((await evaluate("getComputedStyle(document.querySelector('.canvas-question')).color")) !== colour('#fff8e7') || (await evaluate("getComputedStyle(document.querySelector('.canvas-button')).backgroundColor")) !== colour('#ff7a00')) throw new Error('question text or button colour not on the canvas');
      // A weak pair is named, not silently accepted.
      await setColour('question', '#1a3c5e');
      await waitFor("document.querySelector('[data-theme-warnings]').innerText.includes('Question text')", 'contrast warning');
      await setColour('question', '#fff8e7');
      if (await evaluate("document.querySelector('[data-theme-warnings]').innerText.trim().length > 0")) throw new Error('warning did not clear');
      await layoutCheck('form theme editor', '#design-panel');
      await click('[data-theme-form] [type="submit"]');
      await waitFor("document.querySelector('[data-theme-apply]')", 'theme saved');
      const saved = app.db.get("SELECT id FROM form_themes WHERE name = 'Acme brand'");
      if (!saved) throw new Error('theme not stored for the workspace');
      if (app.db.get('SELECT published_version FROM forms WHERE id = ?', id).published_version !== null) throw new Error('theme work published the form');
      // Device view reshapes the canvas only; Preview is a separate run that stores nothing, at either size.
      await click('[data-device="mobile"]');
      const frame = await evaluate("(() => { const box = document.querySelector('.canvas-frame').getBoundingClientRect(); return { width: box.width, height: box.height, shown: getComputedStyle(document.querySelector('.builder-edit')).display !== 'none' }; })()");
      if (frame.width > 415 || frame.height <= frame.width || !frame.shown) throw new Error('mobile device view did not reshape the canvas: ' + JSON.stringify(frame));
      if ((await paint('.canvas-frame')).background !== colour('#123456')) throw new Error('theme lost in mobile device view');
      await click('.mobile-switch [data-view="preview"]');
      await waitFor("document.querySelector('#preview form')", 'preview shown');
      const mobile = await evaluate("(() => { const box = document.querySelector('#preview').getBoundingClientRect(); return { width: box.width, background: getComputedStyle(document.querySelector('#preview')).backgroundColor, button: getComputedStyle(document.querySelector('#preview .btn-primary')).backgroundColor, question: getComputedStyle(document.querySelector('#preview .q-label')).color }; })()");
      if (mobile.width > 375 || mobile.background !== colour('#123456') || mobile.button !== colour('#ff7a00') || mobile.question !== colour('#fff8e7')) throw new Error('mobile preview not themed: ' + JSON.stringify(mobile));
      await click('[data-device="desktop"]');
      const desktop = await evaluate("(() => { const box = document.querySelector('#preview').getBoundingClientRect(); return { width: box.width, background: getComputedStyle(document.querySelector('#preview')).backgroundColor }; })()");
      if (desktop.width <= 375 || desktop.background !== colour('#123456')) throw new Error('desktop preview not themed: ' + JSON.stringify(desktop));
      await fill('#preview #q-name', 'Preview person');
      await fill('#preview #q-email', 'preview@example.com');
      await evaluate("const o = document.querySelector('#preview [name=topic][value=support]'); o.checked = true; o.dispatchEvent(new Event('change', { bubbles: true }))");
      await click('#preview [type="submit"]');
      await waitFor("document.querySelector('#preview').innerText.includes('Preview complete')", 'preview run finished');
      if (responses() !== 0) throw new Error('preview stored a response');
      await click('.mobile-switch [data-view="edit"]');
      await click('[data-design-close]');
      if (!(await focused('#open-design')) || (await evaluate("getComputedStyle(document.querySelector('.question-settings')).display === 'none'"))) throw new Error('closing Design did not restore the inspector and focus');
      // Save and publish: the respondent sees exactly this look.
      await click('#save');
      await waitFor("document.querySelector('#builder-status').innerText.includes('All changes saved')", 'themed draft saved');
      await click('#publish');
      await waitFor("document.querySelector('#share-panel #share-link')", 'themed form published');
      const published = await liveDefinition();
      if (published.theme?.background !== '#123456' || published.theme.source !== undefined) throw new Error('public form has the wrong theme payload: ' + JSON.stringify(published.theme));
      const seePublic = async () => { await evaluate('delete document.body.dataset.dirty'); await open(`/f/${slug}`, "document.querySelector('#form-root form')"); return evaluate("(() => { const page = getComputedStyle(document.querySelector('.form-page')); return { background: page.backgroundColor, font: page.fontFamily, question: getComputedStyle(document.querySelector('#form-root .q-label')).color, button: getComputedStyle(document.querySelector('#form-root .btn-primary')).backgroundColor }; })()"); };
      const before = await seePublic();
      if (before.background !== colour('#123456') || before.question !== colour('#fff8e7') || before.button !== colour('#ff7a00') || !/serif/i.test(before.font)) throw new Error('published form not themed: ' + JSON.stringify(before));
      await layoutCheck('themed public form');
      // Later draft changes stay in the draft.
      await open(`/forms/${id}`, "document.querySelector('#open-design')");
      await click('#open-design');
      await waitFor("document.querySelector('[data-theme-id] [data-theme-edit]')", 'theme listed');
      await click('#design-tab-gallery');
      await click('[data-preset-id="paper"] [data-preset-apply]');
      if ((await paint('.canvas-frame')).background !== colour('#faf6ee')) throw new Error('second theme did not reach the draft canvas');
      await click('[data-design-close]');
      await click('#save');
      await waitFor("document.querySelector('#builder-status').innerText.includes('Saved draft not yet published')", 'draft ahead of live');
      if (JSON.stringify(await seePublic()) !== JSON.stringify(before)) throw new Error('a saved draft changed the published look');
      // Editing the reusable theme itself restyles nothing already saved or published.
      await open(`/forms/${id}`, "document.querySelector('#open-design')");
      await click('#open-design');
      await waitFor("document.querySelector('[data-theme-id] [data-theme-edit]')", 'theme listed again');
      await click(`[data-theme-id="${saved.id}"] [data-theme-edit]`);
      await setColour('background', '#000000');
      await click('[data-theme-form] [type="submit"]');
      await waitFor(`document.querySelector('[data-theme-id="${saved.id}"]')`, 'theme edited');
      await evaluate('delete document.body.dataset.dirty');
      if (!JSON.parse(app.db.get('SELECT tokens FROM form_themes WHERE id = ?', saved.id).tokens).background.startsWith('#000000')) throw new Error('theme edit not stored');
      if (JSON.stringify(await seePublic()) !== JSON.stringify(before) || (await liveDefinition()).theme.background !== '#123456') throw new Error('editing the reusable theme restyled the published form');
      // Respondent can still submit the themed form.
      await fill('#form-root #q-name', 'Themed person');
      await fill('#form-root #q-email', 'themed@example.com');
      await evaluate("const o = document.querySelector('#form-root [name=topic][value=support]'); o.checked = true; o.dispatchEvent(new Event('change', { bubbles: true }))");
      await click('#form-root [type="submit"]');
      await waitFor("document.querySelector('.receipt')", 'themed receipt');
      if (responses() !== 1) throw new Error('themed response not stored exactly once');
      if ((await evaluate("getComputedStyle(document.querySelector('.form-page')).backgroundColor")) !== colour('#123456')) throw new Error('receipt lost the theme');
    } finally { await evaluate('delete document.body.dataset.dirty').catch(() => {}); }
  });
  await step('form typography on a blank draft: default style, no workspace theme, Preview matches the published form in both layouts at desktop and phone width, other forms unaffected; 3,000-character descriptions keep line breaks and fold by keyboard', async () => {
    const LONG = ('Record one video with camera and screen sharing on.\nPart 1: introduce yourself, explain the objective, demo the screens and name the technologies.\nPart 2: explain one question from each section, in your own words, with examples.\n').repeat(20).slice(0, 2999) + '.';
    const sizes = scope => evaluate(`(() => { const root = document.querySelector(${JSON.stringify(scope)}); const size = selector => { const el = root.querySelector(selector); return el ? getComputedStyle(el).fontSize : null; };
      return { title: size('h1'), question: size('.q-label'), description: size('.q-help'), answer: size('input:not([type=radio], [type=checkbox]), textarea'), button: size('.btn-primary'), font: getComputedStyle(root.querySelector('.q-label')).fontFamily.split(',')[0] }; })()`);
    const themeRows = () => app.db.get('SELECT COUNT(*) AS count FROM form_themes').count;
    const viewport = (width, mobile) => send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile });
    const key = async (keyName, code, keyCode) => {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: keyCode, ...(keyName === 'Enter' ? { text: '\r' } : keyName === ' ' ? { text: ' ' } : {}) });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: keyCode });
    };
    // Another published form, to show this one's typography reaches no other form.
    const other = await (async () => {
      const me = await evaluate("fetch('/api/me').then(r => r.json())");
      const definition = { title: 'Unrelated form', presentation: 'classic', fields: [{ id: 'q', type: 'short_text', label: 'Unrelated question', required: false, help: 'Short help.' }] };
      const call = (method, path, body) => evaluate(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': ${JSON.stringify(me.csrf_token)} }, body: ${JSON.stringify(JSON.stringify(body))} }).then(r => r.json())`);
      const created = await call('POST', `/api/workspaces/${me.workspaces[0].id}/forms`, { definition });
      await call('POST', `/api/workspaces/${me.workspaces[0].id}/forms/${created.id}/publish`, {});
      return app.db.get('SELECT id, slug FROM forms WHERE id = ?', created.id);
    })();
    const otherState = () => JSON.stringify([app.db.get('SELECT draft, published_version FROM forms WHERE id = ?', other.id), app.db.all('SELECT version, definition FROM form_versions WHERE form_id = ?', other.id)]);
    const otherBefore = otherState();
    await open(`/f/${other.slug}`, "document.querySelector('#form-root .q-label')");
    const otherLook = await sizes('#form-root');

    await open('/forms', "document.querySelector('#new-form')");
    await click('#new-form');
    await click('[data-template="blank"]');
    await waitFor("document.querySelector('#fh-0')", 'typography form builder');
    const id = await evaluate("location.pathname.split('/')[2]");
    const slug = app.db.get('SELECT slug FROM forms WHERE id = ?', id).slug;
    const themesBefore = themeRows();
    try {
      // A 3,000-character question description, with line breaks, is counted against the shared limit.
      if ((await evaluate("document.querySelector('#fh-0').maxLength")) !== 3000) throw new Error('question description limit is not 3,000 in the builder');
      await fill('#fh-0', LONG);
      if (!(await evaluate("document.querySelector('#fh-0-count').textContent")).startsWith('3,000 / 3,000')) throw new Error('character count does not show the limit');
      if ((await evaluate("document.querySelector('#fh-0').getAttribute('aria-describedby')")) !== 'fh-0-count') throw new Error('count is not linked to its description');
      const enter = await evaluate("(() => { const area = document.querySelector('#fh-0'); const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }); area.dispatchEvent(event); return event.defaultPrevented; })()");
      if (enter) throw new Error('Enter is still blocked in a description');
      if ((await evaluate("document.querySelector('#f-description')?.maxLength ?? 2000")) !== 2000) throw new Error('the form description limit changed');

      // A blank draft has no theme: typography starts from the default style.
      await click('#open-design');
      await waitFor("document.querySelector('#draft-question_size')", 'typography on a draft without a theme');
      if ((await evaluate("[document.querySelector('#draft-font').value, document.querySelector('#draft-question_size').value].join()")) !== 'system,medium') throw new Error('typography does not start from the default style');
      if (!(await evaluate("document.querySelector('[data-design-current]').innerText")).includes('default style')) throw new Error('the panel does not say the draft uses the default style');
      const canvasBefore = await evaluate("({ size: parseFloat(getComputedStyle(document.querySelector('.canvas-question')).fontSize), background: getComputedStyle(document.querySelector('.canvas-frame')).backgroundColor })");
      await fill('#draft-question_size', 'large');
      await fill('#draft-description_size', 'small');
      await fill('#draft-answer_size', 'large');
      await fill('#draft-font', 'rounded');
      const canvasAfter = await evaluate("({ size: parseFloat(getComputedStyle(document.querySelector('.canvas-question')).fontSize), background: getComputedStyle(document.querySelector('.canvas-frame')).backgroundColor, font: getComputedStyle(document.querySelector('.canvas-question')).fontFamily, themed: document.querySelector('.canvas-frame').hasAttribute('data-themed') })");
      if (!(canvasAfter.size > canvasBefore.size * 1.1) || !/rounded|Trebuchet/i.test(canvasAfter.font)) throw new Error('typography did not reach the canvas: ' + JSON.stringify(canvasAfter));
      if (canvasAfter.background !== canvasBefore.background || canvasAfter.themed) throw new Error('typography changed the default colours: ' + JSON.stringify([canvasBefore, canvasAfter]));
      if (!(await evaluate("document.querySelector('[data-design-current]').innerText")).includes('its own typography')) throw new Error('the panel does not say the draft has its own typography');
      if (!(await text()).includes('Unsaved changes')) throw new Error('typography did not mark the draft unsaved');
      await layoutCheck('form design typography', '#design-panel');
      await click('[data-design-close]');
      await click('#save');
      await waitFor("document.querySelector('#builder-status').innerText.includes('All changes saved')", 'typography draft saved');
      const stored = JSON.parse(app.db.get('SELECT draft FROM forms WHERE id = ?', id).draft);
      if (stored.fields[0].help !== LONG) throw new Error('the long description was not saved exactly, line breaks included');
      if (JSON.stringify(stored.theme) !== JSON.stringify({ name: 'Default style', font: 'rounded', question_size: 'large', description_size: 'small', answer_size: 'large' })) throw new Error('draft typography not stored as the default style: ' + JSON.stringify(stored.theme));
      if (themeRows() !== themesBefore) throw new Error('draft typography created or changed a workspace theme');

      // Reopen: the same text and settings come back.
      await evaluate('delete document.body.dataset.dirty');
      await open(`/forms/${id}`, "document.querySelector('#fh-0')");
      if ((await evaluate("document.querySelector('#fh-0').value")) !== LONG) throw new Error('reopened description differs');
      await click('#open-design');
      await waitFor("document.querySelector('#draft-question_size')", 'reopened typography');
      if ((await evaluate("['font', 'question_size', 'description_size', 'answer_size'].map(key => document.querySelector('#draft-' + key).value).join()")) !== 'rounded,large,small,large') throw new Error('reopened typography differs');
      await click('[data-design-close]');

      // Preview at phone and desktop size, in both layouts; the published form must match each.
      const preview = {};
      for (const mode of ['classic', 'conversational']) {
        await fill('#preview-mode', mode);
        await click('.mobile-switch [data-view="preview"]');
        for (const device of ['mobile', 'desktop']) {
          await click(`[data-device="${device}"]`);
          await waitFor("document.querySelector('#preview .q-label')", 'preview shown');
          preview[`${mode}/${device}`] = await sizes('#preview');
        }
        await click('.mobile-switch [data-view="edit"]');
      }
      if (app.db.get('SELECT published_version FROM forms WHERE id = ?', id).published_version !== null) throw new Error('previewing published the form');
      await click('#publish');
      await waitFor("document.querySelector('#share-panel #share-link')", 'typography form published');
      await evaluate('delete document.body.dataset.dirty');
      const published = {};
      for (const mode of ['classic', 'conversational']) {
        for (const [device, width] of [['mobile', 375], ['desktop', 1280]]) {
          await viewport(width, width < 768);
          await open(`/f/${slug}?mode=${mode}`, "document.querySelector('#form-root .q-label')");
          published[`${mode}/${device}`] = await sizes('#form-root');
        }
      }
      await viewport(1280, false);
      for (const key of Object.keys(preview)) if (JSON.stringify(preview[key]) !== JSON.stringify(published[key])) throw new Error(`Preview and published form differ (${key}): ${JSON.stringify(preview[key])} vs ${JSON.stringify(published[key])}`);
      // Large questions and answers, small descriptions, against Classic's standard 18px, 16px and 15px.
      const desktop = published['classic/desktop'];
      if (desktop.question !== '20.7px' || desktop.answer !== '18.4px' || desktop.description !== '13.125px' || !/rounded|Trebuchet/i.test(desktop.font)) throw new Error('typography not applied on the published form: ' + JSON.stringify(desktop));
      if (await evaluate("document.querySelector('.form-page').hasAttribute('data-themed')")) throw new Error('the published default style gained theme colours');
      if ((await (await fetch(`${base}/api/public/forms/${slug}`)).json()).definition.theme.source !== undefined) throw new Error('the public payload reveals a theme source');
      await open(`/f/${slug}?mode=classic`, "document.querySelector('#form-root .q-label')");
      await layoutCheck('long description public form');

      // The long description: folded, line breaks kept, and the button works from the keyboard.
      await open(`/f/${slug}?mode=classic`, "document.querySelector('[data-desc-toggle=\"q:name\"]')");
      const state = () => evaluate("(() => { const text = document.querySelector('#q-name-help'); const button = document.querySelector('[data-desc-toggle=\"q:name\"]'); return { folded: text.classList.contains('is-folded'), height: text.clientHeight, full: text.textContent.length, breaks: getComputedStyle(text).whiteSpace, expanded: button.getAttribute('aria-expanded'), controls: button.getAttribute('aria-controls'), label: button.textContent, type: button.type, focused: document.activeElement === button }; })()");
      const folded = await state();
      if (!folded.folded || folded.full !== 3000 || folded.breaks !== 'pre-line' || folded.expanded !== 'false' || folded.controls !== 'q-name-help' || folded.type !== 'button' || folded.label !== 'Show full description') throw new Error('long description not folded correctly: ' + JSON.stringify(folded));
      // Reached with Tab from the field before it, then opened with Enter and closed with Space.
      await evaluate('document.activeElement?.blur()');
      for (let presses = 0; presses < 40 && !(await state()).focused; presses++) await key('Tab', 'Tab', 9);
      if (!(await state()).focused) throw new Error('Show full description is not reachable with Tab');
      await key('Enter', 'Enter', 13);
      const opened = await state();
      if (opened.folded || opened.expanded !== 'true' || opened.label !== 'Show less' || opened.height < folded.height * 3 || !opened.focused) throw new Error('Enter did not open the description, or focus moved: ' + JSON.stringify(opened));
      if (app.db.get('SELECT COUNT(*) AS count FROM responses WHERE form_id = ?', id).count !== 0) throw new Error('Enter on the button submitted the form');
      await key(' ', 'Space', 32);
      const closed = await state();
      if (!closed.folded || closed.expanded !== 'false' || closed.label !== 'Show full description' || !closed.focused) throw new Error('Space did not close the description: ' + JSON.stringify(closed));
      await key('Enter', 'Enter', 13);
      await fill('#form-root #q-name', 'Typography person');
      if ((await state()).expanded !== 'true') throw new Error('an opened description closed again on redraw');
      // Conversational: the same control on a one-question screen, and Enter on it does not move on.
      await open(`/f/${slug}?mode=conversational`, "document.querySelector('[data-desc-toggle=\"q:name\"]')");
      await evaluate("document.querySelector('[data-desc-toggle=\"q:name\"]').focus()");
      await key('Enter', 'Enter', 13);
      const conversational = await evaluate("({ expanded: document.querySelector('[data-desc-toggle=\"q:name\"]')?.getAttribute('aria-expanded'), still: !!document.querySelector('#q-name') })");
      if (conversational.expanded !== 'true' || !conversational.still) throw new Error('conversational fold control failed: ' + JSON.stringify(conversational));

      // Nothing reached the other form, and a later draft change stays in the draft until published.
      if (otherState() !== otherBefore) throw new Error('publishing this form changed another form');
      await open(`/f/${other.slug}`, "document.querySelector('#form-root .q-label')");
      if (JSON.stringify(await sizes('#form-root')) !== JSON.stringify(otherLook)) throw new Error('another published form changed its typography');
      await open(`/forms/${id}`, "document.querySelector('#open-design')");
      await click('#open-design');
      await waitFor("document.querySelector('#draft-question_size')", 'typography again');
      await fill('#draft-question_size', 'small');
      await click('[data-design-close]');
      await click('#save');
      await waitFor("document.querySelector('#builder-status').innerText.includes('Saved draft not yet published')", 'draft ahead of live');
      await evaluate('delete document.body.dataset.dirty');
      await open(`/f/${slug}?mode=classic`, "document.querySelector('#form-root .q-label')");
      if ((await sizes('#form-root')).question !== '20.7px') throw new Error('a saved draft changed the published typography');
      // Back at the default style's values, the draft holds no theme at all.
      await open(`/forms/${id}`, "document.querySelector('#open-design')");
      await click('#open-design');
      await waitFor("document.querySelector('[data-theme-clear]')", 'reset typography');
      await click('[data-theme-clear]');
      if (await evaluate("!!document.querySelector('[data-theme-clear]') || document.querySelector('#draft-font').value !== 'system'")) throw new Error('Reset typography did not return to the default style');
      await click('[data-design-close]');
      await click('#save');
      await waitFor("document.querySelector('#builder-status').innerText.includes('Saved draft not yet published')", 'reset saved');
      if ('theme' in JSON.parse(app.db.get('SELECT draft FROM forms WHERE id = ?', id).draft)) throw new Error('a reset draft still stores a theme');
      if (themeRows() !== themesBefore) throw new Error('a workspace theme was created');
    } finally { await viewport(1280, false).catch(() => {}); await evaluate('delete document.body.dataset.dirty').catch(() => {}); }
  });
  await step('Contact Info page: picker, outline, keyboard reorder and collapse, one screen, invalid focus, Back, preview, branching, publish, inbox and CSV', async () => {
    const press = async (name, code, vk) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: vk, text: name === 'Enter' ? '\r' : undefined }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: vk }); };
    const type = value => send('Input.insertText', { text: value });
    const MEMBERS = ['first_name', 'last_name', 'phone', 'email', 'company'];
    await open('/forms', "document.querySelector('#new-form')");
    await click('#new-form');
    await click('[data-template="blank"]');
    await waitFor("document.querySelector('[data-question-key=\"topic\"]')", 'page form builder');
    const id = await evaluate("location.pathname.split('/')[2]");
    const slug = app.db.get('SELECT slug FROM forms WHERE id = ?', id).slug;
    const responses = () => app.db.get('SELECT COUNT(*) AS count FROM responses WHERE form_id = ?', id).count;
    const memberKeys = () => evaluate("[...document.querySelectorAll('.question-row.is-member')].map(row => row.dataset.questionKey)");
    // Selecting a question on a page follows its focus event, which an unfocused headless page does not fire.
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    try {
      // The starter's own name and email keep their keys; the preset never reuses one.
      await selectQuestion('topic');
      await click('#add-field');
      await click('[data-add-type="contact_info"]');
      await waitFor("document.querySelector('.question-row.is-page')", 'page in the outline');
      const pageKey = await evaluate("document.querySelector('.question-row.is-page').dataset.questionKey");
      const members = await memberKeys();
      if (pageKey !== 'contact_info' || members.join() !== 'first_name,last_name,phone,email_2,company') throw new Error('unexpected keys: ' + pageKey + ' ' + members.join());
      if (!(await focused('[data-prop="label"].canvas-question')) || (await evaluate('document.activeElement.value')) !== 'Contact Info') throw new Error('adding the page did not focus its title');
      await waitFor("document.querySelector('#builder-live').innerText.includes('Contact Info page added with 5 questions')", 'page announced');
      if ((await evaluate("document.querySelectorAll('.canvas-member').length")) !== 5) throw new Error('the canvas does not show the whole page');
      await fill('.canvas-question', 'How can we reach you?');
      await fill('.canvas-description', 'We only use this to reply.');
      if (!(await evaluate("document.querySelector('.question-row.is-page').innerText.includes('How can we reach you?')"))) throw new Error('page title not in the outline');
      if (!(await evaluate("document.querySelector('[data-inspector=\"logic\"]') && !document.querySelector('.question-settings [data-type]')"))) throw new Error('page settings show question settings');

      // Each question is selected and set on its own, without losing the page view.
      await evaluate("document.querySelector('.canvas-member[data-member] [data-prop=\"label\"]').focus()");
      const firstAt = await evaluate("document.querySelector('[data-question-key=\"first_name\"]').dataset.questionRow");
      if ((await evaluate(`document.querySelector('[data-question-index="${firstAt}"]').getAttribute('aria-pressed')`)) !== 'true' || (await evaluate("document.querySelector('.question-settings [data-prop=\"id\"]').value")) !== 'first_name') throw new Error('focusing a question on the page did not select it');
      if (!(await focused('.canvas-member [data-prop="label"]')) || (await evaluate("document.querySelectorAll('.canvas-member').length")) !== 5) throw new Error('selecting a question lost its place on the page');
      await selectQuestion('company');
      const companyAt = await evaluate("document.querySelector('[data-question-key=\"company\"]').dataset.questionRow");
      const companyMark = () => evaluate(`Boolean(document.querySelector('.canvas-member[data-member="${companyAt}"] .required-mark'))`);
      if (await companyMark()) throw new Error('Company should start optional');
      await click('.question-settings [data-prop="required"]');
      if (!(await companyMark()) || !(await focused('.question-settings [data-prop="required"]')) || (await evaluate("document.querySelector('.canvas-member[data-member=\"' + document.querySelector('[data-question-key=\"phone\"]').dataset.questionRow + '\"] .required-mark') !== null"))) throw new Error('required did not apply to that question alone');
      await click('.question-settings [data-prop="required"]');
      if (await companyMark()) throw new Error('required did not clear');

      // Keyboard reorder: within the page, then out and back; a page moves whole.
      await selectQuestion('last_name');
      await evaluate("document.querySelector('.canvas-tools [data-move=\"1\"]').focus()");
      await press('Enter', 'Enter', 13);
      if ((await memberKeys()).join() !== 'first_name,phone,last_name,email_2,company') throw new Error('keyboard move within the page failed: ' + (await memberKeys()).join());
      if (!(await focused('.canvas-tools [data-move="1"]'))) throw new Error('focus lost after moving within the page');
      await waitFor("document.querySelector('#builder-live').innerText.includes('Moved to position')", 'move announced');
      await click('.canvas-tools [data-move="-1"]');
      if ((await memberKeys()).join() !== 'first_name,last_name,phone,email_2,company') throw new Error('move back failed');
      await selectQuestion('contact_info');
      await click('.canvas-tools [data-move="-1"]');
      const whole = await evaluate("[...document.querySelectorAll('[data-question-key]')].map(row => row.dataset.questionKey).join()");
      if (whole !== 'name,email,contact_info,first_name,last_name,phone,email_2,company,topic,details') throw new Error('page did not move whole: ' + whole);

      // Collapse from the keyboard; a hidden question hands its selection to the page.
      await selectQuestion('phone');
      await evaluate("document.querySelector('[data-page-toggle]').focus()");
      await press('Enter', 'Enter', 13);
      if ((await memberKeys()).length !== 0 || (await evaluate("document.querySelector('[data-page-toggle]').getAttribute('aria-expanded')")) !== 'false' || !(await focused('[data-page-toggle]'))) throw new Error('page did not collapse with focus kept');
      if ((await evaluate("document.querySelector('.question-row.is-page button.question-select').getAttribute('aria-pressed')")) !== 'true') throw new Error('selection did not pass to the collapsed page');
      await press('Enter', 'Enter', 13);
      if ((await memberKeys()).length !== 5) throw new Error('page did not expand');

      // Add while inside the page joins it; remove asks first, then a question goes on its own.
      await selectQuestion('company');
      await click('#add-field');
      await click('[data-add-type="long_text"]');
      if ((await memberKeys()).length !== 6) throw new Error('a question added inside the page did not join it');
      await click('.canvas-tools [data-remove]');
      if ((await memberKeys()).length !== 5 || !(await focused('.canvas-tools [data-remove]'))) throw new Error('removing a question lost focus or the page');

      // Jumps: from the first question straight into the page, and from email past it.
      const jump = async (key, value, target) => {
        await selectQuestion(key);
        await click('[data-jump-add]');
        await fill('[data-jump="0"] [data-jump-op]', 'contains');
        await fill('[data-jump="0"] [data-jump-value]', value);
        await fill('[data-jump="0"] [data-jump-to]', target);
      };
      await jump('name', 'direct', 'group:contact_info');
      await jump('email', 'skip.example', 'field:topic');
      if (!(await evaluate("document.querySelector('[data-jump-sentence]').textContent.includes('What can we help with?')"))) throw new Error('jump past the page not described');
      await selectQuestion('name');
      if (!(await evaluate("document.querySelector('[data-jump-sentence]').textContent.includes('the page “How can we reach you?”')"))) throw new Error('jump into the page not described by its title');
      await selectQuestion('email_2');
      await layoutCheck('form editor contact info page');
      await click('#save');
      await waitFor("document.querySelector('#builder-status').innerText.includes('All changes saved')", 'page saved');

      // Preview in one-question-at-a-time mode: the page on one screen, invalid focus, Back keeps values, nothing stored.
      await click('.mobile-switch [data-view="preview"]');
      await evaluate("(() => { const select = document.querySelector('#preview-mode'); select.value = 'conversational'; select.dispatchEvent(new Event('change', { bubbles: true })); })()");
      const advancePreview = async value => { await fill('#preview form input', value); await click('#preview [type="submit"]'); };
      await advancePreview('Preview person');
      await waitFor("document.querySelector('#preview #q-email')", 'preview email');
      await advancePreview('preview@example.com');
      await waitFor("document.querySelector('#preview .form-page-title')", 'preview page');
      if ((await evaluate("document.querySelector('#preview .form-page-title').textContent")) !== 'How can we reach you?' || (await evaluate("document.querySelectorAll('#preview .question').length")) !== 5) throw new Error('preview does not show the whole page on one screen');
      if (responses() !== 0) throw new Error('preview stored a response');
      await click('.mobile-switch [data-view="edit"]');

      await click('#publish');
      await waitFor("document.querySelector('#share-panel #share-link')", 'page published');
      await evaluate('delete document.body.dataset.dirty');

      // Respondent, keyboard only.
      await open(`/f/${slug}?mode=conversational`, "document.querySelector('#form-root form')");
      await evaluate("document.querySelector('#q-name').focus()");
      await type('Mia');
      await press('Enter', 'Enter', 13);
      await waitFor("document.activeElement.id === 'q-email'", 'email screen');
      await type('mia@example.com');
      await press('Enter', 'Enter', 13);
      await waitFor("document.querySelector('.form-page-title')", 'contact page screen');
      if ((await evaluate("document.querySelectorAll('#form-root .question').length")) !== 5 || (await evaluate('document.activeElement.id')) !== 'q-first_name') throw new Error('the page is not one screen with focus on its first question');
      if ((await evaluate("document.querySelector('#q-first_name').placeholder")) !== 'Asha') throw new Error('placeholder missing');
      if (!(await evaluate("document.querySelector('.form-page-help').textContent === 'We only use this to reply.'"))) throw new Error('page description missing');
      // Two required questions are empty: both named, focus on the first.
      await press('Enter', 'Enter', 13);
      await waitFor("document.querySelectorAll('.field-error').length === 2", 'both required questions flagged');
      if ((await evaluate('document.activeElement.id')) !== 'q-first_name' || (await evaluate("document.activeElement.getAttribute('aria-invalid')")) !== 'true') throw new Error('focus is not on the first invalid question');
      await type('Mia');
      await evaluate("document.querySelector('#q-last_name').focus()");
      await type('Rao');
      await evaluate("document.querySelector('#q-phone').focus()");
      await type('+91 98765 43210');
      await press('Enter', 'Enter', 13);
      await waitFor("document.querySelectorAll('.field-error').length === 1 && document.activeElement.id === 'q-email_2'", 'focus on the one still invalid');
      await type('not an address');
      await press('Enter', 'Enter', 13);
      await waitFor("document.activeElement.id === 'q-email_2' && document.querySelector('.field-error')?.textContent.includes('valid email')", 'invalid email flagged');
      await evaluate("document.querySelector('#q-email_2').select()");
      await type('mia.rao@example.com');
      await evaluate("document.querySelector('#q-company').focus()");
      await type('Acme');
      // Back keeps every value on the page, typed or not yet submitted.
      await click('[data-back]');
      await waitFor("document.activeElement.id === 'q-email'", 'back to email');
      await press('Enter', 'Enter', 13);
      await waitFor("document.querySelector('.form-page-title')", 'forward to the page');
      const kept = await evaluate("['first_name', 'last_name', 'phone', 'email_2', 'company'].map(key => document.querySelector('#q-' + key).value)");
      if (kept.join('|') !== 'Mia|Rao|+91 98765 43210|mia.rao@example.com|Acme') throw new Error('Back lost values: ' + kept.join('|'));
      await press('Enter', 'Enter', 13);
      await waitFor("document.querySelector('[name=topic]')", 'after the page');
      await click('[name="topic"][value="support"]');
      await click('#form-root [type="submit"]');
      await waitFor("document.querySelector('.receipt')", 'receipt after the page');

      // Host: each answer is under its own key, and the inbox and CSV agree.
      const stored = JSON.parse(app.db.get('SELECT answers FROM responses WHERE form_id = ?', id).answers);
      for (const [key, value] of Object.entries({ first_name: 'Mia', last_name: 'Rao', phone: '+91 98765 43210', email_2: 'mia.rao@example.com', company: 'Acme' })) if (stored[key] !== value) throw new Error(`stored ${key} wrong: ${JSON.stringify(stored)}`);
      await open(`/forms/${id}/responses`, "document.querySelector('table')");
      if (!(await text()).includes('mia.rao@example.com')) throw new Error('contact answer not in the inbox');
      const csv = await evaluate(`fetch('/api/me').then(r => r.json()).then(me => fetch('/api/workspaces/' + me.workspaces[0].id + '/forms/${id}/responses.csv')).then(r => r.text())`);
      for (const column of ['First name', 'Last name', 'Phone number', 'Company']) if (!csv.includes(`"${column}"`)) throw new Error('CSV lacks column ' + column);
      if (!csv.includes('"Acme"') || !csv.includes('"mia.rao@example.com"') || csv.includes('How can we reach you?')) throw new Error('CSV wrong: ' + csv.slice(0, 400));

      // Past the page: its required questions are not asked, and typed-then-abandoned answers are not stored.
      const answersOf = email => JSON.parse(app.db.get("SELECT answers FROM responses WHERE form_id = ? AND answers LIKE ?", id, `%${email}%`).answers);
      await open(`/f/${slug}?mode=conversational`, "document.querySelector('#form-root form')");
      await evaluate("document.querySelector('#q-name').focus()");
      await type('Bo');
      await press('Enter', 'Enter', 13);
      await waitFor("document.activeElement.id === 'q-email'", 'email before the page');
      await type('bo@normal.example');
      await press('Enter', 'Enter', 13);
      await waitFor("document.querySelector('#q-first_name')", 'page reached on this path');
      await evaluate("document.querySelector('#q-first_name').focus()");
      await type('Abandoned');
      await click('[data-back]');
      await waitFor("document.activeElement.id === 'q-email'", 'back to change the earlier answer');
      await evaluate("document.querySelector('#q-email').select()");
      await type('bo@skip.example');
      await press('Enter', 'Enter', 13);
      await waitFor("document.querySelector('[name=topic]')", 'jump past the page');
      if (await evaluate("Boolean(document.querySelector('.form-page-title'))")) throw new Error('page shown on a path that skips it');
      await click('[name="topic"][value="support"]');
      await click('#form-root [type="submit"]');
      await waitFor("document.querySelector('.receipt')", 'receipt past the page');
      const past = answersOf('bo@skip.example');
      if (past.first_name !== undefined || past.email_2 !== undefined || past.name !== 'Bo') throw new Error('skipped answers were stored: ' + JSON.stringify(past));

      // Into the page, past the question before it.
      await open(`/f/${slug}?mode=conversational`, "document.querySelector('#form-root form')");
      await evaluate("document.querySelector('#q-name').focus()");
      await type('direct line');
      await press('Enter', 'Enter', 13);
      await waitFor("document.querySelector('.form-page-title')", 'jump into the page');
      if (await evaluate("Boolean(document.querySelector('#q-email'))")) throw new Error('the skipped question is on this screen');
      await evaluate("document.querySelector('#q-first_name').focus()");
      await type('Di');
      await evaluate("document.querySelector('#q-email_2').focus()");
      await type('di@into.example');
      await press('Enter', 'Enter', 13);
      await waitFor("document.querySelector('[name=topic]')", 'after the page, reached by a jump');
      await click('[name="topic"][value="support"]');
      await click('#form-root [type="submit"]');
      await waitFor("document.querySelector('.receipt')", 'receipt into the page');
      const into = answersOf('di@into.example');
      if (into.email !== undefined || into.first_name !== 'Di') throw new Error('into-the-page answers wrong: ' + JSON.stringify(into));
    } finally { await send('Emulation.setFocusEmulationEnabled', { enabled: false }); await evaluate('delete document.body.dataset.dirty').catch(() => {}); }
  });
  await step('Workflow map: draws existing jumps, edits them in place, reports unreached items, and shares one set of rules with Content', async () => {
    const formApi = (method, path, body) => evaluate(`(async () => { const me = await (await fetch('/api/me')).json(); const r = await fetch('/api/workspaces/' + me.workspaces[0].id + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: ${JSON.stringify(JSON.stringify(body))} }); return r.json(); })()`);
    const created = await formApi('POST', '/forms', { definition: { title: 'Mapped form', description: '', presentation: 'conversational', submit_label: 'Send', endings: [{ id: 'thanks', title: 'Thanks' }, { id: 'sales', title: 'Sales will call' }], fields: [
      { id: 'kind', type: 'single_choice', label: 'Who is this for?', required: true, options: [{ id: 'home', label: 'Home' }, { id: 'office', label: 'Office' }] },
      { id: 'size', type: 'short_text', label: 'Team size?', required: false },
      { id: 'notes', type: 'long_text', label: 'Notes', required: false }
    ], logic: [{ field: 'kind', rules: [{ when: { field: 'kind', op: 'equals', value: 'home' }, to: { type: 'field', id: 'notes' } }] }] } });
    if (!created.id) throw new Error('map fixture not created: ' + JSON.stringify(created));
    const arcs = () => evaluate("[...document.querySelectorAll('#workflow-arcs [data-arc]')].map(path => path.dataset.arc).join()");
    try {
      await open(`/forms/${created.id}`, "document.querySelector('#builder-index [data-section=\"workflow\"]')");
      await click('#builder-index [data-section="workflow"]');
      if (!(await focused('#workflow-heading')) || !(await evaluate("document.querySelector('#workflow-nodes').getClientRects().length > 0 && document.querySelector('.question-canvas').getClientRects().length === 0"))) throw new Error('Workflow is not its own surface');
      if ((await arcs()) !== 'kind>notes') throw new Error('existing jump not drawn: ' + await arcs());
      if (!(await evaluate("document.querySelector('[data-map-node=\"kind\"] .workflow-rules').innerText.includes('When “Who is this for?” is “Home”, go to “Notes”')"))) throw new Error('jump not written in words');
      if (!(await evaluate("document.querySelector('#workflow-summary').innerText.includes('1 jump rule') && document.querySelector('[data-map-node=\"ending:sales\"]').classList.contains('is-unreached')"))) throw new Error('unreached ending not reported');
      await layoutCheck('form workflow map', '#workflow-map');

      // Select and edit from the map; focus stays with the work, and the picture follows.
      await click('[data-map-select="2"]');
      if (!(await focused('[data-map-select="2"]')) || (await evaluate("document.querySelector('[data-map-select=\"2\"]').getAttribute('aria-pressed')")) !== 'true') throw new Error('selecting a map item failed');
      await click('#workflow-editor [data-jump-add]');
      if (!(await focused('#workflow-editor [data-jump="0"] [data-jump-field]'))) throw new Error('adding a jump lost focus');
      if (!(await text()).includes('Unsaved changes')) throw new Error('map edit did not mark the draft unsaved');
      await fill('#workflow-editor [data-jump="0"] [data-jump-to]', 'ending:sales');
      if (!(await focused('#workflow-editor [data-jump="0"] [data-jump-to]'))) throw new Error('changing the target lost focus');
      if (!(await arcs()).includes('notes>ending:sales')) throw new Error('new jump not drawn: ' + await arcs());
      if (await evaluate("document.querySelector('[data-map-node=\"ending:sales\"]').classList.contains('is-unreached')")) throw new Error('reached ending still reported as unreached');

      // The same rule is there in Content, because there is only one.
      await click('#builder-index [data-section="questions"]');
      if (!(await evaluate("document.querySelector('[data-question-index=\"2\"]').getAttribute('aria-pressed') === 'true' && document.querySelector('.question-settings [data-jump-sentence]').textContent.includes('Sales will call')"))) throw new Error('Content does not show the jump made in Workflow');
      await click('#builder-index [data-section="workflow"]');
      await click('#workflow-editor [data-jump-remove]');
      if (!(await focused('#workflow-editor [data-jump-add]')) || (await arcs()).includes('notes>')) throw new Error('removing the jump lost focus or left its arc');
      await click('#workflow-editor [data-jump-add]');
      await fill('#workflow-editor [data-jump="0"] [data-jump-to]', 'ending:sales');
      await click('#save');
      await waitFor("document.querySelector('#builder-status').innerText.includes('All changes saved')", 'map edit saved');
      const saved = JSON.parse(app.db.get('SELECT draft FROM forms WHERE id = ?', created.id).draft);
      if (saved.logic.find(entry => entry.field === 'notes')?.rules[0].to.id !== 'sales') throw new Error('map edit not saved: ' + JSON.stringify(saved.logic));
      if (app.db.get('SELECT published_version FROM forms WHERE id = ?', created.id).published_version !== null) throw new Error('editing the map published the form');
    } finally { await evaluate('delete document.body.dataset.dirty').catch(() => {}); }
  });
  await step('hide-choice rules: author in Workflow, preview, conflicts block publishing, Back recalculates, crafted requests, inbox and CSV', async () => {
    const formApi = (method, path, body) => evaluate(`(async () => { const me = await (await fetch('/api/me')).json(); const r = await fetch('/api/workspaces/' + me.workspaces[0].id + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: ${JSON.stringify(JSON.stringify(body))} }); return r.json(); })()`);
    const created = await formApi('POST', '/forms', { definition: { title: 'Support request', description: '', presentation: 'conversational', submit_label: 'Send', endings: [{ id: 'thanks', title: 'Thanks' }, { id: 'sales', title: 'Sales will call' }], fields: [
      { id: 'plan', type: 'single_choice', label: 'Which plan?', required: true, options: [{ id: 'free', label: 'Free plan' }, { id: 'team', label: 'Team plan' }, { id: 'closed', label: 'Closed account' }] },
      { id: 'help', type: 'single_choice', label: 'How can we help?', required: true, options: [{ id: 'email', label: 'By email' }, { id: 'phone', label: 'Phone call' }, { id: 'visit', label: 'Site visit' }] },
      { id: 'extras', type: 'multiple_choice', label: 'Extras', required: false, options: [{ id: 'sla', label: 'Fast SLA' }, { id: 'audit', label: 'Audit report' }, { id: 'guide', label: 'Setup guide' }] },
      { id: 'details', type: 'page_break', label: 'Your details', grouped: true },
      { id: 'who', type: 'short_text', label: 'Your name', required: true, group: 'details' },
      { id: 'org', type: 'short_text', label: 'Company', required: false, group: 'details' },
      { id: 'notes', type: 'long_text', label: 'Notes', required: false }
    ], logic: [{ field: 'help', rules: [{ when: { field: 'help', op: 'equals', value: 'phone' }, to: { type: 'ending', id: 'sales' } }] }] } });
    if (!created.id) throw new Error('hide-rule fixture not created: ' + JSON.stringify(created));
    const editor = '#workflow-editor';
    const notice = "document.querySelector('#builder-notice').innerText";
    const hasText = (selector, words) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].some(node => node.textContent.includes(${JSON.stringify(words)}))`);
    const mouse = (type, x, y, buttons) => send('Input.dispatchMouseEvent', { type, x, y, buttons, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    const row = index => evaluate(`(() => { const row = document.querySelector('[data-question-row="${index}"]'); row.scrollIntoView({ block: 'center' }); const box = row.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2, height: box.height }; })()`);
    try {
      // Authoring: Workflow, Logic, on a standalone question.
      await open(`/forms/${created.id}`, "document.querySelector('#builder-index [data-section=\"workflow\"]')");
      await click('#builder-index [data-section="workflow"]');
      await waitFor(`document.querySelector('[data-map-select="1"]')`, 'map rows');
      await click('[data-map-select="1"]');
      await click(`${editor} [data-cr-add]`);
      if (!(await focused(`${editor} [data-choice-rule="0"] [data-cr-field]`))) throw new Error('adding a hide rule lost focus');
      await click(`${editor} [data-choice-rule="0"] [data-cr-hide="email"]`);
      if (!(await hasText(`${editor} [data-cr-conflict]`, 'at least one choice')) || (await evaluate(`document.querySelector('.toast')?.textContent.includes('at least one choice') || false`))) throw new Error('an empty rule should say so on its row, without a toast');
      await click(`${editor} [data-choice-rule="0"] [data-cr-hide="phone"]`);
      if (!(await focused(`${editor} [data-choice-rule="0"] [data-cr-hide="phone"]`))) throw new Error('choosing a choice lost focus');
      await click(`${editor} [data-choice-rule="0"] [data-cr-hide="visit"]`);
      if (!(await hasText(`${editor} [data-cr-sentence]`, 'When “Which plan?” is “Free plan”, hide “Phone call” and “Site visit”.'))) throw new Error('rule not described in words');
      await click(`${editor} [data-cr-add]`);
      await fill(`${editor} [data-choice-rule="1"] [data-cr-value]`, 'closed');
      for (const id of ['phone', 'visit']) await click(`${editor} [data-choice-rule="1"] [data-cr-hide="${id}"]`);
      if (!(await hasText(`${editor} [data-cr-sentence]`, 'hide every choice, so this question is skipped'))) throw new Error('hiding all not explained');
      await layoutCheck('form hide-choice rules', editor);
      await click('[data-map-select="2"]');
      await click(`${editor} [data-cr-add]`);
      await fill(`${editor} [data-choice-rule="0"] [data-cr-field]`, 'plan');
      await click(`${editor} [data-choice-rule="0"] [data-cr-hide="sla"]`);
      await click(`${editor} [data-choice-rule="0"] [data-cr-hide="audit"]`);
      if (!(await hasText('[data-map-node="extras"] [data-map-hides]', 'hide “Audit report”'))) throw new Error('rule not on the map, or wrong choice');
      await click(`${editor} [data-choice-rule="0"] [data-cr-hide="sla"]`);
      await click(`${editor} [data-choice-rule="0"] [data-cr-hide="audit"]`);
      if (!(await hasText('#workflow-summary', '3 hide-choice rules'))) throw new Error('summary does not count hide rules');
      // A question on a multi-question page says it is unsupported and offers no rule.
      await click('[data-map-select="4"]');
      if (await evaluate(`Boolean(document.querySelector('${editor} [data-cr-add]'))`) || !(await evaluate(`document.querySelector('${editor}').textContent.length > 0`))) throw new Error('a text question on a page offered a hide rule');

      // Preview uses the same evaluator, on one classic page, and recalculates as answers change.
      await click('#builder-index [data-section="questions"]');
      await fill('#preview-mode', 'classic');
      await waitFor("document.querySelector('#preview [name=plan]')", 'classic preview');
      await click('#preview [name="plan"][value="team"]');
      await click('#preview [name="help"][value="visit"]');
      await click('#preview [name="plan"][value="free"]');
      await waitFor("document.querySelectorAll('#preview [name=help]').length === 1", 'preview hides two choices');
      if (await evaluate("document.querySelector('#preview [name=help]:checked') !== null")) throw new Error('preview kept a hidden selection');
      await click('#preview [name="plan"][value="closed"]');
      await waitFor("!document.querySelector('#preview [name=help]') && document.querySelector('#preview [name=extras]')", 'preview skips the question');

      // Moving the rule-bearing question onto the page keeps the rule, says so, and blocks publishing.
      await click('[data-question-index="1"]');
      const from = await row(1);
      const to = await row(4);
      const y = to.y + to.height / 2 - 1;
      await mouse('mouseMoved', from.x, from.y, 0);
      await mouse('mousePressed', from.x, from.y, 1);
      await mouse('mouseMoved', from.x, from.y + 10, 1);
      await mouse('mouseMoved', to.x, y, 1);
      await mouse('mouseReleased', to.x, y, 0);
      await waitFor("document.querySelector('[data-question-row=\"4\"]').dataset.questionKey === 'help'", 'dragged onto the page');
      await waitFor("document.querySelector('.toast')?.textContent.includes('multi-question page')", 'conflict shown as a toast');
      if (!(await hasText('.question-settings [data-cr-conflict]:not([hidden])', 'multi-question page'))) throw new Error('conflict not shown beside the question');
      await click('#publish');
      await waitFor(`${notice}.includes('Not published') && ${notice}.includes('multi-question page')`, 'publish refused');
      if (app.db.get('SELECT published_version FROM forms WHERE id = ?', created.id).published_version !== null) throw new Error('published with a conflict');
      const kept = JSON.parse(app.db.get('SELECT draft FROM forms WHERE id = ?', created.id).draft);
      if (kept.choice_rules.find(entry => entry.field === 'help')?.rules.length !== 2) throw new Error('the conflicting rule was not kept in the draft');
      await waitFor("document.querySelector('#readiness-body').textContent.includes('multi-question page') && document.querySelector('[data-goto=\"workflow\"]')", 'readiness reports it and links to Workflow');
      await click('.question-settings [data-open-workflow]');
      if (!(await focused('#workflow-editor-heading'))) throw new Error('Edit in Workflow did not open the rules');
      await click('#builder-index [data-section="questions"]');
      await click('[data-goto="workflow"]');
      if (!(await focused('#workflow-heading'))) throw new Error('the readiness link did not open Workflow');
      if (!(await hasText('[data-map-node="help"] [data-map-conflict]', 'multi-question page')) || !(await hasText('#workflow-summary', '2 hide-choice conflicts'))) throw new Error('map does not show the conflict: ' + await evaluate("document.querySelector('[data-map-node=\"help\"]')?.innerText + ' | ' + document.querySelector('#workflow-summary').innerText + ' | ' + document.querySelector('.builder-page').dataset.surface"));
      if (await evaluate(`Boolean(document.querySelector('${editor} [data-cr-add]'))`)) throw new Error('a new rule was offered on a page');
      if (!(await hasText(editor, 'not supported on a question inside a multi-question page'))) throw new Error('editor does not explain the restriction');
      await click('#builder-index [data-section="questions"]');
      await click('.canvas-tools [data-move="-1"]');
      await click('.canvas-tools [data-move="-1"]');
      await click('.canvas-tools [data-move="-1"]');
      await waitFor("document.querySelector('[data-question-key=\"help\"]').dataset.questionRow === '1' && !document.querySelector('[data-question-key=\"help\"]').classList.contains('is-member')", 'moved off the page');

      // Removing a choice a rule hides: same story, and repaired in Workflow.
      await click('[data-question-index="1"]');
      await click('.question-canvas [data-remove-option="2"]');
      await waitFor("document.querySelector('.toast')?.textContent.includes('no longer in this question')", 'removed choice shown as a toast');
      await click('#publish');
      await waitFor(`${notice}.includes('Not published') && ${notice}.includes('no longer in this question')`, 'publish refused after removing a choice');
      await click('#builder-index [data-section="workflow"]');
      await waitFor(`document.querySelector('${editor} [data-choice-rule="0"] [data-cr-hide="visit"]')`, 'the removed choice can be cleared');
      for (const position of [0, 1]) await click(`${editor} [data-choice-rule="${position}"] [data-cr-hide="visit"]`);
      await click('#publish');
      await waitFor(`${notice}.includes('Version 1 is live')`, 'published once repaired');
      const live = JSON.parse(app.db.get('SELECT definition FROM form_versions WHERE form_id = ? AND version = 1', created.id).definition);
      if (JSON.stringify(live.choice_rules.find(entry => entry.field === 'help').rules.map(rule => rule.hide)) !== '[["phone"],["email","phone"]]') throw new Error('unexpected published rules: ' + JSON.stringify(live.choice_rules));

      const slug = created.slug;
      const start = () => open(`/f/${slug}`, "document.querySelector('#form-root [name=plan]')");
      const next = () => click('#form-root [type="submit"]');
      const finish = async () => { // The page and the last question, then the receipt.
        await waitFor("document.querySelector('#q-who')", 'details page');
        await fill('#q-who', 'Asha');
        await next();
        await waitFor("document.querySelector('#q-notes')", 'notes');
        await next();
        await waitFor("document.querySelector('.receipt')", 'receipt');
      };
      const latest = () => JSON.parse(app.db.get('SELECT answers FROM responses WHERE form_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', created.id).answers);
      const choices = name => evaluate(`[...document.querySelectorAll('#form-root [name=${name}]')].map(input => input.value).join()`);

      // Partial hiding with Back and a changed answer: a required question asks again.
      await start();
      await click('#form-root [name="plan"][value="team"]');
      await next();
      await waitFor("document.querySelector('#form-root [name=help]')", 'help question');
      if ((await choices('help')) !== 'email,phone') throw new Error('nothing should be hidden yet: ' + await choices('help'));
      await click('#form-root [name="help"][value="phone"]');
      await click('[data-back]');
      await waitFor("document.querySelector('#form-root [name=plan]:checked')?.value === 'team'", 'back to plan');
      await click('#form-root [name="plan"][value="free"]');
      await next();
      await waitFor("document.querySelector('#form-root [name=help]')", 'help question again');
      if ((await choices('help')) !== 'email') throw new Error('phone still offered: ' + await choices('help'));
      if (await evaluate("document.querySelector('#form-root [name=help]:checked') !== null")) throw new Error('hidden choice stayed selected');
      await next();
      await waitFor("document.querySelector('#form-root .field-error')?.textContent.includes('Choose an option')", 'still required with a choice left');
      await click('#form-root [name="help"][value="email"]');
      await next();
      await waitFor("document.querySelector('#form-root [name=extras]')", 'extras');
      await next();
      await finish();
      if (JSON.stringify(latest()) !== '{"plan":"free","help":"email","who":"Asha"}') throw new Error('unexpected answers: ' + JSON.stringify(latest()));
      if (!(await evaluate("document.querySelector('.receipt').innerText.includes('Thanks')"))) throw new Error('wrong ending after a hidden jump choice');
      await layoutCheck('hide-choice receipt');

      // Multi-select and full hiding: the question is skipped; Back makes it reappear and drops the hidden choice.
      await start();
      await click('#form-root [name="plan"][value="closed"]');
      await next();
      await waitFor("document.querySelector('#form-root [name=extras]')", 'required question skipped');
      if (await evaluate("Boolean(document.querySelector('#form-root [name=help]'))")) throw new Error('fully hidden question shown');
      await click('#form-root [name="extras"][value="sla"]');
      await click('#form-root [name="extras"][value="guide"]');
      await click('[data-back]');
      await waitFor("document.querySelector('#form-root [name=plan]:checked')?.value === 'closed'", 'back past the skipped question');
      await click('#form-root [name="plan"][value="free"]');
      await next();
      await waitFor("document.querySelector('#form-root [name=help]')", 'the question reappears');
      await click('#form-root [name="help"][value="email"]');
      await next();
      await waitFor("document.querySelector('#form-root [name=extras]')", 'extras again');
      if ((await choices('extras')) !== 'audit,guide') throw new Error('sla still offered: ' + await choices('extras'));
      if (await evaluate("[...document.querySelectorAll('#form-root [name=extras]:checked')].map(input => input.value).join()") !== 'guide') throw new Error('multi-select lost the visible choice');
      await next();
      await finish();
      if (JSON.stringify(latest()) !== '{"plan":"free","help":"email","extras":["guide"],"who":"Asha"}') throw new Error('unexpected answers: ' + JSON.stringify(latest()));

      // Fully hidden through to a stored, blank answer.
      await start();
      await click('#form-root [name="plan"][value="closed"]');
      await next();
      await waitFor("document.querySelector('#form-root [name=extras]')", 'skipped again');
      await next();
      await finish();
      if (JSON.stringify(latest()) !== '{"plan":"closed","who":"Asha"}') throw new Error('unexpected answers: ' + JSON.stringify(latest()));

      // A crafted request: the same page, no form.
      const post = answers => evaluate(`fetch('/api/public/forms/${slug}/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(JSON.stringify({ answers }))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
      const required = await post({ plan: 'free', help: 'phone', who: 'Crafted' });
      if (required.status !== 400 || !required.body.error.errors.help) throw new Error('crafted hidden choice accepted: ' + JSON.stringify(required));
      const jump = await post({ plan: 'closed', help: 'phone', who: 'Crafted' });
      if (jump.status !== 201 || jump.body.ending?.id !== 'thanks') throw new Error('crafted hidden choice used its jump: ' + JSON.stringify(jump));
      const extra = await post({ plan: 'free', help: 'email', extras: ['sla', 'guide'], who: 'Crafted' });
      if (extra.status !== 201) throw new Error('crafted multi-select refused: ' + JSON.stringify(extra));
      const stored = app.db.all('SELECT answers FROM responses WHERE form_id = ?', created.id).map(item => JSON.parse(item.answers));
      if (stored.length !== 5 || stored.some(item => item.help === 'phone' || item.extras?.includes('sla'))) throw new Error('a hidden choice was stored: ' + JSON.stringify(stored));

      // Inbox and CSV show what was stored.
      await open(`/forms/${created.id}/responses`, "document.querySelector('table')");
      await layoutCheck('hide-choice inbox');
      await waitFor("document.querySelectorAll('[data-view-response]').length === 5", 'five responses in the inbox');
      await click('[data-view-response]');
      await waitFor("document.querySelector('#detail-title')", 'response detail');
      const csv = await evaluate(`fetch('/api/me').then(r => r.json()).then(me => fetch('/api/workspaces/' + me.workspaces[0].id + '/forms/${created.id}/responses.csv')).then(r => r.text())`);
      if (typeof csv !== 'string' || !csv.includes('By email') || !csv.includes('Setup guide') || csv.includes('Phone call') || csv.includes('Fast SLA')) throw new Error('CSV does not match what was stored: ' + csv);

      // Classic, one page: Enter commits a typed answer that hides the selected choice on this very screen.
      const typed = await formApi('POST', '/forms', { definition: { title: 'Access code', description: '', presentation: 'classic', submit_label: 'Send', fields: [
        { id: 'code', type: 'short_text', label: 'Access code', required: false },
        { id: 'level', type: 'single_choice', label: 'Level', required: true, options: [{ id: 'basic', label: 'Basic' }, { id: 'vip', label: 'VIP lounge' }] },
        { id: 'tail', type: 'single_choice', label: 'Extra', required: true, options: [{ id: 'only', label: 'Only one' }] }
      ], choice_rules: [{ field: 'level', rules: [{ when: { field: 'code', op: 'equals', value: 'no vip' }, hide: ['vip'] }] }, { field: 'tail', rules: [{ when: { field: 'code', op: 'contains', value: 'skip' }, hide: ['only'] }] }] } });
      await formApi('POST', `/forms/${typed.id}/publish`, {});
      await open(`/f/${typed.slug}`, "document.querySelector('#q-code')");
      await click('#form-root [name="level"][value="vip"]');
      await click('#form-root [name="tail"][value="only"]');
      await evaluate("document.querySelector('#q-code').focus()");
      await send('Input.insertText', { text: '  no   vip ' });
      const enter = async () => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); };
      await enter();
      await waitFor("document.querySelectorAll('#form-root [name=level]').length === 1 && !document.querySelector('#form-root [name=level]:checked')", 'the changed choices are shown before moving on');
      if (await evaluate("Boolean(document.querySelector('.receipt'))") || !(await focused('#q-code'))) throw new Error('moved on without showing the change, or lost focus');
      await click('#form-root [name="level"][value="basic"]');
      await click('#form-root [type="submit"]');
      await waitFor("document.querySelector('.receipt')", 'receipt on the classic form');
      const classic = JSON.parse(app.db.get('SELECT answers FROM responses WHERE form_id = ?', typed.id).answers);
      if (JSON.stringify(classic) !== '{"code":"no vip","level":"basic","tail":"only"}') throw new Error('unexpected classic answers: ' + JSON.stringify(classic));
    } finally { await evaluate('delete document.body.dataset.dirty').catch(() => {}); }
  });
  await step('URL parameters: declare in Workflow, drive a hidden choice and a jump, preview samples, partner and default links, enforcement, attribution in the inbox and CSV', async () => {
    const formApi = (method, path, body) => evaluate(`(async () => { const me = await (await fetch('/api/me')).json(); const r = await fetch('/api/workspaces/' + me.workspaces[0].id + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: ${JSON.stringify(JSON.stringify(body))} }); return r.json(); })()`);
    const created = await formApi('POST', '/forms', { definition: { title: 'Partner enquiry', description: '', presentation: 'classic', submit_label: 'Send', endings: [{ id: 'thanks', title: 'Thanks' }, { id: 'offer', title: 'Spring offer' }], fields: [
      { id: 'help', type: 'single_choice', label: 'How can we help?', required: true, options: [{ id: 'email', label: 'By email' }, { id: 'phone', label: 'Phone call' }, { id: 'visit', label: 'Site visit' }] },
      { id: 'notes', type: 'long_text', label: 'Notes', required: false }
    ] } });
    if (!created.id) throw new Error('URL parameter fixture not created: ' + JSON.stringify(created));
    const panel = '#url-params';
    const editor = '#workflow-editor';
    const hasText = (selector, words) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].some(node => node.textContent.includes(${JSON.stringify(words)}))`);
    const responseCount = () => app.db.get('SELECT COUNT(*) AS count FROM responses WHERE form_id = ?', created.id).count;
    const addParam = async key => {
      await fill(`${panel} #url-param-key`, key);
      await click(`${panel} [data-url-add]`);
    };
    try {
      await open(`/forms/${created.id}`, "document.querySelector('#builder-index [data-section=\"workflow\"]')");
      await click('#builder-index [data-section="workflow"]');
      await waitFor(`document.querySelector('${panel} #url-param-key')`, 'URL parameters section under Workflow');
      await fill(`${panel} #url-param-key`, 'Bad Name');
      await click(`${panel} [data-url-add]`);
      if (!(await hasText('#url-param-message', 'lowercase letters')) || !(await focused(`${panel} #url-param-key`))) throw new Error('an invalid name was not explained');
      await fill(`${panel} #url-param-key`, 'mode');
      await click(`${panel} [data-url-add]`);
      if (!(await hasText('#url-param-message', 'used by form links'))) throw new Error('a reserved name was not refused');
      await addParam('utm_source');
      if (!(await focused(`${panel} #url-param-key`))) throw new Error('adding a parameter lost focus');
      await addParam('campaign');
      await click(`${panel} [data-url-record="utm_source"]`);
      if (!(await focused(`${panel} [data-url-record="utm_source"]`)) || !(await evaluate(`document.querySelector('${panel} [data-url-record="utm_source"]').checked && !document.querySelector('${panel} [data-url-record="campaign"]').checked`))) throw new Error('opt-in not kept');

      // A declared parameter hides one choice, chosen in the same rule editor as earlier answers.
      await click('[data-map-select="0"]');
      await click(`${editor} [data-cr-add]`);
      if (!(await evaluate(`document.querySelector('${editor} [data-cr-field]').value === 'param:utm_source'`))) throw new Error('a first question should start from a URL parameter');
      await fill(`${editor} [data-choice-rule="0"] [data-cr-value]`, 'partner');
      await click(`${editor} [data-choice-rule="0"] [data-cr-hide="email"]`);
      await click(`${editor} [data-choice-rule="0"] [data-cr-hide="visit"]`);
      if (!(await hasText(`${editor} [data-cr-sentence]`, 'When the link’s utm_source is “partner”, hide “Site visit”.'))) throw new Error('rule not in words: ' + await evaluate(`document.querySelector('${editor} [data-cr-sentence]').textContent`));
      if (!(await hasText('[data-map-node="help"] [data-map-hides]', 'utm_source'))) throw new Error('rule not on the map');
      // And drives a jump.
      await click(`${editor} [data-jump-add]`);
      await fill(`${editor} [data-jump="0"] [data-jump-field]`, 'param:campaign');
      await fill(`${editor} [data-jump="0"] [data-jump-value]`, 'spring');
      await fill(`${editor} [data-jump="0"] [data-jump-to]`, 'ending:offer');
      if (!(await hasText(`${editor} [data-jump-sentence]`, 'When the link’s campaign is “spring”, go to the ending “Spring offer”.'))) throw new Error('jump not in words');
      await layoutCheck('form URL parameters', panel);

      // The example link uses the value a rule looks for, and a parameter in use cannot be removed.
      if (!(await evaluate(`document.querySelector('#url-param-link').value.endsWith('/f/${created.slug}?utm_source=partner&campaign=spring')`))) throw new Error('example link wrong: ' + await evaluate("document.querySelector('#url-param-link').value"));
      await click(`${panel} [data-url-copy]`);
      await waitFor("document.querySelector('#url-param-copied').textContent.length > 0", 'copy outcome reported');
      await click(`${panel} [data-url-remove="utm_source"]`);
      if (!(await hasText('#url-param-message', 'still in use')) || !(await evaluate(`Boolean(document.querySelector('${panel} [data-url-param="utm_source"]'))`))) throw new Error('removed a parameter a rule uses');

      // Preview takes sample values and records nothing.
      await click('#builder-index [data-section="questions"]');
      await waitFor("document.querySelector('[data-preview-param=\"utm_source\"]')", 'sample inputs in Preview');
      const previewChoices = () => evaluate("[...document.querySelectorAll('#preview [name=help]')].map(input => input.value).join()");
      if ((await previewChoices()) !== 'email,phone,visit') throw new Error('preview default wrong: ' + await previewChoices());
      await fill('[data-preview-param="utm_source"]', 'partner');
      if ((await previewChoices()) !== 'email,phone') throw new Error('preview with partner wrong: ' + await previewChoices());
      await fill('[data-preview-param="utm_source"]', 'other');
      if ((await previewChoices()) !== 'email,phone,visit') throw new Error('preview with another value wrong: ' + await previewChoices());
      await layoutCheck('form preview samples', '#builder-preview');
      await fill('[data-preview-param="campaign"]', 'spring');
      await click('#preview [name="help"][value="email"]');
      await click('#preview [type="submit"]');
      await waitFor("document.querySelector('#preview').innerText.includes('Spring offer')", 'preview follows the jump');
      if (responseCount() !== 0) throw new Error('preview recorded a response');

      await click('#publish');
      await waitFor("document.querySelector('#builder-notice').innerText.includes('Version 1 is live')", 'published with URL parameters');
      if ((await evaluate("document.querySelector('#builder-notice').innerText")).includes('utm_source')) throw new Error('unexpected notice');

      const slug = created.slug;
      const choices = () => evaluate("[...document.querySelectorAll('#form-root [name=help]')].map(input => input.value).join()");
      const visit = query => open(`/f/${slug}${query}`, "document.querySelector('#form-root [name=help]')");
      const send1 = async value => {
        await click(`#form-root [name="help"][value="${value}"]`);
        await click('#form-root [type="submit"]');
        await waitFor("document.querySelector('.receipt')", 'receipt');
      };
      const newest = () => app.db.get('SELECT answers, attribution FROM responses WHERE form_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', created.id);

      // Partner link, with an undeclared key and a declared one not opted in.
      await visit('?utm_source=partner&utm_medium=undeclared_value&campaign=autumn_value');
      if ((await choices()) !== 'email,phone') throw new Error('partner link wrong: ' + await choices());
      await send1('phone');
      let row = newest();
      if (row.answers !== '{"help":"phone"}' || row.attribution !== '{"utm_source":"partner"}') throw new Error('partner response wrong: ' + JSON.stringify(row));
      if (!(await evaluate("document.querySelector('.receipt').innerText.includes('Thanks')"))) throw new Error('partner link took the wrong ending');

      // Default link: the same form offers and accepts the choice.
      await visit('');
      if ((await choices()) !== 'email,phone,visit') throw new Error('default link wrong: ' + await choices());
      await send1('visit');
      row = newest();
      if (row.answers !== '{"help":"visit"}' || row.attribution !== null) throw new Error('default response wrong: ' + JSON.stringify(row));

      // Empty, duplicate, oversized and undeclared values on a real link.
      for (const [query, expected] of [['?utm_source=', 'email,phone,visit'], ['?utm_source=partner&utm_source=other', 'email,phone'], ['?utm_source=other&utm_source=partner', 'email,phone,visit'], [`?utm_source=${'a'.repeat(201)}`, 'email,phone,visit'], ['?UTM_SOURCE=partner&source=partner', 'email,phone,visit'], ['?mode=conversational&utm_source=partner', 'email,phone']]) {
        await visit(query);
        if ((await choices()) !== expected) throw new Error(`link ${query.slice(0, 40)} wrong: ` + await choices());
      }

      // A parameter chooses the jump; the server returns the same ending.
      await visit('?campaign=spring');
      await send1('email');
      if (!(await evaluate("document.querySelector('.receipt').innerText.includes('Spring offer')"))) throw new Error('jump on a parameter did not reach its ending');
      if (newest().attribution !== null) throw new Error('a parameter not opted in was stored');

      // A crafted request: the server applies the same rule to what it is told, and stores no more than a link could.
      const post = body => evaluate(`fetch('/api/public/forms/${slug}/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
      const before = responseCount();
      const refused = await post({ answers: { help: 'visit' }, url_params: { utm_source: 'partner' } });
      if (refused.status !== 400 || !refused.body.error.errors.help || responseCount() !== before) throw new Error('hidden choice accepted: ' + JSON.stringify(refused));
      const jumped = await post({ answers: { help: 'email', notes: 'dropped on the skipped path' }, url_params: { campaign: 'spring', evil: 'undeclared_value' } });
      if (jumped.status !== 201 || jumped.body.ending?.id !== 'offer') throw new Error('crafted jump wrong: ' + JSON.stringify(jumped));

      // Markup in a value stays text in the inbox.
      await visit(`?utm_source=${encodeURIComponent('<img src=x onerror=alert(1)>')}`);
      if ((await choices()) !== 'email,phone,visit') throw new Error('markup value wrong: ' + await choices());
      await send1('email');

      const every = JSON.stringify(app.db.all('SELECT answers, attribution FROM responses WHERE form_id = ?', created.id));
      if (every.includes('undeclared_value') || every.includes('autumn_value') || every.includes('spring')) throw new Error('a value not opted in was stored: ' + every);

      // Inbox and CSV: only opted-in attribution, labelled apart from the answers.
      await open(`/forms/${created.id}/responses`, "document.querySelector('table')");
      if ((await evaluate("[...document.querySelectorAll('[data-attribution-column]')].map(th => th.textContent).join()")) !== 'Attribution: utm_source') throw new Error('attribution columns wrong');
      if (!(await hasText('#responses td', 'partner')) || !(await hasText('#responses td', '<img src=x onerror=alert(1)>')) || (await evaluate("document.querySelectorAll('#responses td img').length")) !== 0) throw new Error('attribution not shown as text');
      await layoutCheck('form attribution inbox');
      const partnerRow = app.db.get("SELECT id FROM responses WHERE form_id = ? AND attribution LIKE '%partner%'", created.id).id;
      await click(`[data-view-response="${partnerRow}"]`);
      await waitFor("document.querySelector('[data-attribution]')", 'attribution in the response detail');
      if (!(await hasText('#response-detail', 'treat these as unverified')) || !(await hasText('[data-attribution]', 'utm_source')) || (await hasText('.response-answers:not([data-attribution])', 'utm_source'))) throw new Error('detail does not separate attribution from answers');
      await layoutCheck('form attribution detail');
      const csv = await evaluate(`fetch('/api/me').then(r => r.json()).then(me => fetch('/api/workspaces/' + me.workspaces[0].id + '/forms/${created.id}/responses.csv')).then(r => r.text())`);
      if (!csv.split('\r\n')[0].endsWith('"Attribution: utm_source"') || !csv.includes('"partner"')) throw new Error('CSV attribution wrong: ' + csv);
      for (const absent of ['campaign', 'spring', 'autumn_value', 'undeclared_value', 'utm_medium']) if (csv.includes(absent)) throw new Error('CSV holds ' + absent);
    } finally { await evaluate('delete document.body.dataset.dirty').catch(() => {}); }
  });
  await step('evaluation policy: "yes " in preview, public form and server; an old version stays as it was, a new one is consistent, an open page follows its version', async () => {
    const formApi = (method, path, body) => evaluate(`(async () => { const me = await (await fetch('/api/me')).json(); const r = await fetch('/api/workspaces/' + me.workspaces[0].id + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: ${JSON.stringify(JSON.stringify(body))} }); return r.json(); })()`);
    // Publishes, then removes the stamp from the stored row, which is exactly what a version published before the policy looks like.
    const legacyForm = async definition => {
      const created = await formApi('POST', '/forms', { definition });
      if (!created.id) throw new Error('policy fixture not created: ' + JSON.stringify(created));
      await formApi('POST', `/forms/${created.id}/publish`, {});
      const stored = JSON.parse(app.db.get('SELECT definition FROM form_versions WHERE form_id = ? AND version = 1', created.id).definition);
      if (stored.evaluation_policy !== 'normalized_v1') throw new Error('a new publish was not stamped: ' + JSON.stringify(stored));
      if ('evaluation_policy' in JSON.parse(app.db.get('SELECT draft FROM forms WHERE id = ?', created.id).draft)) throw new Error('the draft holds the policy');
      delete stored.evaluation_policy;
      const text = JSON.stringify(stored);
      app.db.run('UPDATE form_versions SET definition = ? WHERE form_id = ? AND version = 1', text, created.id);
      return { ...created, oldText: text };
    };
    const versionText = (id, version) => app.db.get('SELECT definition FROM form_versions WHERE form_id = ? AND version = ?', id, version).definition;
    const rowsOf = id => app.db.all('SELECT form_version, answers FROM responses WHERE form_id = ? ORDER BY created_at, rowid', id);
    const post = (slug, body) => evaluate(`fetch('/api/public/forms/${slug}/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(JSON.stringify({ evaluator: 2, ...body }))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
    const plain = await legacyForm({ title: 'Typed rule', description: '', presentation: 'classic', submit_label: 'Send', fields: [
      { id: 'code', type: 'short_text', label: 'Do you have a code?', required: false },
      { id: 'more', type: 'short_text', label: 'Which code?', required: true, show_if: { field: 'code', op: 'equals', value: 'yes' } }
    ] });
    try {
      // The old version: the public form and the server keep what it always did.
      await open(`/f/${plain.slug}`, "document.querySelector('#q-code')");
      await fill('#q-code', 'yes ');
      if (await evaluate("Boolean(document.querySelector('#q-more'))")) throw new Error('old version showed the follow-up for "yes "');
      await click('#form-root [type="submit"]');
      await waitFor("document.querySelector('.receipt')", 'old version accepted without the follow-up');
      const oldStored = rowsOf(plain.id);
      if (oldStored.length !== 1 || oldStored[0].form_version !== 1 || oldStored[0].answers !== '{"code":"yes"}') throw new Error('old response wrong: ' + JSON.stringify(oldStored));
      const oldServer = await post(plain.slug, { answers: { code: 'yes ' } });
      if (oldServer.status !== 201) throw new Error('old version server path changed: ' + JSON.stringify(oldServer));
      const oldExact = await post(plain.slug, { answers: { code: 'yes' } });
      if (oldExact.status !== 400 || !oldExact.body.error.errors.more) throw new Error('old version exact path changed: ' + JSON.stringify(oldExact));

      // Preview shows the next publish, while the live version is untouched.
      await open(`/forms/${plain.id}`, "document.querySelector('#preview #q-code')");
      await waitFor("document.querySelector('[data-preview-policy]')", 'preview says it shows the next publish');
      await fill('#preview #q-code', 'yes ');
      await waitFor("document.querySelector('#preview #q-more')", 'preview shows the follow-up for "yes "');
      await waitFor("document.querySelector('#readiness-body').textContent.includes('compares typed answers exactly as typed')", 'readiness explains the live version');
      if (versionText(plain.id, 1) !== plain.oldText || rowsOf(plain.id).length !== 2) throw new Error('preview changed the live version or recorded something');

      // A page opened on the old version keeps following it after a republish.
      await open(`/f/${plain.slug}`, "document.querySelector('#q-code')");
      const republished = await formApi('POST', `/forms/${plain.id}/publish`, {});
      if (republished.published_version !== 2 || republished.has_unpublished_changes || republished.legacy_text_comparison) throw new Error('republish state wrong: ' + JSON.stringify(republished));
      await fill('#q-code', 'yes ');
      if (await evaluate("Boolean(document.querySelector('#q-more'))")) throw new Error('an open old page changed behaviour');
      await click('#form-root [type="submit"]');
      await waitFor("document.querySelector('.receipt')", 'open old page accepted');
      if (rowsOf(plain.id).at(-1).form_version !== 1) throw new Error('open old page was not judged by its version');

      // The new version: "yes " and "yes" mean the same everywhere.
      await open(`/f/${plain.slug}`, "document.querySelector('#q-code')");
      await fill('#q-code', 'yes ');
      await waitFor("document.querySelector('#q-more')", 'new version shows the follow-up');
      await click('#form-root [type="submit"]');
      await waitFor("document.querySelector('#form-root .field-error')", 'new version requires the follow-up');
      await fill('#q-more', 'ABC');
      await click('#form-root [type="submit"]');
      await waitFor("document.querySelector('.receipt')", 'new version accepted');
      const newest = rowsOf(plain.id).at(-1);
      if (newest.form_version !== 2 || newest.answers !== '{"code":"yes","more":"ABC"}') throw new Error('new response wrong: ' + JSON.stringify(newest));
      const newServer = await post(plain.slug, { answers: { code: 'yes ' } });
      if (newServer.status !== 400 || !newServer.body.error.errors.more) throw new Error('new version server path wrong: ' + JSON.stringify(newServer));
      const pinned = await post(plain.slug, { answers: { code: 'yes ' }, version: 1 });
      if (pinned.status !== 201 || pinned.body.version !== 1) throw new Error('a response on the old version did not follow it: ' + JSON.stringify(pinned));
      if (versionText(plain.id, 1) !== plain.oldText) throw new Error('an old version was rewritten');
      if (rowsOf(plain.id)[0].answers !== '{"code":"yes"}') throw new Error('a historical response was rewritten');

      // Hide rules and URL parameters, through the Publish button with no edits, and a jump and an ending.
      const mixed = await legacyForm({ title: 'Typed rule with hide rules', description: '', presentation: 'classic', submit_label: 'Send', url_params: [{ key: 'ref' }], fields: [
        { id: 'code', type: 'short_text', label: 'Do you have a code?', required: false },
        { id: 'pick', type: 'single_choice', label: 'Pick one', required: true, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }] }
      ], choice_rules: [{ field: 'pick', rules: [{ when: { field: 'code', op: 'equals', value: 'Yes ' }, hide: ['b'] }, { when: { param: 'ref', op: 'equals', value: 'partner' }, hide: ['c'] }] }] });
      const picks = root => evaluate(`[...document.querySelectorAll('${root} [name=pick]')].map(input => input.value).join()`);
      await open(`/forms/${mixed.id}`, "document.querySelector('#preview #q-code')");
      await fill('#preview #q-code', 'Yes');
      await waitFor("document.querySelectorAll('#preview [name=pick]').length === 2", 'preview tidies a rule value too');
      await layoutCheck('form preview next publish', '#builder-preview');
      await click('#publish');
      await waitFor("document.querySelector('dialog button[value=ok]')", 'an unedited old version can be republished');
      await click('dialog button[value=ok]');
      await waitFor("document.querySelector('#builder-notice').innerText.includes('Version 2 is live')", 'version 2 live');
      if (JSON.parse(versionText(mixed.id, 2)).evaluation_policy !== 'normalized_v1' || versionText(mixed.id, 1) !== mixed.oldText) throw new Error('republish stamped the wrong version');
      await click('#publish');
      await waitFor("document.querySelector('#builder-notice').innerText.includes('already live')", 'nothing further to publish');
      await open(`/f/${mixed.slug}?ref=%20partner%20`, "document.querySelector('#q-code')");
      await fill('#q-code', ' Yes  ');
      await waitFor("[...document.querySelectorAll('#form-root [name=pick]')].map(input => input.value).join() === 'a'", 'hide rules read the tidied answer and the tidied link value');
      await open(`/f/${mixed.slug}?ref=Partner`, "document.querySelector('#q-code')");
      await fill('#q-code', 'yes');
      if ((await picks('#form-root')) !== 'a,b,c') throw new Error('capitals must stay significant for typed rules and link values: ' + await picks('#form-root'));
    } finally { await evaluate('delete document.body.dataset.dirty').catch(() => {}); }
  });
  await step('a server on another version wants a question this path skipped: it is shown, answered and accepted', async () => {
    const formApi = (method, path, body) => evaluate(`(async () => { const me = await (await fetch('/api/me')).json(); const r = await fetch('/api/workspaces/' + me.workspaces[0].id + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: ${JSON.stringify(JSON.stringify(body))} }); return r.json(); })()`);
    const created = await formApi('POST', '/forms', { definition: { title: 'Skipped by a jump', description: '', presentation: 'classic', submit_label: 'Send', endings: [{ id: 'done', title: 'Done' }], fields: [
      { id: 'kind', type: 'single_choice', label: 'Kind', required: true, options: [{ id: 'home', label: 'Home' }, { id: 'office', label: 'Office' }] },
      { id: 'size', type: 'short_text', label: 'Team size', required: true }
    ], logic: [{ field: 'kind', rules: [{ when: { field: 'kind', op: 'equals', value: 'home' }, to: { type: 'ending', id: 'done' } }] }] } });
    await formApi('POST', `/forms/${created.id}/publish`, {});
    await open(`/f/${created.slug}`, "document.querySelector('[name=kind]')");
    await click('[name="kind"][value="home"]');
    if (await evaluate("Boolean(document.querySelector('#q-size'))")) throw new Error('the jump should skip this question');
    // Stands in for a previous backend, which does not know jumps.
    await evaluate(`(() => { const real = window.fetch; window.fetch = (url, init) => { if (String(url).endsWith('/responses') && !JSON.parse(init.body).answers.size) return Promise.resolve(new Response(JSON.stringify({ error: { code: 'validation_failed', message: 'Please check the highlighted answers.', errors: { size: 'This question is required.' } } }), { status: 400, headers: { 'Content-Type': 'application/json' } })); return real(url, init); }; })()`);
    await click('#form-root [type="submit"]');
    await waitFor("document.querySelector('#q-size') && document.querySelector('[data-field=size] .field-error')", 'the question the server wants, with its error');
    await fill('#q-size', '3');
    await click('#form-root [type="submit"]');
    await waitFor("document.querySelector('.receipt')", 'accepted once answered');
    // An error naming nothing in this form still says something.
    const next = await formApi('POST', '/forms', { definition: { title: 'Unknown question', description: '', presentation: 'classic', submit_label: 'Send', fields: [{ id: 'one', type: 'short_text', label: 'One', required: false }] } });
    await formApi('POST', `/forms/${next.id}/publish`, {});
    await open(`/f/${next.slug}`, "document.querySelector('#q-one')");
    await evaluate(`(() => { window.fetch = () => Promise.resolve(new Response(JSON.stringify({ error: { code: 'validation_failed', message: 'x', errors: { other: 'Required.' } } }), { status: 400, headers: { 'Content-Type': 'application/json' } })); })()`);
    await click('#form-root [type="submit"]');
    await waitFor("document.querySelector('#form-root [data-form-status]').innerText.includes('could not accept these answers')", 'a message rather than nothing');
    if (app.db.get('SELECT COUNT(*) AS count FROM responses WHERE form_id = ?', next.id).count !== 0) throw new Error('nothing should be stored');
  });
  await step('responses inbox, detail and CSV', async () => {
    await open('/forms', "document.querySelector('.list')");
    await click(`a[href="/forms/${formId}/responses"]`);
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
  await step('embedded forms: no site chrome, and a sign-in-only form refuses inside a frame with a link to open it in a tab', async () => {
    await open(`/f/${formSlug}?embed=1`, "document.querySelector('form [type=submit]')");
    if (await evaluate("Boolean(document.querySelector('#site-header')?.offsetHeight || document.querySelector('#site-footer')?.offsetHeight)")) throw new Error('embedded form shows the site header or footer');
    await layoutCheck('embedded form');
    const formApi = (method, path, body) => evaluate(`(async () => { const me = await (await fetch('/api/me')).json(); const r = await fetch('/api/workspaces/' + me.workspaces[0].id + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: ${JSON.stringify(JSON.stringify(body))} }); return { status: r.status, body: await r.json().catch(() => null) }; })()`);
    const issuer = 'https://idp.browser-check.test';
    const realProvider = app.fetchProvider;
    // Respondent sign-in is off by default (FORMS_RESPONDENT_SIGNIN); this step needs it on.
    const realSwitch = app.config.respondentSignin;
    app.config.respondentSignin = true;
    app.fetchProvider = async url => new Response(JSON.stringify(url.endsWith('/.well-known/openid-configuration') ? { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` } : { keys: [] }), { headers: { 'Content-Type': 'application/json' } });
    try {
      if ((await formApi('PUT', '/sso', { issuer, client_id: 'browser-check', client_secret: 'browser-check-secret', email_domain: 'example.com' })).status !== 200) throw new Error('could not configure SSO');
      const protectedForm = (await formApi('POST', '/forms', { title: 'Sign-in only check' })).body;
      await formApi('POST', `/forms/${protectedForm.id}/publish`, {});
      if ((await formApi('PUT', `/forms/${protectedForm.id}/access`, { access: 'signin' })).status !== 200) throw new Error('could not require sign-in');
      await open(`/f/${protectedForm.slug}?embed=1&mode=conversational`, "document.querySelector('#respondent-open-tab')");
      if (await evaluate("Boolean(document.querySelector('#respondent-signin, form [type=submit]'))")) throw new Error('an embedded sign-in-only form offers sign-in or questions inside the frame');
      if ((await evaluate("document.querySelector('#respondent-open-tab').target + ' ' + document.querySelector('#respondent-open-tab').getAttribute('href')")) !== `_blank /f/${protectedForm.slug}?mode=conversational`) throw new Error('the embedded refusal does not open the same form in a new tab');
      await layoutCheck('embedded sign-in-only form');
      await open(`/f/${protectedForm.slug}?mode=conversational`, "document.querySelector('#respondent-signin')");
      await open(`/forms/${protectedForm.id}`, "document.querySelector('#publish')");
      await click('#builder-index [data-section="share"]');
      await waitFor("document.querySelector('#embed-signin-note')", 'no embed code for a sign-in-only form');
      if (await evaluate("Boolean(document.querySelector('#embed'))")) throw new Error('Share offers embed code for a sign-in-only form');
      await formApi('DELETE', `/forms/${protectedForm.id}`);
      app.db.run('DELETE FROM sso_configs WHERE issuer = ?', issuer); // test configuration only; later steps sign in with passwords
    } finally { app.fetchProvider = realProvider; app.config.respondentSignin = realSwitch; }
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
    await click('#builder-index [data-section="share"]');
    await layoutCheck('forms readiness (live)');
    // Real Tab key presses reach every control in the card with a visible focus indicator.
    await evaluate("document.querySelector('#builder-index [data-section=\"share\"]').focus()");
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
    await evaluate("{ const input = document.querySelector('[data-option]'); input.value = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10) + 'T10:00'; input.dispatchEvent(new Event('change', { bubbles: true })); }");
    await click('#add-option');
    await evaluate("{ const input = document.querySelectorAll('[data-option]')[1]; input.value = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10) + 'T10:00'; input.dispatchEvent(new Event('change', { bubbles: true })); }");
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
  await step('meeting session form (fake-connected fixture): host attaches from the Session panel; guest gets one prompt, answers beside the call, uncertain submit keeps answers, receipt, no repeat', async () => {
    await withFakeRoom(async () => {
      await viewport(1280, 900);
      const form = await pageApi('/api/workspaces/:ws/forms', { definition: { title: 'Kickoff brief', presentation: 'classic', fields: [{ id: 'goal', type: 'short_text', label: 'What should this project achieve?', required: true }] } });
      await pageApi(`/api/workspaces/:ws/forms/${form.id}/publish`);
      const room = await pageApi('/api/workspaces/:ws/meet-video/rooms', { title: 'Client kickoff' });
      const invite = await pageApi(`/api/meet-video/rooms/${room.public_id}/invites`, { seats: 3 });
      const goal = '#session-form-panel [name="goal"]';
      // Host: attach the form and pin a note from the Session panel.
      await open(new URL(room.host_url).pathname, "document.querySelector('#join-form')");
      await enterRoom();
      await click('#session-toggle');
      await waitFor("document.querySelector('#session-panel:not([hidden]) #session-form-choice')", 'session panel with form picker');
      if (!(await evaluate("[...document.querySelectorAll('#session-form-choice option')].some(option => option.textContent === 'Kickoff brief')"))) throw new Error('published form not offered in the picker');
      await click('#session-panel [data-attach]');
      await waitFor("document.querySelector('#session-card:not([hidden])')?.innerText.includes('Kickoff brief')", 'card shows the attached form');
      await fill('#session-note-body', 'Agenda: goals, scope, next steps');
      await fill('#session-note-url', 'javascript:alert(1)');
      await click('#session-panel [data-save-note]');
      await waitFor("document.querySelector('#session-note-status')?.innerText.includes('https')", 'unsafe link refused inline');
      await fill('#session-note-url', 'https://example.com/agenda');
      await click('#session-panel [data-save-note]');
      await waitFor("document.querySelector('#session-card .session-note a')?.getAttribute('rel') === 'noopener noreferrer'", 'note pinned with a safe link');
      if (await evaluate("Boolean(document.querySelector('#session-note-status').textContent.trim()) || !document.querySelector('#session-panel [data-remove-note]')")) throw new Error('host panel kept the old error or did not switch to Replace/Remove after saving');
      await layoutCheck('meeting room session panel (host)', '#video-room');
      await click('#session-panel [data-close-panel]');
      // A guest joins after the offer exists (a late joiner) and is prompted once.
      app.db.run('UPDATE video_rooms SET host_joined_at = ? WHERE public_id = ?', Date.now(), room.public_id);
      await open(new URL(invite.url).pathname, "document.querySelector('#join-form')");
      await fill('#display-name', 'Late client');
      await enterRoom();
      await waitFor("document.querySelector('#session-card .session-prompt')", 'one automatic prompt for the late joiner');
      if (!(await evaluate("document.querySelector('#session-card .session-note-body').textContent === 'Agenda: goals, scope, next steps'"))) throw new Error('pinned note missing for the late joiner');
      await layoutCheck('meeting room session card with prompt (guest)', '#video-room');
      await click('#session-card [data-open-form]');
      await waitFor(`document.querySelector('#session-form-panel:not([hidden])') && document.querySelector('${goal}')`, 'form opens beside the call');
      if (!(await focused('#session-form-heading'))) throw new Error('focus did not move to the form panel heading');
      if (!(await evaluate("document.querySelector('#connection').dataset.state === 'connected' && Boolean(document.querySelector('#grid'))"))) throw new Error('call not kept while the form is open');
      await fill(goal, 'Launch the client portal by March');
      // Minimise and reopen: answers stay on the page.
      await click('#session-form-panel [data-minimise]');
      if (!(await focused('#session-card [data-open-form]'))) throw new Error('minimise did not return focus to the card');
      if (!(await evaluate("document.querySelector('#session-card [data-open-form]').textContent.startsWith('Continue form')"))) throw new Error('card does not offer to continue');
      await click('#session-card [data-open-form]');
      if ((await evaluate(`document.querySelector('${goal}').value`)) !== 'Launch the client portal by March') throw new Error('answers lost on minimise');
      await layoutCheck('meeting room form panel open (guest)', '#video-room');
      // Uncertain submission: offline, answers kept, safe retry.
      expectedOfflineSubmitUrl = `${base}/api/public/forms/${form.slug}/responses`;
      try {
        await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        await click('#session-form-panel [type="submit"]');
        await waitFor("document.querySelector('#session-form-panel').innerText.includes('could not confirm')", 'uncertain result explained', 20000);
      } finally {
        await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        expectedOfflineSubmitUrl = null;
      }
      if ((await evaluate(`document.querySelector('${goal}').value`)) !== 'Launch the client portal by March') throw new Error('answers not kept after an uncertain submit');
      await click('#session-form-panel [type="submit"]');
      await waitFor("document.querySelector('#session-form-panel .receipt') && document.querySelector('#session-card').innerText.includes('Completed · Receipt')", 'receipt and completed status', 15000);
      if (app.db.get('SELECT COUNT(*) AS count FROM responses WHERE form_id = ?', form.id).count !== 1) throw new Error('expected exactly one response');
      if (!app.db.get('SELECT response_id FROM video_session_receipts WHERE response_id IS NOT NULL')) throw new Error('response not linked to the offer and seat');
      if (await evaluate("document.title.startsWith('Response received')")) throw new Error('meeting page title replaced by the form receipt');
      // Reconnect in the same tab: same seat, completed, no prompt, no second response.
      await open(new URL(invite.url).pathname, "document.querySelector('#join-form')");
      await fill('#display-name', 'Late client');
      await enterRoom();
      await waitFor("document.querySelector('#session-card')?.innerText.includes('Completed')", 'completed after reconnect');
      if (await evaluate("Boolean(document.querySelector('#session-card .session-prompt'))")) throw new Error('prompt repeated after reconnect');
      await layoutCheck('meeting room session card completed (guest)', '#video-room');
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
    // Setup offers the same starting points as /forms (Blank, Import JSON, ten templates), then returns here.
    await waitFor("document.querySelector('#live-forms-picker [data-template]')", 'live form step picker');
    if ((await evaluate("document.querySelectorAll('#live-forms-picker [data-template]').length")) !== 11 || !(await evaluate("Boolean(document.querySelector('#live-forms-picker [data-import]'))"))) throw new Error('setup does not offer the same starting points as /forms');
    await layoutCheck('live onboarding form picker');
    await click('#live-forms-picker [data-template="blank"]');
    await waitFor("document.querySelector('#live-forms-form') && document.querySelector('#live-form-created')", 'setup returns after creating a draft');
    if (!(await evaluate("document.querySelector('#live-open-builder').getAttribute('href').includes('from=setup')"))) throw new Error('builder link from setup has no way back');
    await fill('#live-form-title', 'Live Onboarding Form');
    // Onboarding uses the shared 2,000-character form description limit, line breaks included.
    if ((await evaluate("document.querySelector('#live-form-description').maxLength")) !== 2000) throw new Error('onboarding form description is not limited to 2,000');
    const onboardingDescription = ('Tell us what you need.\nWe reply within a day.\n').repeat(50).slice(0, 1999) + '.';
    await fill('#live-form-description', onboardingDescription);
    await click('#live-forms-form button[type=submit]');
    await waitFor("document.querySelector('#live-flow-form')", 'live flow step');
    const onboardingForm = app.db.all('SELECT draft FROM forms').map(row => JSON.parse(row.draft)).find(draft => draft.title === 'Live Onboarding Form');
    if (onboardingForm?.description !== onboardingDescription) throw new Error('onboarding did not save a 2,000-character description exactly');
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
    // Marked as just synced: otherwise the background worker fetches this address and overwrites the status under test.
    app.db.run('INSERT INTO calendar_connections (id, workspace_id, user_id, provider, feed_url, label, status, last_error, last_synced_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', crypto.randomUUID(), ws, peer, 'ics', 'https://example.com/' + sentinel, sentinel, 'error', sentinel, app.now(), app.now());
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
if (problems.length) { console.log('\nProblems:\n- ' + [...new Set(problems)].join('\n- '));
  // In CI, annotations stay readable without signing in to download the log.
  if (process.env.GITHUB_ACTIONS) for (const problem of [...new Set(problems)].slice(0, 9)) console.log('::error::' + problem.replace(/\s+/g, ' ').slice(0, 600));
  process.exit(1);
}
console.log('No runtime errors, overflow or failed journeys.');
