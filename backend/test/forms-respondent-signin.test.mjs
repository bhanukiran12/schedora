// Respondent sign-in (docs/FORMS.md, "Respondent sign-in"): a per-form setting enforced by the server on
// form access and on submission, through the workspace's own identity provider. Respondents never become
// users, members or editors, and every existing link stays public.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import { client, setup, signUp } from './helpers.mjs';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const definition = { title: 'Placement check-in', presentation: 'classic', fields: [
  { id: 'student_id', type: 'short_text', label: 'Student ID', required: true },
  { id: 'batch', type: 'single_choice', label: 'Batch', required: true, options: [{ id: 'jan', label: 'January' }, { id: 'jul', label: 'July' }] }
] };
const answers = { student_id: 'NW-1', batch: 'jan' };

// A workspace with SSO on a mock identity provider, a published form, and helpers that sign respondents in.
async function world() {
  const env = await setup();
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const issuer = 'https://idp.example.com';
  const pending = [];
  env.app.fetchProvider = async (url, init = {}) => {
    if (url === `${issuer}/.well-known/openid-configuration`) return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    if (url === `${issuer}/jwks`) return json({ keys: [jwk] });
    if (url === `${issuer}/token`) {
      const claims = pending.shift();
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url');
      const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
      return json({ id_token: `${header}.${body}.${rsaSign('sha256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url')}` });
    }
    return json({}, 404);
  };
  const owner = env.client();
  const { ws, user } = await signUp(owner, 'Placement');
  assert.equal((await owner.raw('PUT', `/api/workspaces/${ws.id}/sso`, { issuer, client_id: 'schedora-app', client_secret: 'idp-secret', email_domain: 'nxtwave.in' })).status, 200);
  const form = (await owner.post(`/api/workspaces/${ws.id}/forms`, { definition })).body;
  assert.equal((await owner.post(`/api/workspaces/${ws.id}/forms/${form.id}/publish`, {})).status, 200);
  const forms = `/api/workspaces/${ws.id}/forms`;
  // Runs the whole browser round trip and returns the respondent cookie, or the redirect on failure.
  const signIn = async (slug, claims = {}, search = '') => {
    const start = await fetch(`${env.base}/api/public/forms/${slug}/signin${search ? '?return=' + encodeURIComponent(search) : ''}`, { redirect: 'manual' });
    const location = new URL(start.headers.get('location'), env.base);
    if (location.origin !== issuer) return { location: start.headers.get('location') };
    const flow = start.headers.getSetCookie().find(cookie => cookie.startsWith('schedora_sso_respondent=')).split(';')[0];
    const now = Math.floor(env.clock.now / 1000);
    pending.push({ iss: issuer, aud: 'schedora-app', sub: 'student-42', email: 'asha@nxtwave.in', email_verified: true, name: 'Asha', nonce: location.searchParams.get('nonce'), exp: now + 300, iat: now, ...claims });
    const callback = await fetch(`${env.base}/api/auth/sso/callback?code=c&state=${location.searchParams.get('state')}`, { headers: { Cookie: flow }, redirect: 'manual' });
    const cookies = callback.headers.getSetCookie();
    return { location: callback.headers.get('location'), cookie: cookies.find(cookie => cookie.startsWith('schedora_respondent=') && !cookie.includes('Max-Age=0'))?.split(';')[0], cookies, authorize: location };
  };
  const as = cookie => ({ get: path => fetch(env.base + path, { headers: cookie ? { Cookie: cookie } : {} }), post: (path, body) => fetch(env.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: env.base, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) }) });
  return { env, owner, ws, user, form, forms, signIn, as, issuer };
}

