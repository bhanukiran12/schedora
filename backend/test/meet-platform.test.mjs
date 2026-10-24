// Contacts, lead routing, paid bookings, webhooks, API keys, managed event types, analytics, branding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { idem, setup, signUp } from './helpers.mjs';

const MON9 = '2026-10-26T09:00:00.000Z';
const create = async (http, ws, body) => (await http.post(`/api/workspaces/${ws.id}/event-types`, { timezone: 'UTC', published: true, min_notice_min: 0, duration_min: 60, ...body })).body;
const book = (env, ws, type, start, extra = {}) => env.client().post(`/api/public/meet/${ws.slug}/${type.slug}/bookings`, { name: 'Ivy', email: 'ivy@example.com', timezone: 'UTC', start, ...extra }, idem());

test('contacts are created from bookings and responses, with notes and follow-ups', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Owner');
    const type = await create(owner, ws, { title: 'Intro' });
    await book(env, ws, type, MON9, { email: 'Mia@Example.com', name: 'Mia' });
    const form = (await owner.post(`/api/workspaces/${ws.id}/forms`, {})).body;
    await owner.post(`/api/workspaces/${ws.id}/forms/${form.id}/publish`);
    await env.client().post(`/api/public/forms/${form.slug}/responses`, { answers: { name: 'Mia', email: 'mia@example.com', topic: 'support' } });
    const contacts = (await owner.get(`/api/workspaces/${ws.id}/contacts`)).body;
    assert.equal(contacts.length, 1);
    const profile = (await owner.get(`/api/workspaces/${ws.id}/contacts/${contacts[0].id}`)).body;
    assert.equal(profile.meetings.length, 1);
    assert.equal(profile.responses.length, 1);
    await owner.post(`/api/workspaces/${ws.id}/contacts/${profile.id}/notes`, { body: 'Prefers mornings' });
    await owner.post(`/api/workspaces/${ws.id}/contacts/${profile.id}/follow-ups`, { title: 'Send proposal', due_at: '2026-10-28T10:00:00Z' });
    const updated = (await owner.patch(`/api/workspaces/${ws.id}/contacts/${profile.id}`, { company: 'Acme', tags: ['VIP', 'lead'], custom: { plan: 'pro' } })).body;
    assert.deepEqual([updated.notes.length, updated.tasks.length, updated.company], [1, 1, 'Acme']);
    assert.deepEqual(updated.tags, ['vip', 'lead']);
    assert.equal((await owner.get(`/api/workspaces/${ws.id}/contacts?tag=vip`)).body.length, 1);
    assert.equal((await owner.get(`/api/workspaces/${ws.id}/bookings?scope=upcoming&contact=${profile.id}`)).body.length, 1);
    const stranger = env.client();
    await signUp(stranger, 'Stranger');
    assert.equal((await stranger.get(`/api/workspaces/${ws.id}/contacts/${profile.id}`)).status, 404);
  } finally { await env.close(); }
});

test('routing forms send respondents to the right booking page, pre-filled', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Owner');
    const enterprise = await create(owner, ws, { title: 'Enterprise demo', questions: [{ id: 'topic', type: 'single_choice', label: 'Topic', required: false, options: [{ id: 'new_project', label: 'New' }, { id: 'support', label: 'Support' }, { id: 'other', label: 'Other' }] }] });
    const form = (await owner.post(`/api/workspaces/${ws.id}/forms`, {})).body;
    await owner.post(`/api/workspaces/${ws.id}/forms/${form.id}/publish`);
    const saved = await owner.raw('PUT', `/api/workspaces/${ws.id}/forms/${form.id}/routing`, { routing: {
      rules: [{ condition: { field: 'topic', op: 'equals', value: 'new_project' }, action: { type: 'event', event_type_id: enterprise.id } },
        { condition: { field: 'topic', op: 'equals', value: 'support' }, action: { type: 'url', url: 'https://help.example.com' } }],
      fallback: { type: 'message', message: 'We will email you.' } } });
    assert.equal(saved.status, 200);
    const submit = topic => env.client().post(`/api/public/forms/${form.slug}/responses`, { answers: { name: 'Mia', email: 'mia@example.com', topic } });
    const toBooking = (await submit('new_project')).body.route;
    assert.equal(toBooking.type, 'event');
    assert.match(toBooking.url, new RegExp(`^/meet/${ws.slug}/${enterprise.slug}\\?`));
    const params = new URL(toBooking.url, 'https://x').searchParams;
    assert.deepEqual([params.get('name'), params.get('email'), params.get('a_topic')], ['Mia', 'mia@example.com', 'new_project']);
    assert.deepEqual((await submit('support')).body.route, { type: 'url', url: 'https://help.example.com/' });
    assert.deepEqual((await submit('other')).body.route, { type: 'message', message: 'We will email you.' });
  } finally { await env.close(); }
});

