// Forms reliability milestone: draft/live separation, version-pinned submissions, idempotent retries,
// atomic quota, tenant isolation, export integrity, versioned routing and the Meet handoff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idem, setup, signUp } from './helpers.mjs';
import { VERSION_GRACE_MS } from '../src/forms/service.mjs';
import { QUOTAS } from '../src/billing/plans.mjs';

const MON9 = '2026-10-26T09:00:00.000Z';
const MON10 = '2026-10-26T10:00:00.000Z';
const HOUR = 60 * 60 * 1000;

const intake = {
  title: 'Client intake', description: '', presentation: 'classic', submit_label: 'Send',
  fields: [
    { id: 'name', type: 'short_text', label: 'Name', required: true },
    { id: 'email', type: 'email', label: 'Email', required: true },
    { id: 'kind', type: 'single_choice', label: 'Kind', required: true, options: [{ id: 'home', label: 'Home' }, { id: 'office', label: 'Office' }] },
    { id: 'team', type: 'short_text', label: 'Team size', required: true, show_if: { field: 'kind', op: 'equals', value: 'office' } },
    { id: 'notes', type: 'long_text', label: 'Notes', required: false }
  ]
};

async function workspaceWithForm(env, definition = intake) {
  const owner = env.client();
  const { ws, user } = await signUp(owner, 'Owner');
  const form = (await owner.post(`/api/workspaces/${ws.id}/forms`, { definition })).body;
  const path = `/api/workspaces/${ws.id}/forms/${form.id}`;
  const published = (await owner.post(`${path}/publish`)).body;
  return { owner, ws, user, form: published, path, submit: body => env.client().post(`/api/public/forms/${form.slug}/responses`, body) };
}

const count = (env, sql, ...params) => env.app.db.get(sql, ...params).count;
const usage = env => env.app.db.get("SELECT COALESCE(SUM(count), 0) AS count FROM usage_counters WHERE metric = 'responses'").count;
const eventType = async (http, ws, body = {}) => (await http.post(`/api/workspaces/${ws.id}/event-types`, { title: 'Consultation', timezone: 'UTC', published: true, min_notice_min: 0, duration_min: 60, ...body })).body;

test('draft edits and conflicting saves never change the live form or overwrite silently', async () => {
  const env = await setup();
  try {
    const { owner, form, path } = await workspaceWithForm(env);
    const live = () => env.client().get(`/api/public/forms/${form.slug}`).then(response => response.body);
    assert.equal(form.revision, 1);

    const edited = { ...intake, title: 'Client intake (draft)', fields: intake.fields.slice(0, 3) };
    const first = await owner.patch(path, { definition: edited, base_revision: 1 });
    assert.equal(first.status, 200);
    assert.deepEqual([first.body.revision, first.body.has_unpublished_changes], [2, true]);
    assert.equal((await live()).definition.title, 'Client intake', 'the saved draft is not live');
    assert.equal((await live()).definition.fields.length, 5);

    // A second editor still on revision 1 is refused and shown the current draft.
    const stale = await owner.patch(path, { definition: { ...intake, title: 'Other tab' }, base_revision: 1 });
    assert.deepEqual([stale.status, stale.body.error.code], [409, 'draft_conflict']);
    assert.equal(stale.body.error.current.draft.title, 'Client intake (draft)');
    assert.equal((await owner.get(path)).body.draft.title, 'Client intake (draft)', 'nothing was overwritten');
    // Choosing to overwrite is explicit: it names the revision being replaced.
    assert.equal((await owner.patch(path, { definition: { ...intake, title: 'Other tab' }, base_revision: 2 })).status, 200);

    // Publishing must be of the revision the editor reviewed.
    const outdated = await owner.post(`${path}/publish`, { base_revision: 2 });
    assert.deepEqual([outdated.status, outdated.body.error.code], [409, 'draft_conflict']);
    assert.equal((await live()).definition.title, 'Client intake');
    const v2 = (await owner.post(`${path}/publish`, { base_revision: 3 })).body;
    assert.deepEqual([v2.published_version, v2.has_unpublished_changes], [2, false]);
    assert.equal((await live()).definition.title, 'Other tab');
    // Keys used by a published version are reported so the builder keeps them fixed.
    assert.ok(['name', 'email', 'kind', 'team', 'notes'].every(id => v2.locked_ids.includes(id)));
  } finally { await env.close(); }
});

