import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, signUp } from './helpers.mjs';

test('persisted live onboarding stores product choices, skips optional calendar honestly, reflects saved records and never auto-publishes or grants entitlements', async () => {
  const env = await setup({ config: { billingMode: 'enforced' } });
  try {
    const owner = env.client();
    const { email, ws } = await signUp(owner, 'LiveOnboard');

    // Initial state before starting
    const initial = await owner.get(`/api/workspaces/${ws.id}/onboarding`);
    assert.equal(initial.status, 200);
    assert.equal(initial.body.started, false);
    assert.deepEqual(initial.body.selected_products, ['meet', 'forms', 'flow']);
    assert.equal(initial.body.meet_calendar_skipped, false);
    assert.equal(initial.body.records.meet.event_type, null);
    assert.equal(initial.body.records.forms.form, null);
    assert.equal(initial.body.records.flow.flow, null);
    assert.equal(initial.body.entitlements.meet.active, false, 'enforced billing starts without entitlement');

    // Empty product selection is rejected
    const badSelection = await owner.patch(`/api/workspaces/${ws.id}/onboarding`, { selected_products: [] });
    assert.equal(badSelection.status, 400);

    // Suite user chooses Meet and Forms only
    const chosen = await owner.patch(`/api/workspaces/${ws.id}/onboarding`, {
      selected_products: ['meet', 'forms'],
      active_product: 'meet',
      active_step: 'calendar'
    });
    assert.equal(chosen.status, 200);
    assert.equal(chosen.body.started, true);
    assert.deepEqual(chosen.body.selected_products, ['meet', 'forms']);
    assert.equal(chosen.body.active_step, 'calendar');

    // Skip optional calendar step: skipped is recorded, but connections remain empty (never verified)
    const skippedCal = await owner.patch(`/api/workspaces/${ws.id}/onboarding`, {
      meet_calendar_skipped: true,
      active_step: 'availability'
    });
    assert.equal(skippedCal.status, 200);
    assert.equal(skippedCal.body.meet_calendar_skipped, true);
    assert.equal(skippedCal.body.records.meet.connections.length, 0, 'skipped calendar is never reported as connected');

    // Save availability and draft event type via real authenticated APIs
    const schedule = await owner.raw('PUT', `/api/workspaces/${ws.id}/schedule`, {
      timezone: 'Asia/Kolkata',
      rules: [{ weekday: 1, start_min: 540, end_min: 1020 }, { weekday: 3, start_min: 540, end_min: 1020 }],
      overrides: []
    });
    assert.equal(schedule.status, 200);

    const draftEvent = await owner.post(`/api/workspaces/${ws.id}/event-types`, {
      title: 'Discovery consultation',
      duration_min: 30,
      timezone: 'Asia/Kolkata',
      rules: [{ weekday: 1, start_min: 540, end_min: 1020 }, { weekday: 3, start_min: 540, end_min: 1020 }],
      locations: [{ type: 'phone_host_calls' }],
      published: false
    });
    assert.equal(draftEvent.status, 201);
    assert.equal(draftEvent.body.published, false, 'event type stays unpublished draft');

    // Create unpublished draft form
    const draftForm = await owner.post(`/api/workspaces/${ws.id}/forms`, {
      title: 'Client intake questionnaire'
    });
    assert.equal(draftForm.status, 201);
    assert.equal(draftForm.body.published_version, null, 'form stays unpublished draft');

    // Create draft flow
    const draftFlow = await owner.post(`/api/workspaces/${ws.id}/flows`, {
      name: 'Follow-up task after booking',
      trigger_type: 'meet.booking.created',
      action_type: 'task',
      action_config: { title: 'Prepare notes for {{invitee.name}}', details: 'Check context before meeting.' },
      status: 'draft'
    });
    assert.equal(draftFlow.status, 201);
    assert.equal(draftFlow.body.status, 'draft', 'flow stays disabled draft');

    // Save onboarding references and mark completed
    const completed = await owner.patch(`/api/workspaces/${ws.id}/onboarding`, {
      selected_products: ['meet', 'forms', 'flow'],
      meet_event_type_id: draftEvent.body.id,
      forms_form_id: draftForm.body.id,
      flow_id: draftFlow.body.id,
      active_step: 'review',
      completed: true
    });
    assert.equal(completed.status, 200);
    assert.ok(completed.body.completed_at > 0);
    assert.equal(completed.body.records.meet.event_type.id, draftEvent.body.id);
    assert.equal(completed.body.records.meet.event_type.published, false, 'completing onboarding never auto-publishes event type');
    assert.ok(completed.body.records.meet.slots, 'readiness includes computed preview slots from saved rules');
    assert.equal(completed.body.records.forms.form.id, draftForm.body.id);
    assert.equal(completed.body.records.forms.form.published_version, null, 'completing onboarding never auto-publishes form');
    assert.equal(completed.body.records.forms.publish_check.can_publish, false, 'readiness includes server publish check and honestly reports missing entitlement');
    assert.equal(completed.body.records.forms.publish_check.problems[0].code, 'entitlement_required');
    assert.equal(completed.body.records.flow.flow.id, draftFlow.body.id);
    assert.equal(completed.body.records.flow.flow.status, 'draft', 'completing onboarding never auto-enables flow');
    assert.equal(completed.body.entitlements.meet.active, false, 'completing onboarding never grants entitlements');
    assert.equal(completed.body.entitlements.forms.active, false);
    assert.equal(completed.body.entitlements.flow.active, false);

    // Sign in from a fresh browser session and verify progress is preserved
    const secondBrowser = env.client();
    const login = await secondBrowser.post('/api/auth/login', { email, password: 'a sufficiently long password' });
    assert.equal(login.status, 200);
    const reloaded = await secondBrowser.get(`/api/workspaces/${ws.id}/onboarding`);
    assert.equal(reloaded.status, 200);
    assert.equal(reloaded.body.started, true);
    assert.equal(reloaded.body.active_step, 'review');
    assert.equal(reloaded.body.meet_calendar_skipped, true);
    assert.equal(reloaded.body.records.meet.event_type.title, 'Discovery consultation');
    assert.equal(reloaded.body.records.forms.form.draft.title, 'Client intake questionnaire');
    assert.equal(reloaded.body.records.flow.flow.name, 'Follow-up task after booking');

    // Deleting a saved record updates readiness immediately to reflect actual database state
    const delForm = await secondBrowser.del(`/api/workspaces/${ws.id}/forms/${draftForm.body.id}`);
    assert.equal(delForm.status, 204);
    const afterDelete = await secondBrowser.get(`/api/workspaces/${ws.id}/onboarding`);
    assert.equal(afterDelete.status, 200);
    assert.equal(afterDelete.body.forms_form_id, null);
    assert.equal(afterDelete.body.records.forms.form, null, 'readiness drops deleted form instead of reporting stale state');
  } finally {
    await env.close();
  }
});
