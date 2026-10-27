import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, signUp, publishedEventType } from './helpers.mjs';

test('publish check shares Publish rules, preserves live routing and creates no business records', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'PublishCheck');
    const event = await publishedEventType(owner, ws);
    const base = `/api/workspaces/${ws.id}/forms`;
    let form = (await owner.post(base, {})).body;
    const path = `${base}/${form.id}`;
    const routing = { rules: [], fallback: { type: 'event', event_type_id: event.id } };
    form = (await owner.raw('PUT', path + '/routing', { routing, base_revision: form.revision })).body;
    const snapshot = () => JSON.stringify({ form: env.app.db.get('SELECT * FROM forms WHERE id = ?', form.id),
      versions: env.app.db.all('SELECT * FROM form_versions WHERE form_id = ?', form.id),
      totals: env.app.db.get('SELECT (SELECT COUNT(*) FROM responses) AS responses, (SELECT COUNT(*) FROM bookings) AS bookings, (SELECT COUNT(*) FROM outbox) AS events, (SELECT COUNT(*) FROM emails) AS emails, (SELECT COUNT(*) FROM usage_counters) AS usage') });
    const before = snapshot();
    const checked = await owner.post(path + '/publish-check', { base_revision: form.revision });
    assert.equal(checked.status, 200);
    assert.equal(checked.body.can_publish, true);
    assert.equal(checked.body.revision, form.revision);
    assert.equal(snapshot(), before, 'checking cannot publish, change a draft, consume usage or trigger follow-ups');
    form = (await owner.post(path + '/publish', { base_revision: form.revision })).body;
    assert.deepEqual(form.published_routing, routing);
    form = (await owner.raw('PUT', path + '/routing', { routing: null, base_revision: form.revision })).body;
    assert.equal(form.routing, null);
    assert.deepEqual(form.published_routing, routing, 'saving a different draft cannot change live routing');
    assert.equal(form.has_unpublished_changes, true);
    form = (await owner.raw('PUT', path + '/routing', { routing, base_revision: form.revision })).body;
    env.app.db.run('UPDATE event_types SET published = 0 WHERE id = ?', event.id);
    const blockedBefore = snapshot();
    const blocked = await owner.post(path + '/publish-check', { base_revision: form.revision });
    assert.equal(blocked.status, 200);
    assert.equal(blocked.body.can_publish, false);
    assert.equal(snapshot(), blockedBefore);
    const refused = await owner.post(path + '/publish', { base_revision: form.revision });
    assert.equal(refused.status, 400);
    assert.equal(blocked.body.problems[0].message, refused.body.error.message);
    assert.equal(blocked.body.problems[0].field, 'routing');
    const stale = await owner.post(path + '/publish-check', { base_revision: form.revision - 1 });
    assert.equal(stale.status, 409);
    const stranger = env.client();
    await signUp(stranger, 'Unrelated');
    assert.equal((await stranger.post(path + '/publish-check', {})).status, 404);
    assert.equal((await owner.post(base + '/missing/publish-check', {})).status, 404);
    assert.equal((await env.client().post(path + '/publish-check', {})).status, 401);
  } finally { await env.close(); }
});

test('publish check cannot grant access or bypass a missing Forms entitlement', async () => {
  const env = await setup({ config: { billingMode: 'enforced' } });
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'NoFormsPlan');
    const base = `/api/workspaces/${ws.id}/forms`;
    const form = (await owner.post(base, {})).body;
    const check = await owner.post(`${base}/${form.id}/publish-check`, {});
    const publish = await owner.post(`${base}/${form.id}/publish`, {});
    assert.equal(check.body.can_publish, false);
    assert.equal(check.body.problems[0].code, 'entitlement_required');
    assert.equal(check.body.problems[0].message, publish.body.error.message);
    assert.equal(publish.status, 402);
    assert.equal(env.app.db.get('SELECT published_version FROM forms WHERE id = ?', form.id).published_version, null);
  } finally { await env.close(); }
});