test('existing and new forms stay public; only an owner-set form requires sign-in, and only with SSO', async () => {
  const { env, owner, form, forms, close = env.close } = await world();
  try {
    assert.equal(form.access, 'public');
    assert.equal((await env.client().get(`/api/public/forms/${form.slug}`)).status, 200, 'a public link works without anyone signing in');
    assert.deepEqual(form.signin, { issuer_host: 'idp.example.com', email_domain: 'nxtwave.in' }, 'the builder learns the provider, never the secret');
    assert.ok(!JSON.stringify(form).includes('idp-secret') && !JSON.stringify(form).includes('schedora-app'));
    assert.equal((await owner.raw('PUT', `${forms}/${form.id}/access`, { access: 'members' })).status, 400);
    const other = env.client();
    const { ws: noSso } = await signUp(other, 'NoSso');
    const plain = (await other.post(`/api/workspaces/${noSso.id}/forms`, { definition })).body;
    assert.equal(plain.signin, null);
    const refused = await other.raw('PUT', `/api/workspaces/${noSso.id}/forms/${plain.id}/access`, { access: 'signin' });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error.code, 'signin_unavailable');
    assert.equal((await other.raw('PUT', `/api/workspaces/${noSso.id}/forms/${form.id}/access`, { access: 'signin' })).status, 404, 'another workspace cannot change it');
    const set = await owner.raw('PUT', `${forms}/${form.id}/access`, { access: 'signin' });
    assert.equal(set.status, 200);
    assert.equal(set.body.access, 'signin');
    assert.equal(set.body.published_version, 1, 'takes effect without republishing');
    env.app.config.formsAuthoringFrozen = true;
    assert.equal((await owner.raw('PUT', `${forms}/${form.id}/access`, { access: 'public' })).status, 423, 'changing access is authoring');
  } finally { await close(); }
});

test('a protected form reveals nothing and accepts nothing without sign-in, including direct API calls and replays', async () => {
  const { env, owner, form, forms, as, signIn } = await world();
  try {
    // A response accepted while the form was public, then the form is protected.
    const early = await as(null).post(`/api/public/forms/${form.slug}/responses`, { answers, submission_id: 'replay-attempt-000001', evaluator: 2 });
    assert.equal(early.status, 201);
    await owner.raw('PUT', `${forms}/${form.id}/access`, { access: 'signin' });
    const view = await as(null).get(`/api/public/forms/${form.slug}`);
    assert.equal(view.status, 401);
    const body = await view.json();
    assert.equal(body.error.code, 'signin_required');
    assert.equal(body.error.signin_url, `/api/public/forms/${form.slug}/signin`);
    assert.ok(!JSON.stringify(body).includes('Student ID') && !body.definition, 'no questions are revealed');
    const submit = await as(null).post(`/api/public/forms/${form.slug}/responses`, { answers, evaluator: 2 });
    assert.equal(submit.status, 401);
    const replay = await as(null).post(`/api/public/forms/${form.slug}/responses`, { answers, submission_id: 'replay-attempt-000001', evaluator: 2 });
    assert.equal(replay.status, 401, 'a replay of an earlier receipt also needs sign-in');
    // A forged identity in the body is ignored: identity only ever comes from the session.
    assert.equal((await as(null).post(`/api/public/forms/${form.slug}/responses`, { answers, respondent: { email: 'boss@nxtwave.in' }, evaluator: 2 })).status, 401);
    assert.equal((await as('schedora_respondent=' + 'x'.repeat(43)).get(`/api/public/forms/${form.slug}`)).status, 401, 'an unknown session is no session');
    // A workspace member's own session is not a respondent sign-in.
    assert.equal((await owner.get(`/api/public/forms/${form.slug}`)).status, 401);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM responses').count, 1);
    // Signing in unlocks it; the stored identity is the session's, not the body's.
    const { cookie, location } = await signIn(form.slug);
    assert.equal(location, `/f/${form.slug}`);
    const seen = await (await as(cookie).get(`/api/public/forms/${form.slug}`)).json();
    assert.equal(seen.definition.title, 'Placement check-in');
    assert.deepEqual(seen.respondent, { email: 'asha@nxtwave.in', name: 'Asha' });
    const accepted = await as(cookie).post(`/api/public/forms/${form.slug}/responses`, { answers, respondent: { email: 'boss@nxtwave.in' }, evaluator: 2 });
    assert.equal(accepted.status, 201);
    const row = env.app.db.get('SELECT respondent, answers FROM responses WHERE id = ?', (await accepted.json()).id);
    const identity = JSON.parse(row.respondent);
    assert.equal(identity.email, 'asha@nxtwave.in');
    assert.equal(identity.subject, 'student-42');
    assert.equal(identity.issuer, 'https://idp.example.com');
    assert.ok(!row.answers.includes('asha@nxtwave.in'), 'identity is kept apart from answers');
    // Inbox and CSV show the verified identity separately; the earlier public response has none.
    const list = (await owner.get(`${forms}/${form.id}/responses`)).body.responses;
    assert.equal(list.find(item => item.respondent)?.respondent.email, 'asha@nxtwave.in');
    assert.equal(list.filter(item => !item.respondent).length, 1);
    const csv = (await owner.get(`${forms}/${form.id}/responses.csv`)).body;
    assert.match(csv.split('\r\n')[0], /"Verified sign-in email","Verified sign-in subject"$/);
    assert.match(csv, /"asha@nxtwave\.in","student-42"/);
  } finally { await env.close(); }
});