test('conditional required questions are enforced only when shown, and hidden answers are discarded', async () => {
  const env = await setup();
  try {
    const { owner, path, submit, form } = await workspaceWithForm(env);
    const office = await submit({ answers: { name: 'Ana', email: 'ana@example.com', kind: 'office' }, version: 1 });
    assert.deepEqual([office.status, Object.keys(office.body.error.errors)], [400, ['team']], 'shown and required');
    const home = await submit({ answers: { name: 'Ana', email: 'ana@example.com', kind: 'home', team: 'injected', unknown: 'x' }, version: 1 });
    assert.equal(home.status, 201, 'hidden required question is not required');
    const stored = JSON.parse(env.app.db.get('SELECT answers FROM responses WHERE id = ?', home.body.id).answers);
    assert.deepEqual(stored, { name: 'Ana', email: 'ana@example.com', kind: 'home' }, 'hidden and unknown answers are not stored');
    assert.equal(count(env, 'SELECT COUNT(*) AS count FROM responses'), 1, 'the rejected attempt stored nothing');
    assert.equal(usage(env), 1, 'and consumed nothing');
    // Logic must refer to earlier questions and existing options before it can be saved or published.
    const broken = { ...intake, fields: intake.fields.map(field => field.id === 'team' ? { ...field, show_if: { field: 'kind', op: 'equals', value: 'warehouse' } } : field) };
    assert.equal((await owner.patch(path, { definition: broken })).status, 400);
    assert.ok(form.published_version);
  } finally { await env.close(); }
});

