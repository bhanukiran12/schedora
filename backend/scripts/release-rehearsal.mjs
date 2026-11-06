// Forms release rehearsal: runs the previous release and this tree as real servers against a disposable
// PostgreSQL, and drives old and new frontends in headless Chrome. Covers the upgrade from the previous
// release, the mixed-version rollout matrix and the rollback. It never needs a private environment file.
//
// Usage: DATABASE_URL=postgres://...@127.0.0.1:port/postgres DATABASE_CA_CERT=<pem> \
//        npm run release-rehearsal -- --prev <exported previous release> [--only upgrade,rollout,cached,rollback,freeze] [--rollback-build <exported rollback build>] [--json <file>]
// Export the previous release with: git archive <commit> | tar -x -C <dir>
// It refuses any database that is not on this computer.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pg = require('pg');
const argument = name => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : null; };
const adminUrl = new URL(process.env.DATABASE_URL || 'postgres://missing');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(adminUrl.hostname)) { console.error('Refusing to run: DATABASE_URL must be a disposable database on this computer.'); process.exit(2); }
const ca = process.env.DATABASE_CA_CERT;
const prevRoot = resolve(argument('--prev') || '');
if (!existsSync(join(prevRoot, 'backend/server.mjs'))) { console.error('Give the exported previous release with --prev <dir>.'); process.exit(2); }
const only = (argument('--only') || 'upgrade,rollout,cached,rollback,freeze').split(',');
const rollbackRoot = argument('--rollback-build') ? resolve(argument('--rollback-build')) : null;
if (only.includes('freeze') && !rollbackRoot) { console.error('Give the exported rollback build with --rollback-build <dir>.'); process.exit(2); }
if (rollbackRoot && !existsSync(join(rollbackRoot, 'backend/src/forms/freeze.mjs'))) { console.error('--rollback-build does not contain the authoring freeze.'); process.exit(2); }
const newBackend = fileURLToPath(new URL('..', import.meta.url));
const newFrontend = join(newBackend, '../frontend');
const oldBackend = join(prevRoot, 'backend');
const oldFrontend = join(prevRoot, 'frontend');
if (!existsSync(join(oldBackend, 'node_modules'))) symlinkSync(join(newBackend, 'node_modules'), join(oldBackend, 'node_modules'), 'junction');
if (rollbackRoot && !existsSync(join(rollbackRoot, 'backend/node_modules'))) symlinkSync(join(newBackend, 'node_modules'), join(rollbackRoot, 'backend/node_modules'), 'junction');

// ---- Results -------------------------------------------------------------------------------------
const results = [];
const observations = [];
const check = (section, name, ok, detail = '') => { results.push({ section, name, ok: Boolean(ok), detail }); console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok || !detail ? '' : ' :: ' + detail}`); };
const observe = (section, name, value) => { observations.push({ section, name, value }); console.log(`  NOTE  ${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`); };
const heading = text => console.log(`\n== ${text}`);

// ---- Databases -----------------------------------------------------------------------------------
const dbUrl = name => { const url = new URL(adminUrl); url.pathname = '/' + name; return url.href; };
async function sql(database, text, values = []) {
  const url = new URL(dbUrl(database));
  const client = new pg.Client({ connectionString: url.href, ssl: { rejectUnauthorized: true, ca } });
  await client.connect();
  try { return (await client.query(text, values)).rows; } finally { await client.end(); }
}
const admin = text => sql(adminUrl.pathname.slice(1) || 'postgres', text);
const freshDatabase = async name => { await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin(`CREATE DATABASE ${name}`); };
const copyDatabase = async (from, to) => { await admin(`DROP DATABASE IF EXISTS ${to} WITH (FORCE)`); await admin(`CREATE DATABASE ${to} TEMPLATE ${from}`); };
const q = (database, text, values) => sql(database, text.replace(/\b(forms|form_versions|responses|schema_migrations|contacts|form_themes)\b/g, 'schedora.$1'), values);

// ---- Servers -------------------------------------------------------------------------------------
const PORT = 3900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${PORT}`;
let server = null;
async function stopServer() {
  if (!server) return;
  const child = server;
  server = null;
  child.kill();
  await new Promise(done => { child.once('exit', done); setTimeout(done, 4000); });
}
// Only what the server needs: nothing is inherited from a private environment.
async function startServer(backend, frontend, database, extraEnv = {}) {
  await stopServer();
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, NODE_ENV: 'development', PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: base, DATABASE_URL: dbUrl(database), DATABASE_CA_CERT: ca, SERVE_FRONTEND: 'true', FRONTEND_DIR: frontend, RATE_LIMIT_PER_MINUTE: '100000', ...extraEnv };
  let output = '';
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.mjs'], { cwd: backend, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => { output = (output + chunk).slice(-4000); });
  server.stderr.on('data', chunk => { output = (output + chunk).slice(-4000); });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.exitCode !== null) throw new Error('server exited: ' + output);
    try { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(2000) })).status < 500) return; } catch { /* starting */ }
    await new Promise(done => setTimeout(done, 200));
  }
  throw new Error('server did not start: ' + output);
}

