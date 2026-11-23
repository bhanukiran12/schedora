import { randomUUID } from 'node:crypto';
import { fail } from '../http.mjs';
import { can } from '../platform/workspaces.mjs';
import { queueEmail } from '../platform/email.mjs';
import { consumeQuota } from '../billing/entitlements.mjs';
import { addDays, isValidTimeZone, localDate, localMinutes, weekday, zonedToUtc } from '../time.mjs';
import { baseFields, choosePath, flatten, renderText, rulesHold, ruleSentence, stepFields, stepTitle as rawStepTitle, TERMINAL, TRIGGERS } from '../shared/flow-logic.mjs';
import { loadContext, maskValue, subjectOf, waitKey, eventKeys } from './context.mjs';
import { FlowError, previewAction, runAction } from './actions.mjs';

// The Flow v1 execution engine (docs/FLOW_V1_IMPLEMENTATION.md, "Engine").
//
// - A run executes the published version it started on. Its position is the set of step records: a run
//   replays its definition from the top, reusing every recorded step, so a resumed or retried run never
//   repeats a step that succeeded (branch choices, waits and approvals included).
// - Workers claim a run with a lease. A run whose lease expired (worker crash, restart) is claimed again;
//   an external call that was in flight is marked uncertain and waits for a person instead of resending.
// - Timers are run fields (next_attempt_at), so waits survive restarts. Event waits and approvals resolve
//   exactly once with a conditional update, so an event racing a timeout has a single winner.
// - Usage counts once, when a run is created from a real event. Simulations, tests and retries never count.

const MINUTE = 60000;
const LEASE_MS = 2 * MINUTE;
const STEP_ATTEMPTS = 5;
const MAX_DEPTH = 3;
const backoff = attempts => Math.min(60 * MINUTE, 30000 * 2 ** Math.max(0, attempts - 1));
const LIVE_STATUSES = ['queued', 'retrying', 'waiting', 'needs_approval'];
const parse = value => value ? JSON.parse(value) : null;
// Titles people read show fields as [Field name], never {{tokens}}.
function titler(definition) {
  const labels = Object.fromEntries([...baseFields(definition?.trigger?.type), ...stepFields(definition?.steps || [])]);
  return step => rawStepTitle(step, labels).replace(/\{\{\s*([a-z][a-z0-9_.-]{0,80})\s*\}\}/g, (_, key) => '[' + (labels[key] || key.replace(/^answer\./, '').replace(/[._]/g, ' ')) + ']');
}
const stepTitle = step => titler(null)(step);

export function versionDefinition(app, flowId, version) {
  const row = app.db.get('SELECT definition, published_by, published_at FROM flow_versions WHERE flow_id = ? AND version = ?', flowId, version);
  return row ? { definition: JSON.parse(row.definition), publishedBy: row.published_by, publishedAt: row.published_at } : null;
}

// ---- Starting runs --------------------------------------------------------------------------------