test('republishing: in-flight answers are stored against the version shown, within a bounded window', async () => {
  const env = await setup();
  try {
    const { owner, path, submit } = await workspaceWithForm(env);
    // Version 2 renames an option, removes "notes" and adds a required question.
    const v2 = { ...intake, fields: [...intake.fields.slice(0, 4).map(field => field.id === 'kind' ? { ...field, options: [{ id: 'home', label: 'Residential' }, { id: 'office', label: 'Office' }] } : field),
      { id: 'budget', type: 'short_text', label: 'Budget', required: true }] };
    await owner.patch(path, { definition: v2 });
    await owner.post(`${path}/publish`);

    const old = await submit({ answers: { name: 'Old', email: 'old@example.com', kind: 'home', notes: 'Line one\nLine two' }, version: 1, submission_id: 'inflight-000000000001' });
    assert.deepEqual([old.status, old.body.version], [201, 1], 'validated against version 1, where budget did not exist');
    assert.equal(env.app.db.get('SELECT form_version FROM responses WHERE id = ?', old.body.id).form_version, 1);
    const current = await submit({ answers: { name: 'New', email: 'new@example.com', kind: 'home' }, version: 2 });
    assert.deepEqual([current.status, Object.keys(current.body.error.errors)], [400, ['budget']]);
    assert.equal((await submit({ answers: { name: 'New', email: 'new@example.com', kind: 'home', budget: '₹50,000' } })).body.version, 2, 'no version means the live one');

    // After the window, an old version is refused with a recoverable error and nothing is stored.
    env.clock.now += VERSION_GRACE_MS + HOUR;
    const before = [count(env, 'SELECT COUNT(*) AS count FROM responses'), usage(env), count(env, 'SELECT COUNT(*) AS count FROM outbox')];
    const late = await submit({ answers: { name: 'Late', email: 'late@example.com', kind: 'home' }, version: 1 });
    assert.deepEqual([late.status, late.body.error.code, late.body.error.version], [409, 'form_version_changed', 2]);
    assert.equal((await submit({ answers: { name: 'X', email: 'x@example.com', kind: 'home' }, version: 7 })).body.error.code, 'form_version_changed', 'unknown versions too');
    assert.deepEqual([count(env, 'SELECT COUNT(*) AS count FROM responses'), usage(env), count(env, 'SELECT COUNT(*) AS count FROM outbox')], before);

    // History renders with the recorded version's labels: the old answer stays "Home".
    const csv = (await owner.get(`${path}/responses.csv`)).body;
    const oldLine = csv.split('\r\n').find(line => line.includes(old.body.id));
    assert.match(oldLine, /"1",""(,"[^"]*"){2},"Home"/, 'version column and original option label');
    assert.match(csv, /"Line one\nLine two"/, 'multiline answers are preserved inside one quoted cell');
    const inbox = (await owner.get(`${path}/responses`)).body;
    assert.deepEqual(Object.keys(inbox.versions).sort(), ['1', '2']);
    assert.equal(inbox.versions[1].fields.find(field => field.id === 'kind').options[0].label, 'Home');
  } finally { await env.close(); }
});

test('a retried submission is accepted once: one response, one usage unit, one event, even across republishing and closing', async () => {
  const env = await setup();
  try {
    const { owner, path, submit } = await workspaceWithForm(env);
    const body = { answers: { name: 'Ravi', email: 'ravi@example.com', kind: 'home' }, version: 1, submission_id: 'retry-identity-000001' };
    const first = await submit(body);
    assert.deepEqual([first.status, first.body.replay], [201, false]);
    assert.match(first.body.reference, /^[0-9A-F]{8}$/);
    // The browser timed out and retries with the same identity.
    const retry = await submit(body);
    assert.deepEqual([retry.status, retry.body.replay, retry.body.id, retry.body.answers_changed], [200, true, first.body.id, false]);
    // The owner republishes; the retry still returns the original acceptance, not a version error.
    await owner.patch(path, { definition: { ...intake, title: 'Changed' } });
    await owner.post(`${path}/publish`);
    const changed = await submit({ ...body, answers: { ...body.answers, name: 'Ravi K' } });
    assert.deepEqual([changed.status, changed.body.id, changed.body.version, changed.body.answers_changed], [200, first.body.id, 1, true], 'later edits are reported as not saved');
    await owner.post(`${path}/unpublish`);
    assert.deepEqual([(await submit(body)).status, (await submit(body)).body.id], [200, first.body.id], 'a closed form still confirms an accepted response');

    assert.equal(count(env, 'SELECT COUNT(*) AS count FROM responses'), 1);
    assert.equal(usage(env), 1);
    assert.equal(count(env, "SELECT COUNT(*) AS count FROM outbox WHERE type = 'forms.response.created'"), 1);
    assert.equal(JSON.parse(env.app.db.get('SELECT answers FROM responses').answers).name, 'Ravi', 'the first accepted answers stand');
  } finally { await env.close(); }
});

test('concurrent submissions at the quota boundary cannot overspend, and replays are not blocked by it', async () => {
  const env = await setup({ config: { billingMode: 'enforced' } });
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Owner');
    await owner.post(`/api/workspaces/${ws.id}/billing/test-events`, { action: 'checkout', plan: 'forms' });
    const form = (await owner.post(`/api/workspaces/${ws.id}/forms`, { definition: intake })).body;
    await owner.post(`/api/workspaces/${ws.id}/forms/${form.id}/publish`);
    const submit = (index, id) => env.client().post(`/api/public/forms/${form.slug}/responses`, { answers: { name: 'P' + index, email: `p${index}@example.com`, kind: 'home' }, submission_id: id || `quota-boundary-${String(index).padStart(6, '0')}` });
    const accepted = await submit(0);
    const limit = QUOTAS.responses.monthly;
    env.app.db.run("UPDATE usage_counters SET count = ? WHERE metric = 'responses'", limit - 2);

    const results = await Promise.all([1, 2, 3, 4, 5, 6].map(index => submit(index)));
    assert.equal(results.filter(result => result.status === 201).length, 2, 'exactly the remaining allowance');
    assert.ok(results.filter(result => result.status !== 201).every(result => result.status === 429 && result.body.error.code === 'quota_exceeded'));
    assert.equal(count(env, 'SELECT COUNT(*) AS count FROM responses'), 3);
    assert.equal(count(env, 'SELECT COUNT(*) AS count FROM outbox'), 3, 'no event without a response');
    assert.equal(usage(env), limit);
    assert.equal((await env.client().get(`/api/public/forms/${form.slug}`)).body.availability, 'capacity_reached', 'new visitors are told before they start');
    assert.equal((await submit(0, 'quota-boundary-000000')).status, 200, 'a retry of an accepted response still succeeds at full quota');

    // Deleting a response does not return its unit.
    await owner.del(`/api/workspaces/${ws.id}/forms/${form.id}/responses/${accepted.body.id}`);
    assert.equal(usage(env), limit);
    assert.equal((await submit(9)).status, 429);
  } finally { await env.close(); }
});

