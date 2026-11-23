// End-to-end check of Schedora Sheets in a real browser (docs/SHEETS.md).
// Two isolated browser contexts are two signed-in sessions of the same workspace; a third, signed
// out, answers the published form. Keyboard input goes through the DevTools protocol, so the grid
// receives real key events.
// Usage: CHROME_PATH=<browser executable> npm run sheets-check [-- --screenshots <dir>]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';

const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
const browserPath = candidates.find(path => existsSync(path));
if (!browserPath) { console.error('No Chrome/Edge found. Set CHROME_PATH.'); process.exit(2); }
const shotsIndex = process.argv.indexOf('--screenshots');
const shotsDir = shotsIndex > 0 ? process.argv[shotsIndex + 1] : null;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });
const keepOpen = process.argv.includes('--keep-open');

const workDir = mkdtempSync(join(tmpdir(), 'schedora-sheets-'));
const app = createApp({ databasePath: join(workDir, 'test.db'), formUploadScan: async path => { if (readFileSync(path).includes(Buffer.from('test-rejected'))) throw Object.assign(new Error('test scan rejection'), { code: 1 }); }, configOverrides: { formUploadDirectory: join(workDir, 'private-files'), formUploadScanner: process.execPath, port: 0, cookieDomain: '', workerIntervalMs: 500, rateLimitPerMinute: 100000 }, log: () => {} });
await app.start();
await new Promise(resolve => app.server.close(resolve));
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
app.config.baseUrl = base;

const port = 9800 + Math.floor(Math.random() * 400);
const browser = spawn(browserPath, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(workDir, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', 'about:blank'], { stdio: 'ignore' });
let version;
for (let attempt = 0; attempt < 150 && !version; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 200));
  try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { /* starting */ }
}
if (!version) { browser.kill(); await app.stop(); throw new Error('Browser did not start: ' + browserPath); }

const socket = new WebSocket(version.webSocketDebuggerUrl);
await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
let nextId = 0;
const pending = new Map();
const problems = [];
const listeners = [];
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data);
  if (message.id && pending.has(message.id)) { const { resolve, reject } = pending.get(message.id); pending.delete(message.id); message.error ? reject(new Error(message.error.message)) : resolve(message.result); }
  for (const listener of listeners) listener(message);
});
const command = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });

async function session(label, { width = 1280, height = 860 } = {}) {
  const { browserContextId } = await command('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await command('Target.createTarget', { url: 'about:blank', browserContextId, newWindow: true });
  const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => command(method, params, sessionId);
  const workerSessions=new Map();
  listeners.push(message => {
    if (message.sessionId !== sessionId) return;
    if (message.method === 'Runtime.exceptionThrown') problems.push(`${label}: exception ${message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text}`);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') problems.push(`${label}: console.error ${message.params.args.map(arg => arg.value ?? arg.description).join(' ')}`);
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error' && !/status of 4\d\d|ERR_INTERNET_DISCONNECTED|net::ERR_/.test(message.params.entry.text)) problems.push(`${label}: ${message.params.entry.text}`);
  });
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`${label}: evaluation failed: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
    return result.result.value;
  };
  const waitFor = async (expression, what, timeout = 10000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await evaluate(`Boolean(${expression})`).catch(() => false)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`${label}: timed out waiting for ${what}`);
  };
  const open = async (path, ready) => {
    await send('Page.navigate', { url: base + path });
    await waitFor(`document.readyState === 'complete' && location.href === ${JSON.stringify(base + path)} && ${ready}${path.startsWith('/sheets/') ? " && (!document.querySelector('#sheets-app') || document.querySelector('#sheets-app').dataset.workbookReady==='true')" : ''}`, `${path} to render`);
    await evaluate("document.querySelector('.cookie-banner [data-choice=\"rejected\"]')?.click()");
  };
  const KEYS = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, F2: 113 };
  const press = async (key, modifiers = 0) => {
    const single = key.length === 1;
    const code = single ? (/[a-z]/i.test(key) ? 'Key' + key.toUpperCase() : /[0-9]/.test(key) ? 'Digit' + key : key === '=' ? 'Equal' : '') : key;
    const params = { key, code, windowsVirtualKeyCode: single ? key.toUpperCase().charCodeAt(0) : KEYS[key], modifiers };
    await send('Input.dispatchKeyEvent', { type: single && !(modifiers & 6) ? 'keyDown' : 'rawKeyDown', ...params, ...(single && !(modifiers & 6) ? { text: key } : key === 'Enter' ? { text: '\r' } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
  };
  const type = text => send('Input.insertText', { text });
  // Types a value into the active cell the way a person would: the first key opens the editor.
  const enter = async value => { await press(value[0]); if (value.length > 1) await type(value.slice(1)); await press('Enter'); };
  const shot = async name => {
    if (!shotsDir) return;
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(shotsDir, `${name}.png`), Buffer.from(data, 'base64'));
  };
  return { label, send, evaluate, waitFor, open, press, type, enter, shot, offline: async offline => {const settings={offline,latency:0,downloadThroughput:-1,uploadThroughput:-1};await send('Network.emulateNetworkConditions',settings);const {targetInfos}=await command('Target.getTargets');for(const target of targetInfos.filter(item=>item.type==='service_worker'&&item.url===base+'/sw.js')){let workerSession=workerSessions.get(target.targetId);if(!workerSession){({sessionId:workerSession}=await command('Target.attachToTarget',{targetId:target.targetId,flatten:true}));workerSessions.set(target.targetId,workerSession);await command('Network.enable',{},workerSession)}await command('Network.emulateNetworkConditions',settings,workerSession)}} };
}

const steps = [];
let checkingExpansion=false;const expandedOnly=process.argv.includes('--expanded-only');const productOnly=process.argv.includes('--product-only');let checkingProducts=false;
async function step(name, fn) {
  if((expandedOnly&&!checkingExpansion || productOnly&&!checkingProducts)&&steps.length)return;
  try { await fn(); steps.push(`✓ ${name}`); }
  catch (error) { steps.push(`✗ ${name}: ${error.message}`); problems.push(`${name}: ${error.message}`); }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const CTRL = 2;
const SHIFT = 8;

const alice = await session('session A');
const bob = await session('session B');
const respondent = await session('respondent', { width: 390, height: 844 });
let formId;
let slug;
const cellText = (r, c) => `document.getElementById('sgc-${r}-${c}')?.textContent`;
const status = "document.querySelector('#sheets-sync')?.dataset.state";

await step('sign in twice and publish a test form', async () => {
  await alice.open('/signup', "document.querySelector('#signup')");
  const signed = await alice.evaluate(`fetch('/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Asha Sheets', email: 'asha.sheets@example.com', password: 'a sufficiently long password', workspace: 'Sheets Check' }) }).then(r => r.status)`);
  if (signed !== 201) throw new Error('sign-up failed: ' + signed);
  await bob.open('/login', "document.querySelector('main')");
  const logged = await bob.evaluate(`fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'asha.sheets@example.com', password: 'a sufficiently long password' }) }).then(r => r.status)`);
  if (logged !== 200) throw new Error('second sign-in failed: ' + logged);
  const created = await alice.evaluate(`(async () => {
    const me = await (await fetch('/api/me')).json();
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token };
    const base = '/api/workspaces/' + me.workspaces[0].id + '/forms';
    const definition = { title: 'Workshop feedback', presentation: 'classic', fields: [
      { id: 'name', type: 'short_text', label: 'Your name', required: true },
      { id: 'score', type: 'short_text', label: 'Score out of 10', required: true },
      { id: 'track', type: 'single_choice', label: 'Track', required: true, options: [{ id: 'design', label: 'Design' }, { id: 'build', label: 'Build' }] }
    ] };
    const form = await (await fetch(base, { method: 'POST', headers, body: JSON.stringify({ definition }) })).json();
    const published = await fetch(base + '/' + form.id + '/publish', { method: 'POST', headers, body: '{}' });
    return { id: form.id, slug: form.slug, published: published.status };
  })()`);
  if (created.published !== 200) throw new Error('publish failed: ' + created.published);
  formId = created.id;
  slug = created.slug;
});

async function submitThroughForm(name, score, track) {
  await respondent.open(`/f/${slug}`, "document.querySelector('#form-root form #q-name')");
  await respondent.evaluate(`(() => { const set = (selector, value) => { const el = document.querySelector(selector); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }; set('#q-name', ${JSON.stringify(name)}); set('#q-score', ${JSON.stringify(score)}); const option = document.querySelector('[name=track][value=${track}]'); option.checked = true; option.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await respondent.evaluate("document.querySelector('#form-root [type=submit]').click()");
  await respondent.waitFor("document.body.innerText.includes('Response received')", 'receipt');
}

await step('responses submitted through the published form appear in the linked tab, oldest first', async () => {
  await submitThroughForm('Meera', '8', 'design');
  await submitThroughForm('=HYPERLINK("http://evil.example")', '=99', 'build');
  await alice.open(`/sheets/${formId}`, "document.querySelector('#sgc-1-0')");
  await alice.waitFor(`${cellText(1, 6)} === 'Meera' && ${cellText(2, 6)} === '=HYPERLINK("http://evil.example")'`, 'responses in rows 2 and 3');
  if (await alice.evaluate(cellText(0, 0)) !== 'Submitted at (UTC)') throw new Error('header row missing');
  if (await alice.evaluate(cellText(2, 7)) !== '=99') throw new Error('a submitted "=99" must stay literal text');
  if (!await alice.evaluate("document.querySelector('#sheets-grid').getAttribute('aria-label').includes('read-only')")) throw new Error('linked grid not labelled read-only');
  await alice.evaluate("document.querySelector('#sheets-grid').focus()");
  await alice.press('x');
  await alice.waitFor("document.body.innerText.includes('Choose Edit a copy')", 'edit-copy guidance when typing in the linked tab');
  await alice.shot('01-linked-responses');
});

await step('keyboard: arrows, shift-selection, select-all and the status totals', async () => {
  await alice.evaluate("document.querySelector('#sheets-grid').focus()");
  await alice.press('ArrowRight'); await alice.press('ArrowRight');
  if (await alice.evaluate("document.querySelector('#sheets-namebox').value") !== 'C2') throw new Error('arrow keys did not move to C2');
  await alice.press('ArrowDown', SHIFT);
  if (await alice.evaluate("document.querySelector('#sheets-namebox').value") !== 'C2:C3') throw new Error('shift+arrow did not extend the selection');
  if (!/Count: 2|Sum/.test(await alice.evaluate("document.querySelector('#sheets-stats').textContent"))) throw new Error('selection totals missing');
  await alice.press('Home', CTRL);
  if (await alice.evaluate("document.querySelector('#sheets-namebox').value") !== 'A1') throw new Error('Ctrl+Home did not go to A1');
});

await step('add an analysis sheet with formulas over Form Responses', async () => {
  await alice.evaluate("document.querySelector('[data-action=new-sheet]').click()");
  await alice.waitFor("document.querySelector('[role=tab][aria-selected=true]')?.textContent.trim() === 'Sheet1'", 'new sheet tab');
  await alice.evaluate("document.querySelector('#sheets-grid').focus()");
  await alice.enter("=COUNTA('Form Responses'!G2:G)");
  await alice.enter("=SUM('Form Responses'!H:H)");
  await alice.enter("='Form Responses'!G3");
  await alice.enter('=A2*2');
  await alice.waitFor(`${cellText(0, 0)} === '2' && ${cellText(1, 0)} === '8' && ${cellText(2, 0)} === '=HYPERLINK("http://evil.example")' && ${cellText(3, 0)} === '16'`, 'formula results 2, 8, literal text, 16');
  await alice.waitFor(`${status} === 'saved'`, 'saved status');
  await alice.shot('02-analysis-sheet');
});


await step('cell editing starts at the selected cell width and grows with the text', async () => {
  const go = address => alice.evaluate(`document.querySelector('#sheets-namebox').value = ${JSON.stringify(address)}; document.querySelector('#sheets-namebox').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await go('B20');
  await alice.press('d');
  const short = await alice.evaluate(`(() => {
    const cell = document.querySelector('#sgc-19-1').getBoundingClientRect();
    const editor = document.querySelector('#sg-editor').getBoundingClientRect();
    return { cell: cell.width, width: editor.width, left: Math.abs(cell.left - editor.left), height: editor.height, row: cell.height };
  })()`);
  if (Math.abs(short.cell - short.width) > 2 || short.left > 2 || Math.abs(short.height - short.row) > 4) throw new Error('Short text editor must match its cell: ' + JSON.stringify(short));
  await alice.shot('cell-editor-short-text');
  await alice.type(' a longer description '.repeat(12));
  const expanded = await alice.evaluate(`(() => {
    const editor = document.querySelector('#sg-editor').getBoundingClientRect();
    const wrap = document.querySelector('#sheets-grid-wrap').getBoundingClientRect();
    return { width: editor.width, right: editor.right, limit: wrap.right, scroll: document.documentElement.scrollWidth, viewport: innerWidth };
  })()`);
  if (expanded.width <= short.width || expanded.right > expanded.limit + 1 || expanded.scroll > expanded.viewport) throw new Error('Long text editor must grow within the grid.');
  await alice.press('Escape');
  if (await alice.evaluate(`${cellText(19, 1)} !== ''`)) throw new Error('Escape must discard the edit.');
  await go('A1');
});

await step('session B sees the new sheet and values without reloading', async () => {
  await bob.open(`/sheets/${formId}`, "document.querySelector('[role=tab]')");
  await bob.waitFor("[...document.querySelectorAll('[role=tab]')].some(tab => tab.textContent.trim() === 'Sheet1')", 'Sheet1 tab in session B');
  await bob.evaluate("[...document.querySelectorAll('[role=tab]')].find(tab => tab.textContent.trim() === 'Sheet1').click()");
  await bob.waitFor(`${cellText(1, 0)} === '8'`, 'formula value in session B');
});

await step('concurrent edits to different cells both land', async () => {
  await alice.evaluate("document.querySelector('#sheets-namebox').value = 'C1'; document.querySelector('#sheets-namebox').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
  await bob.evaluate("document.querySelector('#sheets-namebox').value = 'D1'; document.querySelector('#sheets-namebox').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
  await Promise.all([alice.enter('from A'), bob.enter('from B')]);
  await alice.waitFor(`${cellText(0, 2)} === 'from A' && ${cellText(0, 3)} === 'from B'`, 'both edits in session A');
  await bob.waitFor(`${cellText(0, 2)} === 'from A' && ${cellText(0, 3)} === 'from B'`, 'both edits in session B');
});

await step('presence: each session sees the other\'s cursor', async () => {
  await alice.waitFor("document.querySelectorAll('#sheets-presence .sheets-avatar').length === 1", 'one avatar for the other session');
  await alice.waitFor("document.querySelector('.sg-c.viewer')", 'the other session\'s cell outlined');
});

await step('multiline and long cells remain editable after reopening, including the formula bar', async () => {
  const go = address => alice.evaluate(`document.querySelector('#sheets-namebox').value = ${JSON.stringify(address)}; document.querySelector('#sheets-namebox').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  const original = 'First line\nSecond line with a long explanation '.repeat(8).trim();
  await go('B20');
  await alice.press('F2');
  await alice.type(original);
  await alice.press('Enter');
  await alice.waitFor(`${status} === 'saved'`, 'multiline cell saved');
  await alice.open(`/sheets/${formId}`, "document.querySelector('[role=tab]')");
  await alice.evaluate("[...document.querySelectorAll('[role=tab]')].find(tab => tab.textContent.trim() === 'Sheet1').click()");
  await go('B20');
  if (await alice.evaluate("document.querySelector('#sheets-formula-input').value") !== original) throw new Error('Reopening a multiline cell must preserve every line in the formula bar.');
  await alice.evaluate("document.querySelector('#sheets-formula-input').focus()");
  await alice.press('Home', CTRL);
  await alice.type('Updated: ');
  await alice.press('Enter');
  if (await alice.evaluate("document.querySelector('#sheets-formula-input').value") !== '') throw new Error('After a formula-bar save, the next blank cell must have a blank formula bar.');
  await go('B20');
  await alice.press('F2');
  if (await alice.evaluate("document.querySelector('#sg-editor').value") !== 'Updated: ' + original) throw new Error('Editing the formula bar lost line breaks.');
  await alice.press('Home', CTRL);
  await alice.type('Cell: ');
  await alice.evaluate("document.querySelector('#sheets-formula-input').focus()");
  await alice.type('bar ');
  await alice.press('Enter');
  await go('B20');
  await alice.press('F2');
  const value = await alice.evaluate("document.querySelector('#sg-editor').value");
  if (!value.includes(original) || !value.startsWith('Cell: bar Updated: ')) throw new Error('Switching editors must preserve the draft and caret: ' + JSON.stringify(value));
  await alice.press('End', CTRL);
  await alice.press('Enter', 1);
  await alice.type('Last line');
  await alice.press('Enter');
  await go('B20');
  await alice.press('F2');
  if (!await alice.evaluate("document.querySelector('#sg-editor').value.endsWith('\\nLast line')")) throw new Error('Alt+Enter line break did not survive reopening.');
  await alice.shot('multiline-cell-reopened');
  await alice.press('Escape');
  await go('B20');
  await alice.press('Delete');
  await go('A1');
});

await step('double-click opens the full cell editor and Ctrl+Enter inserts lines in both editors', async () => {
  const go = address => alice.evaluate(`document.querySelector('#sheets-namebox').value = ${JSON.stringify(address)}; document.querySelector('#sheets-namebox').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await go('B20');
  await alice.enter('A long first line '.repeat(12).trim());
  await go('A20');
  const point = await alice.evaluate("(() => { const r = document.querySelector('#sgc-19-1').getBoundingClientRect(); return {x:r.left+20,y:r.top+r.height/2}; })()");
  for (const clickCount of [1, 2]) {
    await alice.send('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount,...point});
    await alice.send('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount,...point});
  }
  await alice.waitFor("!document.querySelector('#sg-editor').hidden && document.activeElement === document.querySelector('#sg-editor')", 'double-click cell editing');
  await alice.press('End', CTRL);
  await alice.press('Enter', CTRL);
  await alice.type('Second line');
  if (await alice.evaluate("document.querySelector('#sg-editor').hidden || !document.querySelector('#sg-editor').value.endsWith('\\nSecond line')")) throw new Error('Ctrl+Enter must insert a line and keep editing.');
  await alice.press('Enter');
  await go('B20');
  await alice.evaluate("document.querySelector('#sheets-formula-input').focus()");
  await alice.press('End', CTRL);
  await alice.press('Enter', CTRL);
  await alice.type('Third line');
  await alice.press('Enter');
  await go('B20');
  await alice.press('F2');
  if (!await alice.evaluate("document.querySelector('#sg-editor').value.endsWith('\\nSecond line\\nThird line')")) throw new Error('Both Ctrl+Enter line breaks must survive saving and reopening.');
  await alice.shot('double-click-ctrl-enter');
  await alice.press('Escape');
  await alice.press('Delete');
  await go('A1');
});

// Journeys after this one edit Sheet1; each resize journey returns there even when it fails.
const backToSheet1 = async () => { try { await alice.evaluate("[...document.querySelectorAll('[role=tab]')].find(tab=>tab.textContent.trim()==='Sheet1')?.click(); document.querySelector('#sheets-namebox').value = 'A1'; document.querySelector('#sheets-namebox').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))"); } catch { /* the next journey reports its own state */ } };
await step('row and column edges show resize cursors, drag, undo, cancel and retain sizes after reload', async () => { try {
  const go = address => alice.evaluate(`document.querySelector('#sheets-namebox').value = ${JSON.stringify(address)}; document.querySelector('#sheets-namebox').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  const point = selector => alice.evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)});const r=el.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;return {x,y,cursor:getComputedStyle(document.elementFromPoint(x,y)).cursor};})()`);
  const size = () => alice.evaluate("({width:document.querySelector('[data-col-header=\"1\"]').getBoundingClientRect().width,height:document.querySelector('[data-row-header=\"19\"]').getBoundingClientRect().height})");
  const dragAxis = async (selector, dx, dy, cursor, cancel=false) => {
    const p=await point(selector);
    if(p.cursor!==cursor)throw new Error('Missing resize cursor: '+JSON.stringify(p));
    const start={x:p.x,y:p.y},end={x:p.x+dx,y:p.y+dy};
    await alice.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...start});
    await alice.send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'none',buttons:1,...end});
    if(cancel)await alice.press('Escape');
    await alice.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...end});
  };
  await go('B20');
  const original=await size();
  await dragAxis('[data-resize-row="19"]',0,35,'row-resize');
  await alice.waitFor(`Math.abs(document.querySelector('[data-row-header="19"]').getBoundingClientRect().height-${original.height+35})<2`, 'dragged row height');
  await dragAxis('[data-resize="1"]',56,0,'col-resize');
  await alice.waitFor(`Math.abs(document.querySelector('[data-col-header="1"]').getBoundingClientRect().width-${original.width+56})<2`, 'dragged column width');
  await alice.press('z',CTRL);await alice.press('z',CTRL);
  await alice.waitFor(`Math.abs(document.querySelector('[data-row-header="19"]').getBoundingClientRect().height-${original.height})<2 && Math.abs(document.querySelector('[data-col-header="1"]').getBoundingClientRect().width-${original.width})<2`, 'both sizes undone');
  await alice.press('y',CTRL);await alice.press('y',CTRL);
  await alice.waitFor(`${status} === 'saved'`, 'resized axes saved');
  await dragAxis('[data-resize-row="19"]',0,20,'row-resize',true);
  await alice.waitFor(`Math.abs(document.querySelector('[data-row-header="19"]').getBoundingClientRect().height-${original.height+35})<2`, 'canceled resize retains saved size');
  await alice.open(`/sheets/${formId}`, "document.querySelector('[role=tab]')");
  await alice.evaluate("[...document.querySelectorAll('[role=tab]')].find(tab=>tab.textContent.trim()==='Sheet1').click()");
  await go('B20');
  const reloaded=await size();
  if(Math.abs(reloaded.height-original.height-35)>2||Math.abs(reloaded.width-original.width-56)>2)throw new Error('Resized dimensions did not persist: '+JSON.stringify(reloaded));
  await alice.shot('drag-row-height-column-width');
  await alice.evaluate("document.querySelector('[data-tab=responses]').click()");
  // Resize only once the linked tab has rendered; otherwise the drag can land on the previous sheet.
  await alice.waitFor("document.querySelector('#sheets-grid')?.getAttribute('aria-label')?.includes('read-only') && document.querySelector('[data-resize-row=\"0\"]')", 'linked response tab before resizing');
  const linkedHeight=await alice.evaluate("document.querySelector('[data-row-header=\"0\"]').getBoundingClientRect().height");
  await dragAxis('[data-resize-row="0"]',0,20,'row-resize');
  await alice.open(`/sheets/${formId}`, "document.querySelector('[role=tab]')");
  await alice.evaluate("document.querySelector('[data-tab=responses]').click()");
  // The linked tab renders after its rows load; wait for it rather than reading it mid-render.
  try { await alice.waitFor(`Math.abs(document.querySelector('[data-row-header="0"]')?.getBoundingClientRect().height-${linkedHeight+20})<2 && document.querySelector('#sheets-grid')?.getAttribute('aria-label')?.includes('read-only')`, 'linked row height view preference'); }
  catch { throw new Error('Linked response row resize must persist as a view preference without enabling editing. Saw ' + JSON.stringify(await alice.evaluate(`({expected:${linkedHeight+20},height:document.querySelector('[data-row-header="0"]')?.getBoundingClientRect().height,label:document.querySelector('#sheets-grid')?.getAttribute('aria-label'),tab:document.querySelector('[role=tab][aria-selected=true]')?.textContent.trim(),prefs:Object.keys(localStorage).filter(k=>/sheet|view/i.test(k))})`))); }
  await alice.evaluate("[...document.querySelectorAll('[role=tab]')].find(tab=>tab.textContent.trim()==='Sheet1').click()");
  await go('A1');
} finally { await backToSheet1(); } });

// Regression for the intermittent failure above: Chrome sometimes dropped pointer capture right after the
// press (lostpointercapture with the button still held), and the editor treated that as a cancel. Here the
// capture is taken away on purpose mid-drag, and one release happens outside the grid entirely.
await step('a resize survives losing pointer capture mid-drag and a release outside the grid', async () => { try {
  const handle = selector => alice.evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  const mouse = (type, at, buttons) => alice.send('Input.dispatchMouseEvent', { type, button: 'left', buttons, clickCount: 1, ...at });
  const dropCapture = () => alice.evaluate("(() => {const grid=document.querySelector('#sheets-grid');const had=grid.hasPointerCapture(1);grid.releasePointerCapture(1);return had && !grid.hasPointerCapture(1);})()");
  // Linked tab: row height is a view preference and survives a reload.
  await alice.evaluate("document.querySelector('[data-tab=responses]').click()");
  await alice.waitFor("document.querySelector('#sheets-grid')?.getAttribute('aria-label')?.includes('read-only') && document.querySelector('[data-resize-row=\"1\"]')", 'linked response tab');
  const rowHeight = () => alice.evaluate("document.querySelector('[data-row-header=\"1\"]').getBoundingClientRect().height");
  const before = await rowHeight();
  const start = await handle('[data-resize-row="1"]');
  await mouse('mousePressed', start, 1);
  if (!await dropCapture()) throw new Error('The test could not take pointer capture away from the grid.');
  await mouse('mouseMoved', { x: start.x, y: start.y + 30 }, 1);
  await mouse('mouseReleased', { x: start.x, y: start.y + 30 }, 0);
  await alice.waitFor(`Math.abs(document.querySelector('[data-row-header="1"]').getBoundingClientRect().height-${before + 30})<2`, 'linked row resized after losing capture');
  await alice.open(`/sheets/${formId}`, "document.querySelector('[role=tab]')");
  await alice.evaluate("document.querySelector('[data-tab=responses]').click()");
  await alice.waitFor(`Math.abs(document.querySelector('[data-row-header="1"]')?.getBoundingClientRect().height-${before + 30})<2 && document.querySelector('#sheets-grid').getAttribute('aria-label').includes('read-only')`, 'linked row height kept as a view preference after reload');
  // Editable sheet: losing capture, then releasing far outside the grid, still saves one width change.
  await alice.evaluate("[...document.querySelectorAll('[role=tab]')].find(tab=>tab.textContent.trim()==='Sheet1').click()");
  await alice.waitFor("!document.querySelector('#sheets-grid').getAttribute('aria-label').includes('read-only') && document.querySelector('[data-resize=\"3\"]')", 'Sheet1');
  const width = () => alice.evaluate("document.querySelector('[data-col-header=\"3\"]').getBoundingClientRect().width");
  const wide = await width();
  const edge = await handle('[data-resize="3"]');
  await mouse('mousePressed', edge, 1);
  if (!await dropCapture()) throw new Error('The test could not take pointer capture away from the grid.');
  const outside = await alice.evaluate("(() => {const r=document.querySelector('#sheets-toolbar').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()");
  if (await alice.evaluate(`document.querySelector('#sheets-grid').contains(document.elementFromPoint(${outside.x},${outside.y}))`)) throw new Error('Release point is not outside the grid.');
  const target = { x: edge.x + 40, y: outside.y };
  await mouse('mouseMoved', target, 1);
  await mouse('mouseReleased', target, 0);
  await alice.waitFor(`Math.abs(document.querySelector('[data-col-header="3"]').getBoundingClientRect().width-${wide + 40})<2 && ${status} === 'saved'`, 'column width saved after release outside the grid');
  // The drag is over: later pointer events do not keep resizing.
  await mouse('mouseMoved', { x: target.x + 80, y: target.y }, 0);
  await alice.press('z', CTRL);
  await alice.waitFor(`Math.abs(document.querySelector('[data-col-header="3"]').getBoundingClientRect().width-${wide})<2`, 'one undo restores the width');
  await alice.waitFor(`${status} === 'saved'`, 'undo saved');
} finally { await backToSheet1(); } });

await step('the same cell: first save wins, the second edit is kept for review and can be restored', async () => {
  // Session B goes offline, edits E1; session A edits E1 and saves; B comes back and conflicts.
  await bob.offline(true);
  await bob.evaluate("document.querySelector('#sheets-namebox').value = 'E1'; document.querySelector('#sheets-namebox').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
  await bob.enter('B wins?');
  await bob.waitFor(`${status} === 'offline'`, 'offline status in session B');
  await bob.shot('03-offline');
  await alice.evaluate("document.querySelector('#sheets-namebox').value = 'E1'; document.querySelector('#sheets-namebox').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
  await alice.enter('A saved first');
  await alice.waitFor(`${status} === 'saved'`, 'A saved');
  await bob.offline(false);
  await bob.evaluate("window.dispatchEvent(new Event('online'))");
  await bob.waitFor("!document.querySelector('#sheets-conflicts').hidden && document.querySelector('#sheets-conflicts').innerText.includes('B wins?')", 'conflict panel with both values');
  if (await bob.evaluate(cellText(0, 4)) !== 'A saved first') throw new Error('the saved value should show until a choice is made');
  await bob.shot('04-conflict');
  await bob.evaluate("document.querySelector('[data-resolve][data-choice=mine]').click()");
  await alice.waitFor(`${cellText(0, 4)} === 'B wins?'`, 'restored edit reaches session A');
  await bob.waitFor(`${status} === 'saved'`, 'B saved after resolving');
});

await step('unsynced edits survive a reload while offline', async () => {
  await bob.offline(true);
  await bob.evaluate("document.querySelector('#sheets-namebox').value = 'F1'; document.querySelector('#sheets-namebox').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
  await bob.enter('kept across reload');
  await bob.waitFor(`${status} === 'offline'`, 'offline');
  await bob.offline(false);
  // Reload before the retry timer fires: the queued edit is in browser storage and is sent on load.
  await bob.send('Page.reload', { ignoreCache: true });
  await bob.waitFor("document.querySelector('#sheets-sync')?.dataset.state === 'saved'", 'saved after reload');
  await alice.waitFor(`${cellText(0, 5)} === 'kept across reload'`, 'edit from before the reload reaches session A');
});

await step('a new response recalculates dependent formulas; sorting the linked view does not move references', async () => {
  await submitThroughForm('Ravi', '30', 'build');
  await alice.waitFor(`${cellText(0, 0)} === '3' && ${cellText(1, 0)} === '38'`, 'COUNTA 3 and SUM 38 after the new response');
  await alice.evaluate("document.querySelector('[data-tab=responses]').click()");
  await alice.waitFor(`${cellText(3, 6)} === 'Ravi'`, 'Ravi in row 4');
  await alice.evaluate("document.querySelector('#sheets-namebox').value = 'G2'; document.querySelector('#sheets-namebox').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
  await alice.evaluate("document.querySelector('[data-menu=data]').click()");
  await alice.evaluate("document.querySelector('[data-action=view-sort-desc]').click()");
  await alice.waitFor("[...document.querySelectorAll('#sg-body .sg-row')][0]?.querySelector('.sg-rh')?.textContent !== '2'", 'sorted view');
  const firstRow = await alice.evaluate("[...document.querySelectorAll('#sg-body .sg-row')].slice(0, 3).map(row => row.querySelector('.sg-rh').textContent + ':' + row.children[7].textContent)");
  if (!firstRow.includes('4:Ravi')) throw new Error('row headers must keep real row numbers in a sorted view: ' + firstRow.join(', '));
  await alice.shot('05-sorted-linked-view');
  await alice.evaluate("[...document.querySelectorAll('[role=tab]')].find(tab => tab.textContent.trim() === 'Sheet1').click()");
  await alice.waitFor(`${cellText(2, 0)} === '=HYPERLINK("http://evil.example")'`, 'reference to row 3 unchanged by the sorted view');
  // Searching on the Responses page does not change the grid either.
  const grid = await alice.evaluate(`fetch('/api/workspaces/' + (JSON.parse(localStorage.getItem('schedora.workspace') || 'null') || '') + '/forms/${formId}/workbook/responses?q=Ravi').then(r => r.status)`);
  if (![200, 404].includes(grid)) throw new Error('grid request failed: ' + grid);
});

await step('formatting, fill down, undo and redo with the keyboard', async () => {
  await alice.evaluate("document.querySelector('#sheets-namebox').value = 'B1'; document.querySelector('#sheets-namebox').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
  await alice.enter('10');
  await alice.enter('20');
  await alice.enter('=B1+B2');
  await alice.press('ArrowUp');
  await alice.press('ArrowDown', SHIFT);
  await alice.press('d', CTRL);
  await alice.waitFor(`${cellText(3, 1)} === '50'`, 'fill down shifts the relative references (=B2+B3 → 50)');
  await alice.press('b', CTRL);
  await alice.waitFor("document.getElementById('sgc-2-1')?.classList.contains('fb')", 'bold applied');
  await alice.press('z', CTRL);
  await alice.waitFor("!document.getElementById('sgc-2-1')?.classList.contains('fb')", 'undo removes bold');
  await alice.press('y', CTRL);
  await alice.waitFor("document.getElementById('sgc-2-1')?.classList.contains('fb')", 'redo restores bold');
  await alice.evaluate("document.querySelector('[data-action=num-currency]').click()");
  await alice.waitFor(`${cellText(2, 1)}?.includes('₹')`, 'currency format');
});

await step('insert a row above: formulas that point below it follow the data', async () => {
  await alice.evaluate("document.querySelector('#sheets-namebox').value = 'A1'; document.querySelector('#sheets-namebox').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
  await alice.evaluate("document.querySelector('[data-menu=insert]').click()");
  await alice.evaluate("document.querySelector('[data-action=row-above]').click()");
  await alice.waitFor(`${cellText(1, 0)} === '3' && ${cellText(4, 0)} === '76'`, 'rows moved down and =A2*2 became =A3*2');
  const formula = await alice.evaluate("document.querySelector('#sheets-namebox').value = 'A5', document.querySelector('#sheets-namebox').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })), document.querySelector('#sheets-formula-input').value");
  if (formula !== '=A3*2') throw new Error('formula not adjusted: ' + formula);
});

await step('filter view hides rows but keeps row numbers, and export downloads', async () => {
  await alice.evaluate("document.querySelector('[data-tab=responses]').click()");
  await alice.evaluate("document.querySelector('[data-menu=data]').click()");
  await alice.evaluate("document.querySelector('[data-action=clear-view]').click()");
  await alice.evaluate("document.querySelector('[data-action=filter]').click()");
  await alice.waitFor("document.querySelector('[data-filter-col=\"8\"]')", 'filter buttons');
  await alice.evaluate("document.querySelector('[data-filter-col=\"8\"]').click()");
  await alice.waitFor("document.querySelector('[data-filter-value=\"Design\"]')", 'filter values');
  await alice.evaluate("document.querySelector('[data-filter-value=\"Design\"]').checked = false; document.querySelector('[data-action=filter-apply]').click()");
  await alice.waitFor("[...document.querySelectorAll('#sg-body .sg-row .sg-rh')].slice(0, 2).map(cell => cell.textContent).join(',') === '3,4'", 'rows 3 and 4 shown with their real numbers');
  await alice.shot('06-filtered');
  const csv = await alice.evaluate("(async () => { let captured; const original = URL.createObjectURL; URL.createObjectURL = blob => { captured = blob; return original.call(URL, blob); }; document.querySelector('[data-menu=file]').click(); document.querySelector('[data-action=download-csv]').click(); URL.createObjectURL = original; return captured ? await captured.text() : null; })()");
  if (!csv || !csv.includes("\"'=HYPERLINK") || !csv.includes('Meera')) throw new Error('CSV export missing data or formula protection');
  const xlsx = await alice.evaluate("(async () => { let captured; const original = URL.createObjectURL; URL.createObjectURL = blob => { captured = blob; return original.call(URL, blob); }; document.querySelector('[data-menu=file]').click(); document.querySelector('[data-action=download-xlsx]').click(); URL.createObjectURL = original; return captured ? captured.size : 0; })()");
  if (!(xlsx > 1000)) throw new Error('XLSX export empty');
});

await step('phone layout has no horizontal page overflow; light and dark', async () => {
  for (const theme of ['light', 'dark']) {
    await alice.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
    for (const width of [375, 768, 1280]) {
      await alice.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 768 });
      await pause(150);
      const overflow = await alice.evaluate('document.documentElement.scrollWidth - innerWidth');
      if (overflow > 0) throw new Error(`horizontal overflow of ${overflow}px at ${width}px (${theme})`);
      if (width !== 768) await alice.shot(`07-${width}-${theme}`);
    }
  }
  await alice.send('Emulation.setEmulatedMedia', { features: [] });
  await alice.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
});

await step('an editable response copy keeps submitted text literal and saves edits and formatting', async () => {
  await alice.evaluate("document.querySelector('[data-tab=responses]').click(); document.querySelector('[data-action=edit-response-copy]').click()");
  await alice.waitFor("document.querySelector('dialog[open] button[value=ok]')", 'copy dialog');
  await alice.evaluate("document.querySelector('dialog[open] button[value=ok]').click()");
  await alice.waitFor("document.querySelector('[role=tab][aria-selected=true]')?.textContent.includes('Responses copy')", 'editable copy');
  if (!await alice.evaluate(`${cellText(2, 6)} === '=HYPERLINK("http://evil.example")' && ${cellText(2, 7)} === '=99'`)) throw new Error('formula-like answers changed on copy');
  await alice.evaluate("document.querySelector('#sheets-namebox').value = 'G2'; document.querySelector('#sheets-namebox').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
  await alice.press('F2');
  await alice.evaluate("document.querySelector('#sg-editor').value = 'Reviewed'");
  await alice.press('Enter');
  await alice.evaluate("document.querySelector('#sheets-namebox').value = 'G2'; document.querySelector('#sheets-namebox').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
  await alice.evaluate("document.querySelector('[data-menu=cell-style]').click(); document.querySelector('[data-action=border-all]').click(); document.querySelector('[data-menu=cell-style]').click(); document.querySelector('[data-action=font-monospace]').click(); document.querySelector('[data-menu=cell-style]').click(); document.querySelector('[data-action=cell-note]').click()");
  await alice.waitFor("document.querySelector('#sheets-cell-note')", 'note editor');
  await alice.evaluate("document.querySelector('#sheets-cell-note').value = 'Verified'; document.querySelector('dialog[open] button[value=ok]').click()");
  await alice.waitFor("document.querySelector('#sgc-1-6')?.title === 'Verified' && document.querySelector('#sheets-sync')?.dataset.state === 'saved'", 'note and copy saved');
  await alice.open(`/sheets/${formId}`, "document.querySelector('#sgc-1-6')?.title === 'Verified'");
  if (!await alice.evaluate(`${cellText(1, 6)} === 'Reviewed' && document.querySelector('#sgc-1-6').dataset.border === 'trbl' && document.querySelector('#sgc-1-6').dataset.font === 'monospace'`)) throw new Error('copy edit or formatting lost on reload');
  await alice.evaluate("document.querySelector('[data-tab=responses]').click(); document.querySelector('[data-menu=data]').click(); document.querySelector('[data-action=clear-view]').click()");
  if (await alice.evaluate(cellText(1, 6)) !== 'Meera') throw new Error('editing the copy changed the linked response');
});

await step('drag fill, formula point entry and horizontal canvas scrolling work in one sheet', async () => {
  const go = address => alice.evaluate(`document.querySelector('#sheets-namebox').value = ${JSON.stringify(address)}; document.querySelector('#sheets-namebox').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  const point = selector => alice.evaluate(`(() => { const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`);
  const mouse = (type, location, buttons, modifiers = 0) => alice.send('Input.dispatchMouseEvent', { type, ...location, button: type === 'mouseMoved' ? 'none' : 'left', buttons, modifiers, clickCount: type === 'mouseMoved' ? 0 : 1 });
  await alice.evaluate("document.querySelector('.sheets-tab-tool[data-action=new-sheet]').click()");
  await go('A1'); await alice.enter('1'); await alice.enter('3');
  await go('A1:A2');
  await alice.waitFor("!document.querySelector('#sg-fill-handle').hidden", 'visible fill handle');
  const handle = await point('#sg-fill-handle');
  const end = await point('#sgc-3-0');
  const dragSetup = await alice.evaluate(`({ values: [${cellText(0, 0)}, ${cellText(1, 0)}], handle: document.elementFromPoint(${handle.x}, ${handle.y})?.id, target: document.elementFromPoint(${end.x}, ${end.y})?.id })`);
  if (dragSetup.values.join(',') !== '1,3' || dragSetup.handle !== 'sg-fill-handle' || dragSetup.target !== 'sgc-3-0') throw new Error('Unexpected drag setup ' + JSON.stringify(dragSetup));
  await mouse('mousePressed', handle, 1);
  await mouse('mouseMoved', end, 1);
  await mouse('mouseReleased', end, 0);
  try { await alice.waitFor(`${cellText(2, 0)} === '5' && ${cellText(3, 0)} === '7'`, 'series filled via the canvas grid', 2500); }
  catch (error) { throw new Error(`${error.message}. Observed cells: ${JSON.stringify(await alice.evaluate(`[${cellText(2,0)}, ${cellText(3,0)}, document.querySelector('#sheets-namebox').value, document.querySelector('#sheets-sync').textContent]`))}`); }
  await alice.press('z', CTRL);
  await alice.waitFor(`${cellText(2, 0)} === '' && ${cellText(3, 0)} === ''`, 'fill reverted in one step');
  await alice.press('y', CTRL);
  await alice.waitFor(`${cellText(3, 0)} === '7'`, 'redo restored fill');
  await go('B1'); await alice.press('=');
  const reference = await point('#sgc-0-0');
  await mouse('mousePressed', reference, 1);
  await mouse('mouseReleased', reference, 0);
  await alice.waitFor("document.querySelector('#sg-editor').value === '=A1'", 'pointed formula reference');
  await alice.press('Enter');
  await alice.waitFor(`${cellText(0, 1)} === '1'`, 'pointed formula evaluates');
  await go('D1:D3'); await alice.press('='); await alice.type('A1'); await alice.press('Enter', CTRL | SHIFT);
  await alice.waitFor(`${cellText(0, 3)} === '1' && ${cellText(1, 3)} === '3' && ${cellText(2, 3)} === '5'`, 'keyboard fill shifts formula references');
  await go('A1');
  const cut = await alice.evaluate("(() => { const clipboardData = new DataTransfer(); document.querySelector('#sheets-grid').dispatchEvent(new ClipboardEvent('cut', { clipboardData, bubbles: true, cancelable: true })); return clipboardData.getData('text/plain'); })()");
  await go('C1');
  await alice.evaluate(`(() => { const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', ${JSON.stringify(cut)}); document.querySelector('#sheets-grid').dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })); })()`);
  await alice.waitFor(`${cellText(0, 0)} === '' && ${cellText(0, 2)} === '1'`, 'cut range moved');
  await go('B1');
  if (await alice.evaluate("document.querySelector('#sheets-formula-input').value") !== '=C1') throw new Error('incoming reference did not follow the cut');
  await alice.press('z', CTRL);
  await alice.waitFor(`${cellText(0, 0)} === '1' && ${cellText(0, 2)} === '' && document.querySelector('#sheets-formula-input').value === '=A1'`, 'cut and reference reverted together');
  await go('A1');
  const additional = await point('#sgc-0-3');
  await mouse('mousePressed', additional, 1, CTRL);
  await mouse('mouseReleased', additional, 0, CTRL);
  await alice.waitFor("document.getElementById('sgc-0-0').getAttribute('aria-selected') === 'true' && document.getElementById('sgc-0-3').getAttribute('aria-selected') === 'true'", 'disjoint selection exposed to assistive technology');
  await alice.press('Delete');
  await alice.waitFor(`${cellText(0, 0)} === '' && ${cellText(0, 3)} === '' && ${cellText(1, 0)} === '3'`, 'delete affects only the selected cells');
  await alice.press('z', CTRL);
  await alice.waitFor(`${cellText(0, 0)} === '1' && ${cellText(0, 3)} === '1'`, 'disjoint delete reverted together');
  const grip = await point('[data-resize="3"]');
  await mouse('mousePressed', grip, 1); await mouse('mouseReleased', grip, 0);
  await mouse('mousePressed', grip, 1); await mouse('mouseReleased', grip, 0);
  await alice.waitFor('document.querySelector(\'[data-col-header="3"]\').getBoundingClientRect().width < 104', 'double-click column autofit');
  await go('Z99');
  await alice.waitFor("document.getElementById('sgc-98-25') && !document.getElementById('sgc-98-0') && document.querySelector('#sheets-grid').getAttribute('aria-activedescendant') === 'sgc-98-25'", 'canvas and accessible window scrolled together');
  if (!await alice.evaluate("[...document.querySelector('#sg-canvas').getContext('2d').getImageData(70, 40, 1, 1).data][3] === 255")) throw new Error('canvas did not paint visible cells');
});