/** Creates a run for a real event, once per (flow, event). Returns the run id, or null for a duplicate. */
export function startRun(app, flow, { eventId, eventType, subjectId, data = null, depth = 0 }) {
  return app.db.transaction(() => {
    if (app.db.get('SELECT 1 FROM flow_runs WHERE flow_id = ? AND event_id = ?', flow.id, eventId)) return null;
    const id = randomUUID();
    const now = app.now();
    let status = 'queued';
    let error = null;
    try { consumeQuota(app, flow.workspace_id, 'flow_runs'); } catch (quota) { status = 'failed'; error = quota.message; }
    app.db.run(`INSERT INTO flow_runs (id, workspace_id, flow_id, event_id, event_type, subject_id, status, next_attempt_at, last_error, created_at, updated_at, version, trigger_data, depth, reason, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, flow.workspace_id, flow.id, eventId, eventType, subjectId || '', status, now, error, now, now,
    flow.published_version, data ? JSON.stringify(data) : null, depth, error, status === 'failed' ? now : null);
    app.nudge?.();
    return id;
  });
}

function sourceMatches(app, trigger, event, data) {
  if (!trigger.source) return true;
  const subject = subjectOf(trigger.type);
  if (subject === 'booking') return event.source_id === trigger.source || app.db.get('SELECT 1 FROM bookings WHERE id = ? AND event_type_id = ?', event.subject_id, trigger.source);
  if (subject === 'row') return event.source_id === trigger.source && data?.sheet === trigger.config?.sheet;
  return event.source_id === trigger.source;
}

const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/** Called inside the outbox dispatch transaction for every event: starts v1 runs and resolves waits. */
export function dispatchFlowEvent(app, event) {
  resolveWaits(app, event);
  if (event.type === 'meet.booking.canceled') stopBookingRuns(app, event);
  const data = parse(event.payload);
  const depth = Number(event.depth || 0);
  // Loop protection: sheet changes made by automation, undo or redo never start sheet workflows, and no
  // chain of automations goes deeper than MAX_DEPTH.
  if (event.type.startsWith('sheets.') && ['automation', 'undo', 'redo'].includes(event.origin)) return;
  if (depth >= MAX_DEPTH) { app.log?.('warn', 'flow_depth_limit', { event: event.id, type: event.type }); return; }
  const flows = app.db.all("SELECT * FROM flows WHERE workspace_id = ? AND trigger_type = ? AND status = 'enabled' AND action_type = 'steps' AND published_version IS NOT NULL", event.workspace_id, event.type);
  for (const flow of flows) {
    const version = versionDefinition(app, flow.id, flow.published_version);
    const trigger = version?.definition.trigger;
    if (!trigger || trigger.type !== event.type || !sourceMatches(app, trigger, event, data)) continue;
    if (event.type === 'sheets.cell.changed' && !(same(data?.column, trigger.config?.column) && same(data?.value, trigger.config?.value))) continue;
    if (event.type === 'sheets.row.manual' && data?.flow_id !== flow.id) continue;
    startRun(app, flow, { eventId: event.id, eventType: event.type, subjectId: event.subject_id, data, depth });
  }
}

/**
 * A canceled booking stops its unfinished runs (waiting, awaiting approval, queued or retrying), so nobody
 * is followed up or reminded about a meeting they canceled. Workflows started by the cancellation itself
 * are not affected. A step already in flight finishes; nothing after it runs.
 */
function stopBookingRuns(app, event) {
  const now = app.now();
  const runs = app.db.all(`SELECT id FROM flow_runs WHERE workspace_id = ? AND subject_id = ? AND version IS NOT NULL AND event_type <> 'meet.booking.canceled'
    AND status IN ('queued', 'retrying', 'waiting', 'needs_approval', 'running')`, event.workspace_id, event.subject_id);
  for (const { id } of runs) {
    if (!app.db.run(`UPDATE flow_runs SET status = 'canceled', reason = 'The booking was canceled.', finished_at = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'retrying', 'waiting', 'needs_approval', 'running')`, now, now, id).changes) continue;
    app.db.run("UPDATE flow_waits SET outcome = 'canceled', resolved_at = ? WHERE run_id = ? AND resolved_at IS NULL", now, id);
    app.db.run("UPDATE flow_approvals SET status = 'canceled', decided_at = ? WHERE run_id = ? AND status = 'pending'", now, id);
    app.db.run("UPDATE flow_run_steps SET status = 'canceled', error = 'The booking was canceled.', finished_at = ? WHERE run_id = ? AND status = 'waiting'", now, id);
  }
}

/** An event that answers "wait until they …" resolves those waits once; the race with a timeout has one winner. */
function resolveWaits(app, event) {
  const keys = eventKeys(app, event);
  if (!keys.length) return;
  const now = app.now();
  const waits = app.db.all(`SELECT run_id, step_id FROM flow_waits WHERE workspace_id = ? AND event_type = ? AND resolved_at IS NULL AND timeout_at > ? AND (source_id IS NULL OR source_id = ?) AND match_key IN (${keys.map(() => '?').join(', ')})`,
    event.workspace_id, event.type, now, event.source_id, ...keys);
  for (const wait of waits) {
    const won = app.db.run("UPDATE flow_waits SET outcome = 'matched', resolved_at = ?, matched_subject = ? WHERE run_id = ? AND step_id = ? AND resolved_at IS NULL", now, event.subject_id, wait.run_id, wait.step_id);
    if (won.changes) app.db.run("UPDATE flow_runs SET status = 'queued', next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'waiting'", now, now, wait.run_id);
  }
}

// ---- Timed triggers: before/after/ended meetings and schedules ------------------------------------

// Schedules are wall-clock times in the chosen time zone (UTC when none was chosen). A time skipped by a
// daylight-saving change runs at the first minute that exists after it; a repeated time runs once, at
// the first occurrence.
function slotAt(date, minutes, timeZone) {
  for (const shift of [0, 30, 60, 90, 120]) {
    const at = zonedToUtc(date, Math.min(minutes + shift - (shift ? minutes % 30 : 0), 1440), timeZone);
    if (at != null) return at;
  }
  return null;
}
const scheduleZone = config => (config.timezone && isValidTimeZone(config.timezone) ? config.timezone : 'UTC');

/** The most recent scheduled instant at or before `now`. */
export function scheduleSlot(config, now, timeZone = scheduleZone(config)) {
  const [hours, minutes] = (config.time || '09:00').split(':').map(Number);
  if (config.every === 'hour') {
    const floor = Math.floor(now / MINUTE) * MINUTE;
    return floor - (((localMinutes(floor, timeZone) - minutes) % 60) + 60) % 60 * MINUTE;
  }
  let date = localDate(now, timeZone);
  for (let back = 0; back < 9; back++) {
    const at = slotAt(date, hours * 60 + minutes, timeZone);
    if (at != null && at <= now && (config.every === 'day' || weekday(date) === config.weekday)) return at;
    date = addDays(date, -1);
  }
  return null;
}

/** The next `count` scheduled instants after `now`, for the builder's "Next runs" line. */
export function nextScheduleRuns(config, now, count = 3) {
  const timeZone = scheduleZone(config);
  const runs = [];
  if (config.every === 'hour') {
    let at = scheduleSlot(config, now, timeZone);
    while (runs.length < count) { at += 60 * MINUTE; if (at > now) runs.push(at); }
    return runs;
  }
  const [hours, minutes] = (config.time || '09:00').split(':').map(Number);
  let date = localDate(now, timeZone);
  for (let ahead = 0; ahead < 60 && runs.length < count; ahead++) {
    const at = slotAt(date, hours * 60 + minutes, timeZone);
    if (at != null && at > now && (config.every === 'day' || weekday(date) === config.weekday)) runs.push(at);
    date = addDays(date, 1);
  }
  return runs;
}

/** Worker: starts runs for time-based triggers. Each (flow, booking, time) or (flow, slot) starts at most once. */
export function scanTimedTriggers(app, { force = false } = {}) {
  const now = app.now();
  if (!force && now - (app.flowScanAt || 0) < 30000) return 0;
  app.flowScanAt = now;
  let started = 0;
  const flows = app.db.all("SELECT * FROM flows WHERE status = 'enabled' AND action_type = 'steps' AND published_version IS NOT NULL AND trigger_type IN ('meet.booking.before_start', 'meet.booking.after_end', 'meet.booking.ended', 'schedule')");
  for (const flow of flows) {
    const trigger = versionDefinition(app, flow.id, flow.published_version)?.definition.trigger;
    if (!trigger) continue;
    const since = Math.max(flow.enabled_at || 0, now - 7 * 24 * 60 * MINUTE);
    if (trigger.type === 'schedule') {
      const slot = scheduleSlot(trigger.config, now);
      const last = app.db.get('SELECT last_slot FROM flow_schedules WHERE flow_id = ?', flow.id)?.last_slot ?? 0;
      if (slot == null || slot <= last || slot < (flow.enabled_at || 0)) continue;
      app.db.run('INSERT INTO flow_schedules (flow_id, last_slot) VALUES (?, ?) ON CONFLICT (flow_id) DO UPDATE SET last_slot = excluded.last_slot', flow.id, slot);
      if (startRun(app, flow, { eventId: `schedule:${slot}`, eventType: 'schedule', subjectId: '', data: { slot } })) started++;
      continue;
    }
    const minutes = (trigger.config?.minutes || 0) * MINUTE;
    const target = trigger.type === 'meet.booking.before_start' ? `b.starts_at - ${minutes}` : trigger.type === 'meet.booking.after_end' ? `b.ends_at + ${minutes}` : 'b.ends_at';
    const due = app.db.all(`SELECT b.id, ${target} AS target, b.starts_at FROM bookings b WHERE b.workspace_id = ? AND b.status = 'confirmed' AND b.anonymized_at IS NULL
      AND (? IS NULL OR b.event_type_id = ?) AND ${target} <= ? AND ${target} > ? ${trigger.type === 'meet.booking.before_start' ? 'AND b.starts_at > ?' : 'AND 1 = ?'} ORDER BY ${target} LIMIT 200`,
    flow.workspace_id, trigger.source ?? null, trigger.source ?? null, now, since, trigger.type === 'meet.booking.before_start' ? now : 1);
    for (const booking of due) if (startRun(app, flow, { eventId: `${trigger.type}:${booking.id}:${booking.target}`, eventType: trigger.type, subjectId: booking.id })) started++;
  }
  return started;
}

// ---- Execution --------------------------------------------------------------------------------------

const getStep = (app, runId, stepId) => app.db.get('SELECT * FROM flow_run_steps WHERE run_id = ? AND step_id = ?', runId, stepId);
function putStep(app, runId, step, status, { input, output, error, attempts } = {}) {
  const now = app.now();
  app.db.run(`INSERT INTO flow_run_steps (run_id, step_id, step_type, status, attempts, input, output, error, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (run_id, step_id) DO UPDATE SET status = excluded.status, attempts = excluded.attempts, input = COALESCE(excluded.input, flow_run_steps.input), output = excluded.output, error = excluded.error, finished_at = excluded.finished_at`,
  runId, step.id, step.type === 'action' ? step.action : step.type, status, attempts ?? 0, input ? JSON.stringify(input) : null, output ? JSON.stringify(output) : null, error ? String(error).slice(0, 500) : null, now, ['running', 'waiting'].includes(status) ? null : now);
}

// Step outputs that later steps can use as fields.
function outputValues(step, output) {
  if (!output) return {};
  if (output.values) return output.values;
  const values = {};
  if (typeof output.text === 'string') values[`steps.${step.id}.text`] = output.text;
  if (typeof output.label === 'string') values[`steps.${step.id}.label`] = output.label;
  if (typeof output.happened === 'boolean') values[`steps.${step.id}.happened`] = output.happened ? 'yes' : 'no';
  if (output.replaces && typeof output.text === 'string') values[`steps.${output.replaces}.text`] = output.text;
  return values;
}

/**
 * Walks the steps. `io` performs or simulates each step type. Returns { end, reason } when the run is
 * finished, { hold, until, status } when it must wait, or { fail } on an error.
 */
async function walk(steps, io) {
  for (const step of steps) {
    if (io.halted?.()) return { hold: true, status: 'queued', until: io.now() };
    const record = io.record(step);
    if (record && ['succeeded', 'skipped'].includes(record.status) && !(step.type === 'condition' && record.status === 'skipped')) {
      Object.assign(io.values, outputValues(step, record.output));
      if (step.type === 'branch') {
        const path = step.paths.find(item => item.id === record.output?.path);
        if (path) { const result = await walk(path.steps, io); if (result) return result; }
      }
      continue;
    }
    if (record?.status === 'uncertain') return { fail: `“${stepTitle(step)}” may or may not have happened. Review it before retrying.`, uncertain: true };
    if (record?.status === 'canceled') return { end: 'canceled', reason: record.error || 'Canceled.' };
    const result = await io.execute(step, record);
    if (result.done) { Object.assign(io.values, outputValues(step, result.output)); if (step.type === 'branch' && result.path) { const inner = await walk(result.path.steps, io); if (inner) return inner; } continue; }
    if (result.skipStep) continue;
    return result;
  }
  return null;
}

function liveIo(app, run, context, values, publisherId) {
  const records = new Map(app.db.all('SELECT * FROM flow_run_steps WHERE run_id = ?', run.id).map(row => [row.step_id, { ...row, output: parse(row.output) }]));
  const now = () => app.now();
  return {
    values, now,
    halted: () => app.db.get('SELECT status FROM flows WHERE id = ?', run.flow_id)?.status !== 'enabled' || app.db.get('SELECT status FROM flow_runs WHERE id = ?', run.id)?.status !== 'running',
    record: step => records.get(step.id),
    async execute(step, record) {
      switch (step.type) {
        case 'condition': {
          if (rulesHold(step.match, step.rules, values)) { putStep(app, run.id, step, 'succeeded', { output: { passed: true } }); return { done: true }; }
          const reason = `Only-if rule not met: ${ruleSentence(step.match, step.rules)}.`;
          putStep(app, run.id, step, 'skipped', { output: { passed: false }, error: reason });
          return { end: 'skipped', reason };
        }
        case 'branch': {
          const path = choosePath(step, values);
          putStep(app, run.id, step, 'succeeded', { output: { path: path?.id || null, label: path?.label || 'No path matched' } });
          return { done: true, path };
        }
        case 'stop': putStep(app, run.id, step, 'succeeded', { output: { stopped: true } }); return { end: 'succeeded', reason: `Stopped: ${step.reason || 'the workflow ended here'}.` };
        case 'wait': {
          const until = record?.output?.until ?? (step.mode === 'duration' ? now() + step.minutes * MINUTE : Date.parse(step.at));
          if (until <= now()) { putStep(app, run.id, step, 'succeeded', { output: { until } }); return { done: true }; }
          if (!record) putStep(app, run.id, step, 'waiting', { output: { until } });
          return { hold: true, status: 'waiting', until };
        }
        case 'wait_for': {
          let wait = app.db.get('SELECT * FROM flow_waits WHERE run_id = ? AND step_id = ?', run.id, step.id);
          if (!wait) {
            const matchKey = waitKey(context);
            const timeout = now() + step.timeout_minutes * MINUTE;
            if (!matchKey) { putStep(app, run.id, step, 'succeeded', { output: { happened: false, note: 'No contact to match on this record.' } }); return { done: true, output: { happened: false } }; }
            app.db.run('INSERT INTO flow_waits (run_id, step_id, workspace_id, event_type, match_key, source_id, timeout_at) VALUES (?, ?, ?, ?, ?, ?, ?)', run.id, step.id, run.workspace_id, step.event, matchKey, step.source || null, timeout);
            putStep(app, run.id, step, 'waiting', { output: { until: timeout } });
            return { hold: true, status: 'waiting', until: timeout };
          }
          if (!wait.resolved_at && wait.timeout_at <= now()) {
            app.db.run("UPDATE flow_waits SET outcome = 'timeout', resolved_at = ? WHERE run_id = ? AND step_id = ? AND resolved_at IS NULL", now(), run.id, step.id);
            wait = app.db.get('SELECT * FROM flow_waits WHERE run_id = ? AND step_id = ?', run.id, step.id);
          }
          if (!wait.resolved_at) return { hold: true, status: 'waiting', until: wait.timeout_at };
          const output = { happened: wait.outcome === 'matched', at: wait.resolved_at, ...(wait.outcome === 'matched' && step.event === 'forms.response.created' ? { values: matchedResponseValues(app, run, step, wait.matched_subject) } : {}) };
          putStep(app, run.id, step, 'succeeded', { output });
          return { done: true, output };
        }
        case 'approval': {
          let approval = app.db.get('SELECT * FROM flow_approvals WHERE run_id = ? AND step_id = ?', run.id, step.id);
          if (!approval) {
            const draftStep = [...Object.keys(values)].reverse().find(name => /^steps\.[a-z0-9_-]+\.text$/.test(name));
            const expires = now() + step.expires_hours * 60 * MINUTE;
            // The title names this record (fields filled in), so approvers know what they are deciding.
            const title = renderText(step.title, values).slice(0, 200) || 'Approval';
            app.db.run(`INSERT INTO flow_approvals (id, run_id, step_id, workspace_id, approver, status, title, draft, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
              randomUUID(), run.id, step.id, run.workspace_id, step.approver, title, draftStep ? JSON.stringify({ text: values[draftStep], replaces: draftStep.split('.')[1] }) : null, expires, now());
            putStep(app, run.id, step, 'waiting', { output: { until: expires } });
            notifyApprover(app, run, step, context, title);
            return { hold: true, status: 'needs_approval', until: expires };
          }
          if (approval.status === 'pending' && approval.expires_at <= now()) {
            app.db.run("UPDATE flow_approvals SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'", now(), approval.id);
            approval = app.db.get('SELECT * FROM flow_approvals WHERE id = ?', approval.id);
          }
          if (approval.status === 'pending') return { hold: true, status: 'needs_approval', until: approval.expires_at };
          if (approval.status === 'approved') {
            const draft = parse(approval.draft);
            const output = draft ? { text: draft.text, replaces: draft.replaces, approved_by: approval.decided_by } : { approved_by: approval.decided_by };
            putStep(app, run.id, step, 'succeeded', { output });
            return { done: true, output };
          }
          const reason = approval.status === 'rejected' ? `Not approved${approval.note ? `: ${approval.note}` : '.'}` : approval.status === 'expired' ? 'The approval request expired before anyone decided.' : 'The approval request was canceled.';
          putStep(app, run.id, step, approval.status === 'rejected' ? 'skipped' : 'canceled', { error: reason });
          return { end: approval.status === 'rejected' ? 'skipped' : 'canceled', reason };
        }
        case 'action': {
          const attempts = (record?.attempts || 0) + 1;
          // Messages, Slack and webhooks reach people or other systems. Mark them in flight first: if the worker
          // dies mid-call, recovery sees "running" and treats the outcome as uncertain instead of calling again
          // (the email queue also leaves an interrupted Flow message alone; platform/email.mjs).
          const external = ['send_email', 'send_whatsapp', 'send_sms', 'send_booking_link', 'send_form', 'slack', 'webhook'].includes(step.action);
          if (external) putStep(app, run.id, step, 'running', { attempts });
          try {
            const result = await runAction(app, run, step, context, values, publisherId);
            putStep(app, run.id, step, 'succeeded', { attempts, output: result.output && result.values ? { ...result.output, values: result.values } : result.output });
            return { done: true, output: result.values ? { values: result.values } : result.output };
          } catch (error) {
            const flowError = error instanceof FlowError ? error : new FlowError(error.message || 'Unexpected error.', 'permanent');
            if (flowError.kind === 'skip') { putStep(app, run.id, step, 'skipped', { attempts, error: flowError.message }); return { skipStep: true }; }
            if (flowError.kind === 'uncertain') { putStep(app, run.id, step, 'uncertain', { attempts, error: flowError.message }); return { fail: flowError.message, uncertain: true }; }
            if (flowError.kind === 'transient' && attempts < STEP_ATTEMPTS) {
              putStep(app, run.id, step, 'failed', { attempts, error: flowError.message });
              return { hold: true, status: 'retrying', until: now() + backoff(attempts), error: flowError.message };
            }
            putStep(app, run.id, step, 'failed', { attempts, error: flowError.message });
            return { fail: flowError.message };
          }
        }
        default: return { fail: 'Unknown step.' };
      }
    }
  };
}