test('responses, exports and routing are isolated per workspace, and removed members lose access', async () => {
  const env = await setup();
  try {
    const { owner, ws, path, submit } = await workspaceWithForm(env);
    await submit({ answers: { name: 'Ana', email: 'ana@example.com', kind: 'home' } });
    const colleague = env.client();
    const { email, user } = await signUp(colleague, 'Colleague');
    await owner.post(`/api/workspaces/${ws.id}/members`, { email, role: 'member' });
    const stranger = env.client();
    const strangerSpace = (await signUp(stranger, 'Stranger')).ws;

    assert.equal((await colleague.get(`${path}/responses`)).status, 200, 'members can read');
    const rid = (await colleague.get(`${path}/responses`)).body.responses[0].id;
    assert.equal((await colleague.del(`${path}/responses/${rid}`)).status, 403, 'members cannot delete');
    for (const request of [stranger.get(`${path}/responses`), stranger.get(`${path}/responses.csv`), stranger.patch(path, { definition: intake }), stranger.post(`${path}/publish`)]) {
      assert.equal((await request).status, 404, 'other workspaces cannot even confirm the form exists');
    }
    // A form id is matched with its workspace: the stranger's own workspace id does not help.
    assert.equal((await stranger.get(path.replace(ws.id, strangerSpace.id) + '/responses.csv')).status, 404);
    // Routing cannot point at another workspace's booking page.
    const foreign = await eventType(stranger, strangerSpace);
    const routed = await owner.raw('PUT', `${path}/routing`, { routing: { rules: [{ condition: { field: 'kind', op: 'equals', value: 'home' }, action: { type: 'event', event_type_id: foreign.id } }] } });
    assert.equal(routed.status, 400);

    // Export permission is checked when the export runs.
    await owner.del(`/api/workspaces/${ws.id}/members/${user.id}`);
    assert.equal((await colleague.get(`${path}/responses.csv`)).status, 404);
    assert.equal((await colleague.get(`${path}/responses`)).status, 404);
  } finally { await env.close(); }
});

