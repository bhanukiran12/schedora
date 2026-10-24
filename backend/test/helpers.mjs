import { createApp } from '../src/app.mjs';
import { randomUUID } from 'node:crypto';
import { openPostgres } from '../src/postgres.mjs';
import { loadConfig } from '../src/config.mjs';

export const START = Date.UTC(2026, 9, 24, 6, 0); // Saturday 24 October 2026, 06:00 UTC

// Boots the real HTTP server on an in-memory database with a controllable clock and fake providers.
export async function setup({ config = {}, db } = {}) {
  const testSchema = !db && process.env.RUN_POSTGRES_TESTS === 'true' ? 'schedora_test_' + randomUUID().replaceAll('-', '') : null;
  if (testSchema) {
    const settings = loadConfig();
    if (!settings.databaseUrl) throw new Error('DATABASE_URL is required for opt-in PostgreSQL tests.');
    db = openPostgres(settings.databaseUrl, { ca: settings.databaseCa, schemaName: testSchema });
  }
  const clock = { now: START };
  const sent = [];
  const emailProvider = {
    name: 'fake', mode: 'ok',
    async send(message) {
      if (this.mode === 'transient') throw new Error('provider unavailable');
      if (this.mode === 'permanent') throw Object.assign(new Error('mailbox rejected'), { permanent: true });
      sent.push(message);
      return { id: 'msg-' + sent.length };
    }
  };
  const feeds = new Map();
  const app = createApp({
    ...(db ? { db } : {}),
    databasePath: ':memory:', now: () => clock.now, emailProvider, log: () => {},
    fetchCalendar: async url => { const feed = feeds.get(url); if (feed instanceof Error) throw feed; if (!feed) throw new Error('unknown feed'); return feed; },
    configOverrides: { billingMode: 'open', billingProvider: 'test', billingWebhookSecret: 'whsec_test', baseUrl: 'http://localhost:3000', ...config }
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, clock, sent, emailProvider, feeds, base, client: () => client(base), close: async () => {
    await app.stop();
    if (testSchema) { try { db.exec('DROP SCHEMA "' + testSchema + '" CASCADE'); } finally { db.close(); } }
  } };
}

export function client(base) {
  let cookie = '';
  let csrf = '';
  const request = async (method, path, body, headers = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0].endsWith('=') ? '' : setCookie.split(';')[0];
    const text = await response.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    if (parsed?.csrf_token) csrf = parsed.csrf_token;
    return { status: response.status, body: parsed, headers: response.headers };
  };
  return {
    get: (path, headers) => request('GET', path, undefined, headers),
    post: (path, body = {}, headers) => request('POST', path, body, headers),
    patch: (path, body = {}, headers) => request('PATCH', path, body, headers),
    del: (path, body, headers) => request('DELETE', path, body, headers),
    raw: request,
    forgetCsrf() { csrf = ''; },
    get csrf() { return csrf; }
  };
}

let counter = 0;
export async function signUp(http, name = 'Host') {
  const email = `${name.toLowerCase().replace(/\W/g, '')}${++counter}@example.com`;
  const response = await http.post('/api/auth/signup', { name, email, password: 'a sufficiently long password', workspace: `${name} Studio ${counter}` });
  if (response.status !== 201) throw new Error('signup failed: ' + JSON.stringify(response.body));
  return { email, user: response.body.user, ws: response.body.workspaces[0] };
}

export async function publishedEventType(http, ws, overrides = {}) {
  const response = await http.post(`/api/workspaces/${ws.id}/event-types`, { title: 'Intro call', timezone: 'Asia/Kolkata', published: true, min_notice_min: 0, ...overrides });
  if (response.status !== 201) throw new Error('event type failed: ' + JSON.stringify(response.body));
  return response.body;
}

let keyCounter = 0;
export const idem = () => ({ 'Idempotency-Key': 'test-key-' + String(++keyCounter).padStart(10, '0') });