function notifyApprover(app, run, step, context, title) {
  const flow = app.db.get('SELECT name, created_by FROM flows WHERE id = ?', run.flow_id);
  const id = step.approver === 'host' ? context.hostId : step.approver === 'owner' ? context.contact?.owner_id : step.approver.startsWith('member:') ? step.approver.slice(7) : null;
  const people = id ? app.db.all('SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.user_id = ?', run.workspace_id, id)
    : app.db.all("SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.role IN ('owner', 'admin') ORDER BY m.created_at LIMIT 3", run.workspace_id);
  for (const person of people) queueEmail(app, { workspaceId: run.workspace_id, key: `flow-approval:${run.id}:${step.id}:${person.email}`, kind: 'flow_approval', relatedId: run.id, to: person.email,
    subject: `Approval needed: ${flow.name}`.slice(0, 200), body: `“${flow.name}” is waiting for your approval: ${title}\n\nReview it here: ${app.config.baseUrl}/flow/approvals\n\nNothing is sent until someone approves.` });
}

// A matched form response's answers become fields of the waiting run (for example a feedback rating).
function matchedResponseValues(app, run, step, responseId) {
  const matched = responseId && loadContext(app, { event_type: 'forms.response.created', workspace_id: run.workspace_id, subject_id: responseId });
  const values = { [`steps.${step.id}.happened`]: 'yes' };
  for (const [name, value] of Object.entries(matched?.values || {})) if (name.startsWith('answer.') || name.startsWith('lead.')) values[`steps.${step.id}.${name}`] = String(value).slice(0, 500);
  return values;
}