test('CSV export keeps Unicode and line breaks and neutralizes formulas in answers and labels', async () => {
  const env = await setup();
  try {
    const definition = { ...intake, fields: [...intake.fields.slice(0, 3), { id: 'notes', type: 'long_text', label: '=Notes', required: false }] };
    const { owner, path, submit } = await workspaceWithForm(env, definition);
    const answers = [
      { name: 'प्रिया 🌼', notes: 'पहली पंक्ति\r\nदूसरी "उद्धरण" पंक्ति' },
      { name: '=1+2', notes: '+SUM(A1)' },
      { name: '-5', notes: '@cmd' }
    ];
    for (const [index, item] of answers.entries()) assert.equal((await submit({ answers: { email: `u${index}@example.com`, kind: 'office', team: '3', ...item } })).status, 201);
    const response = await owner.get(`${path}/responses.csv`);
    assert.match(response.headers.get('content-type'), /text\/csv; charset=utf-8/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const csv = response.body;
    assert.ok(csv.replace(/^﻿/, '').startsWith('"Response ID","Submitted at (UTC)","Form version","Next step"'), 'leading columns');
    assert.ok(csv.includes('"\'=Notes"'), 'question labels are neutralized');
    assert.ok(csv.includes('"प्रिया 🌼"'));
    assert.ok(csv.includes('"पहली पंक्ति\nदूसरी ""उद्धरण"" पंक्ति"'), 'line endings normalized, quotes escaped, text intact');
    for (const cell of ["'=1+2", "'+SUM(A1)", "'-5", "'@cmd"]) assert.ok(csv.includes(`"${cell}"`), cell);
    assert.equal(csv.trim().split('\r\n').length, 4);
  } finally { await env.close(); }
});

test('routing is validated at publish and an unavailable destination still accepts the response with a fallback', async () => {
  const env = await setup();
  try {
    const { owner, ws, path, submit } = await workspaceWithForm(env);
    const consult = await eventType(owner, ws, { title: 'Consultation' });
    const rules = { rules: [{ condition: { field: 'kind', op: 'equals', value: 'office' }, action: { type: 'event', event_type_id: consult.id } }], fallback: { type: 'message', message: 'We will reply by email.' } };
    assert.equal((await owner.raw('PUT', `${path}/routing`, { routing: { rules: [{ condition: { field: 'kind', op: 'equals', value: 'warehouse' }, action: rules.rules[0].action }] } })).status, 400, 'unknown option');
    assert.equal((await owner.raw('PUT', `${path}/routing`, { routing: rules })).status, 200);

    // The draft later drops the "office" option the rule depends on: publishing is blocked.
    const fewer = { ...intake, fields: intake.fields.map(field => field.id === 'kind' ? { ...field, options: [field.options[0]] } : field).filter(field => field.id !== 'team') };
    await owner.patch(path, { definition: fewer });
    const blocked = await owner.post(`${path}/publish`);
    assert.deepEqual([blocked.status, blocked.body.error.field], [400, 'routing']);
    assert.match(blocked.body.error.message, /Routing rule 1 refers to an option/);
    await owner.patch(path, { definition: intake });

    // An unpublished destination also blocks publishing.
    await owner.patch(`/api/workspaces/${ws.id}/event-types/${consult.id}`, { published: false });
    assert.match((await owner.post(`${path}/publish`)).body.error.message, /not published/);
    await owner.patch(`/api/workspaces/${ws.id}/event-types/${consult.id}`, { published: true });
    assert.equal((await owner.post(`${path}/publish`)).body.published_version, 2);

    // After publishing, the destination is withdrawn: responses are still accepted.
    await owner.patch(`/api/workspaces/${ws.id}/event-types/${consult.id}`, { published: false });
    const result = await submit({ answers: { name: 'Ana', email: 'ana@example.com', kind: 'office', team: '4' } });
    assert.equal(result.status, 201);
    assert.deepEqual(result.body.next, { type: 'booking', status: 'unavailable', fallback: { type: 'message', message: 'We will reply by email.' } });
    const inbox = (await owner.get(`${path}/responses`)).body.responses;
    assert.deepEqual(inbox[0].next_step, { status: 'unavailable', reason: 'destination_unavailable' });
    // First match wins; no match uses the fallback.
    assert.deepEqual((await submit({ answers: { name: 'B', email: 'b@example.com', kind: 'home' } })).body.next, { type: 'message', message: 'We will reply by email.' });
  } finally { await env.close(); }
});

test('Meet handoff: receipt is distinct from booking, booking is linked once, and failures keep the response', async () => {
  const env = await setup({ config: { billingMode: 'enforced' } });
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Owner');
    await owner.post(`/api/workspaces/${ws.id}/billing/test-events`, { action: 'checkout', plan: 'suite' });
    const consult = await eventType(owner, ws, { title: 'Consultation' });
    const form = (await owner.post(`/api/workspaces/${ws.id}/forms`, { definition: intake })).body;
    const path = `/api/workspaces/${ws.id}/forms/${form.id}`;
    await owner.raw('PUT', `${path}/routing`, { routing: { rules: [{ condition: { field: 'kind', op: 'answered' }, action: { type: 'event', event_type_id: consult.id } }] } });
    await owner.post(`${path}/publish`);
    const submit = body => env.client().post(`/api/public/forms/${form.slug}/responses`, body);
    const body = { answers: { name: 'Meera', email: 'meera@example.com', kind: 'home' }, submission_id: 'handoff-identity-0001' };

    const accepted = await submit(body);
    assert.equal(accepted.status, 201);
    assert.deepEqual([accepted.body.next.type, accepted.body.next.status], ['booking', 'offered'], 'received, not booked');
    const token = new URL(accepted.body.next.url, 'https://x').searchParams.get('handoff');
    assert.equal(env.app.db.get('SELECT token_hash FROM form_handoffs').token_hash.length, 64, 'only the hash is stored');
    assert.equal((await owner.get(`${path}/responses`)).body.responses[0].next_step.status, 'offered');

    // A retry of the submission rotates the token; only the newest link books.
    const replay = await submit(body);
    const fresh = new URL(replay.body.next.url, 'https://x').searchParams.get('handoff');
    assert.notEqual(fresh, token);
    assert.equal((await env.client().get('/api/public/form-handoffs/' + token)).status, 404);

    // Meet stops being available (revoked plan): the booking fails, the response stays.
    env.app.db.run("UPDATE subscriptions SET status = 'canceled' WHERE workspace_id = ?", ws.id);
    assert.equal((await env.client().get('/api/public/form-handoffs/' + fresh)).body.status, 'unavailable');
    const book = (start, key, extra = {}) => env.client().post(`/api/public/meet/${ws.slug}/${consult.slug}/bookings`, { name: 'Meera', email: 'meera@example.com', timezone: 'UTC', start, handoff: fresh, ...extra }, key);
    const refused = await book(MON9, idem());
    assert.deepEqual([refused.status, refused.body.error.code], [402, 'entitlement_required'], 'no booking without Meet');
    assert.equal(count(env, 'SELECT COUNT(*) AS count FROM responses'), 1);
    assert.equal(env.app.db.get('SELECT status FROM form_handoffs').status, 'offered');
    await owner.post(`/api/workspaces/${ws.id}/billing/test-events`, { action: 'checkout', plan: 'suite' });

    // A failed booking attempt (slot taken) leaves the handoff open.
    await env.client().post(`/api/public/meet/${ws.slug}/${consult.slug}/bookings`, { name: 'Other', email: 'other@example.com', timezone: 'UTC', start: MON9 }, idem());
    assert.equal((await book(MON9, idem())).body.error.code, 'slot_unavailable');
    assert.equal(env.app.db.get('SELECT status FROM form_handoffs').status, 'offered');

    // The real booking: confirmed only by Meet, linked in the same transaction, and retry-safe.
    const key = idem();
    const booked = await book(MON10, key);
    assert.deepEqual([booked.status, booked.body.booking.status, booked.body.handoff_linked], [201, 'confirmed', true]);
    const replayedBooking = await book(MON10, key);
    assert.equal(replayedBooking.status, 200, 'retry returns the same booking');
    assert.equal(replayedBooking.body.handoff_linked, true);
    assert.equal(count(env, "SELECT COUNT(*) AS count FROM bookings WHERE invitee_email = 'meera@example.com'"), 1);
    const second = await book('2026-10-26T11:00:00.000Z', idem());
    assert.deepEqual([second.status, second.body.error.code], [409, 'handoff_used'], 'one booking per response through the handoff');
    const step = (await owner.get(`${path}/responses`)).body.responses[0].next_step;
    assert.deepEqual([step.status, step.reference], ['booked', booked.body.booking.reference]);
    assert.equal((await submit(body)).body.next.status, 'booked');
    assert.deepEqual((await env.client().get('/api/public/form-handoffs/' + fresh)).body, { status: 'booked' }, 'a used token reveals no personal details');

    env.clock.now += 3 * HOUR;
    const expiredUsed = await book('2026-10-26T11:00:00.000Z', idem());
    assert.deepEqual([expiredUsed.status, expiredUsed.body.error.code], [409, 'handoff_used']);
    assert.equal(count(env, "SELECT COUNT(*) AS count FROM bookings WHERE invitee_email = 'meera@example.com'"), 1);

    // Canceling the booking is reflected without touching the response.
    await env.client().post(`/api/public/bookings/${booked.body.manage_token}/cancel`, { reason: 'Changed plans' });
    assert.equal((await owner.get(`${path}/responses`)).body.responses[0].next_step.status, 'booking_canceled');
    assert.equal(count(env, 'SELECT COUNT(*) AS count FROM responses'), 1);
  } finally { await env.close(); }
});

