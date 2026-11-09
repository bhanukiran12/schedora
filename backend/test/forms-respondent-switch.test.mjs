// The deployment switch for respondent sign-in (FORMS_RESPONDENT_SIGNIN, docs/FORMS.md "Respondent sign-in").
// Off by default. While off, sign-in-only forms fail closed for everyone, including requests carrying a
// valid respondent session; authors cannot require sign-in or publish such a form; public forms and
// workspace member SSO keep working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadConfig, publicConfig } from '../src/config.mjs';
import { setup, signUp } from './helpers.mjs';

const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const definition = { title: 'Placement check-in', presentation: 'classic', fields: [
  { id: 'batch', type: 'single_choice', label: 'Batch', required: true, options: [{ id: 'jan', label: 'January' }, { id: 'jul', label: 'July' }] }
] };
const answers = { batch: 'jan' };

test('the switch is off unless FORMS_RESPONDENT_SIGNIN is exactly "enabled", and the browser is told', () => {
  assert.equal(loadConfig({}).respondentSignin, false);
  for (const value of ['true', '1', 'on', 'ENABLED', 'enabled ']) assert.equal(loadConfig({ FORMS_RESPONDENT_SIGNIN: value }).respondentSignin, false, value);
  assert.equal(loadConfig({ FORMS_RESPONDENT_SIGNIN: 'enabled' }).respondentSignin, true);
  assert.equal(publicConfig(loadConfig({})).respondentSignin, false);
  assert.equal(publicConfig(loadConfig({ FORMS_RESPONDENT_SIGNIN: 'enabled' })).respondentSignin, true);
});

// A workspace with SSO, a sign-in-only form that was protected while the switch was on, a public form,
// and a respondent session that was valid before the switch went off.
async function world() {
  const env = await setup({ config: { respondentSignin: true } });
  const issuer = 'https://idp.example.com';
  env.app.fetchProvider = async url => json(url.endsWith('/.well-known/openid-configuration') ? { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` } : { keys: [] });
  const owner = env.client();
  const { ws } = await signUp(owner, 'Switch');
  const forms = `/api/workspaces/${ws.id}/forms`;
  assert.equal((await owner.raw('PUT', `/api/workspaces/${ws.id}/sso`, { issuer, client_id: 'schedora-app', client_secret: 'idp-secret', email_domain: 'nxtwave.in' })).status, 200);
  const make = async () => { const form = (await owner.post(forms, { definition })).body; assert.equal((await owner.post(`${forms}/${form.id}/publish`, {})).status, 200); return form; };
  const protectedForm = await make();
  const publicForm = await make();
  assert.equal((await owner.raw('PUT', `${forms}/${protectedForm.id}/access`, { access: 'signin' })).status, 200);
  const token = 'r'.repeat(43);
  env.app.db.run('INSERT INTO respondent_sessions (token_hash, workspace_id, issuer, subject, email, name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    createHash('sha256').update(token).digest('hex'), ws.id, issuer, 'student-7', 'asha@nxtwave.in', 'Asha', env.clock.now, env.clock.now + 3600000);
  const session = `schedora_respondent=${token}`;
  const call = (method, path, { body, cookie } = {}) => fetch(env.base + path, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', Origin: env.base, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  // Switched on, the session opens the protected form: the setup is real.
  assert.equal((await call('GET', `/api/public/forms/${protectedForm.slug}`, { cookie: session })).status, 200);
  env.app.config.respondentSignin = false; // the deployment switch goes off
  const responses = id => env.app.db.get('SELECT COUNT(*) AS count FROM responses WHERE form_id = ?', id).count;
  return { env, owner, ws, forms, protectedForm, publicForm, session, call, responses, issuer };
}

test('switched off: a sign-in-only form refuses access and submission for everyone, even with a valid respondent session', async () => {
  const { env, protectedForm, session, call, responses } = await world();
  try {
    for (const cookie of [undefined, session]) {
      const opened = await call('GET', `/api/public/forms/${protectedForm.slug}`, { cookie });
      const body = await opened.json();
      assert.equal(opened.status, 503, `open with${cookie ? '' : 'out'} a session`);
      assert.equal(body.error.code, 'signin_unavailable');
      assert.equal(body.error.reason, 'switched_off');
      assert.ok(!JSON.stringify(body).includes('Batch'), 'no question is revealed');
      const sent = await call('POST', `/api/public/forms/${protectedForm.slug}/responses`, { cookie, body: { answers, submission_id: `switch-off-${cookie ? 'session' : 'anon'}-0001` } });
      assert.equal(sent.status, 503, `submit with${cookie ? '' : 'out'} a session`);
    }
    assert.equal(responses(protectedForm.id), 0, 'nothing was stored');
    // Starting a respondent sign-in goes back to the form with a reason, never to the provider.
    const start = await call('GET', `/api/public/forms/${protectedForm.slug}/signin`);
    assert.equal(start.status, 302);
    assert.match(start.headers.get('location'), new RegExp(`^/f/${protectedForm.slug}\\?signin_error=`));
    assert.ok(!(start.headers.getSetCookie?.() || []).some(cookie => cookie.startsWith('schedora_sso_respondent=') && !cookie.includes('Max-Age=0')), 'no sign-in flow is started');
  } finally { await env.close(); }
});

test('switched off: authors cannot require sign-in or publish a sign-in-only form, and can reopen it to everyone', async () => {
  const { env, owner, forms, protectedForm, publicForm, call, responses } = await world();
  try {
    const refused = await owner.raw('PUT', `${forms}/${publicForm.id}/access`, { access: 'signin' });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error.code, 'respondent_signin_disabled');
    assert.equal((await owner.get(`${forms}/${publicForm.id}`)).body.access, 'public', 'the public form stays public');
    const publish = await owner.raw('POST', `${forms}/${protectedForm.id}/publish`, {});
    assert.equal(publish.status, 400);
    assert.equal(publish.body.error.field, 'access');
    const check = (await owner.post(`${forms}/${protectedForm.id}/publish-check`, {})).body;
    assert.equal(check.can_publish, false);
    assert.equal((await owner.get(`${forms}/${protectedForm.id}`)).body.published_version, 1, 'no new version was published');
    // Public forms keep working throughout.
    assert.equal((await call('GET', `/api/public/forms/${publicForm.slug}`)).status, 200);
    assert.equal((await call('POST', `/api/public/forms/${publicForm.slug}/responses`, { body: { answers, submission_id: 'switch-off-public-0001' } })).status, 201);
    assert.equal(responses(publicForm.id), 1);
    // Reopening to everyone is always allowed, and the form answers again.
    assert.equal((await owner.raw('PUT', `${forms}/${protectedForm.id}/access`, { access: 'public' })).status, 200);
    assert.equal((await call('GET', `/api/public/forms/${protectedForm.slug}`)).status, 200);
    assert.equal((await call('POST', `/api/public/forms/${protectedForm.slug}/responses`, { body: { answers, submission_id: 'switch-off-reopened-01' } })).status, 201);
  } finally { await env.close(); }
});

test('switched off: workspace member single sign-on still starts at the identity provider', async () => {
  const { env, call, issuer } = await world();
  try {
    const start = await call('GET', '/api/auth/sso/start?email=jo@nxtwave.in');
    assert.equal(start.status, 302);
    assert.ok(start.headers.get('location').startsWith(`${issuer}/authorize?`), start.headers.get('location'));
  } finally { await env.close(); }
});