/** Runs one claimed run as far as it can go. */
export async function executeRun(app, runId, owner) {
  const run = app.db.get('SELECT * FROM flow_runs WHERE id = ?', runId);
  const version = versionDefinition(app, run.flow_id, run.version);
  if (!version) return finishRun(app, run, owner, 'failed', 'The workflow version was deleted.');
  const context = loadContext(app, run);
  if (!context) return finishRun(app, run, owner, 'failed', 'The record this run is about was deleted or removed by retention.');
  if (context.kind === 'booking' && context.bookingStatus === 'canceled' && run.event_type !== 'meet.booking.canceled') return finishRun(app, run, owner, 'canceled', 'The booking was canceled.');
  if (context.paymentIncomplete && run.event_type !== 'payments.captured') return finishRun(app, run, owner, 'failed', 'The response is waiting for payment; Flow only runs on completed responses.');
  const values = { ...context.values };
  const io = liveIo(app, run, context, values, version.publishedBy);
  let result;
  try { result = await walk(version.definition.steps, io); }
  catch (error) { result = { fail: 'Unexpected error: ' + String(error.message).slice(0, 200) }; app.log?.('error', 'flow_run_crashed', { run: run.id, error: error.message }); }
  if (!result) return finishRun(app, run, owner, 'succeeded', null);
  if (result.end) return finishRun(app, run, owner, result.end, result.reason);
  if (result.fail) return finishRun(app, run, owner, 'failed', result.fail);
  // Hold: release the lease with the timer that wakes it.
  app.db.run('UPDATE flow_runs SET status = ?, next_attempt_at = ?, lease_owner = NULL, lease_until = NULL, last_error = ?, updated_at = ? WHERE id = ? AND lease_owner = ? AND status = ?',
    result.status, result.until, result.error || null, app.now(), run.id, owner, 'running');
  return result.status;
}