test('respondents never become users, members or editors, and their session works only for that workspace', async () => {
  const { env, owner, form, forms, ws, as, signIn } = await world();
  try {
    await owner.raw('PUT', `${forms}/${form.id}/access`, { access: 'signin' });
    const users = env.app.db.get('SELECT COUNT(*) AS count FROM users').count;
    const memberships = env.app.db.get('SELECT COUNT(*) AS count FROM memberships').count;
    const { cookie, cookies } = await signIn(form.slug);
    assert.ok(cookie);
    assert.ok(!cookies.some(item => item.startsWith('schedora_session=') && !item.includes('Max-Age=0')), 'no member session cookie');
    assert.match(cookies.find(item => item.startsWith('schedora_respondent=')), /Path=\/api\/public\/forms; HttpOnly; SameSite=Lax/);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM users').count, users, 'no user row');
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM memberships').count, memberships, 'no membership');
    assert.equal(env.app.db.get("SELECT COUNT(*) AS count FROM users WHERE email = 'asha@nxtwave.in'").count, 0);
    const me = await (await as(cookie).get('/api/me')).json();
    assert.equal(me.user, null, 'a respondent is not signed in to Schedora');
    assert.equal((await as(cookie).get(`/api/workspaces/${ws.id}/forms`)).status, 401);
    assert.equal((await as(cookie).get(`/api/workspaces/${ws.id}/forms/${form.id}/responses`)).status, 401);
    // Another workspace's protected form does not accept this session, even with the same provider domain.
    const second = env.client();
    const { ws: otherWs } = await signUp(second, 'Other');
    await second.raw('PUT', `/api/workspaces/${otherWs.id}/sso`, { issuer: 'https://idp.example.com', client_id: 'schedora-app', client_secret: 's', email_domain: 'other.in' });
    const otherForm = (await second.post(`/api/workspaces/${otherWs.id}/forms`, { definition })).body;
    await second.post(`/api/workspaces/${otherWs.id}/forms/${otherForm.id}/publish`, {});
    await second.raw('PUT', `/api/workspaces/${otherWs.id}/forms/${otherForm.id}/access`, { access: 'signin' });
    assert.equal((await as(cookie).get(`/api/public/forms/${otherForm.slug}`)).status, 401, 'sessions are per workspace');
    assert.equal((await as(cookie).post(`/api/public/forms/${otherForm.slug}/responses`, { answers, evaluator: 2 })).status, 401);
  } finally { await env.close(); }
});