test('paid bookings hold the slot, confirm on payment, and release on timeout', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Coach');
    const type = await create(owner, ws, { title: 'Coaching', price_cents: 150000, currency: 'INR' });
    const pending = await book(env, ws, type, MON9);
    assert.equal(pending.status, 201);
    assert.equal(pending.body.booking.status, 'pending');
    assert.equal(pending.body.checkout.provider, 'test');
    assert.equal(env.app.db.get("SELECT COUNT(*) AS count FROM emails WHERE kind = 'confirmation'").count, 0, 'no confirmation before payment');
    assert.equal((await book(env, ws, type, MON9, { email: 'other@example.com' })).body.error.code, 'slot_unavailable', 'slot held');
    assert.equal((await env.client().post(`/api/public/bookings/${pending.body.manage_token}/test-pay`)).body.result, 'confirmed');
    const confirmed = (await env.client().get('/api/public/bookings/' + pending.body.manage_token)).body.booking;
    assert.deepEqual([confirmed.status, confirmed.payment.status], ['confirmed', 'paid']);
    assert.equal(env.app.db.get("SELECT COUNT(*) AS count FROM emails WHERE kind = 'confirmation'").count, 1);
    assert.equal((await env.client().post(`/api/public/bookings/${pending.body.manage_token}/test-pay`)).body.result, 'duplicate');

    const unpaid = await book(env, ws, type, '2026-10-26T10:00:00.000Z', { email: 'slow@example.com' });
    env.clock.now += 16 * 60000;
    await env.app.worker.tick();
    assert.equal((await env.client().get('/api/public/bookings/' + unpaid.body.manage_token)).body.booking.status, 'canceled');
    assert.equal((await book(env, ws, type, '2026-10-26T10:00:00.000Z', { email: 'next@example.com' })).status, 201, 'released slot is bookable');
  } finally { await env.close(); }
});

test('Stripe checkout and signed webhook confirm the booking', async () => {
  const env = await setup({ config: { production: false } });
  try {
    const calls = [];
    env.app.fetchProvider = async (url, init) => { calls.push({ url, body: String(init.body) }); return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }), { status: 200 }); };
    const owner = env.client();
    const { ws } = await signUp(owner, 'Coach');
    assert.equal((await owner.post(`/api/workspaces/${ws.id}/integrations/stripe`, { secret_key: 'nope', webhook_secret: 'whsec_x' })).body.error.field, 'secret_key');
    const connected = (await owner.post(`/api/workspaces/${ws.id}/integrations/stripe`, { secret_key: 'rk_test_1234567890', webhook_secret: 'whsec_testsecret123' })).body;
    assert.match(connected.webhook_url, new RegExp(`/api/payments/stripe/${ws.id}$`));
    assert.ok(!env.app.db.get('SELECT credentials FROM integrations').credentials.includes('rk_test'), 'secret stored encrypted');
    const type = await create(owner, ws, { title: 'Paid', price_cents: 5000, currency: 'usd' });
    const pending = (await book(env, ws, type, MON9)).body;
    assert.equal(pending.checkout.url, 'https://checkout.stripe.com/c/pay/cs_test_1');
    assert.match(calls[0].body, /line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=5000/);

    const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_1', payment_status: 'paid', payment_intent: 'pi_1', metadata: { booking_id: pending.booking.id, manage_token: pending.manage_token } } } });
    const t = Math.floor(env.clock.now / 1000);
    const signature = `t=${t},v1=${createHmac('sha256', 'whsec_testsecret123').update(`${t}.${event}`).digest('hex')}`;
    const post = sig => env.client().raw('POST', `/api/payments/stripe/${ws.id}`, event, { 'Content-Type': 'application/json', 'Stripe-Signature': sig });
    const tampered = signature.replace(/v1=(.)/, (_, first) => 'v1=' + (first === '0' ? '1' : '0'));
    assert.equal((await post(tampered)).body.error.code, 'invalid_signature');
    assert.equal((await post(signature)).body.result, 'confirmed');
    assert.equal(env.app.db.get('SELECT payment_ref FROM bookings').payment_ref, 'pi_1');
  } finally { await env.close(); }
});