function finishRun(app, run, owner, status, reason) {
  const now = app.now();
  const changed = app.db.run('UPDATE flow_runs SET status = ?, reason = ?, last_error = ?, finished_at = ?, next_attempt_at = ?, lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND lease_owner = ? AND status = ?',
    status, reason, status === 'failed' ? reason : null, now, now, now, run.id, owner, 'running').changes;
  if (changed) trackFailures(app, run.flow_id, status);
  return status;
}

// Three failures in a row: one alert email, and an automatic pause when the author asked for it.
function trackFailures(app, flowId, status) {
  if (status !== 'failed') { app.db.run('UPDATE flows SET consecutive_failures = 0, alerted_at = NULL WHERE id = ? AND consecutive_failures > 0', flowId); return; }
  app.db.run('UPDATE flows SET consecutive_failures = consecutive_failures + 1 WHERE id = ?', flowId);
  const flow = app.db.get('SELECT * FROM flows WHERE id = ?', flowId);
  if (flow.consecutive_failures < 3 || flow.alerted_at) return;
  app.db.run('UPDATE flows SET alerted_at = ? WHERE id = ?', app.now(), flowId);
  if (flow.auto_pause) app.db.run("UPDATE flows SET status = 'paused', updated_at = ? WHERE id = ?", app.now(), flowId);
  const people = flow.created_by ? app.db.all('SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.user_id = ?', flow.workspace_id, flow.created_by) : [];
  const to = people.length ? people : app.db.all("SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.role = 'owner' LIMIT 1", flow.workspace_id);
  for (const person of to) queueEmail(app, { workspaceId: flow.workspace_id, key: `flow-alert:${flowId}:${app.now()}:${person.email}`, kind: 'flow_alert', relatedId: flowId, to: person.email,
    subject: `Workflow failing: ${flow.name}`.slice(0, 200), body: `“${flow.name}” failed 3 times in a row.${flow.auto_pause ? ' It has been paused so it stops failing.' : ''}\n\nSee what went wrong and retry: ${app.config.baseUrl}/flow/runs?flow=${flowId}&status=failed` });
}

