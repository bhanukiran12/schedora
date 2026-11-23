// Flow v1 builder journeys in a real headless Chrome (docs/FLOW_V1_IMPLEMENTATION.md, "Builder coverage").
// Runs against a fresh in-process server and SQLite database with fake providers and synthetic records.
// Nothing leaves this machine: email uses the local outbox, webhooks and Slack are stubbed in-process.
// Every journey also checks runtime errors and horizontal overflow at 320/375/768/1280 px, light and dark.
// Usage: npm run flow-builder-check [-- --screenshots <dir>]
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
import { createRateLimiter } from '../src/http.mjs';
import { dispatchOutbox } from '../src/flow/service.mjs';
import { processFlowRuns } from '../src/flow/engine.mjs';

const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
const browserPath = candidates.find(path => path && existsSync(path));
if (!browserPath) { console.error('No Chrome/Edge found. Set CHROME_PATH.'); process.exit(2); }
const shotsIndex = process.argv.indexOf('--screenshots');
const shotsDir = shotsIndex > 0 ? process.argv[shotsIndex + 1] : null;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

const workDir = mkdtempSync(join(tmpdir(), 'schedora-flow-builder-'));
// The worker is driven by hand (app.worker.tick) so each journey controls exactly when runs advance.
const app = createApp({ databasePath: join(workDir, 'test.db'), config: loadConfig({ NODE_ENV: 'test' }, { port: 0, workerIntervalMs: 3600000, rateLimitPerMinute: 100000, billingMode: 'open' }), log: () => {} });
await app.start();
await new Promise(resolve => app.server.close(resolve));
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
app.config.baseUrl = base;
// Outbound webhooks never leave the process; calls are recorded.
const webhookCalls = [];
app.assertPublicHost = async () => {};
app.fetchWebhook = async (url, init) => { webhookCalls.push({ url, body: init?.body }); return new Response('ok', { status: 200 }); };
// No background ticks: publishing, approving and retrying would otherwise run work before a journey looks.
app.nudge = () => {};