function apiClient() {
  let cookie = '';
  let csrf = '';
  const request = async (method, path, body) => {
    const response = await fetch(base + path, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await response.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    if (parsed?.csrf_token) csrf = parsed.csrf_token;
    return { status: response.status, body: parsed };
  };
  return { get: path => request('GET', path), post: (path, body = {}) => request('POST', path, body), patch: (path, body) => request('PATCH', path, body), put: (path, body) => request('PUT', path, body), del: (path, body) => request('DELETE', path, body) };
}
let accounts = 0;
async function signUp(http) {
  const email = `rehearsal${++accounts}.${Date.now()}@example.com`;
  const created = await http.post('/api/auth/signup', { name: 'Rehearsal', email, password: 'a sufficiently long password', workspace: `Rehearsal ${accounts}` });
  if (created.status !== 201) throw new Error('signup failed: ' + JSON.stringify(created.body));
  return { email, forms: `/api/workspaces/${created.body.workspaces[0].id}/forms`, ws: created.body.workspaces[0].id, wsName: created.body.workspaces[0].name };
}
const logIn = async (http, email) => { const result = await http.post('/api/auth/login', { email, password: 'a sufficiently long password' }); if (result.status !== 200) throw new Error('login failed: ' + JSON.stringify(result.body)); return result; };
async function published(http, forms, definition) {
  const created = await http.post(forms, { definition });
  if (created.status !== 201) throw new Error('form refused: ' + JSON.stringify(created.body));
  const live = await http.post(`${forms}/${created.body.id}/publish`);
  if (live.status !== 200) throw new Error('publish refused: ' + JSON.stringify(live.body));
  return live.body;
}

// ---- Browser -------------------------------------------------------------------------------------
const browserPath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path));
const workDir = mkdtempSync(join(tmpdir(), 'schedora-rehearsal-'));
const debugPort = 9800 + Math.floor(Math.random() * 150);
const browser = spawn(browserPath, ['--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${join(workDir, 'profile')}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
let target;
for (let attempt = 0; attempt < 100 && !target; attempt++) {
  await new Promise(done => setTimeout(done, 200));
  try { target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(item => item.type === 'page'); } catch { /* starting */ }
}
if (!target) throw new Error('browser did not start');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(done => socket.addEventListener('open', done, { once: true }));
let nextId = 0;
const pending = new Map();
const pageErrors = [];
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data);
  if (message.id && pending.has(message.id)) { const { resolve: ok, reject } = pending.get(message.id); pending.delete(message.id); message.error ? reject(new Error(message.error.message)) : ok(message.result); }
  if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
});
const send = (method, params = {}) => new Promise((ok, reject) => { const id = ++nextId; pending.set(id, { resolve: ok, reject }); socket.send(JSON.stringify({ id, method, params })); });
await send('Page.enable');
await send('Runtime.enable');
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
};
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function waitFor(expression, label, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { if (await evaluate(`Boolean(${expression})`)) return true; } catch { /* navigating */ }
    await sleep(100);
  }
  throw new Error('timed out waiting for ' + label);
}
const open = async (path, ready) => { await send('Page.navigate', { url: base + path }); await waitFor(`document.readyState === 'complete' && ${ready}`, path); };
const fill = (selector, value) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('missing ${selector}'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const click = selector => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('missing ${selector}'); el.click(); })()`);
const shown = selector => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);

// After Submit: accepted, or something the person can see and act on. Anything else is being stuck: the
// request failed and the page shows no question to answer and no message.
async function submitAndRead() {
  await click('#form-root [type="submit"]');
  const started = Date.now();
  while (Date.now() - started < 8000) {
    const state = await evaluate(`({ receipt: Boolean(document.querySelector('.receipt')), errors: [...document.querySelectorAll('#form-root .field-error')].map(node => node.closest('[data-field]')?.dataset.field), notice: document.querySelector('#form-root [data-form-status]')?.innerText || '', busy: Boolean(document.querySelector('#form-root form')?.dataset.busy), text: document.querySelector('#form-root').innerText.slice(0, 300) })`);
    if (state.receipt) return { outcome: 'accepted', ...state };
    if (state.busy) { await sleep(100); continue; } // still sending: what is on the page is not the outcome yet
    if (state.errors.length) return { outcome: 'shows_error', ...state };
    if (state.notice.trim()) return { outcome: 'shows_notice', ...state };
    await sleep(150);
  }
  const state = await evaluate(`({ text: document.querySelector('#form-root').innerText.slice(0, 300) })`);
  return { outcome: 'stuck', ...state };
}
const newestResponse = async (database, formId) => (await q(database, 'SELECT form_version, answers, attribution FROM responses WHERE form_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [formId]))[0];
const responseCount = async (database, formId) => Number((await q(database, 'SELECT COUNT(*) AS count FROM responses WHERE form_id = $1', [formId]))[0].count);

// ---- Fixtures ------------------------------------------------------------------------------------
const options = (...ids) => ids.map(id => ({ id, label: id[0].toUpperCase() + id.slice(1) }));
const is = (field, value) => ({ field, op: 'equals', value });
const shell = (title, extra) => ({ title, description: '', presentation: 'classic', submit_label: 'Send', ...extra });
const typedForm = title => shell(title, { fields: [
  { id: 'code', type: 'short_text', label: 'Do you have a code?', required: false },
  { id: 'more', type: 'short_text', label: 'Which code?', required: true, show_if: is('code', 'yes') }
] });
const hiddenChoiceRequired = () => shell('Hidden choice, required', { fields: [
  { id: 'plan', type: 'single_choice', label: 'Plan', required: true, options: options('free', 'team') },
  { id: 'help', type: 'single_choice', label: 'Help', required: true, options: options('email', 'phone') }
], choice_rules: [{ field: 'help', rules: [{ when: is('plan', 'free'), hide: ['phone'] }] }] });
const hiddenChoiceFollowUp = () => shell('Hidden choice, follow-up', { fields: [
  { id: 'plan', type: 'single_choice', label: 'Plan', required: true, options: options('free', 'team') },
  { id: 'help', type: 'single_choice', label: 'Help', required: false, options: options('email', 'phone') },
  { id: 'why', type: 'short_text', label: 'Why not phone?', required: true, show_if: { field: 'help', op: 'not_equals', value: 'phone' } }
], choice_rules: [{ field: 'help', rules: [{ when: is('plan', 'free'), hide: ['phone'] }] }] });
const attributionForm = () => shell('Partner enquiry', { url_params: [{ key: 'utm_source', record: true }], fields: [
  { id: 'help', type: 'single_choice', label: 'Help', required: true, options: options('email', 'phone', 'visit') }
], choice_rules: [{ field: 'help', rules: [{ when: { param: 'utm_source', op: 'equals', value: 'partner' }, hide: ['visit'] }] }] });
const pageForm = () => shell('Conditional page', { fields: [
  { id: 'plan', type: 'single_choice', label: 'Plan', required: true, options: options('free', 'team') },
  { id: 'details', type: 'page_break', label: 'Team details', grouped: true, show_if: is('plan', 'team') },
  { id: 'seats', type: 'short_text', label: 'Seats', required: true, group: 'details' },
  { id: 'after', type: 'short_text', label: 'Anything else?', required: true }
] });
const jumpForm = () => shell('Jump', { fields: [
  { id: 'kind', type: 'single_choice', label: 'Kind', required: true, options: options('home', 'office') },
  { id: 'size', type: 'short_text', label: 'Team size', required: true },
  { id: 'notes', type: 'long_text', label: 'Notes', required: false }
], logic: [{ field: 'kind', rules: [{ when: is('kind', 'home'), to: { type: 'ending', id: 'done' } }] }], endings: [{ id: 'thanks', title: 'Thanks' }, { id: 'done', title: 'Home done' }] });
const THEME = { name: 'Rehearsal', font: 'serif', background: '#102405', question: '#ffffff', answer: '#ffffff', button: '#ffffff', button_text: '#102405' };

// The one test of a client: type or pick, submit, and read what the person is left with.
async function respond(steps) {
  for (const step of steps) {
    if (step.fill) await fill(step.fill[0], step.fill[1]);
    if (step.pick) await click(step.pick);
    await sleep(60);
  }
  return submitAndRead();
}
const stuckCheck = (section, name, result) => check(section, name, result.outcome !== 'stuck', `${result.outcome}: ${String(result.text).replace(/\s+/g, ' ').slice(0, 120)}`);

// ---- Upgrade -------------------------------------------------------------------------------------
async function upgradeSection() {
  heading('PostgreSQL: fresh database and upgrade from the previous release');
  const S = 'upgrade';
  // Fresh database on this tree.
  await freshDatabase('rh_fresh');
  await startServer(newBackend, newFrontend, 'rh_fresh');
  const freshMigrations = (await q('rh_fresh', 'SELECT name FROM schema_migrations ORDER BY name')).map(row => row.name);
  check(S, 'fresh database: postgres_v13 to postgres_v16 recorded', ['postgres_v13_form_assets', 'postgres_v14_session_offers', 'postgres_v15_form_themes', 'postgres_v16_response_attribution'].every(name => freshMigrations.includes(name)), freshMigrations.join());
  const fresh = apiClient();
  const account = await signUp(fresh);
  const freshForm = await published(fresh, account.forms, typedForm('Fresh form'));
  check(S, 'fresh database: a form publishes and answers', (await fresh.post(`/api/public/forms/${freshForm.slug}/responses`, { answers: { code: 'no' } })).status === 201);
  await stopServer();

  // The previous release's own code creates the database and its data.
  await freshDatabase('rh_upgrade');
  await startServer(oldBackend, oldFrontend, 'rh_upgrade');
  const http = apiClient();
  const owner = await signUp(http);
  const typed = await published(http, owner.forms, typedForm('Published by the previous release'));
  const submit = (slug, body) => http.post(`/api/public/forms/${slug}/responses`, body);
  const seeded = [await submit(typed.slug, { answers: { code: 'yes ' } }), await submit(typed.slug, { answers: { code: 'yes', more: 'ABC' } }), await submit(typed.slug, { answers: { code: 'no' }, submission_id: 'prev-release-retry-0001' })];
  check(S, 'previous release: fixture responses accepted', seeded.every(result => result.status === 201), JSON.stringify(seeded.map(result => result.status)));
  const multi = await published(http, owner.forms, shell('Republished by the previous release', { fields: [{ id: 'topic', type: 'single_choice', label: 'Topic', required: true, options: options('sales', 'support') }, { id: 'mail', type: 'email', label: 'Email', required: false }] }));
  const firstAnswer = await submit(multi.slug, { answers: { topic: 'support', mail: 'Someone@Example.com' } });
  const edited = await http.patch(`${owner.forms}/${multi.id}`, { definition: shell('Republished by the previous release', { fields: [{ id: 'topic', type: 'single_choice', label: 'Topic', required: true, options: [...options('sales'), { id: 'support', label: 'Help desk' }] }, { id: 'mail', type: 'email', label: 'Email', required: false }, { id: 'extra', type: 'long_text', label: 'Extra', required: false }] }), base_revision: (await http.get(`${owner.forms}/${multi.id}`)).body.revision });
  check(S, 'previous release: a draft edit is saved', edited.status === 200);
  await http.post(`${owner.forms}/${multi.id}/publish`);
  await submit(multi.slug, { answers: { topic: 'support', extra: 'second version' } });
  await http.put(`${owner.forms}/${typed.id}/routing`, { routing: { rules: [{ condition: is('code', 'yes'), action: { type: 'message', message: 'Matched' } }], fallback: { type: 'message', message: 'Other' } }, base_revision: (await http.get(`${owner.forms}/${typed.id}`)).body.revision });
  await http.post(`${owner.forms}/${typed.id}/publish`);
  const csvBefore = { typed: (await http.get(`${owner.forms}/${typed.id}/responses.csv`)).body, multi: (await http.get(`${owner.forms}/${multi.id}/responses.csv`)).body };
  const snapshot = async () => JSON.stringify([await q('rh_upgrade', 'SELECT id, slug, draft, routing, published_version FROM forms ORDER BY id'), await q('rh_upgrade', 'SELECT form_id, version, definition, routing FROM form_versions ORDER BY form_id, version'), await q('rh_upgrade', 'SELECT id, form_id, form_version, answers, request_hash, contact_id, created_at FROM responses ORDER BY id')]);
  const before = await snapshot();
  const oldMigrations = (await q('rh_upgrade', 'SELECT name FROM schema_migrations ORDER BY name')).map(row => row.name);
  observe(S, 'data tested', 'generated by the previous release\'s own code on this database, not sanitized production data');
  observe(S, 'previous release migrations', oldMigrations.filter(name => name.startsWith('postgres_v')).sort((a, b) => parseInt(a.slice(10)) - parseInt(b.slice(10))).at(-1));
  await stopServer();

  // Upgrade in place.
  await startServer(newBackend, newFrontend, 'rh_upgrade');
  const after = (await q('rh_upgrade', 'SELECT name FROM schema_migrations ORDER BY name')).map(row => row.name);
  const added = after.filter(name => !oldMigrations.includes(name));
  check(S, 'upgrade: applies exactly the four new steps', added.join() === 'postgres_v13_form_assets,postgres_v14_session_offers,postgres_v15_form_themes,postgres_v16_response_attribution', added.join());
  check(S, 'upgrade: forms, published versions and responses are byte for byte unchanged', (await snapshot()) === before);
  check(S, 'upgrade: existing responses have no attribution', Number((await q('rh_upgrade', 'SELECT COUNT(*) AS count FROM responses WHERE attribution IS NOT NULL'))[0].count) === 0);
  await stopServer();
  await startServer(newBackend, newFrontend, 'rh_upgrade');
  check(S, 'upgrade: restarting re-applies nothing', (await q('rh_upgrade', 'SELECT name FROM schema_migrations')).length === after.length);

  // Same schema by either route.
  const shape = async database => JSON.stringify([await sql(database, "SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'schedora' ORDER BY table_name, column_name"), await sql(database, "SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'schedora' ORDER BY tablename, indexname")]);
  const [freshShape, upgradedShape] = [await shape('rh_fresh'), await shape('rh_upgrade')];
  check(S, 'upgrade and fresh databases have the same columns and indexes', freshShape === upgradedShape);

  // Older forms and historical responses, read by the new code.
  const later = apiClient();
  await logIn(later, owner.email);
  check(S, 'older form: CSV is byte for byte the same (typed-rule form)', (await later.get(`${owner.forms}/${typed.id}/responses.csv`)).body === csvBefore.typed);
  check(S, 'older form: CSV is byte for byte the same (two versions, renamed option)', (await later.get(`${owner.forms}/${multi.id}/responses.csv`)).body === csvBefore.multi);
  const listed = (await later.get(`${owner.forms}/${typed.id}/responses`)).body.responses;
  check(S, 'older responses: inbox lists them with original answers and no attribution', listed.length === 3 && listed.every(row => !('attribution' in row)));
  const retry = await later.post(`/api/public/forms/${typed.slug}/responses`, { answers: { code: 'no' }, submission_id: 'prev-release-retry-0001' });
  check(S, 'older response: a retry after the upgrade replays the first result', retry.status === 200 && retry.body.replay === true);
  const flagged = (await later.get(`${owner.forms}/${typed.id}`)).body;
  check(S, 'older form with a typed rule: flagged, not marked changed', flagged.legacy_text_comparison === true && flagged.has_unpublished_changes === false);
  check(S, 'older form: "yes " keeps the path it had (no follow-up required)', (await later.post(`/api/public/forms/${typed.slug}/responses`, { answers: { code: 'yes ' }, evaluator: 2 })).status === 201);
  check(S, 'older form: "yes" still requires the follow-up', (await later.post(`/api/public/forms/${typed.slug}/responses`, { answers: { code: 'yes' }, evaluator: 2 })).status === 400);
  const liveOld = (await later.get(`/api/public/forms/${typed.slug}`)).body;
  check(S, 'older published version carries no policy', !('evaluation_policy' in liveOld.definition));
  await later.post(`${owner.forms}/${typed.id}/publish`);
  const stamped = (await q('rh_upgrade', 'SELECT definition FROM form_versions WHERE form_id = $1 ORDER BY version DESC LIMIT 1', [typed.id]))[0].definition;
  check(S, 'republishing stamps only the new version', JSON.parse(stamped).evaluation_policy === 'normalized_v1' && Number((await q('rh_upgrade', "SELECT COUNT(*) AS count FROM form_versions WHERE form_id = $1 AND definition LIKE '%evaluation_policy%'", [typed.id]))[0].count) === 1);
  check(S, 'a stamped version: "yes " requires the follow-up, and routing agrees', (await later.post(`/api/public/forms/${typed.slug}/responses`, { answers: { code: 'yes ' }, evaluator: 2 })).status === 400 && (await later.post(`/api/public/forms/${typed.slug}/responses`, { answers: { code: 'yes ', more: 'x' }, evaluator: 2 })).body.next?.message === 'Matched');
  await stopServer();
}

// ---- Mixed-version rollout -----------------------------------------------------------------------
async function rolloutSection() {
  heading('Mixed-version rollout: old frontend on the new backend, fresh and left open');
  const S = 'rollout';
  // The compatibility rule stands in for the previous renderer, so compare it with the real one.
  const oldLogic = await import(new URL('file:///' + join(oldBackend, 'src/shared/forms-logic.mjs').replace(/\\/g, '/')).href);
  const newLogic = await import(new URL('../src/shared/forms-logic.mjs', import.meta.url).href);
  let seed = 7;
  const random = limit => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % limit; };
  const pick = list => list[random(list.length)];
  let differences = 0;
  for (let round = 0; round < 3000; round++) {
    const fields = [];
    const count = 2 + random(9);
    let page = null;
    for (let index = 0; index < count; index++) {
      const id = `q${index}`;
      const type = pick(['short_text', 'email', 'single_choice', 'multiple_choice', 'page_break', 'page_break']);
      const earlier = fields.filter(field => field.type !== 'page_break');
      const field = { id, type, label: id, required: Boolean(random(2)) };
      if (type.endsWith('_choice')) field.options = options('a', 'b');
      if (type === 'page_break') { page = random(2) ? id : null; if (page) field.grouped = true; delete field.required; }
      else if (page && random(3)) field.group = page; else page = null;
      if (earlier.length && random(2)) { const source = pick(earlier); field.show_if = { field: source.id, op: pick(['equals', 'not_equals', 'contains', 'answered', 'not_answered']), value: source.options ? 'a' : 'yes' }; }
      fields.push(field);
    }
    const answers = {};
    for (const field of fields) if (field.type !== 'page_break' && random(3)) answers[field.id] = field.type === 'multiple_choice' ? pick([['a'], ['a', 'b'], []]) : field.options ? pick(['a', 'b']) : pick(['yes', 'yes ', ' Yes', 'no', '']);
    const definition = { title: 'T', presentation: 'classic', fields, choice_rules: [], evaluation_policy: 'normalized_v1' };
    const real = oldLogic.visibleFields(definition, answers).map(field => field.id).join();
    const modelled = [...newLogic.olderClientFieldIds(definition, answers)].join();
    if (real !== modelled) differences++;
  }
  check(S, 'the compatibility rule matches the previous renderer on 3000 random forms and answers', differences === 0, `${differences} differed`);
  await freshDatabase('rh_rollout');

  // A tab opened before the rollout: old backend, old frontend, a version from before the policy.
  await startServer(oldBackend, oldFrontend, 'rh_rollout');
  const http = apiClient();
  const owner = await signUp(http);
  const openOld = await published(http, owner.forms, typedForm('Tab open before rollout'));
  const openLate = await published(http, owner.forms, typedForm('Tab open past the grace period'));
  await open(`/f/${openOld.slug}`, "document.querySelector('#q-code')");
  await stopServer();

  await startServer(newBackend, oldFrontend, 'rh_rollout');
  await logIn(http, owner.email);
  let result = await respond([{ fill: ['#q-code', 'yes '] }]);
  stuckCheck(S, 'old tab, old version, no republish: "yes " is not stuck', result);
  check(S, 'old tab, old version: judged by that version', result.outcome === 'accepted' && (await newestResponse('rh_rollout', openOld.id)).answers === '{"code":"yes"}', JSON.stringify(result));

  // Old tab, republished under it, within the 24-hour grace.
  await stopServer();
  await startServer(oldBackend, oldFrontend, 'rh_rollout');
  await open(`/f/${openOld.slug}`, "document.querySelector('#q-code')");
  await stopServer();
  await startServer(newBackend, oldFrontend, 'rh_rollout');
  await http.post(`${owner.forms}/${openOld.id}/publish`);
  result = await respond([{ fill: ['#q-code', 'yes '] }]);
  stuckCheck(S, 'old tab, republished during rollout, within grace: not stuck', result);
  check(S, 'old tab within grace: stored against the version it answered', Number((await newestResponse('rh_rollout', openOld.id)).form_version) === 1, JSON.stringify(result));

  // Old tab, republished after the hold ended, older than the grace: it reloads the new version into old code.
  await stopServer();
  await startServer(oldBackend, oldFrontend, 'rh_rollout');
  await open(`/f/${openLate.slug}`, "document.querySelector('#q-code')");
  await stopServer();
  await startServer(newBackend, oldFrontend, 'rh_rollout');
  await http.post(`${owner.forms}/${openLate.id}/publish`);
  await sql('rh_rollout', 'UPDATE schedora.form_versions SET published_at = published_at - $1 WHERE form_id = $2 AND version = 2', [25 * 3600 * 1000, openLate.id]);
  result = await respond([{ fill: ['#q-code', 'yes '] }]);
  if (result.outcome !== 'accepted') { await waitFor("document.querySelector('[data-form-banner]') || document.querySelector('.receipt')", 'reloaded form', 6000).catch(() => {}); result = await respond([{ fill: ['#q-code', 'yes '] }]); }
  stuckCheck(S, 'old tab past the grace, reloaded onto a stamped version: "yes " is not stuck', result);
  observe(S, 'old tab past the grace', result.outcome);

  // Old code, fresh load, every kind of new form.
  const fresh = async (definition, query = '') => { const form = await published(http, owner.forms, definition); await open(`/f/${form.slug}${query}`, "document.querySelector('#form-root [type=submit]')"); return form; };
  let form = await fresh(typedForm('Stamped, old frontend'));
  check(S, 'a new publish is stamped', (await http.get(`/api/public/forms/${form.slug}`)).body.definition.evaluation_policy === 'normalized_v1');
  result = await respond([{ fill: ['#q-code', 'yes '] }]);
  stuckCheck(S, 'old frontend, stamped version: "yes " is not stuck', result);
  observe(S, 'old frontend, stamped version, "yes "', { outcome: result.outcome, stored: (await newestResponse('rh_rollout', form.id))?.answers });

  // Old code in an open tab reaches a new form through in-app navigation, no reload and no grace involved.
  const navigated = await published(http, owner.forms, typedForm('Reached by in-app navigation'));
  await open(`/f/${openOld.slug}`, "document.querySelector('#q-code')");
  await evaluate(`(() => { const link = document.createElement('a'); link.href = '/f/${navigated.slug}'; document.querySelector('#main').append(link); link.click(); })()`);
  await waitFor(`location.pathname === '/f/${navigated.slug}' && document.querySelector('#q-code')`, 'in-app navigation');
  result = await respond([{ fill: ['#q-code', 'yes '] }]);
  stuckCheck(S, 'open old tab, in-app navigation to a stamped form: "yes " is not stuck', result);
  observe(S, 'holding publishes', 'a tab open through the hold still reaches versions published after it, by in-app navigation or by the version-changed reload');

  form = await fresh(hiddenChoiceRequired());
  result = await respond([{ pick: '#form-root [name="plan"][value="free"]' }, { pick: '#form-root [name="help"][value="phone"]' }]);
  check(S, 'old frontend, hidden choice on a required question: refused with a visible error', result.outcome === 'shows_error' && result.errors.includes('help'), JSON.stringify(result));
  observe(S, 'message shown for a hidden choice', await evaluate("document.querySelector('#form-root [data-field=help] .field-error')?.textContent"));
  const hiddenCount = await responseCount('rh_rollout', form.id);
  check(S, 'old frontend, hidden choice: nothing stored', hiddenCount === 0);
  check(S, 'old frontend, hidden choice: the message says why', (await evaluate("document.querySelector('#form-root [data-field=help] .field-error')?.textContent")) === 'That choice is not available. Choose another.');
  result = await respond([{ pick: '#form-root [name="help"][value="email"]' }]);
  check(S, 'old frontend, hidden choice: choosing another succeeds', result.outcome === 'accepted', JSON.stringify(result));

  form = await fresh(hiddenChoiceFollowUp());
  result = await respond([{ pick: '#form-root [name="plan"][value="free"]' }, { pick: '#form-root [name="help"][value="phone"]' }]);
  stuckCheck(S, 'old frontend, a hidden choice makes the server want a question the browser hid: not stuck', result);
  if (result.outcome === 'accepted') {
    const stored = JSON.parse((await newestResponse('rh_rollout', form.id)).answers);
    check(S, 'old frontend, same case: the hidden choice is still not stored', !('help' in stored), JSON.stringify(stored));
  }

  form = await fresh(attributionForm(), '?utm_source=partner&utm_medium=x');
  const offered = await evaluate("[...document.querySelectorAll('#form-root [name=help]')].map(input => input.value).join()");
  observe(S, 'old frontend, partner link: choices offered', offered);
  result = await respond([{ pick: '#form-root [name="help"][value="visit"]' }]);
  check(S, 'old frontend, partner link: accepted, not stuck', result.outcome === 'accepted', JSON.stringify(result));
  const attributed = await newestResponse('rh_rollout', form.id);
  observe(S, 'old frontend, partner link: stored', attributed);
  check(S, 'old frontend, partner link: no attribution invented', attributed.attribution === null);

  form = await fresh(pageForm());
  result = await respond([{ pick: '#form-root [name="plan"][value="free"]' }]);
  for (let hop = 0; hop < 3 && result.outcome === 'accepted' === false && !result.errors?.length && result.text && await shown('#form-root [type=submit]') && hop < 2; hop++) result = await submitAndRead();
  stuckCheck(S, 'old frontend, question after a hidden multi-question page: not stuck', result);

  form = await fresh(jumpForm());
  result = await respond([{ pick: '#form-root [name="kind"][value="home"]' }, { fill: ['#q-size', '3'] }]);
  check(S, 'old frontend, a jump it does not know: accepted, skipped answer dropped', result.outcome === 'accepted' && (await newestResponse('rh_rollout', form.id)).answers === '{"kind":"home"}', JSON.stringify(result));

  // What a stuck-free old client does not get to do.
  form = await published(http, owner.forms, typedForm('Crafted, no marker'));
  const crafted = await http.post(`/api/public/forms/${form.slug}/responses`, { answers: { code: 'yes' } });
  check(S, 'no marker: a question the old renderer shows is still required', crafted.status === 400 && Boolean(crafted.body.error.errors.more));
  const invalid = await http.post(`/api/public/forms/${form.slug}/responses`, { answers: { code: 'x'.repeat(301) } });
  check(S, 'no marker: a shown answer is still validated', invalid.status === 400 && Boolean(invalid.body.error.errors.code));
  const hidden = await published(http, owner.forms, attributionForm());
  const craftedHidden = await http.post(`/api/public/forms/${hidden.slug}/responses`, { answers: { help: 'visit' }, url_params: { utm_source: 'partner' } });
  check(S, 'no marker: a hidden choice is still refused', craftedHidden.status === 400);

  // A tab left open while the whole frontend is replaced keeps the code it already loaded.
  await startServer(oldBackend, oldFrontend, 'rh_rollout');
  await open(`/f/${openOld.slug}`, "document.querySelector('#q-code')");
  await stopServer();
  await startServer(newBackend, newFrontend, 'rh_rollout');
  await logIn(http, owner.email);
  const afterFrontend = await published(http, owner.forms, typedForm('After the frontend went live'));
  await evaluate(`(() => { const link = document.createElement('a'); link.href = '/f/${afterFrontend.slug}'; document.querySelector('#main').append(link); link.click(); })()`);
  await waitFor(`location.pathname === '/f/${afterFrontend.slug}' && document.querySelector('#q-code')`, 'in-app navigation after the frontend changed');
  await fill('#q-code', 'yes ');
  check(S, 'old tab after the new frontend is live: still runs old code', !(await shown('#q-more')));
  result = await submitAndRead();
  check(S, 'old tab after the new frontend is live: "yes " is accepted, not stuck', result.outcome === 'accepted', JSON.stringify(result));

  // New code on the new backend, as a baseline: the browser and server agree.
  await startServer(newBackend, newFrontend, 'rh_rollout');
  await logIn(http, owner.email);
  form = await fresh(typedForm('Stamped, new frontend'));
  await fill('#q-code', 'yes ');
  await waitFor("document.querySelector('#q-more')", 'new frontend shows the follow-up');
  result = await submitAndRead();
  check(S, 'new frontend: "yes " shows the follow-up and asks for it', result.outcome === 'shows_error' && result.errors.includes('more'), JSON.stringify(result));
  await fill('#q-more', 'ABC');
  result = await submitAndRead();
  check(S, 'new frontend: answered, it is accepted with both answers', result.outcome === 'accepted' && (await newestResponse('rh_rollout', form.id)).answers === '{"code":"yes","more":"ABC"}', JSON.stringify(result));
  form = await fresh(attributionForm(), '?utm_source=partner');
  check(S, 'new frontend: partner link hides the choice', (await evaluate("[...document.querySelectorAll('#form-root [name=help]')].map(input => input.value).join()")) === 'email,phone');
  result = await respond([{ pick: '#form-root [name="help"][value="email"]' }]);
  check(S, 'new frontend: attribution recorded', result.outcome === 'accepted' && (await newestResponse('rh_rollout', form.id)).attribution === '{"utm_source":"partner"}', JSON.stringify(result));
  const direct = await http.post(`/api/public/forms/${form.slug}/responses`, { answers: { help: 'visit' }, url_params: { utm_source: 'partner' }, evaluator: 2 });
  check(S, 'new frontend contract: server still refuses a hidden choice', direct.status === 400);
  await stopServer();
}

// ---- Cached clients ------------------------------------------------------------------------------
// A returning visitor with the service worker. It only registers on https or on localhost.
// Stands in for Vercel: static files with frontend/vercel.json's cache header, /api passed to the backend.
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
function startEdge(port) {
  const edge = { frontend: null };
  edge.server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      try {
        const headers = { ...request.headers };
        delete headers.host; delete headers.connection; delete headers['content-length'];
        const upstream = await fetch(base + request.url, { method: request.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
        const responseHeaders = Object.fromEntries(upstream.headers);
        delete responseHeaders['content-encoding']; delete responseHeaders['transfer-encoding']; delete responseHeaders['content-length'];
        response.writeHead(upstream.status, responseHeaders);
        response.end(Buffer.from(await upstream.arrayBuffer()));
      } catch { response.writeHead(502); response.end('upstream unavailable'); }
      return;
    }
    const candidate = join(edge.frontend, decodeURIComponent(url.pathname));
    const isFile = candidate.startsWith(edge.frontend) && existsSync(candidate) && statSync(candidate).isFile();
    const file = isFile ? candidate : join(edge.frontend, 'index.html');
    response.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=0, must-revalidate' });
    response.end(readFileSync(file));
  });
  return new Promise(done => edge.server.listen(port, 'localhost', () => done(edge)));
}

async function cachedSection() {
  heading('Cached clients: the service worker across a rollout');
  const S = 'cached';
  await freshDatabase('rh_cached');
  const EDGE = PORT + 100;
  const edge = await startEdge(EDGE);
  edge.frontend = oldFrontend;
  await startServer(oldBackend, oldFrontend, 'rh_cached');
  const http = apiClient();
  const owner = await signUp(http);
  const swForm = await published(http, owner.forms, typedForm('Service worker visitor'));
  await send('Page.navigate', { url: 'http://localhost:' + EDGE + '/f/' + swForm.slug });
  await waitFor("document.readyState === 'complete' && document.querySelector('#q-code')", 'service worker page');
  const ready = await evaluate("Promise.race([navigator.serviceWorker.ready.then(() => 'ready'), new Promise(done => setTimeout(() => done('not ready'), 8000))])");
  observe(S, 'service worker on the previous release', ready);
  if (ready !== 'ready') {
    const detail = await evaluate("fetch('/sw.js').then(r => r.status + ' ' + r.headers.get('content-type')).catch(e => String(e))");
    const shell = await evaluate("Promise.all(['/', '/index.html', '/app.css', '/app.js', '/favicon.svg', '/logo-schedora.png', '/manifest.webmanifest'].map(path => fetch(path).then(r => path + ':' + r.status))).then(list => list.join(' '))");
    observe(S, 'service worker script and shell', detail + ' :: ' + shell);
    check(S, 'service worker installs on the previous release', false, detail);
    await stopServer();
    edge.server.close();
    return;
  }
  // Marks the current document, so a wait can only be satisfied by the one the reload brings.
  const reload = async (ready, label) => { await evaluate('window.__beforeReload = true'); await send('Page.reload'); await waitFor('!window.__beforeReload && document.readyState === "complete" && ' + ready, label, 15000); };
  await reload('navigator.serviceWorker.controller && document.querySelector("#q-code")', 'service worker in control');
  const hasMarker = suffix => evaluate("import('/shared/forms-logic.mjs" + suffix + "').then(module => 'CLIENT_EVALUATOR' in module)");
  check(S, 'service worker: the old code is what is loaded', !(await hasMarker('')));
  await stopServer();
  await startServer(newBackend, newFrontend, 'rh_cached');
  edge.frontend = newFrontend;
  await reload('document.querySelector("#q-code")', 'reload through the service worker');
  check(S, 'service worker: a reload after the rollout runs the new code', await hasMarker(''));
  await logIn(http, owner.email);
  await http.post(owner.forms + '/' + swForm.id + '/publish');
  await reload('document.querySelector("#q-code")', 'reload onto the stamped version');
  await fill('#q-code', 'yes ');
  await waitFor("document.querySelector('#q-more')", 'new code shows the follow-up', 5000);
  check(S, 'service worker: "yes " behaves as the stamped version says', true);
  // Unreachable: what the worker serves from its cache cannot reach a form, so nothing can be submitted.
  await stopServer();
  await new Promise(done => { edge.server.close(done); edge.server.closeAllConnections(); });
  await send('Page.reload');
  await sleep(4000);
  const offline = await evaluate('document.body.innerText.slice(0, 200)');
  observe(S, 'service worker, server unreachable', offline);
  check(S, 'service worker, server unreachable: no form can be submitted from the cache', !(await shown('#q-code')), offline);
  await send('Page.navigate', { url: 'about:blank' });
}

// ---- Rollback ------------------------------------------------------------------------------------
const FIELD_KEYS_LOST = (before, after) => {
  const lost = [];
  for (const key of Object.keys(before)) if (!(key in after)) lost.push(key);
  for (const field of before.fields || []) {
    const kept = after.fields?.find(item => item.id === field.id);
    if (!kept) { lost.push(`question ${field.id}`); continue; }
    for (const key of Object.keys(field)) if (!(key in kept)) lost.push(`${field.id}.${key}`);
  }
  return [...new Set(lost)];
};

async function rollbackSection() {
  heading('Rollback: a staging-style copy with every new kind of form');
  const S = 'rollback';
  // Built the way production would get there: the previous release first, then this tree.
  await freshDatabase('rh_stage');
  await startServer(oldBackend, oldFrontend, 'rh_stage');
  const http = apiClient();
  const owner = await signUp(http);
  const legacy = await published(http, owner.forms, typedForm('From the previous release'));
  await http.post(`/api/public/forms/${legacy.slug}/responses`, { answers: { code: 'no' } });
  await stopServer();
  await startServer(newBackend, newFrontend, 'rh_stage');
  await logIn(http, owner.email);
  const themedTitle = 'Themes, groups and everything else';
  const rich = shell(themedTitle, {
    theme: THEME,
    url_params: [{ key: 'utm_source', record: true }],
    fields: [
      { id: 'plan', type: 'single_choice', label: 'Plan', required: true, options: options('free', 'team') },
      { id: 'help', type: 'single_choice', label: 'Help', required: true, options: options('email', 'phone'), media: { type: 'video', provider: 'youtube', video: 'dQw4w9WgXcQ', title: 'Intro' } },
      { id: 'contact', type: 'page_break', label: 'Contact Info', grouped: true },
      { id: 'first', type: 'short_text', label: 'First name', required: true, placeholder: 'Asha', group: 'contact' },
      { id: 'mail', type: 'email', label: 'Email', required: false, group: 'contact' },
      { id: 'code', type: 'short_text', label: 'Code', required: false },
      { id: 'more', type: 'short_text', label: 'Which code?', required: true, show_if: is('code', 'yes') },
      { id: 'skip', type: 'short_text', label: 'Only without the jump', required: true }
    ],
    choice_rules: [{ field: 'help', rules: [{ when: is('plan', 'free'), hide: ['phone'] }, { when: { param: 'utm_source', op: 'equals', value: 'partner' }, hide: ['email'] }] }],
    logic: [{ field: 'code', rules: [{ when: is('code', 'jump'), to: { type: 'ending', id: 'done' } }] }],
    endings: [{ id: 'thanks', title: 'Thanks' }, { id: 'done', title: 'Jumped' }]
  });
  const form = await published(http, owner.forms, rich);
  const savedTheme = await http.post(`/api/workspaces/${owner.ws}/form-themes`, THEME);
  check(S, 'staging copy: a reusable workspace theme exists', savedTheme.status === 201, JSON.stringify(savedTheme.body));
  const stampedTyped = await published(http, owner.forms, typedForm('Stamped, before rollback'));
  const good = await http.post(`/api/public/forms/${form.slug}/responses`, { answers: { plan: 'team', help: 'email', first: 'A', code: 'jump' }, url_params: { utm_source: 'newsletter' }, evaluator: 2 });
  check(S, 'staging copy: a response with attribution exists before rollback', good.status === 201 && good.body.ending?.id === 'done', JSON.stringify(good.body));
  const beforeRows = JSON.stringify(await q('rh_stage', 'SELECT id, form_version, answers, attribution FROM responses ORDER BY id'));
  const beforeVersions = JSON.stringify(await q('rh_stage', 'SELECT form_id, version, definition FROM form_versions ORDER BY form_id, version'));
  await stopServer();
  await copyDatabase('rh_stage', 'rh_rollback');

  // ---- New frontend still loaded, backend rolled back ----
  heading('Rollback, step 1: backend back to the previous release, new frontend still live');
  await startServer(oldBackend, newFrontend, 'rh_rollback');
  check(S, 'the previous backend starts on the upgraded database', true);
  await open(`/f/${form.slug}`, "document.querySelector('#form-root [name=plan]')");
  await click('#form-root [name="plan"][value="team"]');
  await click('#form-root [name="help"][value="email"]');
  await click('#form-root [type="submit"]');
  await waitFor("document.querySelector('#q-first')", 'contact page');
  await fill('#q-first', 'Asha');
  await click('#form-root [type="submit"]');
  await waitFor("document.querySelector('#q-code')", 'code page');
  await fill('#q-code', 'jump');
  let result = await submitAndRead();
  // The old backend does not know the jump, so it wants a question this browser skipped.
  stuckCheck(S, 'new frontend, previous backend: a question it skipped is required by the server: not stuck', result);
  observe(S, 'new frontend, previous backend, jump', { outcome: result.outcome, errors: result.errors });
  if (result.outcome === 'shows_error') {
    if (await shown('#q-skip')) await fill('#q-skip', 'answered');
    result = await submitAndRead();
    check(S, 'new frontend, previous backend: answering it completes the response', result.outcome === 'accepted', JSON.stringify(result));
  }
  // The browser follows the stamp and the previous server does not: the follow-up is asked, then dropped.
  await open(`/f/${stampedTyped.slug}`, "document.querySelector('#q-code')");
  await fill('#q-code', 'yes ');
  await waitFor("document.querySelector('#q-more')", 'new frontend asks the follow-up');
  await fill('#q-more', 'ABC');
  result = await submitAndRead();
  check(S, 'new frontend, previous backend, stamped "yes ": not stuck', result.outcome === 'accepted', JSON.stringify(result));
  const droppedAnswer = await newestResponse('rh_rollback', stampedTyped.id);
  observe(S, 'new frontend, previous backend, stamped "yes ": stored', droppedAnswer.answers);
  check(S, 'new frontend, previous backend, stamped "yes ": the answer it asked for is lost (a reason not to linger here)', droppedAnswer.answers === '{"code":"yes"}', droppedAnswer.answers);
  const rollbackApi = apiClient();
  await logIn(rollbackApi, owner.email);
  observe(S, 'new builder on the previous backend: reusable themes API', (await rollbackApi.get(`/api/workspaces/${owner.ws}/form-themes`)).status);
  observe(S, 'uploaded form images on the previous backend: public asset route', (await rollbackApi.get(`/api/public/form-assets/${'a'.repeat(32)}`)).status);
  await stopServer();

  // ---- Fully rolled back ----
  heading('Rollback, step 2: previous backend and previous frontend');
  await startServer(oldBackend, oldFrontend, 'rh_rollback');
  await logIn(http, owner.email);
  const live = await http.get(`/api/public/forms/${form.slug}`);
  check(S, 'respondent: a form published on the new release still loads', live.status === 200 && live.body.definition.choice_rules?.length === 1);
  await open(`/f/${form.slug}?utm_source=partner`, "document.querySelector('#form-root [name=plan]')");
  observe(S, 'respondent: choices on a partner link after rollback', await evaluate("[...document.querySelectorAll('#form-root [name=help]')].map(input => input.value).join()"));
  observe(S, 'respondent: theme applied after rollback', await evaluate("getComputedStyle(document.querySelector('.form-page') || document.body).backgroundColor"));
  await click('#form-root [name="plan"][value="free"]');
  await click('#form-root [name="help"][value="phone"]');
  await click('#form-root [type="submit"]');
  await waitFor("document.querySelector('#q-first')", 'contact questions');
  observe(S, 'respondent: a multi-question page after rollback', await evaluate("document.querySelector('.form-page-title')?.textContent || 'no page title; plain questions'"));
  await fill('#q-first', 'Asha');
  await click('#form-root [type="submit"]');
  await waitFor("document.querySelector('#q-code') || document.querySelector('.receipt')", 'next page');
  if (await shown('#q-code')) {
    await fill('#q-code', 'yes ');
    observe(S, 'respondent: "yes " after rollback shows the follow-up', await shown('#q-more'));
    await fill('#q-skip', 'answered');
    result = await submitAndRead();
    check(S, 'respondent: previous frontend and backend agree, not stuck', result.outcome === 'accepted', JSON.stringify(result));
  }
  const after = await newestResponse('rh_rollback', form.id);
  observe(S, 'response written during rollback', after);
  check(S, 'during rollback, a hidden choice IS stored (must be frozen or accepted)', JSON.parse(after.answers).help === 'phone', after.answers);
  check(S, 'during rollback, no attribution is recorded', after.attribution === null);
  const rows = JSON.parse(beforeRows);
  const keptRows = JSON.stringify(await q('rh_rollback', `SELECT id, form_version, answers, attribution FROM responses WHERE id = ANY($1) ORDER BY id`, [rows.map(row => row.id)]));
  check(S, 'existing responses, including attribution, are not changed', keptRows === beforeRows);
  check(S, 'existing published versions are not changed', JSON.stringify(await q('rh_rollback', 'SELECT form_id, version, definition FROM form_versions ORDER BY form_id, version')) === beforeVersions);
  const oldCsv = (await http.get(`${owner.forms}/${form.id}/responses.csv`)).body;
  observe(S, 'previous inbox and CSV show attribution', oldCsv.includes('Attribution') || oldCsv.includes('newsletter'));

  // An author who only opens and saves.
  const opened = (await http.get(`${owner.forms}/${form.id}`)).body;
  check(S, 'author: the previous builder API still returns the full draft', Boolean(opened.draft.choice_rules && opened.draft.theme && opened.draft.url_params));
  await open(`/forms/${form.id}`, "document.querySelector('#save') || document.querySelector('#main h1')");
  check(S, 'author: the previous builder opens the form without a page error', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300));
  const saved = await http.patch(`${owner.forms}/${form.id}`, { definition: opened.draft, base_revision: opened.revision });
  observe(S, 'author save on the previous backend: status', saved.status);
  const lost = saved.status === 200 ? FIELD_KEYS_LOST(opened.draft, saved.body.draft) : [];
  observe(S, 'author save on the previous backend: settings removed from the draft', lost);
  check(S, 'author save on the previous backend removes new settings (must be frozen)', lost.includes('choice_rules') && lost.includes('url_params') && lost.includes('theme'), lost.join());
  const republished = await http.post(`${owner.forms}/${form.id}/publish`);
  const newestVersion = (await q('rh_rollback', 'SELECT version, definition FROM form_versions WHERE form_id = $1 ORDER BY version DESC LIMIT 1', [form.id]))[0];
  observe(S, 'author publish on the previous backend', { status: republished.status, version: newestVersion.version, keeps_new_settings: /choice_rules|evaluation_policy|url_params/.test(newestVersion.definition) });
  await stopServer();

  // ---- Forward again ----
  heading('Roll forward again on the same data');
  await startServer(newBackend, newFrontend, 'rh_rollback');
  await logIn(http, owner.email);
  check(S, 'roll forward: the new backend starts with no migration repeated', (await q('rh_rollback', "SELECT COUNT(*) AS count FROM schema_migrations WHERE name = 'postgres_v16_response_attribution'"))[0].count === '1');
  const forward = (await http.get(`${owner.forms}/${form.id}`)).body;
  check(S, 'roll forward: settings removed by a save during rollback do NOT come back', !forward.draft.choice_rules && !forward.draft.url_params);
  const versionTwo = (await q('rh_rollback', 'SELECT definition FROM form_versions WHERE form_id = $1 AND version = 1', [form.id]))[0];
  check(S, 'roll forward: they remain in the published version they went live with', /choice_rules/.test(versionTwo.definition) && /url_params/.test(versionTwo.definition) && /"theme"/.test(versionTwo.definition));
  const listed = (await http.get(`${owner.forms}/${form.id}/responses`)).body.responses;
  check(S, 'roll forward: earlier attribution is back in the inbox', listed.some(row => row.attribution?.utm_source === 'newsletter'));
  check(S, 'roll forward: the CSV shows it', (await http.get(`${owner.forms}/${form.id}/responses.csv`)).body.includes('newsletter'));
  check(S, 'roll forward: the reusable theme is still there', (await http.get(`/api/workspaces/${owner.ws}/form-themes`)).body.themes?.length === 1 || (await http.get(`/api/workspaces/${owner.ws}/form-themes`)).body.length === 1);
  const untouched = (await http.get(`${owner.forms}/${stampedTyped.id}`)).body;
  check(S, 'roll forward: a form nobody saved during the rollback is unchanged and not flagged', untouched.has_unpublished_changes === false && !untouched.legacy_text_comparison);
  const newVersionAfter = (await q('rh_rollback', 'SELECT definition FROM form_versions WHERE form_id = $1 AND version = 2', [form.id]))[0].definition;
  check(S, 'roll forward: a version published during the rollback stays without the new settings or the policy', !/choice_rules|evaluation_policy/.test(newVersionAfter));
  await stopServer();
}

// ---- Authoring freeze ----------------------------------------------------------------------------
async function freezeSection() {
  heading('Freeze, rollback and recovery: synthetic data, drafts holding settings the previous code cannot keep');
  const S = 'freeze';
  const rollbackBackend = join(rollbackRoot, 'backend');
  const rollbackFrontend = join(rollbackRoot, 'frontend');
  const FROZEN = { FORMS_AUTHORING_FREEZE: 'true' };

  // Upgrade, then an author's work: one form live, and one draft whose newest settings exist nowhere else.
  await freshDatabase('rh_freeze');
  await startServer(oldBackend, oldFrontend, 'rh_freeze');
  const http = apiClient();
  const owner = await signUp(http);
  const older = await published(http, owner.forms, typedForm('Published before the upgrade'));
  await startServer(newBackend, newFrontend, 'rh_freeze');
  await logIn(http, owner.email);
  const rich = shell('Newer settings', {
    theme: THEME, url_params: [{ key: 'utm_source', record: true }],
    fields: [
      { id: 'plan', type: 'single_choice', label: 'Plan', required: true, options: options('free', 'team') },
      { id: 'help', type: 'single_choice', label: 'Help', required: true, options: options('email', 'phone'), media: { type: 'video', provider: 'youtube', video: 'dQw4w9WgXcQ', title: 'Intro' } },
      { id: 'contact', type: 'page_break', label: 'Contact Info', grouped: true },
      { id: 'first', type: 'short_text', label: 'First name', required: true, placeholder: 'Asha', group: 'contact' },
      { id: 'code', type: 'short_text', label: 'Code', required: false }
    ],
    choice_rules: [{ field: 'help', rules: [{ when: is('plan', 'free'), hide: ['phone'] }] }],
    logic: [{ field: 'code', rules: [{ when: is('code', 'jump'), to: { type: 'ending', id: 'done' } }] }],
    endings: [{ id: 'thanks', title: 'Thanks' }, { id: 'done', title: 'Jumped' }]
  });
  const live = await published(http, owner.forms, rich);
  const liveEdit = await http.patch(`${owner.forms}/${live.id}`, { definition: { ...rich, title: 'Newer settings, edited after publishing' }, base_revision: live.revision });
  check(S, 'a live form has an unpublished edit', liveEdit.status === 200 && liveEdit.body.has_unpublished_changes === true);
  const draftOnly = (await http.post(owner.forms, { definition: { ...rich, title: 'Draft never published' } })).body;
  const theme = await http.post(`/api/workspaces/${owner.ws}/form-themes`, THEME);
  const first = await http.post(`/api/public/forms/${live.slug}/responses`, { answers: { plan: 'team', help: 'phone', first: 'Asha', code: 'jump' }, url_params: { utm_source: 'newsletter' }, evaluator: 2 });
  check(S, 'a response with attribution exists', first.status === 201);
  // Scoped to this workspace: other people's deletions below must not disturb it, and that is checked too.
  const drafts = () => q('rh_freeze', 'SELECT id, draft, routing, draft_revision, published_version FROM forms WHERE workspace_id = $1 ORDER BY id', [owner.ws]).then(JSON.stringify);
  const versions = () => q('rh_freeze', 'SELECT form_id, version, definition FROM form_versions WHERE form_id IN (SELECT id FROM forms WHERE workspace_id = $1) ORDER BY form_id, version', [owner.ws]).then(JSON.stringify);
  const themes = () => q('rh_freeze', 'SELECT id, name, tokens, revision FROM form_themes WHERE workspace_id = $1 ORDER BY id', [owner.ws]).then(JSON.stringify);
  // Someone else's workspaces, to delete during the freeze. Deleting is a separate operation from authoring.
  const others = async () => { const client = apiClient(); const account = await signUp(client); await published(client, account.forms, typedForm('Belongs to someone else')); return { client, account }; };
  const separate = { release: { workspace: await others(), person: await others() }, rollback: { workspace: await others(), person: await others() } };
  const before = { drafts: await drafts(), versions: await versions(), themes: await themes() };
  const unchanged = async () => (await drafts()) === before.drafts && (await versions()) === before.versions && (await themes()) === before.themes;

  // Snapshot, as the deploy and rollback order says to.
  await stopServer();
  await copyDatabase('rh_freeze', 'rh_freeze_snapshot');
  const snapshotCount = Number((await q('rh_freeze_snapshot', 'SELECT COUNT(*) AS count FROM responses'))[0].count);
  check(S, 'snapshot taken', snapshotCount === 1, String(snapshotCount));

  // Every write an author can send, directly. Themes and images do not exist on the rollback build, which is fine as long as nothing is written.
  const attempts = (hasNewRoutes) => [
    ['POST', owner.forms, { definition: shell('New', { fields: [{ id: 'q', type: 'short_text', label: 'Q', required: false }] }) }],
    ['PATCH', `${owner.forms}/${draftOnly.id}`, { definition: { title: 'Stripped', description: '', presentation: 'classic', submit_label: 'Send', fields: [{ id: 'q', type: 'short_text', label: 'Q', required: false }] }, base_revision: draftOnly.revision }],
    ['PATCH', `${owner.forms}/${draftOnly.id}`, { definition: rich }],
    ['DELETE', `${owner.forms}/${draftOnly.id}`],
    ['PUT', `${owner.forms}/${draftOnly.id}/routing`, { routing: null }],
    ['POST', `${owner.forms}/${live.id}/publish`, {}],
    ['POST', `${owner.forms}/${live.id}/unpublish`, {}],
    ...(hasNewRoutes ? [
      ['POST', `/api/workspaces/${owner.ws}/form-themes`, THEME],
      ['PATCH', `/api/workspaces/${owner.ws}/form-themes/${theme.body.id}`, THEME],
      ['DELETE', `/api/workspaces/${owner.ws}/form-themes/${theme.body.id}`],
      ['POST', `/api/workspaces/${owner.ws}/form-assets`, { image: 'x' }]
    ] : [])
  ];
  const directWrites = async (label, hasNewRoutes) => {
    const raw = async (method, path, body) => method === 'POST' ? http.post(path, body) : method === 'PATCH' ? http.patch(path, body) : method === 'PUT' ? http.put(path, body) : http.del(path);
    const refused = [];
    for (const [method, path, body] of attempts(hasNewRoutes)) { const result = await raw(method, path, body); refused.push(`${method}:${result.status}`); check(S, `${label}: ${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')} is refused`, result.status === 423 && result.body?.error?.code === 'forms_authoring_frozen', JSON.stringify(result.body).slice(0, 160)); }
    check(S, `${label}: nothing changed in drafts, versions or themes`, await unchanged());
  };
  // The builder, as an author sees it: told first, then the server refuses even if the page is forced.
  const uiWrites = async label => {
    await evaluate(`fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ${JSON.stringify(owner.email)}, password: 'a sufficiently long password' }) })`);
    await open(`/forms/${draftOnly.id}`, "document.querySelector('#save') && document.querySelector('[data-authoring-frozen]')");
    check(S, `${label}: the builder says editing is paused and disables Save and Publish`, await evaluate("document.querySelector('#save').disabled && document.querySelector('#publish').disabled"));
    await evaluate("(() => { const save = document.querySelector('#save'); save.disabled = false; save.removeAttribute('aria-disabled'); document.querySelector('#f-title')?.dispatchEvent(new Event('input', { bubbles: true })); save.click(); })()");
    await waitFor("document.querySelector('#builder-notice').innerText.includes('paused while a release is in progress') && document.querySelector('#builder-notice').innerText.includes('Not saved')", label + ': a forced save is refused and says so');
    check(S, `${label}: a forced save from the page is refused`, true);
    const publish = await evaluate(`(async () => { const me = await (await fetch('/api/me')).json(); const r = await fetch('/api/workspaces/${owner.ws}/forms/${live.id}/publish', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: '{}' }); return r.status; })()`);
    check(S, `${label}: a publish sent from the signed-in page is refused`, publish === 423, String(publish));
    await evaluate('delete document.body.dataset.dirty');
    await open('/forms', "document.querySelector('#main h1')");
    const createButton = await evaluate("Boolean(document.querySelector('[data-template]'))");
    if (createButton) {
      const count = async () => Number((await q('rh_freeze', 'SELECT COUNT(*) AS count FROM forms'))[0].count);
      const formsBefore = await count();
      await click('[data-template]');
      await sleep(1500);
      check(S, `${label}: creating a form from the dashboard creates nothing`, (await count()) === formsBefore);
    }
    check(S, `${label}: nothing changed after using the builder`, await unchanged());
    check(S, `${label}: no page errors in the builder`, pageErrors.length === 0, pageErrors.join(' | ').slice(0, 240));
  };
  const deletionsWork = async (label, { workspace, person }) => {
    const formsOf = async ws => Number((await q('rh_freeze', 'SELECT COUNT(*) AS count FROM forms WHERE workspace_id = $1', [ws]))[0].count);
    await logIn(workspace.client, workspace.account.email);
    check(S, `${label}: the other workspace has its form before deleting`, (await formsOf(workspace.account.ws)) === 1);
    const unconfirmed = await workspace.client.del(`/api/workspaces/${workspace.account.ws}`, { confirm: 'wrong name' });
    check(S, `${label}: deleting a workspace still needs its name typed`, unconfirmed.status === 400 && (await formsOf(workspace.account.ws)) === 1, JSON.stringify(unconfirmed.body).slice(0, 160));
    const removedWorkspace = await workspace.client.del(`/api/workspaces/${workspace.account.ws}`, { confirm: workspace.account.wsName });
    check(S, `${label}: deleting a workspace remains available, and removes its forms`, removedWorkspace.status === 204 && (await formsOf(workspace.account.ws)) === 0, JSON.stringify(removedWorkspace.body).slice(0, 160));
    await logIn(person.client, person.account.email);
    const wrongPassword = await person.client.del('/api/me', { password: 'not the password' });
    check(S, `${label}: deleting an account still needs the password`, wrongPassword.status === 401 && (await formsOf(person.account.ws)) === 1, JSON.stringify(wrongPassword.body).slice(0, 160));
    const removedAccount = await person.client.del('/api/me', { password: 'a sufficiently long password' });
    check(S, `${label}: deleting an account remains available, and removes the forms of a workspace it alone owned`, removedAccount.status === 204 && (await formsOf(person.account.ws)) === 0, JSON.stringify(removedAccount.body).slice(0, 160));
    check(S, `${label}: those deletions left every other form untouched`, await unchanged());
  };
  const respondentsWork = async (label, frontendIsNew) => {
    const direct = await apiClient().post(`/api/public/forms/${live.slug}/responses`, { answers: { plan: 'team', help: 'email', first: 'Direct', code: 'x' }, ...(frontendIsNew ? { evaluator: 2 } : {}) });
    check(S, `${label}: a public submission is accepted`, direct.status === 201, JSON.stringify(direct.body).slice(0, 200));
    await open(`/f/${older.slug}`, "document.querySelector('#q-code')");
    await fill('#q-code', 'no');
    const result = await submitAndRead();
    check(S, `${label}: a respondent completes a form in the browser`, result.outcome === 'accepted', JSON.stringify(result).slice(0, 200));
  };

  // 1. Freeze the running release, before anything is rolled back.
  await startServer(newBackend, newFrontend, 'rh_freeze', FROZEN);
  await logIn(http, owner.email);
  check(S, 'freeze on the release: public config says so', (await http.get('/api/config')).body.formsAuthoringFrozen === true);
  await directWrites('release frozen', true);
  await uiWrites('release frozen');
  await respondentsWork('release frozen', true);
  await deletionsWork('release frozen', separate.release);

  // 2. Backend back first would leave a new page on the rollback build: still refused, by the server.
  await startServer(rollbackBackend, newFrontend, 'rh_freeze', FROZEN);
  await logIn(http, owner.email);
  await uiWrites('rollback backend, new frontend');
  await directWrites('rollback backend, new frontend', false);

  // 3. Fully on the rollback build.
  await startServer(rollbackBackend, rollbackFrontend, 'rh_freeze', FROZEN);
  await logIn(http, owner.email);
  await directWrites('rollback build', false);
  await uiWrites('rollback build');
  await respondentsWork('rollback build', false);
  await deletionsWork('rollback build', separate.rollback);

  // The rollback build as a real production-mode server, with no freeze setting at all.
  await startServer(rollbackBackend, rollbackFrontend, 'rh_freeze', { NODE_ENV: 'production', RELEASE_MODE: 'evaluation', BILLING_MODE: 'open', BILLING_PROVIDER: 'none', APP_ENCRYPTION_KEY: 'a'.repeat(64) });
  await logIn(http, owner.email);
  check(S, 'rollback build, production mode, no override: starts frozen', (await http.get('/api/config')).body.formsAuthoringFrozen === true);
  const unset = await http.patch(`${owner.forms}/${draftOnly.id}`, { definition: shell('Stripped', { fields: [{ id: 'q', type: 'short_text', label: 'Q', required: false }] }), base_revision: draftOnly.revision });
  check(S, 'rollback build, production mode, no override: a save is refused', unset.status === 423 && unset.body?.error?.code === 'forms_authoring_frozen', JSON.stringify(unset.body).slice(0, 160));
  const unsetPublish = await http.post(`${owner.forms}/${live.id}/publish`);
  check(S, 'rollback build, production mode, no override: a publish is refused', unsetPublish.status === 423, JSON.stringify(unsetPublish.body).slice(0, 160));
  await respondentsWork('rollback build, production mode', false);
  check(S, 'rollback build, production mode: nothing changed', await unchanged());
  const opened = (await http.get(`${owner.forms}/${draftOnly.id}`)).body;
  check(S, 'rollback build: the draft is still readable with every newer setting', Boolean(opened.draft.choice_rules && opened.draft.url_params && opened.draft.theme && opened.draft.logic && opened.draft.endings));
  const lived = await apiClient().get(`/api/public/forms/${live.slug}`);
  check(S, 'rollback build: the public form still loads', lived.status === 200);
  const afterRollback = Number((await q('rh_freeze', 'SELECT COUNT(*) AS count FROM responses'))[0].count);

  // 4. Roll forward, unfrozen: nothing lost, and authoring resumes at the same revision.
  await startServer(newBackend, newFrontend, 'rh_freeze');
  await logIn(http, owner.email);
  check(S, 'roll forward: drafts, versions and themes are byte for byte what they were', await unchanged());
  const forward = (await http.get(`${owner.forms}/${draftOnly.id}`)).body;
  const keeps = definition => Boolean(definition.choice_rules && definition.url_params && definition.theme && definition.logic && definition.endings && definition.fields.find(field => field.id === 'first').group === 'contact' && definition.fields.find(field => field.id === 'first').placeholder === 'Asha' && definition.fields.find(field => field.id === 'help').media);
  check(S, 'roll forward: the never-published draft kept every newer setting', keeps(forward.draft));
  const liveForward = (await http.get(`${owner.forms}/${live.id}`)).body;
  check(S, 'roll forward: the unpublished edit on a live form is still there', liveForward.draft.title === 'Newer settings, edited after publishing' && liveForward.has_unpublished_changes === true && keeps(liveForward.draft));
  const listed = (await http.get(`${owner.forms}/${live.id}/responses`)).body.responses;
  check(S, 'roll forward: attribution from before the rollback is intact', listed.some(row => row.attribution?.utm_source === 'newsletter'));
  check(S, 'roll forward: responses taken during the freeze and rollback are kept', Number((await q('rh_freeze', 'SELECT COUNT(*) AS count FROM responses'))[0].count) === afterRollback && afterRollback > snapshotCount);
  const resumed = await http.patch(`${owner.forms}/${draftOnly.id}`, { definition: { ...forward.draft, title: 'Edited after recovery' }, base_revision: forward.revision });
  check(S, 'roll forward: an author can save at the same revision, keeping the settings', resumed.status === 200 && keeps(resumed.body.draft) && resumed.body.draft.title === 'Edited after recovery');
  const republished = await http.post(`${owner.forms}/${draftOnly.id}/publish`);
  check(S, 'roll forward: and publish', republished.status === 200 && republished.body.published_version === 1);
  const newest = (await q('rh_freeze', 'SELECT definition FROM form_versions WHERE form_id = $1 ORDER BY version DESC LIMIT 1', [draftOnly.id]))[0].definition;
  check(S, 'roll forward: the new version has the settings and the policy', keeps(JSON.parse(newest)) && JSON.parse(newest).evaluation_policy === 'normalized_v1');
  await stopServer();

  // 5. Recovery: the snapshot is usable on its own.
  await copyDatabase('rh_freeze_snapshot', 'rh_freeze_restored');
  await startServer(newBackend, newFrontend, 'rh_freeze_restored');
  await logIn(http, owner.email);
  const restoredDraft = (await http.get(`${owner.forms}/${draftOnly.id}`)).body;
  check(S, 'recovery from the snapshot: the draft is back as it was', keeps(restoredDraft.draft) && restoredDraft.draft.title === 'Draft never published' && restoredDraft.published_version === null);
  check(S, 'recovery from the snapshot: it holds only what existed then', Number((await q('rh_freeze_restored', 'SELECT COUNT(*) AS count FROM responses'))[0].count) === snapshotCount);
  observe(S, 'recovery note', `restoring the snapshot would lose the ${afterRollback - snapshotCount} responses taken after it, so roll forward instead unless the data itself is damaged`);
  check(S, 'recovery from the snapshot: a live form answers', (await apiClient().post(`/api/public/forms/${live.slug}/responses`, { answers: { plan: 'team', help: 'email', first: 'After', code: 'x' }, evaluator: 2 })).status === 201);
  await stopServer();
}