test('handoff links expire, and abandoning the booking leaves the response valid', async () => {
  const env = await setup();
  try {
    const { owner, ws, path, submit } = await workspaceWithForm(env);
    const consult = await eventType(owner, ws);
    await owner.raw('PUT', `${path}/routing`, { routing: { rules: [], fallback: { type: 'event', event_type_id: consult.id } } });
    await owner.post(`${path}/publish`);
    const result = await submit({ answers: { name: 'Lee', email: 'lee@example.com', kind: 'home' }, submission_id: 'abandon-identity-0001' });
    assert.equal(result.body.next.status, 'offered', 'the fallback can offer a booking page');
    const token = new URL(result.body.next.url, 'https://x').searchParams.get('handoff');
    env.clock.now += 3 * HOUR;
    const expired = await env.client().get('/api/public/form-handoffs/' + token);
    assert.equal(expired.body.status, 'expired', JSON.stringify(expired.body));
    const booking = await env.client().post(`/api/public/meet/${ws.slug}/${consult.slug}/bookings`, { name: 'Lee', email: 'lee@example.com', timezone: 'UTC', start: MON9, handoff: token }, idem());
    assert.deepEqual([booking.status, booking.body.error.code], [410, 'handoff_expired']);
    assert.equal(count(env, 'SELECT COUNT(*) AS count FROM bookings'), 0);
    assert.equal((await submit({ answers: { name: 'Lee', email: 'lee@example.com', kind: 'home' }, submission_id: 'abandon-identity-0001' })).body.next.status, 'expired');
    const inbox = (await owner.get(`${path}/responses`)).body.responses;
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].next_step.status, 'offered', 'never shown as booked');
  } finally { await env.close(); }
});