await step('spill formulas, wrap, frozen columns, row heights, comments and chart previews work in the editor', async () => {
  const go = address => alice.evaluate(`document.querySelector('#sheets-namebox').value = ${JSON.stringify(address)}; document.querySelector('#sheets-namebox').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  const action = (menu, name) => alice.evaluate(`document.querySelector('[data-menu="${menu}"]').click(); document.querySelector('[data-action="${name}"]').click()`);
  const confirm = () => alice.evaluate("document.querySelector('dialog[open] button[value=ok]').click()");
  await go('A10');
  await alice.enter('=SEQUENCE(3)');
  await alice.waitFor(`${cellText(11, 0)} === '3'`, 'array spill cell');
  await go('A10:A12');
  await action('insert', 'chart-preview');
  await alice.waitFor("document.querySelector('#sheets-chart-type')", 'chart settings');
  await confirm();
  await alice.waitFor("document.querySelector('#sheets-chart-preview canvas[role=img]')", 'drawn chart');
  await alice.evaluate("document.querySelector('dialog[open]').close()");
  await go('A10');
  await action('cell-style', 'wrap');
  await action('cell-style', 'row-height');
  await alice.waitFor("document.querySelector('#sheets-height')", 'row height editor');
  await alice.evaluate("document.querySelector('#sheets-height').value = '66'");
  await confirm();
  await alice.waitFor("document.querySelector('#sgc-9-0')?.getBoundingClientRect().height === 66", 'taller cell');
  await action('view', 'freeze-columns-1');
  await go('Z99');
  await alice.waitFor("document.getElementById('sgc-98-0') && document.getElementById('sgc-98-25')", 'first column stays accessible while scrolling');
  await go('A10');
  await action('insert', 'cell-comments');
  await alice.waitFor("document.querySelector('#sheets-comment-body')", 'comment editor');
  await alice.evaluate("document.querySelector('#sheets-comment-body').value = 'Array output checked.'");
  await confirm();
  await alice.waitFor("document.body.textContent.includes('Comment posted.')", 'comment saved');
  await action('insert', 'cell-comments');
  await alice.waitFor("document.querySelector('.sheets-comment-thread')?.textContent.includes('Array output checked.')", 'saved comment loaded');
  await alice.evaluate("document.querySelector('dialog[open]').close()");
  await go('C10');
  await alice.evaluate(`(() => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/html', '<table><tr><td style="background-color:#d0ffe3"><strong>Approved</strong></td><td>=2+2</td></tr></table>');
    document.querySelector('#sheets-grid').dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  })()`);
  await alice.waitFor(`${cellText(9, 2)} === 'Approved' && ${cellText(9, 3)} === '=2+2' && document.querySelector('#sgc-9-2')?.dataset.fill === '#d0ffe3'`, 'HTML paste preserves allowlisted style and literal text');
  const copied = await alice.evaluate(`(() => {
    const clipboardData = new DataTransfer();
    document.querySelector('#sheets-grid').dispatchEvent(new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true }));
    return clipboardData.getData('text/html');
  })()`);
  if (!copied.includes('font-weight:bold') || !copied.includes('Approved')) throw new Error('Copy did not include styled HTML.');
});

await step('merged cells save, skip covered cells with the keyboard, and undo after unmerging', async () => {
  const go = address => alice.evaluate(`document.querySelector('#sheets-namebox').value = ${JSON.stringify(address)}; document.querySelector('#sheets-namebox').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  const command = name => alice.evaluate(`document.querySelector('[data-menu=format]').click(); document.querySelector('[data-action=${name}]').click()`);
  const merged = "document.querySelector('#sgc-13-2')?.getAttribute('aria-colspan') === '2'";
  await go('C14');
  await alice.enter('Report header');
  await go('C14:D15');
  await command('merge-cells');
  await alice.waitFor(merged + " && document.querySelector('#sgc-14-3')?.getAttribute('aria-hidden') === 'true'", 'accessible merged box');
  await go('D15');
  await alice.press('ArrowRight');
  await alice.waitFor("document.querySelector('#sheets-namebox').value === 'E14'", 'arrow skips merged cell');
  await go('C14');
  await alice.waitFor(status + " === 'saved'", 'merge saved');
  await alice.open(`/sheets/${formId}`, "document.querySelector('#sheets-namebox')");
  await alice.waitFor("document.querySelector('#sheets-sync')?.dataset.state === 'saved'", 'workbook loaded');
  await go('C14');
  await alice.waitFor(merged, 'merge restored on reload');
  await command('unmerge-cells');
  await alice.waitFor("!document.querySelector('#sgc-13-2')?.hasAttribute('aria-colspan')", 'unmerged');
  await alice.press('z', CTRL);
  await alice.waitFor(merged, 'unmerge undone');
});

