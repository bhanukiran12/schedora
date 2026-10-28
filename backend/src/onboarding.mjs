import { invalid, oneOf } from './validate.mjs';
import { entitlementsFor } from './billing/entitlements.mjs';
import { getEventType, listEventTypes } from './meet/event-types.mjs';
import { computeAvailability, loadEventType } from './meet/bookings.mjs';
import { listConnections } from './meet/calendar.mjs';
import { checkFormPublish, getForm, listForms } from './forms/service.mjs';
import { getFlow, listFlows } from './flow/service.mjs';
import { addDays, localDate } from './time.mjs';

const PRODUCTS = ['meet', 'forms', 'flow'];
const STEPS = ['products', 'calendar', 'availability', 'event', 'form', 'flow', 'review'];

function parseProducts(raw) {
  try {
    const parsed = JSON.parse(raw);
    const valid = Array.isArray(parsed) ? PRODUCTS.filter(key => parsed.includes(key)) : [];
    return valid.length ? valid : [...PRODUCTS];
  } catch {
    return [...PRODUCTS];
  }
}

function hostSlotsFor(app, eventTypeId, entitlements) {
  const loaded = loadEventType(app, eventTypeId);
  if (!loaded) return null;
  const today = localDate(app.now(), loaded.timezone);
  const windowStart = loaded.start_date && loaded.start_date > today ? loaded.start_date : today;
  let windowEnd = addDays(today, loaded.horizon_days);
  if (loaded.end_date && loaded.end_date < windowEnd) windowEnd = loaded.end_date;
  const fromDate = addDays(windowStart, -1);
  const toDate = addDays(windowEnd, 2);
  const { slots } = computeAvailability(app, loaded, { fromDate, toDate });
  return {
    timezone: loaded.timezone,
    slots: [...slots.keys()].map(ms => new Date(ms).toISOString()),
    accepting: Boolean(entitlements.meet?.active),
    today
  };
}

export function getOnboarding(app, actor) {
  const workspaceId = actor.workspace.id;
  const row = app.db.get('SELECT * FROM workspace_onboarding WHERE workspace_id = ?', workspaceId);
  const selectedProducts = row ? parseProducts(row.selected_products) : [...PRODUCTS];
  const entitlements = entitlementsFor(app, workspaceId);

  const scheduleRow = app.db.get('SELECT timezone, rules, overrides FROM user_schedules WHERE workspace_id = ? AND user_id = ?', workspaceId, actor.userId);
  const schedule = scheduleRow ? { timezone: scheduleRow.timezone, rules: JSON.parse(scheduleRow.rules), overrides: JSON.parse(scheduleRow.overrides) } : null;
  const connections = listConnections(app, workspaceId, actor.userId);
  const integrations = app.db.all('SELECT id, provider, account, status, last_error, created_at, user_id FROM integrations WHERE workspace_id = ? AND (user_id IS NULL OR user_id = ?)', workspaceId, actor.userId);
  const eventTypes = listEventTypes(app, workspaceId, actor);
  const targetEventId = (row?.meet_event_type_id && eventTypes.some(item => item.id === row.meet_event_type_id))
    ? row.meet_event_type_id
    : null;
  const meetEventType = targetEventId ? getEventType(app, workspaceId, targetEventId, actor) : null;
  const slots = meetEventType ? hostSlotsFor(app, meetEventType.id, entitlements) : null;

  const formsList = listForms(app, workspaceId);
  const targetFormId = (row?.forms_form_id && formsList.some(item => item.id === row.forms_form_id))
    ? row.forms_form_id
    : null;
  const formRecord = targetFormId ? getForm(app, workspaceId, targetFormId) : null;
  const publishCheck = formRecord ? checkFormPublish(app, workspaceId, formRecord.id, {}) : null;

  const flowsList = listFlows(app, workspaceId);
  const targetFlowId = (row?.flow_id && flowsList.some(item => item.id === row.flow_id))
    ? row.flow_id
    : null;
  const flowRecord = targetFlowId ? getFlow(app, workspaceId, targetFlowId) : null;

  const activeProduct = row && selectedProducts.includes(row.active_product) ? row.active_product : selectedProducts[0];
  return {
    started: Boolean(row),
    selected_products: selectedProducts,
    active_product: activeProduct,
    active_step: row?.active_step || 'products',
    meet_calendar_skipped: Boolean(row?.meet_calendar_skipped),
    meet_event_type_id: meetEventType?.id || null,
    forms_form_id: formRecord?.id || null,
    flow_id: flowRecord?.id || null,
    completed_at: row?.completed_at ?? null,
    updated_at: row?.updated_at ?? null,
    role: actor.role,
    entitlements,
    records: {
      meet: {
        schedule,
        connections,
        integrations,
        event_types: eventTypes,
        event_type: meetEventType,
        slots
      },
      forms: {
        forms: formsList,
        form: formRecord,
        publish_check: publishCheck
      },
      flow: {
        flows: flowsList,
        flow: flowRecord
      }
    }
  };
}