test('invalid or mismatched handoffs cannot silently create unlinked bookings', async () => {
  const env = await setup();
  try {
    const { owner, ws, path, submit } = await workspaceWithForm(env);
    const consult = await eventType(owner, ws);
    const other = await eventType(owner, ws, { title: 'Other consultation' });
    await owner.raw('PUT', `${path}/routing`, { routing: { rules: [], fallback: { type: 'event', event_type_id: consult.id } } });
    await owner.post(`${path}/publish`);
    const response = await submit({ answers: { name: 'Lee', email: 'lee@example.com', kind: 'home' } });
    const token = new URL(response.body.next.url, 'https://x').searchParams.get('handoff');
    for (const [destination, handoff] of [[consult, 'invalid-token-000000000000'], [consult, ''], [consult, null], [other, token]]) {
      const result = await env.client().post(`/api/public/meet/${ws.slug}/${destination.slug}/bookings`, { name: 'Lee', email: 'lee@example.com', timezone: 'UTC', start: MON9, handoff }, idem());
      assert.deepEqual([result.status, result.body.error.code], [404, 'handoff_not_found']);
    }
    assert.equal(count(env, 'SELECT COUNT(*) AS count FROM bookings'), 0);
    assert.equal(count(env, 'SELECT COUNT(*) AS count FROM responses'), 1);
    const direct = await env.client().post(`/api/public/meet/${ws.slug}/${consult.slug}/bookings`, { name: 'Direct guest', email: 'direct@example.com', timezone: 'UTC', start: MON9 }, idem());
    assert.equal(direct.status, 201);
  } finally { await env.close(); }
});
