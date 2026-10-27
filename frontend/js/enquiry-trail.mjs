// What happened after a form response: booking step, follow-up runs and their tasks. Built only
// from records the existing APIs return (response next_step, bookings, Flow runs and tasks); no
// state is inferred or invented. Plain logic with no browser dependencies, so it is unit-tested.

const UNAVAILABLE = {
  destination_unavailable: 'The booking page was not available when the response arrived.',
  meet_inactive: 'Meet was not active for this workspace when the response arrived.'
};

// state: done | waiting | attention | none | unknown
function bookingStep(next) {
  if (!next) return { key: 'booking', state: 'none', title: 'No booking step', text: 'This response was not offered a booking.' };
  switch (next.status) {
    case 'offered': return { key: 'booking', state: 'waiting', title: 'Booking offered, not booked yet', text: 'The respondent was given a booking link. Nothing is booked until they choose a time.' };
    case 'booked': return { key: 'booking', state: 'done', title: 'Booking confirmed', reference: next.reference, at: next.starts_at };
    case 'booking_pending': return { key: 'booking', state: 'waiting', title: 'Booking held, payment pending', reference: next.reference, at: next.starts_at };
    case 'booking_canceled': return { key: 'booking', state: 'attention', title: 'Booking canceled', reference: next.reference, text: 'The appointment was canceled. Decide whether to follow up.' };
    case 'booking_removed': return { key: 'booking', state: 'none', title: 'Booking no longer listed', text: 'The booking record was removed, for example by retention.' };
    case 'unavailable': return { key: 'booking', state: 'attention', title: 'Booking could not be offered', text: UNAVAILABLE[next.reason] || 'The booking step was unavailable when the response arrived.' };
    default: return { key: 'booking', state: 'unknown', title: 'Booking status unknown' };
  }
}

function emailOutcome(provider) {
  return provider === 'outbox' ? 'Recorded in the local outbox; not delivered to an inbox.' : 'Accepted by the email provider; inbox delivery is not tracked.';
}

function runStep(run, tasks, provider) {
  const base = { key: 'run', runId: run.id, title: run.flow_name, source: run.event_type === 'meet.booking.created' ? 'booking' : 'response', at: run.created_at };
  if (run.status === 'failed') return { ...base, state: 'attention', attention: `Follow-up failed (${run.flow_name})`, text: `Failed after ${run.attempts} ${run.attempts === 1 ? 'attempt' : 'attempts'}: ${run.last_error || 'no error recorded'}.` };
  if (run.status === 'retrying') return { ...base, state: 'attention', attention: `Follow-up retrying (${run.flow_name})`, text: `Retrying: ${run.last_error || 'previous attempt did not finish'}.`, nextAttempt: run.next_attempt_at };
  if (run.status === 'queued' || run.status === 'running') return { ...base, state: 'waiting', text: run.flow_status === 'paused' ? 'Held while the flow is paused.' : 'Waiting to run.' };
  if (run.status !== 'succeeded') return { ...base, state: 'unknown', text: `Status: ${run.status}.` };
  if (run.result?.task) {
    const task = tasks?.find(item => item.id === run.result.task);
    if (!task) return { ...base, state: 'unknown', text: 'Task created; its current status is not available.', taskId: run.result.task };
    return { ...base, state: task.status === 'done' ? 'done' : 'attention', attention: task.status === 'done' ? undefined : `Open task (${run.flow_name})`, text: task.status === 'done' ? `Task done: ${task.title}` : `Task open: ${task.title}`, taskId: task.id };
  }
  if (run.result?.email) return { ...base, state: 'done', text: `Email: ${emailOutcome(provider)}` };
  return { ...base, state: 'done', text: 'Completed.' };
}

/**
 * @param row a response from GET /forms/:id/responses (id, created_at, form_version, next_step)
 * @param context { runs, tasks, bookingsByReference: Map, provider, runsAvailable, tasksAvailable, bookingsAvailable }
 */
export function buildTrail(row, context) {
  const steps = [{ key: 'received', state: 'done', title: 'Response received', at: row.created_at, reference: row.id.replace(/-/g, '').slice(0, 8).toUpperCase() }];
  const booking = bookingStep(row.next_step);
  steps.push(booking);
  const bookingId = booking.reference ? context.bookingsByReference?.get(booking.reference)?.id : null;
  const notes = [];
  if (booking.reference && context.bookingsAvailable && !bookingId) notes.push('Follow-ups for this booking are not visible to your role.');
  if (!context.runsAvailable) {
    steps.push({ key: 'followup', state: 'unknown', title: 'Follow-up status unavailable', text: 'Flow run history could not be loaded.' });
  } else {
    const runs = context.runs.filter(run => (run.event_type === 'forms.response.created' && run.subject_id === row.id)
      || (bookingId && run.event_type === 'meet.booking.created' && run.subject_id === bookingId));
    if (runs.length) steps.push(...runs.sort((a, b) => a.created_at - b.created_at).map(run => runStep(run, context.tasksAvailable ? context.tasks : null, context.provider)));
    else steps.push({ key: 'followup', state: 'none', title: 'No follow-up recorded', text: 'No enabled flow ran for this response or its booking. Flows run only for events after they are enabled.' });
  }
  const attention = steps.filter(step => step.state === 'attention').map(step => step.attention || step.title);
  return { steps, attention, notes };
}

export const STATE_LABELS = { done: 'Done', waiting: 'Waiting', attention: 'Needs attention', none: 'Not applicable', unknown: 'Unknown' };