test('expired sessions, sign-out, refused identities and losing SSO all fail closed', async () => {
  const { env, owner, form, forms, as, signIn } = await world();
  try {
    await owner.raw('PUT', `${forms}/${form.id}/access`, { access: 'signin' });
    const { cookie } = await signIn(form.slug, {}, '?answer.batch=jul&mode=conversational');
    assert.equal((await as(cookie).get(`/api/public/forms/${form.slug}`)).status, 200);
    env.clock.now += 2 * 60 * 60 * 1000 + 1;
    assert.equal((await as(cookie).get(`/api/public/forms/${form.slug}`)).status, 401, 'expired after two hours');
    assert.equal((await as(cookie).post(`/api/public/forms/${form.slug}/responses`, { answers, evaluator: 2 })).status, 401);
    // Signing in again keeps the form's own query string, such as a prefilled answer.
    const again = await signIn(form.slug, {}, '?answer.batch=jul&mode=conversational&signin_error=x');
    assert.equal(again.location, `/f/${form.slug}?answer.batch=jul&mode=conversational`);
    const out = await fetch(`${env.base}/api/public/forms/${form.slug}/signout`, { method: 'POST', headers: { Cookie: again.cookie, Origin: env.base } });
    assert.equal(out.status, 204);
    assert.match(out.headers.get('set-cookie'), /schedora_respondent=;.*Max-Age=0/);
    assert.equal((await as(again.cookie).get(`/api/public/forms/${form.slug}`)).status, 401, 'signed out on the server, not only in the browser');
    // The provider's refusals come back to the form page with a reason, and create no session.
    const wrongDomain = await signIn(form.slug, { email: 'eve@gmail.com' });
    assert.equal(wrongDomain.cookie, undefined);
    assert.match(wrongDomain.location, new RegExp(`^/f/${form.slug}\\?signin_error=.*nxtwave\\.in`));
    const unverified = await signIn(form.slug, { email_verified: false });
    assert.equal(unverified.cookie, undefined);
    const noSubject = await signIn(form.slug, { sub: '' });
    assert.equal(noSubject.cookie, undefined);
    // A public form's sign-in link just returns to the form.
    await owner.raw('PUT', `${forms}/${form.id}/access`, { access: 'public' });
    assert.equal((await signIn(form.slug)).location, `/f/${form.slug}`);
    await owner.raw('PUT', `${forms}/${form.id}/access`, { access: 'signin' });
    // If SSO is switched off, the protected form refuses everyone rather than opening up.
    const fresh = await signIn(form.slug);
    env.app.db.run('UPDATE sso_configs SET enabled = 0');
    const closed = await as(fresh.cookie).get(`/api/public/forms/${form.slug}`);
    assert.equal(closed.status, 503);
    assert.equal((await closed.json()).error.code, 'signin_unavailable');
    assert.equal((await as(null).post(`/api/public/forms/${form.slug}/responses`, { answers, evaluator: 2 })).status, 503);
  } finally { await env.close(); }
});

test('member SSO is unchanged: it still creates the member session, and a respondent flow cookie cannot finish it', async () => {
  const { env, signIn, form, owner, forms } = await world();
  try {
    await owner.raw('PUT', `${forms}/${form.id}/access`, { access: 'signin' });
    const start = await fetch(`${env.base}/api/public/forms/${form.slug}/signin`, { redirect: 'manual' });
    const flow = start.headers.getSetCookie().find(cookie => cookie.startsWith('schedora_sso_respondent=')).split(';')[0];
    // Presented under the member flow cookie's name, a respondent flow is refused.
    const renamed = flow.replace('schedora_sso_respondent=', 'schedora_sso=');
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const member = await fetch(`${env.base}/api/auth/sso/callback?code=c&state=${state}`, { headers: { Cookie: renamed }, redirect: 'manual' });
    assert.match(member.headers.get('location'), /^\/account\?error=/);
    assert.ok(!member.headers.getSetCookie().some(cookie => cookie.startsWith('schedora_session=')));
    void signIn;
    void client;
  } finally { await env.close(); }
});