// ---- Run -----------------------------------------------------------------------------------------
let crashed = null;
try {
  if (only.includes('upgrade')) await upgradeSection();
  if (only.includes('rollout')) await rolloutSection();
  if (only.includes('cached')) await cachedSection();
  if (only.includes('rollback')) await rollbackSection();
  if (only.includes('freeze')) await freezeSection();
} catch (error) { crashed = error; console.error('\nRehearsal stopped: ' + (error.stack || error)); }
await stopServer();
socket.close();
browser.kill();
await sleep(500);
try { rmSync(workDir, { recursive: true, force: true }); } catch { /* the browser may still be closing */ }
const failed = results.filter(result => !result.ok);
console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed${crashed ? ', stopped early' : ''}.`);
for (const item of failed) console.log(`  FAILED [${item.section}] ${item.name}`);
// In CI, annotations stay readable without signing in to download the log.
if (process.env.GITHUB_ACTIONS) {
  for (const item of failed.slice(0, 9)) console.log(`::error::[${item.section}] ${item.name} :: ${String(item.detail).replace(/\s+/g, ' ').slice(0, 300)}`);
  if (crashed) console.log(`::error::Rehearsal stopped: ${String(crashed.message || crashed).replace(/\s+/g, ' ').slice(0, 400)}`);
  console.log(`::notice::Rehearsal: ${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed${crashed ? ', stopped early' : ''}.`);
}
if (argument('--json')) writeFileSync(argument('--json'), JSON.stringify({ results, observations, crashed: crashed ? String(crashed) : null }, null, 2));
process.exit(failed.length || crashed ? 1 : 0);