test('outgoing webhooks are signed, retried, and blocked from private networks', async () => {
  const env = await setup();
  try {
    const received = [];
    let mode = 'fail';
    env.app.assertPublicHost = async url => { if (url.includes('internal')) throw new Error('That host is not reachable from Schedora.'); };
    env.app.fetchWebhook = async (url, init) => { received.push({ url, init }); return new Response('', { status: mode === 'fail' ? 500 : 200 }); };
    const owner = env.client();
    const { ws } = await signUp(owner, 'Dev');
    assert.equal((await owner.post(`/api/workspaces/${ws.id}/webhooks`, { url: 'http://x.example.com', events: ['meet.booking.created'] })).body.error.field, 'url');
    const endpoint = (await owner.post(`/api/workspaces/${ws.id}/webhooks`, { url: 'https://hooks.example.com/schedora', events: ['meet.booking.created', 'meet.booking.canceled'] })).body;
    assert.match(endpoint.secret, /^whsec_/);
    await owner.post(`/api/workspaces/${ws.id}/webhooks`, { url: 'https://internal.corp/hook', events: ['meet.booking.created'] });
    const type = await create(owner, ws, { title: 'Intro' });
    const created = (await book(env, ws, type, MON9)).body;
    await env.app.worker.tick();
    assert.equal(received.length, 1, 'private host never contacted');
    env.clock.now += 61000;
    mode = 'ok';
    await env.app.worker.tick();
    const delivered = received.at(-1);
    const payload = JSON.parse(delivered.init.body);
    assert.equal(payload.type, 'meet.booking.created');
    assert.equal(payload.data.invitee.email, 'ivy@example.com');
    const [t, v1] = delivered.init.headers['Schedora-Signature'].split(',').map(part => part.split('=')[1]);
    assert.equal(v1, createHmac('sha256', endpoint.secret).update(`${t}.${delivered.init.body}`).digest('hex'));
    const list = (await owner.get(`/api/workspaces/${ws.id}/webhooks`)).body;
    assert.equal(list.find(item => item.id === endpoint.id).recent[0].status, 'delivered');
    assert.match(list.find(item => item.url.includes('internal')).recent[0].last_error, /not reachable/);
    await env.client().post(`/api/public/bookings/${created.manage_token}/cancel`, {});
    await env.app.worker.tick();
    assert.equal(JSON.parse(received.at(-1).init.body).type, 'meet.booking.canceled');
  } finally { await env.close(); }
});

