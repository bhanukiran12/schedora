// What happened after a form response or a booking: booking step, follow-up runs and their tasks.
// Built only from records the existing APIs return (response next_step, bookings, Flow runs and
// tasks); no state is invented. Plain logic with no browser dependencies, so it is unit-tested.
import { emailEvidence } from './email-evidence.mjs';

// A Forms booking link lasts this long (HANDOFF_TTL_MS in backend/src/forms/service.mjs). The
// handoff keeps the status "offered" afterwards, so an older offer was never used.
export const OFFER_TTL_MS = 2 * 3600000;

const UNAVAILABLE = {
  destination_unavailable: 'The booking page was not available when the response arrived.',
  meet_inactive: 'Meet was not active for this workspace when the response arrived.'
};

// state: done | waiting | attention | none | unknown
function bookingStep(next, receivedAt, now) {
  if (!next) return { key: 'booking', state: 'none', title: 'No booking step', text: 'This response was not offered a booking.' };
  switch (next.status) {
    case 'offered': return now && now - receivedAt > OFFER_TTL_MS
      ? { key: 'booking', state: 'attention', reason: 'offer_expired', attention: 'Booking offer expired, not booked', title: 'Booking offer expired, not booked', text: 'The booking link lasted 2 hours and was not used. The response is kept; contact the respondent if you still want to meet.' }
      : { key: 'booking', state: 'waiting', title: 'Booking offered, not booked yet', text: 'The respondent was given a booking link. Nothing is booked until they choose a time.' };
    case 'booked': return { key: 'booking', state: 'done', title: 'Booking confirmed', reference: next.reference, at: next.starts_at };
    case 'booking_pending': return { key: 'booking', state: 'waiting', title: 'Booking held, payment pending', reference: next.reference, at: next.starts_at };
    case 'booking_canceled': return { key: 'booking', state: 'attention', reason: 'booking_canceled', title: 'Booking canceled', reference: next.reference, text: 'The appointment was canceled. Decide whether to follow up.' };
    case 'booking_removed': return { key: 'booking', state: 'none', title: 'Booking no longer listed', text: 'The booking record was removed, for example by retention.' };
    case 'unavailable': return { key: 'booking', state: 'attention', reason: 'booking_unavailable', title: 'Booking could not be offered', text: UNAVAILABLE[next.reason] || 'The booking step was unavailable when the response arrived.' };
    default: return { key: 'booking', state: 'unknown', title: 'Booking status unknown' };
  }
}

function runStep(run, tasks) {
  const base = { key: 'run', runId: run.id, title: run.flow_name, source: run.event_type === 'meet.booking.created' ? 'booking' : 'response', at: run.created_at };
  if (run.status === 'failed') return { ...base, state: 'attention', reason: 'followup_failed', attention: `Follow-up failed (${run.flow_name})`, text: `Failed after ${run.attempts} ${run.attempts === 1 ? 'attempt' : 'attempts'}: ${run.last_error || 'no error recorded'}.` };
  if (run.status === 'retrying') return { ...base, state: 'attention', reason: 'followup_retrying', attention: `Follow-up retrying (${run.flow_name})`, text: `Retrying: ${run.last_error || 'previous attempt did not finish'}.`, nextAttempt: run.next_attempt_at };
  if (run.status === 'queued' || run.status === 'running') return { ...base, state: 'waiting', text: run.flow_status === 'paused' ? 'Held while the flow is paused.' : 'Waiting to run.' };
  if (run.status !== 'succeeded') return { ...base, state: 'unknown', text: `Status: ${run.status}.` };
  if (run.result?.task) {
    const task = tasks?.find(item => item.id === run.result.task);
    if (!task) return { ...base, state: 'unknown', text: 'Task created; its current status is not available.', taskId: run.result.task };
    return { ...base, state: task.status === 'done' ? 'done' : 'attention', reason: task.status === 'done' ? undefined : 'task_open', attention: task.status === 'done' ? undefined : `Open task (${run.flow_name})`, text: task.status === 'done' ? `Task done: ${task.title}` : `Task open: ${task.title}`, taskId: task.id };
  }
  if (run.result?.email) {
    const evidence = emailEvidence(run);
    if (evidence.problem) return { ...base, state: 'attention', reason: 'email_undelivered', attention: `Email not delivered (${run.flow_name})`, text: `Email: ${evidence.text}` };
    return { ...base, state: evidence.verified ? 'done' : 'unknown', text: `Email: ${evidence.text}` };
  }
  return { ...base, state: 'done', text: 'Completed.' };
}

/**
 * @param row a response from GET /forms/:id/responses (id, created_at, form_version, next_step)
 * @param context { runs, tasks, bookingsByReference: Map, runsAvailable, tasksAvailable, bookingsAvailable }
 */
export function buildTrail(row, context) {
  const steps = [{ key: 'received', state: 'done', title: 'Response received', at: row.created_at, reference: row.id.replace(/-/g, '').slice(0, 8).toUpperCase() }];
  const booking = bookingStep(row.next_step, row.created_at, context.now);
  steps.push(booking);
  const bookingId = booking.reference ? context.bookingsByReference?.get(booking.reference)?.id : null;
  const notes = [];
  if (booking.reference && context.bookingsAvailable && !bookingId) notes.push('Follow-ups for this booking are not visible to your role.');
  steps.push(...followUps(context, run => (run.event_type === 'forms.response.created' && run.subject_id === row.id)
    || (bookingId && run.event_type === 'meet.booking.created' && run.subject_id === bookingId), 'this response or its booking'));
  return finish(steps, notes);
}