/** Worker: recovers expired leases, then claims and executes due runs. */
export async function processFlowRuns(app, { limit = 20, owner = app.flowWorkerId ||= randomUUID() } = {}) {
  const now = app.now();
  // Expired leases: the worker stopped mid-run. In-flight external calls become uncertain.
  for (const run of app.db.all("SELECT id FROM flow_runs WHERE status = 'running' AND version IS NOT NULL AND lease_until < ?", now)) {
    app.db.transaction(() => {
      if (!app.db.run("UPDATE flow_runs SET status = 'queued', lease_owner = NULL, lease_until = NULL, next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'running' AND lease_until < ?", now, now, run.id, now).changes) return;
      app.db.run("UPDATE flow_run_steps SET status = 'uncertain', error = 'The worker stopped during this call, so it may or may not have happened.', finished_at = ? WHERE run_id = ? AND status = 'running'", now, run.id);
    });
  }
  const due = app.db.all(`SELECT r.id FROM flow_runs r JOIN flows f ON f.id = r.flow_id WHERE r.version IS NOT NULL AND r.status IN ('queued', 'retrying', 'waiting', 'needs_approval')
    AND r.next_attempt_at <= ? AND f.status = 'enabled' ORDER BY r.next_attempt_at LIMIT ?`, now, limit);
  let ran = 0;
  for (const { id } of due) {
    const claimed = app.db.run(`UPDATE flow_runs SET status = 'running', lease_owner = ?, lease_until = ?, attempts = attempts + 1, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'retrying', 'waiting', 'needs_approval') AND next_attempt_at <= ? AND (lease_until IS NULL OR lease_until < ?)`, owner, now + LEASE_MS, now, id, now, now).changes;
    if (!claimed) continue;
    // A freshly claimed run cannot have a step legitimately in flight. One left "running" (for example a
    // crashed run that an older release moved back to retrying) may have happened, so it needs review.
    app.db.run("UPDATE flow_run_steps SET status = 'uncertain', error = 'The worker stopped during this call, so it may or may not have happened.', finished_at = ? WHERE run_id = ? AND status = 'running'", now, id);
    await executeRun(app, id, owner);
    ran++;
  }
  return ran;
}

// ---- People acting on runs ----------------------------------------------------------------------------

export function getRun(app, workspaceId, runId) {
  const run = app.db.get('SELECT r.*, f.name AS flow_name FROM flow_runs r JOIN flows f ON f.id = r.flow_id WHERE r.id = ? AND r.workspace_id = ?', runId, workspaceId);
  if (!run) fail(404, 'not_found', 'Run not found.');
  return run;
}

/** Cancels a run that has not finished: waits and approvals are closed and nothing further happens. */
export function cancelRun(app, workspaceId, runId, actorName = 'a team member') {
  return app.db.transaction(() => {
    const run = getRun(app, workspaceId, runId);
    if (TERMINAL.includes(run.status)) fail(409, 'run_finished', 'This run has already finished.');
    const now = app.now();
    app.db.run("UPDATE flow_runs SET status = 'canceled', reason = ?, finished_at = ?, lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ?", `Canceled by ${actorName}.`, now, now, runId);
    app.db.run("UPDATE flow_waits SET outcome = 'canceled', resolved_at = ? WHERE run_id = ? AND resolved_at IS NULL", now, runId);
    app.db.run("UPDATE flow_approvals SET status = 'canceled', decided_at = ? WHERE run_id = ? AND status = 'pending'", now, runId);
    app.db.run("UPDATE flow_run_steps SET status = 'canceled', finished_at = ? WHERE run_id = ? AND status IN ('waiting', 'running')", now, runId);
    return { run_id: runId, status: 'canceled' };
  });
}

/** What a retry would do: steps that already happened, uncertain ones that need a decision, and the rest. */
export function retryPreview(app, workspaceId, runId) {
  const run = getRun(app, workspaceId, runId);
  const version = versionDefinition(app, run.flow_id, run.version);
  if (!version) fail(409, 'not_retryable', 'This run belongs to the original single-step engine. Use Retry on the run list.');
  const records = new Map(app.db.all('SELECT step_id, status, error FROM flow_run_steps WHERE run_id = ?', runId).map(row => [row.step_id, row]));
  const done = []; const uncertain = []; const again = []; let failedAt = null;
  const stepTitle = titler(version.definition);
  for (const step of flatten(version.definition.steps)) {
    const record = records.get(step.id);
    if (!record) continue;
    if (['succeeded', 'skipped'].includes(record.status)) done.push(stepTitle(step));
    else if (record.status === 'uncertain') uncertain.push({ step: step.id, title: stepTitle(step), reason: record.error });
    else if (record.status === 'failed') { again.push(stepTitle(step)); failedAt ||= stepTitle(step); }
  }
  return { status: run.status, retryable: run.status === 'failed', already_done: done, will_run_again: again, uncertain,
    note: failedAt ? `Retry starts at “${failedAt}”. Steps that already happened are not repeated.` : 'Retry continues from where the run stopped.' };
}

/**
 * Retries a failed run without repeating completed steps. Uncertain steps need a decision first:
 * "resend" calls them again (with the same idempotency key) and "done" records them as having happened.
 * Never counts toward usage.
 */