test('API keys work without cookies and only within their workspace', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Dev');
    const other = env.client();
    const { ws: otherWs } = await signUp(other, 'Other');
    const key = (await owner.post(`/api/workspaces/${ws.id}/api-keys`, { name: 'CRM sync' })).body;
    assert.match(key.token, /^sch_/);
    const api = (method, path, body) => fetch(env.base + path, { method, headers: { Authorization: `Bearer ${key.token}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    assert.equal((await api('POST', `/api/workspaces/${ws.id}/event-types`, { title: 'Via API', timezone: 'UTC' })).status, 201, 'no CSRF token needed');
    assert.equal((await api('GET', `/api/workspaces/${otherWs.id}/event-types`)).status, 404);
    assert.equal((await api('POST', `/api/workspaces/${ws.id}/api-keys`, { name: 'x' })).status, 403);
    assert.equal((await owner.get(`/api/workspaces/${ws.id}/api-keys`)).body[0].prefix, key.token.slice(0, 10));
    assert.ok(!JSON.stringify(env.app.db.all('SELECT * FROM api_keys')).includes(key.token), 'only the hash is stored');
    assert.equal(env.app.db.get('SELECT token_hash FROM api_keys').token_hash, createHash('sha256').update(key.token).digest('hex'));
    await owner.del(`/api/workspaces/${ws.id}/api-keys/${key.id}`);
    assert.equal((await api('GET', `/api/workspaces/${ws.id}/event-types`)).status, 401);
    assert.ok((await owner.get(`/api/workspaces/${ws.id}/audit`)).body.some(entry => entry.action === 'api_key.revoked'));
  } finally { await env.close(); }
});

test('managed event types: assign, lock fields, propagate changes', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Admin');
    const memberHttp = env.client();
    const member = await signUp(memberHttp, 'Rep');
    await owner.post(`/api/workspaces/${ws.id}/members`, { email: member.email, role: 'member' });
    const template = await create(owner, ws, { title: 'Discovery call', managed_template: true, locked_fields: ['title', 'duration_min'], duration_min: 30 });
    assert.equal((await owner.post(`/api/workspaces/${ws.id}/event-types/${template.id}/assign`, { user_ids: [member.user.id] })).body.created, 1);
    const [child] = (await memberHttp.get(`/api/workspaces/${ws.id}/event-types`)).body;
    assert.equal(child.managed_parent_id, template.id);
    assert.equal((await memberHttp.patch(`/api/workspaces/${ws.id}/event-types/${child.id}`, { title: 'My own name' })).body.error.code, 'field_locked');
    assert.equal((await memberHttp.patch(`/api/workspaces/${ws.id}/event-types/${child.id}`, { description: 'Mine' })).status, 200, 'unlocked fields stay editable');
    await owner.patch(`/api/workspaces/${ws.id}/event-types/${template.id}`, { title: 'Discovery call (new)', duration_min: 45 });
    const updated = (await memberHttp.get(`/api/workspaces/${ws.id}/event-types/${child.id}`)).body;
    assert.deepEqual([updated.title, updated.duration_min, updated.description], ['Discovery call (new)', 45, 'Mine']);
    assert.equal((await env.client().get(`/api/public/meet/${ws.slug}/${template.slug}`)).status, 404, 'templates are not bookable');
  } finally { await env.close(); }
});

test('analytics and branded public pages', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Owner');
    const type = await create(owner, ws, { title: 'Intro' });
    const first = (await book(env, ws, type, MON9)).body;
    await book(env, ws, type, '2026-10-26T10:00:00.000Z', { email: 'b@example.com' });
    await env.client().post(`/api/public/bookings/${first.manage_token}/cancel`, {});
    const stats = (await owner.get(`/api/workspaces/${ws.id}/analytics?from=2026-10-20&to=2026-11-20&tz=Asia/Kolkata`)).body;
    assert.deepEqual([stats.totals.scheduled, stats.totals.confirmed, stats.totals.canceled, stats.totals.cancellation_rate], [2, 1, 1, 50]);
    assert.equal(stats.by_event_type[0].label, 'Intro');
    assert.equal(stats.heatmap[1][15], 1, 'Monday 15:30 IST');

    const logo = 'data:image/png;base64,' + Buffer.from('fake-png').toString('base64');
    assert.equal((await owner.patch(`/api/workspaces/${ws.id}`, { logo: 'data:image/svg+xml;base64,PHN2Zz4=' })).body.error.field, 'logo');
    assert.equal((await owner.patch(`/api/workspaces/${ws.id}`, { slug: 'api' })).body.error.field, 'slug');
    await owner.patch(`/api/workspaces/${ws.id}`, { slug: 'asha-studio', brand_color: '#7A3E9D', logo, welcome_message: 'Welcome!' });
    const page = (await env.client().get('/api/public/meet/asha-studio')).body;
    assert.deepEqual([page.brand_color, page.logo, page.welcome_message, page.event_types.length], ['#7A3E9D', logo, 'Welcome!', 1]);
    const summary = (await env.client().get(`/api/public/meet/asha-studio/${type.slug}`)).body;
    assert.equal(summary.branding.color, '#7A3E9D');
    const draft = await create(owner, ws, { title: 'Draft', published: false });
    assert.equal((await env.client().get(`/api/public/meet/asha-studio/${draft.slug}`)).status, 404);
    assert.equal((await owner.get(`/api/public/meet/asha-studio/${draft.slug}`)).body.preview, true, 'members can preview');
    assert.equal((await owner.post(`/api/public/meet/asha-studio/${draft.slug}/bookings`, { name: 'x', email: 'x@example.com', timezone: 'UTC', start: MON9 }, idem())).body.error.code, 'preview_only');
  } finally { await env.close(); }
});