// A booking made directly on a booking page (not from a form response).
export function buildBookingTrail(booking, context) {
  const [state, title, reason] = { confirmed: ['done', 'Booking confirmed'], pending: ['waiting', 'Booking held, payment pending'], canceled: ['attention', 'Booking canceled', 'booking_canceled'] }[booking.status] || ['unknown', 'Booking status unknown'];
  const steps = [{ key: 'booked', state, title, reason, reference: booking.reference, at: booking.starts_at,
    text: booking.status === 'canceled' ? `Canceled by the ${booking.canceled_by || 'host or invitee'}. Decide whether to follow up.` : undefined }];
  steps.push(...followUps(context, run => run.event_type === 'meet.booking.created' && run.subject_id === booking.id, 'this booking'));
  return finish(steps, []);
}

function followUps(context, matches, subject) {
  if (!context.runsAvailable) return [{ key: 'followup', state: 'unknown', title: 'Follow-up status unavailable', text: 'Flow run history could not be loaded.' }];
  const runs = context.runs.filter(matches);
  if (!runs.length) return [{ key: 'followup', state: 'none', title: 'No follow-up recorded', text: `No enabled flow ran for ${subject}. Flows run only for events after they are enabled.` }];
  return runs.sort((a, b) => a.created_at - b.created_at).map(run => runStep(run, context.tasksAvailable ? context.tasks : null));
}

function finish(steps, notes) {
  const flagged = steps.filter(step => step.state === 'attention');
  return { steps, attention: flagged.map(step => step.attention || step.title), reasons: flagged.map(step => step.reason).filter(Boolean), notes };
}

const overall = trail => trail.attention.length ? 'attention' : trail.steps.some(step => step.state === 'waiting') ? 'waiting'
  : trail.steps.some(step => step.state === 'unknown') ? 'unknown' : 'done';

export const REASON_LABELS = {
  followup_failed: ['follow-up failed', 'follow-ups failed'], followup_retrying: ['follow-up retrying', 'follow-ups retrying'], email_undelivered: ['undelivered email', 'undelivered emails'], task_open: ['open task', 'open tasks'],
  booking_canceled: ['booking canceled', 'bookings canceled'], booking_unavailable: ['booking could not be offered', 'bookings could not be offered'],
  offer_expired: ['booking offer expired unused', 'booking offers expired unused']
};

// Who the enquiry is from: a name or email answer when the form asks for one, otherwise the receipt.
function respondentLabel(response, definition) {
  const fields = definition?.fields || [];
  const name = fields.find(field => field.type === 'short_text' && (field.id === 'name' || /\bname\b/i.test(field.label)));
  const email = fields.find(field => field.type === 'email');
  const value = (name && response.answers?.[name.id]) || (email && response.answers?.[email.id]);
  return typeof value === 'string' && value.trim() ? value.trim() : `Response ${response.id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

/**
 * One list across products: every loaded form response, plus bookings made directly (not from a
 * response and not superseded by a reschedule), each with its trail and overall state.
 * @param forms [{ form: { id, draft }, versions: { [version]: definition }, responses }]
 * @param bookings bookings from GET /bookings (any scopes; duplicates are ignored)
 * @param context as for buildTrail, plus now
 */
export function buildEnquiries({ forms, bookings, context }) {
  const enquiries = [];
  const linked = new Set();
  for (const { form, versions, responses } of forms) {
    for (const response of responses) {
      const trail = buildTrail(response, context);
      if (response.next_step?.reference) linked.add(response.next_step.reference);
      const booking = response.next_step?.reference ? context.bookingsByReference?.get(response.next_step.reference) : null;
      enquiries.push({ id: response.id, origin: 'response', at: response.created_at, title: respondentLabel(response, versions?.[response.form_version] || form.draft),
        source: form.draft.title, formId: form.id, booking: booking ? { reference: booking.reference, event: booking.event_title } : null, trail, state: overall(trail) });
    }
  }
  const seen = new Set();
  for (const booking of bookings) {
    if (seen.has(booking.id) || linked.has(booking.reference) || booking.rescheduled_to) continue;
    seen.add(booking.id);
    const trail = buildBookingTrail(booking, context);
    enquiries.push({ id: booking.id, origin: 'booking', at: booking.starts_at, title: booking.invitee_name || `Booking ${booking.reference}`, source: booking.event_title, booking: { reference: booking.reference, event: booking.event_title }, trail, state: overall(trail) });
  }
  const rank = { attention: 0, waiting: 1, unknown: 2, done: 3 };
  enquiries.sort((a, b) => rank[a.state] - rank[b.state] || b.at - a.at);
  const reasons = {};
  for (const enquiry of enquiries) for (const reason of enquiry.trail.reasons) reasons[reason] = (reasons[reason] || 0) + 1;
  const count = state => enquiries.filter(enquiry => enquiry.state === state).length;
  return { enquiries, counts: { all: enquiries.length, attention: count('attention'), waiting: count('waiting'), unknown: count('unknown') }, reasons };
}

export const STATE_LABELS = { done: 'Done', waiting: 'Waiting', attention: 'Needs attention', none: 'Not applicable', unknown: 'Unknown' };