const port = 9800 + Math.floor(Math.random() * 400);
const browser = spawn(browserPath, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(workDir, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let target;
for (let attempt = 0; attempt < 150 && !target; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 200));
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page'); } catch { /* starting */ }
}
if (!target) { browser.kill(); await app.stop(); throw new Error('Browser did not start: ' + browserPath); }

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
let nextId = 0;
const pending = new Map();
const problems = [];
let currentLabel = '';
const dialogAnswers = [];
const dialogsSeen = [];
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data);
  if (message.id && pending.has(message.id)) { const { resolve, reject } = pending.get(message.id); pending.delete(message.id); message.error ? reject(new Error(message.error.message)) : resolve(message.result); }
  if (message.method === 'Runtime.exceptionThrown') problems.push(`${currentLabel}: exception ${message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text}`);
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') problems.push(`${currentLabel}: console.error ${message.params.args.map(arg => arg.value ?? arg.description).join(' ')}`);
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error' && !/status of 4\d\d/.test(message.params.entry.text)) problems.push(`${currentLabel}: ${message.params.entry.text} ${message.params.entry.url || ''}`);
  // window.confirm (unsaved-change navigation): answered from the queue the journey sets up.
  if (message.method === 'Page.javascriptDialogOpening') {
    dialogsSeen.push(message.params.message);
    const accept = dialogAnswers.length ? dialogAnswers.shift() : false;
    send('Page.handleJavaScriptDialog', { accept });
  }
});
// Requests paused by Fetch interception (used to hold a save in flight).
const paused = [];
socket.addEventListener('message', ({ data }) => { const message = JSON.parse(data); if (message.method === 'Fetch.requestPaused') paused.push(message.params.requestId); });
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
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out waiting for ${label}`);
};
await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
if (process.env.BROWSER_TIMEZONE) await send('Emulation.setTimezoneOverride', { timezoneId: process.env.BROWSER_TIMEZONE });

async function open(path, ready = "document.querySelector('#main h1, #main .flow-builder')") {
  currentLabel = path;
  await send('Page.navigate', { url: base + path });
  await waitFor(`document.readyState === 'complete' && ${ready}`, `${path} to render`);
}
const q = JSON.stringify;
const click = selector => evaluate(`(() => { const el = document.querySelector(${q(selector)}); if (!el) throw new Error('missing ${selector.replace(/'/g, '')}'); el.click(); })()`);
const choose = (selector, value) => evaluate(`(() => { const el = document.querySelector(${q(selector)}); if (!el) throw new Error('missing ${selector.replace(/'/g, '')}'); el.value = ${q(String(value))}; if (el.value !== ${q(String(value))}) throw new Error('no option ${String(value).replace(/'/g, '')} in ${selector.replace(/'/g, '')}'); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const type = (selector, value) => evaluate(`(() => { const el = document.querySelector(${q(selector)}); if (!el) throw new Error('missing ${selector.replace(/'/g, '')}'); el.value = ${q(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const text = (selector = '#main') => evaluate(`document.querySelector(${q(selector)})?.innerText || ''`);
const value = selector => evaluate(`document.querySelector(${q(selector)})?.value`);
const confirmDialog = async () => { await waitFor("document.querySelector('dialog[open] button[value=ok]')", 'confirmation dialog'); await click('dialog[open] button[value=ok]'); await waitFor("!document.querySelector('dialog[open]')", 'dialog closed');
  // The dialog's close event (which resolves the page's confirmation) fires in a later task.
  await new Promise(resolve => setTimeout(resolve, 200)); };
const key = async (name, code = name, keyCode = 0, modifiers = 0) => {
  const typed = { Enter: String.fromCharCode(13), ' ': ' ' }[name];
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: keyCode, modifiers, ...(typed ? { text: typed, unmodifiedText: typed } : {}) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: keyCode, modifiers });
};
const KEYS = { Tab: 9, Enter: 13, ArrowLeft: 37, End: 35, Space: 32 };
const press = name => key(name === 'Space' ? ' ' : name, name, KEYS[name]);
const api = (method, path, body) => evaluate(`(async () => { const me = await (await fetch('/api/me')).json(); const r = await fetch('/api/workspaces/' + me.workspaces[0].id + ${q(path)}, { method: ${q(method)}, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }${body ? `, body: ${q(JSON.stringify(body))}` : ''} }); return { status: r.status, body: await r.json().catch(() => null) }; })()`);
const submit = (slug, name, extra = {}) => fetch(`${base}/api/public/forms/${slug}/responses`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers: { name, email: `${name.toLowerCase()}@example.com`, topic: 'support', ...extra }, submission_id: `fb-${name.toLowerCase()}-${Math.random().toString(36).slice(2, 12)}`.padEnd(24, '0').slice(0, 40) }) });
const until = async (check, label, timeout = 8000) => { const started = Date.now(); while (Date.now() - started < timeout) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 80)); } throw new Error('Timed out waiting for ' + label); };
const tick = async (times = 1) => { for (let index = 0; index < times; index++) await app.worker.tick(); };
const definitionOf = id => JSON.parse(app.db.get('SELECT definition FROM flows WHERE id = ?', id).definition);
const flowRow = id => app.db.get('SELECT * FROM flows WHERE id = ?', id);
const builderId = () => evaluate("location.pathname.split('/')[3]");
const stepIds = () => evaluate("[...document.querySelectorAll('#flow-steps > li[data-step]')].map(li => li.dataset.step)");
const lastStep = async () => (await stepIds()).at(-1);
const addStep = async (target, what) => { const before = await stepIds(); await choose(`[data-add="${target}"]`, what); if (target === 'root') await waitFor(`document.querySelectorAll('#flow-steps > li[data-step]').length === ${before.length + 1}`, 'step added'); };
const saveDraft = async () => { await click('#flow-save'); await waitFor("!document.querySelector('#flow-state').textContent.includes('Not saved')", 'draft saved'); };
const noTokens = async where => {
  if (await evaluate("[document.querySelector('#flow-sentence')?.textContent || '', ...[...document.querySelectorAll('.flow-step-title, .flow-step .visually-hidden, .flow-timeline-step strong')].map(el => el.textContent), ...[...document.querySelectorAll('[data-text]')].map(el => el.value)].some(value => value.includes('{{'))")) throw new Error('raw field tokens shown in ' + where);
};

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
        const culprits = await evaluate("[...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > innerWidth + 1).slice(0, 6).map(el => el.tagName.toLowerCase() + '.' + String(el.className) + ':' + Math.round(el.getBoundingClientRect().right)).join(', ')");
        problems.push(`${name}: horizontal overflow of ${overflow}px at ${width}px (${theme}) from ${culprits || 'unknown'}`);
      }
      // Text on the page must keep readable contrast against its own background in both themes.
      if (shotsDir && (width === 375 || width === 1280)) {
        const { data } = await send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(shotsDir, `${name.replace(/[^a-z0-9]+/gi, '_')}-${width}-${theme}.png`), Buffer.from(data, 'base64'));
      }
    }
  }
  await send('Emulation.setEmulatedMedia', { features: [] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
}

const steps = [];
async function journey(name, fn) {
  app.rateLimit = createRateLimiter();
  const before = problems.length;
  try { await fn(); steps.push(`${problems.length > before ? '✗' : '✓'} ${name}`); }
  catch (error) {
    const seen = await evaluate("location.pathname + ' | ' + (document.querySelector('#main')?.innerText || '').split(String.fromCharCode(10)).join(' ').slice(0, 200)").catch(() => '');
    steps.push(`✗ ${name}: ${error.message}`);
    problems.push(`${name}: ${error.message} [page: ${seen}]`);
  }
  // Leave no unsaved state behind for the next journey.
  await evaluate('delete document.body.dataset.dirty').catch(() => {});
}

let ws; let form; let eventType; let workbook;
try {
  // ---- Synthetic workspace -------------------------------------------------------------------------------
  await open('/signup', "document.querySelector('#signup')");
  const signup = await evaluate(`(async () => { const r = await fetch('/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Builder Owner', email: 'builder.owner@example.com', password: 'a sufficiently long password', workspace: 'Builder QA' }) }); return { status: r.status, body: await r.json() }; })()`);
  if (signup.status !== 201) throw new Error('signup failed: ' + JSON.stringify(signup.body));
  ws = signup.body.workspaces[0];
  form = (await api('POST', '/forms', { title: 'Enquiry' })).body;
  await api('POST', `/forms/${form.id}/publish`);
  form = app.db.get('SELECT id, slug FROM forms WHERE id = ?', form.id);
  eventType = (await api('POST', '/event-types', { title: 'Intro call', timezone: 'UTC', published: true, min_notice_min: 0 })).body;
  workbook = (await api('POST', '/workbooks', { title: 'Leads' })).body;
  const sheetId = (await api('GET', `/workbooks/${workbook.id}`)).body.sheets[0].id;
  await api('POST', `/workbooks/${workbook.id}/changes`, { ops: [{ op: 'cell', sheet: sheetId, cell: 'A1', from: null, to: 'Name' }, { op: 'cell', sheet: sheetId, cell: 'B1', from: null, to: 'Email' }, { op: 'cell', sheet: sheetId, cell: 'A2', from: null, to: 'Asha' }, { op: 'cell', sheet: sheetId, cell: 'B2', from: null, to: 'asha@example.com' }] });
  if ((await submit(form.slug, 'Rae')).status !== 201) throw new Error('seed response failed');
  await tick(2);

  await journey('create a draft from a template and a blank workflow', async () => {
    await open(`/flow?form=${form.id}`, "document.querySelector('[data-template=speed_to_lead]') && document.querySelector('#flow-blank')");
    if (!(await text()).includes('for this form')) throw new Error('templates do not say they are for this form');
    await layoutCheck('Flow home with templates');
    await click('[data-template=speed_to_lead]');
    await waitFor("/^\\/flow\\/build\\/[0-9a-f-]{36}$/.test(location.pathname) && document.querySelector('[data-add=root]')", 'template builder');
    const templated = flowRow(await builderId());
    if (templated.status !== 'draft' || templated.published_version != null || templated.template !== 'speed_to_lead') throw new Error('template is not an unpublished draft: ' + JSON.stringify({ status: templated.status, v: templated.published_version, template: templated.template }));
    if (definitionOf(templated.id).trigger.source !== form.id) throw new Error('template not bound to the form it was opened from');
    if (!(await text('#flow-sentence')).startsWith('When ')) throw new Error('no plain-language sentence');
    await noTokens('the template builder');
    await open('/flow', "document.querySelector('#flow-blank')");
    await click('#flow-blank');
    await waitFor("/^\\/flow\\/build\\/[0-9a-f-]{36}$/.test(location.pathname) && document.querySelector('[data-add=root]')", 'blank builder');
    const blank = flowRow(await builderId());
    if (blank.status !== 'draft' || definitionOf(blank.id).steps.length !== 0) throw new Error('blank workflow is not an empty draft');
    if ((await stepIds()).length !== 0) throw new Error('blank builder shows steps');
  });

  let stepsFlow;
  await journey('add, edit, reorder (mouse and keyboard) and remove steps', async () => {
    const created = await api('POST', '/flow/workflows', { name: 'Step editing', definition: { trigger: { type: 'forms.response.created', source: form.id }, steps: [] } });
    stepsFlow = created.body.id;
    await open(`/flow/build/${stepsFlow}`, "document.querySelector('[data-add=root]')");
    await addStep('root', 'action:create_task');
    const taskId = await lastStep();
    await type(`#t-${taskId}-title`, 'First task');
    await addStep('root', 'action:send_email');
    const emailId = await lastStep();
    await type(`#t-${emailId}-subject`, 'Hello');
    await type(`#t-${emailId}-body`, 'Thanks for writing.');
    await addStep('root', 'wait');
    const waitId = await lastStep();
    if (!(await text('#flow-state')).includes('Not saved')) throw new Error('edits are not marked unsaved');
    // Mouse: move the wait up one place.
    await click(`[data-move="${waitId}:-1"]`);
    if ((await stepIds()).join() !== [taskId, waitId, emailId].join()) throw new Error('move up did not reorder');
    // Keyboard: the focused move button keeps focus; Enter moves again; at the top, focus moves to "down".
    if (!(await evaluate(`document.activeElement?.dataset.move === '${waitId}:-1'`))) throw new Error('focus left the move button');
    await press('Enter');
    await waitFor(`[...document.querySelectorAll('#flow-steps > li[data-step]')][0]?.dataset.step === '${waitId}'`, 'keyboard move');
    if (!(await evaluate(`document.activeElement?.dataset.move === '${waitId}:1'`))) throw new Error('focus lost when the step reached the top: ' + await evaluate('document.activeElement?.outerHTML?.slice(0, 120)'));
    await press('Enter');
    await waitFor(`[...document.querySelectorAll('#flow-steps > li[data-step]')][1]?.dataset.step === '${waitId}'`, 'keyboard move down');
    if ((await evaluate(`document.querySelector('[data-move="${taskId}:-1"]').disabled`)) !== true) throw new Error('first step can still move up');
    // Edit toggles; delete asks first and keeps focus on the page.
    await click(`[data-edit="${taskId}"]`);
    if (await evaluate(`Boolean(document.querySelector('[data-editor="${taskId}"]'))`)) throw new Error('Done did not close the editor');
    await click(`[data-edit="${taskId}"]`);
    if ((await value(`#t-${taskId}-title`)) !== 'First task') throw new Error('edit lost the task title');
    await click(`[data-delete="${emailId}"]`);
    await waitFor("document.querySelector('dialog[open]')", 'delete confirmation');
    await click('dialog[open] button[value=cancel], dialog[open] [value=cancel]').catch(async () => { await evaluate("document.querySelector('dialog[open]').close('cancel')"); });
    await waitFor("!document.querySelector('dialog[open]')", 'delete canceled');
    if (!(await stepIds()).includes(emailId)) throw new Error('canceling deleted the step');
    await click(`[data-delete="${emailId}"]`);
    await confirmDialog();
    if ((await stepIds()).includes(emailId)) throw new Error('step not deleted');
    if (!(await evaluate("document.activeElement?.id === 'add-root'"))) throw new Error('focus not returned after delete');
    await layoutCheck('Flow builder editing steps');
    await saveDraft();
    const stored = definitionOf(stepsFlow).steps;
    if (stored.map(step => step.type + ':' + (step.action || '')).join() !== 'action:create_task,wait:') throw new Error('saved steps wrong: ' + JSON.stringify(stored));
    if (stored[0].config.title !== 'First task') throw new Error('task title not saved');
  });

  await journey('field chips go where the caret was in existing text', async () => {
    await open(`/flow/build/${stepsFlow}`, "document.querySelector('[data-add=root]')");
    const [taskId] = await stepIds();
    await click(`[data-edit="${taskId}"]`);
    await type(`#t-${taskId}-title`, 'Call  today');
    await evaluate(`document.querySelector('#t-${taskId}-title').focus()`);
    await press('End');
    for (let index = 0; index < 6; index++) await press('ArrowLeft');
    if ((await evaluate(`document.querySelector('#t-${taskId}-title').selectionStart`)) !== 5) throw new Error('caret not placed');
    await choose(`#i-${taskId}-title`, 'Contact name');
    if ((await value(`#t-${taskId}-title`)) !== 'Call [Contact name] today') throw new Error('chip not at the caret: ' + await value(`#t-${taskId}-title`));
    // A second field goes right after the first.
    await choose(`#i-${taskId}-title`, 'Contact email');
    if ((await value(`#t-${taskId}-title`)) !== 'Call [Contact name][Contact email] today') throw new Error('second chip misplaced: ' + await value(`#t-${taskId}-title`));
    // Details (multi-line): put the caret at the start.
    await type(`#t-${taskId}-details`, 'asked about pricing');
    await evaluate(`(() => { const el = document.querySelector('#t-${taskId}-details'); el.focus(); el.setSelectionRange(0, 0); el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true })); })()`);
    await choose(`#i-${taskId}-details`, 'Contact name');
    if ((await value(`#t-${taskId}-details`)) !== '[Contact name]asked about pricing') throw new Error('chip not at the start of details: ' + await value(`#t-${taskId}-details`));
    if (!(await text('#flow-sentence')).includes('Call [Contact name][Contact email] today')) throw new Error('sentence does not show chips');
    await noTokens('the builder after inserting chips');
    await saveDraft();
    const stored = definitionOf(stepsFlow).steps[0].config;
    if (stored.title !== 'Call {{contact.name}}{{contact.email}} today' || stored.details !== '{{contact.name}}asked about pricing') throw new Error('chips not stored as references: ' + JSON.stringify(stored));
  });

  await journey('conditions, branches, waits and approvals are configured without code', async () => {
    const created = await api('POST', '/flow/workflows', { name: 'Logic', definition: { trigger: { type: 'forms.response.created', source: form.id }, steps: [] } });
    const flowId = created.body.id;
    await open(`/flow/build/${flowId}`, "document.querySelector('[data-add=root]')");
    await addStep('root', 'condition');
    const condition = await lastStep();
    await choose(`#rf-${condition}-0`, 'contact.email');
    await choose(`#ro-${condition}-0`, 'contains');
    await type(`#rv-${condition}-0`, '@example.com');
    await click(`[data-add-rule="${condition}"]`);
    await waitFor(`document.querySelector('#m-${condition}')`, 'match selector for two rules');
    await choose(`#m-${condition}`, 'any');
    await click(`[data-remove-rule="${condition}:1"]`);
    await addStep('root', 'branch');
    const branch = await lastStep();
    const paths = await evaluate(`[...document.querySelectorAll('[data-step="${branch}"] [data-path-label]')].map(el => el.dataset.pathLabel)`);
    await type(`#pl-${paths[0]}`, 'Hot leads');
    await click(`[data-add-path="${branch}"]`);
    const three = await evaluate(`[...document.querySelectorAll('[data-step="${branch}"] [data-path-label]')].map(el => el.dataset.pathLabel)`);
    if (three.length !== 3) throw new Error('could not add a third path');
    if (await evaluate(`Boolean(document.querySelector('[data-add-path="${branch}"]'))`)) throw new Error('more than three paths offered');
    await choose(`[data-add="${three[0]}"]`, 'action:create_task');
    await waitFor(`document.querySelector('[data-step="${branch}"] .flow-steps--nested li[data-step]')`, 'step inside a path');
    const inner = await evaluate(`document.querySelector('[data-step="${branch}"] .flow-steps--nested li[data-step]').dataset.step`);
    await type(`#t-${inner}-title`, 'Call hot lead');
    await click(`[data-remove-path="${branch}:${three[1]}"]`);
    await addStep('root', 'wait');
    const waitId = await lastStep();
    await type(`#w-${waitId}`, '2');
    await choose(`#wu-${waitId}-minutes`, '60');
    await addStep('root', 'approval');
    const approval = await lastStep();
    await choose(`#ap-${approval}`, 'admins');
    await type(`#at-${approval}`, 'Check the reply');
    await type(`#ae-${approval}`, '12');
    await addStep('root', 'wait_for');
    const waitFor_ = await lastStep();
    await choose(`#we-${waitFor_}`, 'meet.booking.created');
    await noTokens('the logic builder');
    await layoutCheck('Flow builder with conditions, paths, waits and approvals');
    await saveDraft();
    const stored = definitionOf(flowId).steps;
    const [c, b, w, a, f] = stored;
    if (c.type !== 'condition' || c.rules.length !== 1 || c.rules[0].field !== 'contact.email' || c.rules[0].op !== 'contains' || c.rules[0].value !== '@example.com') throw new Error('condition not saved: ' + JSON.stringify(c));
    if (b.type !== 'branch' || b.paths.length !== 2 || b.paths[0].label !== 'Hot leads' || b.paths[0].steps[0]?.config.title !== 'Call hot lead' || b.paths[1].rules.length !== 0) throw new Error('branch not saved: ' + JSON.stringify(b));
    if (w.type !== 'wait' || w.minutes !== 120) throw new Error('wait not saved: ' + JSON.stringify(w));
    if (a.type !== 'approval' || a.title !== 'Check the reply' || a.expires_hours !== 12 || a.approver !== 'admins') throw new Error('approval not saved: ' + JSON.stringify(a));
    if (f.type !== 'wait_for' || f.event !== 'meet.booking.created') throw new Error('wait-until not saved: ' + JSON.stringify(f));
  });

  await journey('explicit save, reload persistence and unsaved-change navigation', async () => {
    await open(`/flow/build/${stepsFlow}`, "document.querySelector('[data-add=root]')");
    await type('#flow-name', 'Renamed workflow');
    if (!(await text('#flow-state')).includes('Not saved')) throw new Error('rename not marked unsaved');
    if (flowRow(stepsFlow).name === 'Renamed workflow') throw new Error('saved without Save draft');
    await saveDraft();
    if (flowRow(stepsFlow).name !== 'Renamed workflow') throw new Error('Save draft did not save');
    // Typing while a save is still in flight keeps the new edit and stays "Not saved".
    await send('Fetch.enable', { patterns: [{ urlPattern: '*/flow/workflows/*/draft', requestStage: 'Request' }] });
    await type('#flow-name', 'Renamed during save');
    await click('#flow-save');
    await until(() => paused.length === 1, 'save held in flight');
    await type('#flow-name', 'Typed while saving');
    await send('Fetch.continueRequest', { requestId: paused.shift() });
    await send('Fetch.disable');
    await until(() => flowRow(stepsFlow).name === 'Renamed during save', 'held save landed');
    await new Promise(resolve => setTimeout(resolve, 300));
    if ((await value('#flow-name')) !== 'Typed while saving' || !(await text('#flow-state')).includes('Not saved')) throw new Error('an edit made during a save was lost or marked saved');
    await type('#flow-name', 'Renamed workflow');
    await saveDraft();
    if (flowRow(stepsFlow).name !== 'Renamed workflow') throw new Error('second save did not save');
    await evaluate('window.__beforeReload = true');
    await send('Page.reload');
    await waitFor("!window.__beforeReload && document.readyState === 'complete' && document.querySelector('#flow-name') && document.querySelectorAll('#flow-steps > li[data-step]').length", 'reloaded builder');
    if ((await value('#flow-name')) !== 'Renamed workflow' || (await stepIds()).length !== 2) throw new Error('reload lost saved changes');
    await type('#flow-name', 'Unsaved name');
    dialogAnswers.push(false);
    await click('#flow-builder > a[href="/flow?tab=flows"]');
    await new Promise(resolve => setTimeout(resolve, 300));
    if (!dialogsSeen.at(-1)?.includes('unsaved changes')) throw new Error('no unsaved-change warning');
    if (!(await evaluate("location.pathname.startsWith('/flow/build/')")) || (await value('#flow-name')) !== 'Unsaved name') throw new Error('stay did not keep the edit');
    dialogAnswers.push(true);
    await click('#flow-builder > a[href="/flow?tab=flows"]');
    await waitFor("location.pathname === '/flow'", 'left after confirming');
    if (flowRow(stepsFlow).name !== 'Renamed workflow') throw new Error('leaving saved the unsaved edit');
  });

  let liveFlow;
  await journey('publish validation, missing connections, publish, pause, resume, turn off and republish', async () => {
    const created = await api('POST', '/flow/workflows', { name: 'Reply to enquiries', definition: { trigger: { type: 'forms.response.created', source: form.id }, steps: [] } });
    liveFlow = created.body.id;
    await open(`/flow/build/${liveFlow}`, "document.querySelector('[data-add=root]')");
    await addStep('root', 'action:send_email');
    const emailId = await lastStep();
    const revision = flowRow(liveFlow).draft_revision;
    await click('#flow-publish');
    await until(() => flowRow(liveFlow).draft_revision > revision, 'publish saved the draft first');
    await waitFor("document.querySelector('#flow-problems').innerText.includes('Before publishing')", 'publish problems');
    await new Promise(resolve => setTimeout(resolve, 300));
    if (flowRow(liveFlow).published_version != null) throw new Error('published with an empty email');
    await type(`#t-${emailId}-subject`, 'Thanks [Contact name]');
    await type(`#t-${emailId}-body`, 'We got your enquiry.');
    // Slack is not connected on this server: publishing is allowed, turning on is not.
    await addStep('root', 'action:slack');
    const slackId = await lastStep();
    await type(`#t-${slackId}-text`, 'New enquiry from [Contact name]');
    if (!(await evaluate(`document.querySelector('[data-editor="${slackId}"] [data-provider-state]')?.dataset.providerState === 'not_configured'`))) throw new Error('Slack not shown as not configured');
    await click('#flow-publish');
    await confirmDialog();
    await waitFor("document.querySelector('[data-status=enabled]')", 'published');
    if (flowRow(liveFlow).published_version !== 1) throw new Error('version 1 not published');
    await click('[data-status=enabled]');
    await waitFor("document.querySelector('#flow-problems').innerText.includes('Before turning on')", 'activation problems');
    if (!/Slack/.test(await text('#flow-problems'))) throw new Error('missing connection not named');
    if (flowRow(liveFlow).status === 'enabled') throw new Error('turned on without Slack');
    await layoutCheck('Flow publish blocked by a missing connection');
    await click(`[data-delete="${slackId}"]`);
    await confirmDialog();
    await click('#flow-publish');
    await confirmDialog();
    await until(() => flowRow(liveFlow).published_version === 2, 'version 2 published');
    await waitFor("document.querySelector('[data-status=enabled]')", 'turn on offered');
    await click('[data-status=enabled]');
    await waitFor("document.querySelector('#flow-state').textContent.includes('On')", 'on');
    await click('[data-status=paused]');
    await waitFor("document.querySelector('#flow-state').textContent.includes('Paused')", 'paused');
    if (flowRow(liveFlow).status !== 'paused') throw new Error('pause not saved');
    await click('[data-status=enabled]');
    await waitFor("document.querySelector('#flow-state').textContent.includes('On')", 'resumed');
    await click('[data-status=draft]');
    await waitFor("document.querySelector('#flow-state').textContent.includes('Off')", 'off');
    if (flowRow(liveFlow).status !== 'draft') throw new Error('turn off not saved');
    await click(`[data-edit="${emailId}"]`).catch(() => {});
    if (!(await evaluate(`Boolean(document.querySelector('#t-${emailId}-subject'))`))) await click(`[data-edit="${emailId}"]`);
    await type(`#t-${emailId}-subject`, 'Thanks for your enquiry, [Contact name]');
    await saveDraft();
    await waitFor("document.querySelector('#flow-state').textContent.includes('Unpublished changes')", 'unpublished changes badge');
    await click('#flow-publish');
    await confirmDialog();
    await until(() => flowRow(liveFlow).published_version === 3, 'version 3 published');
    await waitFor("!document.querySelector('#flow-state').textContent.includes('Unpublished')", 'republished');
    await click('[data-status=enabled]');
    await waitFor("document.querySelector('#flow-state').textContent.includes('On')", 'on again');
    if (flowRow(liveFlow).published_version !== 3 || Number(app.db.get('SELECT COUNT(*) AS n FROM flow_versions WHERE flow_id = ?', liveFlow).n) !== 3) throw new Error('versions not kept');
    await layoutCheck('Flow builder published and on');
  });

  await journey('test with a recent record changes nothing and uses no runs', async () => {
    await open(`/flow/build/${liveFlow}`, "document.querySelector('#flow-test')");
    const counts = () => JSON.stringify(['flow_runs', 'emails', 'tasks', 'flow_run_steps', 'outbox'].map(table => Number(app.db.get(`SELECT COUNT(*) AS n FROM ${table}`).n)).concat(Number(app.db.get("SELECT COALESCE(SUM(count), 0) AS n FROM usage_counters WHERE metric = 'flow_runs'").n)));
    const before = counts();
    // Records are offered by reference and time, never by the person's name.
    const options = await evaluate("[...document.querySelectorAll('#flow-record option')].map(option => [option.value, option.textContent])");
    if (!options.length || !options[0][0] || !/^Response [0-9A-F]{8} · /.test(options[0][1])) throw new Error('recent record not offered: ' + JSON.stringify(options));
    await click('#flow-test');
    await waitFor("document.querySelector('#flow-test-result .flow-test-steps')", 'test result');
    const result = await text('#flow-test-result');
    if (!result.includes('Would finish') || !/Nothing (is|was) sent/i.test(result + (await text('.flow-test')))) throw new Error('test result unclear: ' + result.slice(0, 200));
    if (!result.includes('Thanks for your enquiry, Rae')) throw new Error('preview did not use the record: ' + result.slice(0, 200));
    if (!result.includes('[Contact name]') || result.includes('[contact name]')) throw new Error('test steps do not name fields the way the builder does: ' + result.slice(0, 200));
    if (counts() !== before) throw new Error('testing changed data or usage: ' + before + ' → ' + counts());
    await layoutCheck('Flow test result');
  });

  await journey('runs stay on the version they started with', async () => {
    const created = await api('POST', '/flow/workflows', { name: 'Pinned', definition: { trigger: { type: 'forms.response.created', source: form.id }, steps: [{ id: 'ok', type: 'approval', approver: 'admins', expires_hours: 24, title: 'Approve' }, { id: 'mail', type: 'action', action: 'send_email', config: { to: 'contact', subject: 'Version one {{contact.name}}', body: 'One' } }] } });
    const flowId = created.body.id;
    await api('POST', `/flow/workflows/${flowId}/publish`, { revision: created.body.draft_revision });
    await api('POST', `/flow/workflows/${flowId}/status`, { status: 'enabled' });
    await api('POST', `/flow/workflows/${liveFlow}/status`, { status: 'draft' });
    if ((await submit(form.slug, 'Pia')).status !== 201) throw new Error('response failed');
    await tick(2);
    const run = app.db.get("SELECT r.* FROM flow_runs r JOIN responses p ON p.id = r.subject_id WHERE r.flow_id = ? AND p.answers LIKE '%pia@%'", flowId);
    if (run?.status !== 'needs_approval' || run.version !== 1) throw new Error('run not waiting on version 1: ' + JSON.stringify(run));
    await open(`/flow/build/${flowId}`, "document.querySelector('[data-step=mail]')");
    await click('[data-edit=mail]');
    await type('#t-mail-subject', 'Version two [Contact name]');
    await click('#flow-publish');
    await confirmDialog();
    await until(() => flowRow(flowId).published_version === 2, 'version 2');
    await open('/flow/approvals', "document.querySelector('[data-decide=approve]')");
    await click(`[data-approval] [data-decide=approve]`);
    await waitFor("document.querySelector('#approval-list .empty')", 'approved');
    await tick(2);
    const mail = app.db.get("SELECT subject FROM emails WHERE idempotency_key = ?", `flow:${run.id}:mail`);
    if (mail?.subject !== 'Version one Pia') throw new Error('run did not keep its version: ' + JSON.stringify(mail));
    if ((await submit(form.slug, 'Quin')).status !== 201) throw new Error('response failed');
    await tick(2);
    if (app.db.get("SELECT r.version FROM flow_runs r JOIN responses p ON p.id = r.subject_id WHERE r.flow_id = ? AND p.answers LIKE '%quin@%'", flowId)?.version !== 2) throw new Error('new run not on version 2');
    await open(`/flow/runs/${run.id}`, "document.querySelector('.flow-timeline')");
    if (!(await text()).includes('1')) throw new Error('run page does not show its version');
    await api('POST', `/flow/workflows/${flowId}/status`, { status: 'draft', cancel_active: true });
  });

  await journey('run timeline, retry preview and resolving an uncertain step', async () => {
    const created = await api('POST', '/flow/workflows', { name: 'Hook then mail', definition: { trigger: { type: 'forms.response.created', source: form.id }, steps: [{ id: 'first', type: 'action', action: 'create_task', config: { title: 'Prepare for {{contact.name}}', assign_to: 'none' } }, { id: 'hook', type: 'action', action: 'webhook', config: { url: 'https://hooks.example.com/in', include: 'minimal' } }, { id: 'mail', type: 'action', action: 'send_email', config: { to: 'contact', subject: 'After hook {{contact.name}}', body: 'Done' } }] } });
    const flowId = created.body.id;
    await api('POST', `/flow/workflows/${flowId}/publish`, { revision: created.body.draft_revision });
    await api('POST', `/flow/workflows/${flowId}/status`, { status: 'enabled' });
    if ((await submit(form.slug, 'Uma')).status !== 201) throw new Error('response failed');
    dispatchOutbox(app);
    const run = app.db.get("SELECT r.* FROM flow_runs r JOIN responses p ON p.id = r.subject_id WHERE r.flow_id = ? AND p.answers LIKE '%uma@%'", flowId);
    // A worker that died during the webhook call: the task finished, the call may or may not have happened.
    app.db.run("UPDATE flow_runs SET status = 'running', lease_owner = 'dead', lease_until = ? WHERE id = ?", Date.now() - 1, run.id);
    app.db.run("INSERT INTO flow_run_steps (run_id, step_id, step_type, status, attempts, started_at, finished_at, output) VALUES (?, 'first', 'create_task', 'succeeded', 1, ?, ?, ?), (?, 'hook', 'webhook', 'running', 1, ?, NULL, NULL)", run.id, Date.now(), Date.now(), JSON.stringify({ task_id: 'synthetic' }), run.id, Date.now());
    await processFlowRuns(app, { owner: 'recovering-worker' });
    if (app.db.get('SELECT status FROM flow_runs WHERE id = ?', run.id).status !== 'failed') throw new Error('run not stopped for review');
    const callsBefore = webhookCalls.length;
    await open(`/flow/runs/${run.id}`, "document.querySelector('.flow-timeline') && document.querySelector('#run-retry')");
    const timeline = await text();
    if (!timeline.includes('Uncertain') || !timeline.includes('Done') || !/may or may not have happened/.test(timeline)) throw new Error('timeline does not explain the uncertain step: ' + timeline.slice(0, 300));
    await noTokens('the run timeline');
    await layoutCheck('Flow run timeline with an uncertain step');
    await click('#run-retry');
    await waitFor("document.querySelector('dialog[open] [name=uncertain]')", 'retry preview');
    const preview = await text('dialog[open]');
    if (!preview.includes('May already have happened') || !/Prepare for \[Contact name\]|Create a task/.test(preview)) throw new Error('retry preview incomplete: ' + preview.slice(0, 300));
    await layoutCheck('Flow retry preview');
    await evaluate("document.querySelector('dialog[open] [name=uncertain][value=resend]').click()");
    await click('dialog[open] button[value=ok]');
    await until(() => app.db.get('SELECT status FROM flow_runs WHERE id = ?', run.id).status === 'queued', 'retry queued on the server');
    await tick(2);
    const after = app.db.get('SELECT status FROM flow_runs WHERE id = ?', run.id);
    if (after.status !== 'succeeded' || webhookCalls.length !== callsBefore + 1) throw new Error('resend did not call once and finish: ' + JSON.stringify({ after, calls: webhookCalls.length - callsBefore, reason: app.db.get('SELECT reason, last_error FROM flow_runs WHERE id = ?', run.id), steps: app.db.all('SELECT step_id, status, error FROM flow_run_steps WHERE run_id = ?', run.id) }));
    if (Number(app.db.get("SELECT COUNT(*) AS n FROM tasks WHERE source_run_id = ?", `flow:${run.id}:first`).n) !== 0) throw new Error('completed task step repeated');
    await open(`/flow/runs/${run.id}`, "document.querySelector('.flow-timeline')");
    if ((await text()).includes('Uncertain')) throw new Error('timeline still shows uncertain');
    await api('POST', `/flow/workflows/${flowId}/status`, { status: 'draft' });
  });

  await journey('approve and reject on a phone and with the keyboard', async () => {
    const created = await api('POST', '/flow/workflows', { name: 'Needs a yes', definition: { trigger: { type: 'forms.response.created', source: form.id }, steps: [{ id: 'ok', type: 'approval', approver: 'admins', expires_hours: 24, title: 'Reply to {{contact.name}}' }, { id: 'done', type: 'action', action: 'create_task', config: { title: 'Approved {{contact.name}}', assign_to: 'none' } }] } });
    const flowId = created.body.id;
    await api('POST', `/flow/workflows/${flowId}/publish`, { revision: created.body.draft_revision });
    await api('POST', `/flow/workflows/${flowId}/status`, { status: 'enabled' });
    for (const name of ['Vera', 'Wes']) if ((await submit(form.slug, name)).status !== 201) throw new Error('response failed');
    await tick(2);
    await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 760, deviceScaleFactor: 2, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await open('/flow/approvals', "document.querySelectorAll('[data-decide=approve]').length === 2");
    if (!(await text()).includes('Reply to Vera') || (await text()).includes('{{')) throw new Error('approval titles not readable');
    // Phone: tap approve on Vera's request.
    await evaluate("[...document.querySelectorAll('[data-approval]')].find(card => card.innerText.includes('Vera')).querySelector('[data-decide=approve]').click()");
    await waitFor("document.querySelectorAll('[data-decide=approve]').length === 1", 'approved on a phone');
    const tapTarget = await evaluate("(() => { const r = document.querySelector('[data-decide=approve]').getBoundingClientRect(); return Math.min(r.width, r.height); })()");
    if (tapTarget < 40) throw new Error('approval button smaller than a comfortable tap target: ' + tapTarget);
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });
    // Keyboard: Tab to Reject, Enter, type a reason, Enter to confirm.
    await evaluate('document.activeElement?.blur(); document.body.focus()');
    let reached = false;
    for (let index = 0; index < 60 && !reached; index++) { await press('Tab'); reached = await evaluate("document.activeElement?.dataset?.decide === 'reject'"); }
    if (!reached) throw new Error('Reject is not reachable with Tab');
    await press('Enter');
    await waitFor("document.querySelector('dialog[open] #reject-note')", 'reject dialog');
    await evaluate("document.querySelector('#reject-note').focus()");
    await send('Input.insertText', { text: 'Already handled by phone' });
    await press('Enter');
    await waitFor("document.querySelector('#approval-list .empty')", 'rejected with the keyboard');
    await tick(2);
    const outcomes = app.db.all("SELECT a.status, a.note, r.status AS run FROM flow_approvals a JOIN flow_runs r ON r.id = a.run_id WHERE r.flow_id = ? ORDER BY a.title", flowId);
    if (JSON.stringify(outcomes.map(row => [row.status, row.run])) !== JSON.stringify([['approved', 'succeeded'], ['rejected', 'skipped']]) || outcomes[1].note !== 'Already handled by phone') throw new Error('decisions wrong: ' + JSON.stringify(outcomes));
    await open('/flow/approvals?status=all', "document.querySelector('[data-approval]')");
    await layoutCheck('Flow approvals history');
    await api('POST', `/flow/workflows/${flowId}/status`, { status: 'draft' });
  });

  await journey('entry points from Forms, Meet and Sheets', async () => {
    await open(`/forms/${form.id}`, "document.querySelector('#builder-index')");
    await click('#builder-index [data-section=settings]').catch(() => {});
    await waitFor(`document.querySelector('a[href="/flow?form=${form.id}"]')`, 'Forms automation link');
    await click(`a[href="/flow?form=${form.id}"]`);
    await waitFor("location.pathname === '/flow' && document.querySelector('[data-template]')", 'Flow from Forms');
    if (!(await text()).includes('for this form')) throw new Error('Flow does not say it was opened for this form');
    await open(`/meet/event-types/${eventType.id}`, `document.querySelector('a[href="/flow?event_type=${eventType.id}"]')`);
    await click(`a[href="/flow?event_type=${eventType.id}"]`);
    await waitFor("location.pathname === '/flow' && document.querySelector('[data-template]')", 'Flow from Meet');
    if (!(await text()).includes('for this event type')) throw new Error('Flow does not say it was opened for this event type');
    await waitFor("document.querySelector('#flow-blank')", 'blank workflow button');
    await click('#flow-blank');
    await waitFor("location.pathname.startsWith('/flow/build/')", 'blank from Meet');
    const fromMeet = definitionOf(await builderId());
    if (fromMeet.trigger.type !== 'meet.booking.created' || fromMeet.trigger.source !== eventType.id) throw new Error('Meet binding lost: ' + JSON.stringify(fromMeet.trigger));
    // Sheets: "Run Flow on this row" with no row workflows offers to open Flow for this sheet.
    const sheetId = (await api('GET', `/workbooks/${workbook.id}`)).body.sheets[0].id;
    await open(`/sheets/workbooks/${workbook.id}`, "document.querySelector('.sg-c[data-r=\"1\"][data-c=\"0\"]')");
    const openRowMenu = () => evaluate("(() => { const cell = document.querySelector('.sg-c[data-r=\"1\"][data-c=\"0\"]'); const r = cell.getBoundingClientRect(); cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5 })); })()");
    await openRowMenu();
    await waitFor("document.querySelector('[data-action=run-flow]')", 'row context menu');
    await click('[data-action=run-flow]');
    await waitFor("document.querySelector('dialog[open]')?.innerText.includes('No row workflows yet')", 'no row workflows prompt');
    await click('dialog[open] button[value=ok]');
    await waitFor(`location.pathname === '/flow' && location.search.includes('workbook=${workbook.id}')`, 'Flow from Sheets');
    await waitFor("document.querySelector('#flow-blank')", 'blank workflow button');
    await click('#flow-blank');
    await waitFor("location.pathname.startsWith('/flow/build/')", 'blank from Sheets');
    const rowFlowId = await builderId();
    const rowDefinition = definitionOf(rowFlowId);
    if (rowDefinition.trigger.type !== 'sheets.row.manual' || rowDefinition.trigger.source !== workbook.id) throw new Error('Sheets binding lost: ' + JSON.stringify(rowDefinition.trigger));
    await api('PUT', `/flow/workflows/${rowFlowId}/draft`, { revision: flowRow(rowFlowId).draft_revision, name: 'Row follow-up', definition: { trigger: { type: 'sheets.row.manual', source: workbook.id, config: { sheet: sheetId } }, steps: [{ id: 't', type: 'action', action: 'create_task', config: { title: 'Follow up {{row.name}}', assign_to: 'none' } }] } });
    await api('POST', `/flow/workflows/${rowFlowId}/publish`, { revision: flowRow(rowFlowId).draft_revision });
    const on = await api('POST', `/flow/workflows/${rowFlowId}/status`, { status: 'enabled' });
    if (on.status !== 200) throw new Error('row workflow could not be turned on: ' + JSON.stringify(on.body));
    await open(`/sheets/workbooks/${workbook.id}`, "document.querySelector('.sg-c[data-r=\"1\"][data-c=\"0\"]')");
    await openRowMenu();
    await waitFor("document.querySelector('[data-action=run-flow]')", 'row context menu');
    await click('[data-action=run-flow]');
    await waitFor("document.querySelector('dialog[open] #row-flow')", 'choose a row workflow');
    if (!(await text('dialog[open]')).includes('row 2')) throw new Error('row number not shown');
    await click('dialog[open] button[value=ok]');
    await until(() => app.db.get('SELECT 1 AS x FROM flow_runs WHERE flow_id = ?', rowFlowId), 'row run created on the server');
    await tick(2);
    const rowRun = app.db.get('SELECT status FROM flow_runs WHERE flow_id = ?', rowFlowId);
    if (rowRun?.status !== 'succeeded' || !app.db.get("SELECT 1 AS x FROM tasks WHERE title = 'Follow up Asha'")) throw new Error('row run did not use the row: ' + JSON.stringify(rowRun));
    await api('POST', `/flow/workflows/${rowFlowId}/status`, { status: 'draft' });
  });

  await journey('schedule time zone, next runs and trigger explanations', async () => {
    const created = await api('POST', '/flow/workflows', { name: 'Scheduled', definition: { trigger: { type: 'forms.response.created', source: form.id }, steps: [{ id: 't', type: 'action', action: 'create_task', config: { title: 'Review', assign_to: 'none' } }] } });
    await open(`/flow/build/${created.body.id}`, "document.querySelector('#trigger-type')");
    await choose('#trigger-type', 'schedule');
    await waitFor("document.querySelector('#trigger-timezone') && document.querySelector('#flow-next-runs')", 'schedule editor');
    await choose('#trigger-timezone', 'Asia/Kolkata');
    await choose('#trigger-every', 'week');
    await waitFor("document.querySelector('#trigger-weekday')", 'weekday');
    await waitFor("document.querySelector('#flow-next-runs').textContent.startsWith('Next runs:')", 'next runs');
    const next = await text('#flow-next-runs');
    if ((next.match(/·/g) || []).length !== 2 || !/GMT\+5:30|IST/.test(next)) throw new Error('next runs not shown in the chosen zone: ' + next);
    if (!(await text('#flow-sentence')).includes('(Asia/Kolkata)')) throw new Error('sentence does not name the zone');
    await layoutCheck('Flow schedule with time zone');
    await saveDraft();
    const trigger = definitionOf(created.body.id).trigger;
    if (trigger.config.timezone !== 'Asia/Kolkata' || trigger.config.every !== 'week') throw new Error('schedule not saved: ' + JSON.stringify(trigger));
    for (const [type, words] of [['meet.booking.ended', 'scheduled end time'], ['payments.captured', 'Only payments taken by a paid Schedora form'], ['webhook.incoming', 'Each field arrives as text']]) {
      await choose('#trigger-type', type);
      await waitFor(`document.querySelector('.flow-step--trigger').innerText.includes(${q(words)})`, `${type} explanation`);
    }
    const label = await evaluate("[...document.querySelectorAll('#trigger-type option')].find(option => option.value === 'payments.captured').textContent");
    if (!label.includes('Forms only')) throw new Error('payment trigger label hides its scope: ' + label);
    await layoutCheck('Flow webhook trigger explanation');
  });
} finally {
  await evaluate('delete document.body.dataset.dirty').catch(() => {});
  socket.close();
  browser.kill();
  await app.stop();
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* browser may still be closing */ }
}

for (const line of steps) console.log(line);
console.log(`${checks} layout checks across ${WIDTHS.join('/')} px in light and dark themes.`);
if (problems.length) { console.log(`\n${problems.length} problem(s):`); for (const problem of problems) console.log('- ' + problem); process.exit(1); }
console.log(`All ${steps.length} Flow builder journeys passed with no runtime errors or overflow.`);