export function retryFlowRun(app, workspaceId, runId, { uncertain } = {}) {
  return app.db.transaction(() => {
    const run = getRun(app, workspaceId, runId);
    if (run.status !== 'failed' || run.version == null) fail(409, 'not_retryable', 'Only failed runs can be retried.');
    const open = app.db.all("SELECT step_id FROM flow_run_steps WHERE run_id = ? AND status = 'uncertain'", runId);
    if (open.length && !['resend', 'done'].includes(uncertain)) fail(409, 'uncertain_steps', 'Some steps may already have happened. Choose whether to send them again or treat them as done.', { steps: open.map(row => row.step_id) });
    const now = app.now();
    // A message whose provider call was interrupted stays claimed until this decision.
    for (const { step_id: stepId } of open) {
      const messageKey = `flow:${runId}:${stepId}`;
      if (uncertain === 'resend') app.db.run("UPDATE emails SET status = 'queued', claimed_until = NULL, next_attempt_at = ? WHERE idempotency_key = ? AND status = 'sending'", now, messageKey);
      else app.db.run("UPDATE emails SET status = 'canceled', claimed_until = NULL, last_error = 'Treated as already sent after an interrupted send.' WHERE idempotency_key = ? AND status = 'sending'", messageKey);
    }
    if (uncertain === 'done') app.db.run("UPDATE flow_run_steps SET status = 'succeeded', output = ?, error = NULL, finished_at = ? WHERE run_id = ? AND status = 'uncertain'", JSON.stringify({ marked_done: true }), now, runId);
    app.db.run("DELETE FROM flow_run_steps WHERE run_id = ? AND status IN ('failed', 'uncertain')", runId);
    app.db.run("UPDATE flow_runs SET status = 'queued', reason = NULL, last_error = NULL, finished_at = NULL, next_attempt_at = ?, updated_at = ? WHERE id = ?", now, now, runId);
    app.nudge?.();
    return { run_id: runId, status: 'queued' };
  });
}

/** Retries failed runs of one flow after a fix. Runs with uncertain steps are listed, never resent in bulk. */
export function retryFailedRuns(app, workspaceId, flowId, runIds = null) {
  const failed = app.db.all("SELECT id FROM flow_runs WHERE workspace_id = ? AND flow_id = ? AND status = 'failed' AND version IS NOT NULL ORDER BY created_at LIMIT 200", workspaceId, flowId)
    .filter(row => !runIds || runIds.includes(row.id));
  const retried = []; const needsReview = [];
  for (const { id } of failed) {
    if (app.db.get("SELECT 1 FROM flow_run_steps WHERE run_id = ? AND status = 'uncertain'", id)) { needsReview.push(id); continue; }
    retryFlowRun(app, workspaceId, id);
    retried.push(id);
  }
  return { retried: retried.length, needs_review: needsReview };
}

// ---- Approvals ------------------------------------------------------------------------------------------

function canDecide(app, actor, approval, run) {
  if (can(actor.role, 'flows.manage')) return true;
  if (approval.approver === 'admins') return false;
  if (approval.approver.startsWith('member:')) return approval.approver.slice(7) === actor.userId;
  const context = loadContext(app, run);
  if (approval.approver === 'host') return context?.hostId === actor.userId;
  if (approval.approver === 'owner') return context?.contact?.owner_id === actor.userId;
  return false;
}

export function listApprovals(app, actor, status = 'pending') {
  return app.db.all(`SELECT a.*, r.flow_id, f.name AS flow_name, r.event_type, r.subject_id, r.workspace_id AS ws FROM flow_approvals a JOIN flow_runs r ON r.id = a.run_id JOIN flows f ON f.id = r.flow_id
    WHERE a.workspace_id = ? AND (? = 'all' OR a.status = ?) ORDER BY a.created_at DESC LIMIT 100`, actor.workspace.id, status, status)
    .filter(row => canDecide(app, actor, row, app.db.get('SELECT * FROM flow_runs WHERE id = ?', row.run_id)) || row.status !== 'pending')
    .map(row => {
      const context = loadContext(app, app.db.get('SELECT * FROM flow_runs WHERE id = ?', row.run_id));
      return { id: row.id, run_id: row.run_id, flow_id: row.flow_id, flow_name: row.flow_name, title: row.title, status: row.status, revision: row.revision,
        draft: parse(row.draft)?.text ?? null, about: context ? (context.name || (context.email ? maskValue(context.email) : null)) : null,
        expires_at: row.expires_at, created_at: row.created_at, decided_at: row.decided_at, note: row.note, can_decide: row.status === 'pending' && canDecide(app, actor, row, app.db.get('SELECT * FROM flow_runs WHERE id = ?', row.run_id)) };
    });
}

/** Approve or reject once, against the revision the person saw; editing the draft bumps the revision. */
export function decideApproval(app, actor, approvalId, body) {
  return app.db.transaction(() => {
    const approval = app.db.get('SELECT * FROM flow_approvals WHERE id = ? AND workspace_id = ?', approvalId, actor.workspace.id);
    if (!approval) fail(404, 'not_found', 'Approval not found.');
    const run = app.db.get('SELECT * FROM flow_runs WHERE id = ?', approval.run_id);
    if (!canDecide(app, actor, approval, run)) fail(403, 'forbidden', 'You are not an approver for this step.');
    if (approval.status !== 'pending') fail(409, 'approval_closed', approval.status === 'approved' ? 'This was already approved.' : `This request is ${approval.status}.`, { status: approval.status });
    if (approval.expires_at <= app.now()) fail(409, 'approval_closed', 'This request expired.', { status: 'expired' });
    if (body.revision !== approval.revision) fail(409, 'approval_changed', 'The draft changed since you opened it. Review the latest version.', { revision: approval.revision });
    const now = app.now();
    if (body.decision === 'edit') {
      const draft = parse(approval.draft);
      if (!draft || typeof body.draft !== 'string' || !body.draft.trim() || body.draft.length > 3000) fail(400, 'validation_failed', 'Write the message to approve (up to 3,000 characters).');
      app.db.run('UPDATE flow_approvals SET draft = ?, revision = revision + 1 WHERE id = ? AND revision = ?', JSON.stringify({ ...draft, text: body.draft.trim(), edited: true }), approvalId, approval.revision);
      return { status: 'pending', revision: approval.revision + 1 };
    }
    if (!['approve', 'reject'].includes(body.decision)) fail(400, 'validation_failed', 'Choose approve or reject.');
    const status = body.decision === 'approve' ? 'approved' : 'rejected';
    const changed = app.db.run('UPDATE flow_approvals SET status = ?, decided_by = ?, decided_at = ?, note = ? WHERE id = ? AND status = ? AND revision = ?', status, actor.userId, now,
      typeof body.note === 'string' ? body.note.trim().slice(0, 300) || null : null, approvalId, 'pending', approval.revision).changes;
    if (!changed) fail(409, 'approval_closed', 'Someone else decided first.');
    app.db.run("UPDATE flow_runs SET status = 'queued', next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'needs_approval'", now, now, approval.run_id);
    app.nudge?.();
    return { approval_id: approvalId, status };
  });
}