await step('charts and pivot tables persist, and a saved pivot includes new form responses', async () => {
  const go = address => alice.evaluate(`document.querySelector('#sheets-namebox').value = ${JSON.stringify(address)}; document.querySelector('#sheets-namebox').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  const action = name => alice.evaluate(`document.querySelector('[data-menu=insert]').click(); document.querySelector('[data-action=${name}]').click()`);
  const confirm = () => alice.evaluate("document.querySelector('dialog[open] button[value=ok]').click()");
  const close = () => alice.evaluate("document.querySelector('dialog[open]').close()");
  await go('A10:A12');
  await action('chart-preview');
  await alice.waitFor("document.querySelector('#sheets-report-target')", 'chart destination');
  await alice.evaluate("document.querySelector('#sheets-report-target').selectedIndex = 1; document.querySelector('#sheets-report-title').value = 'Saved sequence'");
  await confirm();
  await alice.waitFor("document.querySelector('#sheets-chart-preview canvas')", 'saved chart renders');
  await close();
  await alice.waitFor(status + " === 'saved'", 'chart saved');
  await alice.evaluate("document.querySelector('[data-tab=responses]').click()");
  await go('H1:I4');
  await action('pivot-create');
  await alice.waitFor("document.querySelector('#sheets-pivot-group')", 'pivot options');
  await alice.evaluate("document.querySelector('#sheets-pivot-group').value = '8'; document.querySelector('#sheets-pivot-value').value = '7'; document.querySelector('#sheets-report-title').value = 'Scores by track'");
  await confirm();
  await alice.waitFor("Array.from(document.querySelectorAll('.sheets-pivot tbody tr')).some(row => row.cells[0].textContent === 'Design' && row.cells[1].textContent === '8')", 'pivot computes existing Design score');
  await submitThroughForm('Sara', '12', 'design');
  await alice.waitFor("Array.from(document.querySelectorAll('.sheets-pivot tbody tr')).some(row => row.cells[0].textContent === 'Design' && row.cells[1].textContent === '20')", 'pivot updates after submission');
  await close();
  await alice.waitFor(status + " === 'saved'", 'pivot saved');
  await alice.open(`/sheets/${formId}`, "document.querySelector('#sheets-namebox')");
  await alice.waitFor(status + " === 'saved'", 'reports loaded');
  await action('saved-reports');
  await alice.waitFor("document.querySelector('#sheets-saved-report')?.options.length === 2", 'chart and pivot survive reload');
  await close();
});

await step('Forms Responses opens link controls and loads the destination workbook', async () => {
  const destination = await alice.evaluate(`(async () => {
    const me = await (await fetch('/api/me')).json();
    const response = await fetch('/api/workspaces/' + me.workspaces[0].id + '/forms', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
      body: JSON.stringify({ title: 'Response destination' })
    });
    if (response.status !== 201) throw new Error('Destination creation failed: ' + response.status);
    return (await response.json()).id;
  })()`);
  await alice.open(`/forms/${formId}/responses`, "document.querySelector('a[href$=\"?manage=links\"]')");
  await alice.evaluate("document.querySelector('a[href$=\"?manage=links\"]').click()");
  await alice.waitFor("document.querySelector('#sheets-link-target')", 'link dialog from Forms');
  await alice.evaluate(`document.querySelector('#sheets-link-target').value = ${JSON.stringify(destination)}; document.querySelector('dialog[open] button[value=ok]').click()`);
  await alice.waitFor(`location.pathname === '/sheets/${destination}' && ${cellText(1, 6)} === 'Meera' && document.querySelector('[role=tab][aria-selected=true]')?.textContent.includes('Workshop feedback')`, 'linked workbook with backfilled rows');
});

await step('standalone workbook opens from Sheets, shares with a member, and accepts a form link', async () => {
  const memberEmail = 'sheets-viewer@example.com';
  const viewer = await session('workbook viewer');
  await viewer.open('/signup', "document.querySelector('#signup')");
  const signed = await viewer.evaluate(`fetch('/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Workbook Viewer', email: ${JSON.stringify(memberEmail)}, password: 'a sufficiently long password', workspace: 'Viewer workspace' }) }).then(r => r.status)`);
  if (signed !== 201) throw new Error('Viewer registration failed: ' + signed);
  const workspaceId = await alice.evaluate(`(async () => {
    const me = await (await fetch('/api/me')).json();
    const workspaceId = me.workspaces[0].id;
    const invited = await fetch('/api/workspaces/' + workspaceId + '/members', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: JSON.stringify({ email: ${JSON.stringify(memberEmail)}, role: 'member' }) });
    if (invited.status !== 201) throw new Error('Workspace invite failed: ' + invited.status);
    return workspaceId;
  })()`);
  await alice.open('/sheets', "document.querySelector('#new-workbook')");
  await alice.evaluate("document.querySelector('#new-workbook').click(); document.querySelector('#new-workbook-title').value = 'Staging figures'; document.querySelector('dialog[open] button[value=ok]').click()");
  await alice.waitFor("location.pathname.startsWith('/sheets/workbooks/') && document.querySelector('#sheets-title')?.textContent === 'Staging figures' && !document.querySelector('#sheets-share')?.hidden", 'standalone sheet created');
  const path = await alice.evaluate('location.pathname');
  const id = path.split('/').at(-1);
  await alice.evaluate("document.querySelector('#sheets-namebox').value = 'A1'; document.querySelector('#sheets-namebox').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
  await alice.enter('Private starting value');
  await alice.waitFor(`${cellText(0, 0)} === 'Private starting value' && ${status} === 'saved'`, 'standalone edit saved');
  await alice.evaluate("document.querySelector('#sheets-share').click()");
  await alice.waitFor("document.querySelector('#sheets-share-role')", 'share dialog');
  await alice.evaluate("document.querySelector('#sheets-share-role').value = 'viewer'; document.querySelector('dialog[open] button[value=ok]').click()");
  await alice.waitFor("document.body.textContent.includes('Workbook access updated.')", 'viewer granted');
  await viewer.evaluate(`(async () => { const core = await import('/js/core.mjs'); core.selectWorkspace(${JSON.stringify(workspaceId)}); })()`);
  try { await viewer.open(path, `${cellText(0, 0)} === 'Private starting value' && ${status} === 'readonly'`); }
  catch (error) { throw new Error(error.message + '. Observed: ' + await viewer.evaluate(`JSON.stringify({ body: document.querySelector('main')?.innerText.slice(0, 280), cell: ${cellText(0, 0)}, status: ${status} })`)); }
  const linked = await alice.evaluate(`(async () => {
    const me = await (await fetch('/api/me')).json();
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token };
    const base = '/api/workspaces/' + me.workspaces[0].id + '/forms';
    return (await (await fetch(base, { method: 'POST', headers, body: JSON.stringify({ title: 'Standalone source' }) })).json()).id;
  })()`);
  await alice.open(`/sheets/${linked}?manage=links`, "document.querySelector('#sheets-link-target')");
  await alice.evaluate(`document.querySelector('#sheets-link-target').value = ${JSON.stringify(id)}; document.querySelector('dialog[open] button[value=ok]').click()`);
  await alice.waitFor(`location.pathname === ${JSON.stringify(path)} && document.querySelector('[role=tab][aria-selected=true]')?.textContent.includes('Standalone source')`, 'standalone linked response tab');
  await viewer.waitFor("[...document.querySelectorAll('[role=tab]')].some(tab => tab.textContent.includes('Standalone source'))", 'viewer receives new linked tab');
});

await step('builder saves a response schedule and date limits, and valid submissions reach Sheets', async () => {
  const form = await alice.evaluate(`(async () => {
    const me = await (await fetch('/api/me')).json();
    return (await (await fetch('/api/workspaces/' + me.workspaces[0].id + '/forms', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
      body: JSON.stringify({ definition: { title: 'Date booking preference', presentation: 'classic', fields: [{ id: 'day', type: 'date', label: 'Preferred date', required: true }] } })
    })).json());
  })()`);
  const set = (selector, value) => alice.evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await alice.open(`/forms/${form.id}`, "document.querySelector('#validation-min-0')");
  await set('#validation-min-0', '2027-12-10');
  await set('#validation-max-0', '2027-12-12');
  await alice.evaluate("document.querySelector('[data-section=settings]').click()");
  await set('#f-open', '2020-01-01T00:00');
  await alice.evaluate("document.querySelector('#publish').click()");
  await alice.waitFor("document.querySelector('#builder-status')?.dataset.liveVersion === '1'", 'date form published');
  const persisted = await alice.evaluate(`(async () => { const me = await (await fetch('/api/me')).json(); return (await (await fetch('/api/workspaces/' + me.workspaces[0].id + '/forms/${form.id}')).json()).draft; })()`);
  if (!persisted.responses?.open_at || persisted.fields[0].answer_rule?.min !== '2027-12-10' || persisted.fields[0].answer_rule?.max !== '2027-12-12') throw new Error('Date settings did not persist.');
  const fill = value => respondent.evaluate(`(() => {
    const input = document.querySelector('#q-day');
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#form-root [type=submit]').click();
  })()`);
  await respondent.open(`/f/${form.slug}`, "document.querySelector('#q-day')");
  await fill('2027-12-09');
  await respondent.waitFor("document.body.textContent.includes('Choose 2027-12-10 or a later date.')", 'shared date validation message');
  await fill('2027-12-10');
  await respondent.waitFor("document.body.textContent.includes('Response received')", 'valid date receipt');
  await alice.open(`/sheets/${form.id}`, `${cellText(1, 6)} === '2027-12-10'`);
});


await step('grid builder, phone submission and edit link update the same response row', async () => {
  const form = await alice.evaluate(`(async () => {
    const me = await (await fetch('/api/me')).json();
    return (await (await fetch('/api/workspaces/' + me.workspaces[0].id + '/forms', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
      body: JSON.stringify({ definition: { title: 'Grid edit browser check', presentation: 'classic', fields: [{ id: 'note', type: 'short_text', label: 'Notes' }] } })
    })).json());
  })()`);
  await alice.open(`/forms/${form.id}`, "document.querySelector('#add-field')");
  await alice.evaluate("document.querySelector('#add-field').click(); document.querySelector('[data-add-type=single_grid]').click()");
  await alice.waitFor("document.querySelector('[data-grid-part=rows]')", 'grid editor');
  await alice.evaluate(`(() => {
    const row = document.querySelector('[data-grid-part=rows]');
    row.value = 'Morning';
    row.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-grid-add=rows]').click();
    document.querySelector('[data-section=settings]').click();
    document.querySelector('[data-response-setting=allow_edit]').click();
    document.querySelector('#publish').click();
  })()`);
  await alice.waitFor("document.querySelector('#builder-status')?.dataset.liveVersion === '1'", 'grid published');
  const phone = await session('grid phone');
  await phone.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await phone.open(`/f/${form.slug}`, "document.querySelectorAll('.response-grid-row').length === 3");
  const fits = await phone.evaluate("document.documentElement.scrollWidth <= innerWidth && document.querySelector('.response-grid-row legend').textContent === 'Morning'");
  if (!fits) throw new Error('Grid did not fit the phone or lost the author label.');
  await phone.evaluate("document.querySelector('.response-grid-row input').click(); document.querySelector('#form-root [type=submit]').click()");
  await phone.waitFor("document.querySelector('.receipt a[href*=edit]')", 'private edit link');
  await alice.open(`/sheets/${form.id}`, `${cellText(1, 7)} === 'Column 1'`);
  await alice.evaluate("document.querySelector('[data-action=new-sheet]').click()");
  await alice.waitFor("document.querySelector('[role=tab][aria-selected=true]')?.textContent.trim() === 'Sheet1'", 'analysis sheet');
  await alice.evaluate("document.querySelector('#sheets-grid').focus()");
  await alice.enter("='Form Responses'!H2");
  await alice.waitFor(`${cellText(0, 0)} === 'Column 1' && ${status} === 'saved'`, 'formula tracks the original response');
  await phone.evaluate("document.querySelector('.receipt a[href*=edit]').click()");
  await phone.waitFor("document.querySelector('.response-grid-row input')?.checked", 'edit link loads original grid answer');
  await phone.evaluate("document.querySelectorAll('.response-grid-row input')[1].click(); document.querySelector('#form-root [type=submit]').click()");
  await phone.waitFor("document.querySelector('h1')?.textContent === 'Response updated'", 'response edit receipt');
  await phone.evaluate("document.querySelector('[data-edit-again]').click()");
  await phone.waitFor("document.querySelectorAll('.response-grid-row input')[1]?.checked", 'edit again loads the saved change');
  await alice.waitFor(`${cellText(0, 0)} === 'Column 2'`, 'dependent formula recalculates in the open workbook');
  await alice.evaluate("document.querySelector('[data-tab=responses]').click()");
  await alice.waitFor(`${cellText(1, 7)} === 'Column 2' && !${cellText(2, 7)}`, 'open workbook refreshes the same row');
});


await step('file question uploads a PDF and the host downloads it privately (test scanner)', async () => {
  const form = await alice.evaluate(`(async () => {
    const me = await (await fetch('/api/me')).json();
    return (await (await fetch('/api/workspaces/' + me.workspaces[0].id + '/forms', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
      body: JSON.stringify({ definition: { title: 'Private file browser check', presentation: 'classic', fields: [{ id: 'note', type: 'short_text', label: 'Notes' }] } })
    })).json());
  })()`);
  await alice.open(`/forms/${form.id}`, "document.querySelector('#add-field')");
  await alice.evaluate("document.querySelector('#add-field').click(); document.querySelector('[data-add-type=file_upload]').click(); document.querySelector('[data-prop=required]').click(); document.querySelector('[data-section=settings]').click(); document.querySelector('[data-response-setting=allow_edit]').click(); document.querySelector('#publish').click()");
  await alice.waitFor("document.querySelector('#builder-status')?.dataset.liveVersion === '1'", 'file question published');
  const visitor = await session('file respondent');
  await visitor.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await visitor.open(`/f/${form.slug}`, "document.querySelector('[data-file-input]') && !document.querySelector('[data-file-input]').disabled");
  await visitor.evaluate(`(() => {
    const input = document.querySelector('[data-file-input]');
    const files = new DataTransfer();
    files.items.add(new File(['%PDF-1.4\\n test-rejected \\n%%EOF\\n'], 'rejected.pdf', { type: 'application/pdf' }));
    input.files = files.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await visitor.waitFor("document.querySelector('[data-file-retry]')", 'failed scan offers retry');
  if (!await visitor.evaluate("document.querySelector('#form-root [type=submit]').disabled")) throw new Error('A failed file must be resolved before submitting.');
  await visitor.evaluate("document.querySelector('[data-file-retry]').click()");
  await visitor.waitFor("document.querySelector('[data-file-retry]') && document.querySelector('.form-file-list').textContent.includes('security scan')", 'retry repeats the upload and scan');
  await visitor.evaluate("document.querySelector('[data-file-remove]').click()");
  await visitor.waitFor("!document.querySelector('.form-file-list li') && !document.querySelector('[data-file-input]').disabled", 'remove releases the failed file');
  await visitor.evaluate(`(() => {
    const note = document.querySelector('#q-note');
    note.value = 'Keep my answer while files upload';
    note.dispatchEvent(new Event('input', { bubbles: true }));
    const input = document.querySelector('[data-file-input]');
    const files = new DataTransfer();
    files.items.add(new File(['%PDF-1.4\\n1 0 obj << /Type /Catalog >> endobj\\n%%EOF\\n'], 'project-brief.pdf', { type: 'application/pdf' }));
    input.files = files.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await visitor.waitFor("document.querySelector('.form-file-list')?.textContent.includes('Uploaded')", 'file uploaded and scanned');
  await visitor.shot('private-form-upload-phone');
  if (!await visitor.evaluate("document.querySelector('#q-note').value === 'Keep my answer while files upload' && document.documentElement.scrollWidth <= innerWidth")) throw new Error('Upload lost the existing answer or overflowed the phone.');
  await visitor.evaluate("document.querySelector('#form-root [type=submit]').click()");
  await visitor.waitFor("document.querySelector('.receipt')", 'file response accepted');
  await alice.open(`/forms/${form.id}/responses`, "document.querySelector('[data-view-response]')");
  await alice.evaluate("document.querySelector('[data-view-response]').click()");
  await alice.waitFor("document.querySelector('.attachment-link')", 'private attachment download link');
  const download = await alice.evaluate(`(async () => {
    const response = await fetch(document.querySelector('.attachment-link').href);
    return { status: response.status, text: await response.text(), disposition: response.headers.get('content-disposition') };
  })()`);
  if (download.status !== 200 || !download.text.startsWith('%PDF-1.4') || !download.disposition.startsWith('attachment;')) throw new Error('Private PDF download failed.');
  await alice.open(`/sheets/${form.id}`, `${cellText(1, 7)} === 'project-brief.pdf'`);

  await visitor.evaluate("document.querySelector('.receipt a[href*=edit]').click()");
  await visitor.waitFor("document.querySelector('.form-file-list')?.textContent.includes('project-brief.pdf')", 'edit form retains the submitted file');
  await visitor.evaluate(`(() => {
    const note = document.querySelector('#q-note');
    note.value = 'Edited with replacement';
    note.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-file-remove]').click();
  })()`);
  await visitor.waitFor("!document.querySelector('.form-file-list li')", 'original file removed from this draft');
  await visitor.evaluate(`(() => {
    const input = document.querySelector('[data-file-input]');
    const files = new DataTransfer();
    files.items.add(new File(['%PDF-1.4\\n1 0 obj << /Type /Catalog >> endobj\\n%%EOF\\n'], 'replacement.pdf', { type: 'application/pdf' }));
    input.files = files.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await visitor.waitFor("document.querySelector('.form-file-list')?.textContent.includes('Uploaded')", 'replacement uploaded');
  await visitor.evaluate("document.querySelector('#form-root [type=submit]').click()");
  await visitor.waitFor("document.querySelector('h1')?.textContent === 'Response updated'", 'file response edit saved');
  await alice.waitFor(`${cellText(1, 7)} === 'replacement.pdf' && ${cellText(1, 6)} === 'Edited with replacement'`, 'open Sheets row updates after replacing a file');

});

await step('canvas draws a viewport over one million populated cells without scanning the remainder', async () => {
  const result = await alice.evaluate(`(async () => {
    const { columnOffsets, paintSheetGrid } = await import('/js/sheet-grid.mjs');
    const data = Float64Array.from({ length: 1_000_000 }, (_, index) => index + 1);
    const canvas = document.createElement('canvas');
    canvas.className = 'sg-canvas';
    document.querySelector('.sheets-grid-wrap').append(canvas);
    const offsets = columnOffsets(1000, column => 64 + column % 5);
    const colors = { background: '#ffffff', ink: '#202020', line: '#dddddd', selection: '#dbeee3', selectionLine: '#1f7a4d', font: 'sans-serif' };
    const times = [];
    let maxRead = 0;
    let lastTimestamp = 0;
    let duration = 0;
    for (let frame = 0; frame < 45; frame++) {
      const timestamp = await new Promise(requestAnimationFrame);
      if (frame) duration += timestamp - lastTimestamp;
      lastTimestamp = timestamp;
      const row = (frame * 113) % 970;
      const rows = Array.from({ length: 28 }, (_, index) => ({ row: row + index, y: index * 25 }));
      const left = offsets[(frame * 29) % 980];
      let reads = 0;
      const start = performance.now();
      paintSheetGrid(canvas, { width: 1152, height: 700, scale: devicePixelRatio, blocks: [{ rows, top: 0, bottom: 700 }], offsets, left, gutter: 46, rowHeight: 25, colors, selection: { r1: row, r2: row, c1: 0, c2: 0 }, anchor: { r: row, c: 0 }, readCell: (r, c) => { reads++; return { text: data[r * 1000 + c], number: true }; } });
      times.push(performance.now() - start);
      maxRead = Math.max(maxRead, reads);
    }
    canvas.remove();
    return { maxRead, p95: times.sort((a,b) => a-b)[42], raf: 44_000 / duration };
  })()`);
  if (result.maxRead < 1 || result.maxRead > 600) throw new Error('paint visited cells outside the viewport budget');
  console.log(`1,000,000-cell canvas sample: ${result.p95.toFixed(2)} ms p95 paint, ${result.raf.toFixed(1)} frames/s, ${result.maxRead} cells or fewer per frame.`);
});

if(process.argv.includes('--products')||productOnly){checkingProducts=true;const {checkProductTools}=await import('./product-tools-check.mjs');await checkProductTools({alice,bob,visitor:respondent,app,step,cellText});const {checkProductPayments}=await import('./product-payments-check.mjs');await checkProductPayments({alice,visitor:respondent,app,step});}
if(process.argv.includes('--expanded')||expandedOnly){checkingExpansion=true;const {checkSheetsExpansion}=await import('./sheets-expansion-check.mjs');await checkSheetsExpansion({alice,bob,step,cellText,CTRL,SHIFT});}
console.log(steps.join('\n'));
if (problems.length) console.log('\nProblems:\n' + problems.map(problem => ' - ' + problem).join('\n'));
if (keepOpen) {
  console.log(`\nKept running at ${base}/sheets/${formId} (sign in as asha.sheets@example.com / a sufficiently long password). Ctrl+C to stop.`);
} else {
  socket.close();
  browser.kill();
  await app.stop();
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* browser may still be closing */ }
  process.exit(problems.length ? 1 : 0);
}