export function updateOnboarding(app, actor, body = {}) {
  const workspaceId = actor.workspace.id;
  const existing = app.db.get('SELECT * FROM workspace_onboarding WHERE workspace_id = ?', workspaceId);
  let selectedProducts = existing ? parseProducts(existing.selected_products) : [...PRODUCTS];
  if (body.selected_products !== undefined) {
    if (!Array.isArray(body.selected_products)) invalid('selected_products', 'Choose at least one product to set up.');
    const filtered = PRODUCTS.filter(key => body.selected_products.includes(key));
    if (!filtered.length) invalid('selected_products', 'Choose at least one product to set up.');
    selectedProducts = filtered;
  }
  const activeProduct = body.active_product !== undefined
    ? oneOf(body.active_product, 'active_product', PRODUCTS)
    : (existing && selectedProducts.includes(existing.active_product) ? existing.active_product : selectedProducts[0]);
  const activeStep = body.active_step !== undefined
    ? oneOf(body.active_step, 'active_step', STEPS)
    : (existing?.active_step || 'products');
  const meetCalendarSkipped = body.meet_calendar_skipped !== undefined
    ? (body.meet_calendar_skipped ? 1 : 0)
    : (existing?.meet_calendar_skipped ? 1 : 0);

  let meetEventTypeId = existing?.meet_event_type_id ?? null;
  if (body.meet_event_type_id !== undefined) {
    if (body.meet_event_type_id === null) meetEventTypeId = null;
    else {
      const found = app.db.get('SELECT id FROM event_types WHERE id = ? AND workspace_id = ?', String(body.meet_event_type_id), workspaceId);
      if (!found) invalid('meet_event_type_id', 'Event type not found in this workspace.');
      meetEventTypeId = found.id;
    }
  }

  let formsFormId = existing?.forms_form_id ?? null;
  if (body.forms_form_id !== undefined) {
    if (body.forms_form_id === null) formsFormId = null;
    else {
      const found = app.db.get('SELECT id FROM forms WHERE id = ? AND workspace_id = ?', String(body.forms_form_id), workspaceId);
      if (!found) invalid('forms_form_id', 'Form not found in this workspace.');
      formsFormId = found.id;
    }
  }

  let flowId = existing?.flow_id ?? null;
  if (body.flow_id !== undefined) {
    if (body.flow_id === null) flowId = null;
    else {
      const found = app.db.get('SELECT id FROM flows WHERE id = ? AND workspace_id = ?', String(body.flow_id), workspaceId);
      if (!found) invalid('flow_id', 'Flow not found in this workspace.');
      flowId = found.id;
    }
  }

  const now = app.now();
  const completedAt = body.completed !== undefined ? (body.completed ? now : null) : (existing?.completed_at ?? null);

  app.db.run(
    `INSERT INTO workspace_onboarding (workspace_id, selected_products, active_product, active_step, meet_calendar_skipped, meet_event_type_id, forms_form_id, flow_id, completed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id) DO UPDATE SET
       selected_products = excluded.selected_products,
       active_product = excluded.active_product,
       active_step = excluded.active_step,
       meet_calendar_skipped = excluded.meet_calendar_skipped,
       meet_event_type_id = excluded.meet_event_type_id,
       forms_form_id = excluded.forms_form_id,
       flow_id = excluded.flow_id,
       completed_at = excluded.completed_at,
       updated_at = excluded.updated_at`,
    workspaceId, JSON.stringify(selectedProducts), activeProduct, activeStep, meetCalendarSkipped, meetEventTypeId, formsFormId, flowId, completedAt, now
  );
  return getOnboarding(app, actor);
}