// ---- Timeline ------------------------------------------------------------------------------------------

/** A run with its steps in definition order: titles, outcomes, timestamps and redacted details. */
export function runTimeline(app, workspaceId, runId) {
  const run = getRun(app, workspaceId, runId);
  const version = versionDefinition(app, run.flow_id, run.version);
  const records = new Map(app.db.all('SELECT * FROM flow_run_steps WHERE run_id = ?', runId).map(row => [row.step_id, row]));
  const stepTitle = titler(version?.definition);
  const steps = version ? flatten(version.definition.steps).map(step => {
    const record = records.get(step.id);
    const output = parse(record?.output);
    let delivery = null;
    if (output?.message_id) {
      const message = app.db.get('SELECT status, delivery_status, accepted_transport, sent_at, delivery_event_at FROM emails WHERE id = ? AND workspace_id = ?', output.message_id, workspaceId);
      if (message) delivery = { accepted: message.status === 'sent', accepted_at: message.sent_at, transport: message.accepted_transport, report: message.delivery_status, reported_at: message.delivery_event_at };
    }
    const safe = output ? Object.fromEntries(Object.entries(output).filter(([name]) => !['values', 'message_id'].includes(name))) : null;
    return { id: step.id, type: step.type, title: stepTitle(step), status: record?.status || 'not_reached', attempts: record?.attempts || 0, started_at: record?.started_at || null, finished_at: record?.finished_at || null, reason: record?.error || null, output: safe, delivery };
  }) : [];
  const approval = app.db.get("SELECT id, status, title FROM flow_approvals WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", runId);
  return { id: run.id, flow_id: run.flow_id, flow_name: run.flow_name, version: run.version, status: run.status, reason: run.reason || run.last_error, trigger: TRIGGERS[run.event_type]?.label || run.event_type,
    created_at: run.created_at, finished_at: run.finished_at, next_at: ['waiting', 'needs_approval', 'retrying'].includes(run.status) ? run.next_attempt_at : null, steps, approval: approval || null };
}

// ---- Simulation ----------------------------------------------------------------------------------------

/**
 * "Test with a recent record": every step is evaluated against real values but nothing is sent, written
 * or counted. `assume` chooses what happens at waits for events and approvals.
 */
export async function simulateDefinition(app, workspaceId, definition, runLike, { assume = {} } = {}) {
  const context = runLike ? loadContext(app, { workspace_id: workspaceId, ...runLike }) : { kind: 'none', values: {}, recipients: {} };
  if (!context) fail(404, 'not_found', 'That record is no longer available.');
  const values = { ...context.values };
  const timeline = [];
  const stepTitle = titler(definition);
  const run = { id: 'simulation', workspace_id: workspaceId, flow_id: 'simulation', depth: 0 };
  const io = {
    values, now: () => app.now(), record: () => null,
    async execute(step) {
      const entry = { id: step.id, title: stepTitle(step) };
      timeline.push(entry);
      switch (step.type) {
        case 'condition': { const passed = rulesHold(step.match, step.rules, values); entry.outcome = passed ? 'passes' : 'stops here'; return passed ? { done: true } : { end: 'skipped', reason: `Only-if rule not met: ${ruleSentence(step.match, step.rules)}.` }; }
        case 'branch': { const path = choosePath(step, values); entry.outcome = path ? `takes “${path.label}”` : 'no path matches'; return { done: true, path }; }
        case 'wait': entry.outcome = 'would wait'; return { done: true };
        case 'wait_for': { const happened = assume[step.id] === 'happened'; entry.outcome = happened ? 'assumed it happens' : 'assumed it does not happen within the time limit'; return { done: true, output: { happened } }; }
        case 'approval': { const approved = assume[step.id] !== 'rejected'; entry.outcome = approved ? 'assumed approved' : 'assumed rejected'; return approved ? { done: true } : { end: 'skipped', reason: 'Not approved (assumed).' }; }
        case 'stop': entry.outcome = 'stops here'; return { end: 'succeeded', reason: 'Stopped.' };
        case 'action': entry.outcome = 'would run'; entry.preview = previewAction(app, run, step, context, values); if (step.action === 'ai_classify') values[`steps.${step.id}.label`] = step.config.labels[0]; else if (step.action.startsWith('ai_')) values[`steps.${step.id}.text`] = entry.preview.text; return { done: true };
        default: return { done: true };
      }
    }
  };
  const result = await walk(definition.steps, io);
  return { simulated: true, counted: false, outcome: result?.end || 'succeeded', reason: result?.reason || null, steps: timeline, note: 'Simulation only: nothing was sent, written or counted toward usage.' };
}
