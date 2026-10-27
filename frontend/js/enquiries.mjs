// Enquiries: one list across Forms, Meet and Flow. Each form response or direct booking with what
// happened next (booking, follow-up runs, tasks) and whether it needs attention. Built in the
// browser from existing APIs (enquiry-trail.mjs); the coverage note says exactly what was loaded.
import { $, api, fmtDateTime, html, loading, mount, notice, raw, session, wsPath } from './core.mjs';
import { needsSession, setTitle, signInPrompt } from './pages.mjs';
import { buildEnquiries, REASON_LABELS } from './enquiry-trail.mjs';
import { loadTrailContext, trailList } from './forms.mjs';

// Most recently updated forms, and latest responses per form, loaded for this view.
export const FORM_LIMIT = 20;
export const RESPONSES_PER_FORM = 50;
const STATE_TEXT = { attention: ['Needs attention', '!'], waiting: ['Waiting', '…'], unknown: ['Not verified', '?'], done: ['Done', '✓'] };
const FILTERS = [['all', 'All'], ['attention', 'Needs attention'], ['waiting', 'Waiting']];
const plural = (n, [one, many]) => `${n} ${n === 1 ? one : many}`;

export async function enquiries(ctx) {
  setTitle('Enquiries · Schedora');
  if (!session.user) return mount(ctx.main, signInPrompt(ctx, { product: 'suite', title: 'Sign in to see enquiries', lead: 'Enquiries belong to your workspace.' }));
  if (!needsSession(ctx)) return;
  const filter = FILTERS.some(([key]) => key === ctx.query.get('show')) ? ctx.query.get('show') : 'all';
  const origin = ['response', 'booking'].includes(ctx.query.get('from')) ? ctx.query.get('from') : 'any';
  mount(ctx.main, html`<div class="container page enquiries">
    <span class="tag">Meet · Forms · Flow</span><h1>Enquiries</h1>
    <p class="lead">Each form response and booking, with what happened next: the booking, any follow-up, and anything that needs attention.</p>
    <div id="enquiries-body">${loading('Loading responses, bookings and follow-ups…')}</div></div>`);

  const [formsResult, context] = await Promise.all([api('GET', wsPath('/forms')).then(value => ({ ok: true, value }), error => ({ ok: false, error })), loadTrailContext()]);
  const forms = formsResult.ok ? [...formsResult.value].sort((a, b) => b.updated_at - a.updated_at).slice(0, FORM_LIMIT) : [];
  const loaded = await Promise.allSettled(forms.map(form => api('GET', wsPath(`/forms/${form.id}/responses?limit=${RESPONSES_PER_FORM}`))));
  if (!ctx.alive()) return;
  const responses = loaded.filter(result => result.status === 'fulfilled').map(result => result.value);
  const failedForms = loaded.filter(result => result.status === 'rejected').length;
  const bookings = [...context.bookingsByReference.values()];
  const result = buildEnquiries({ forms: responses, bookings, context });

  const shown = result.enquiries.filter(enquiry => (filter === 'all' || enquiry.state === filter) && (origin === 'any' || enquiry.origin === origin));
  const link = (show, from) => `/enquiries${[show !== 'all' && `show=${show}`, from !== 'any' && `from=${from}`].filter(Boolean).join('&').replace(/^(?=.)/, '?')}`;
  const counts = { all: result.counts.all, attention: result.counts.attention, waiting: result.counts.waiting };
  const reasons = Object.entries(result.reasons).map(([key, n]) => plural(n, REASON_LABELS[key]));
  const coverage = [
    formsResult.ok ? `responses from ${forms.length === FORM_LIMIT ? `the ${FORM_LIMIT} most recently updated forms` : `${forms.length} ${forms.length === 1 ? 'form' : 'forms'}`} (latest ${RESPONSES_PER_FORM} each)` : null,
    context.bookingsAvailable ? 'bookings you can see (up to 300 per list)' : null,
    context.runsAvailable ? (context.runs.length >= 200 ? 'the latest 200 Flow runs' : `${context.runs.length} Flow ${context.runs.length === 1 ? 'run' : 'runs'}`) : null,
    context.tasksAvailable ? (context.tasks.length >= 200 ? 'the latest 200 tasks' : `${context.tasks.length} ${context.tasks.length === 1 ? 'task' : 'tasks'}`) : null
  ].filter(Boolean);
  const missing = [!formsResult.ok && 'form responses', !context.bookingsAvailable && 'bookings', !context.runsAvailable && 'Flow runs', !context.tasksAvailable && 'tasks', failedForms && `${failedForms} ${failedForms === 1 ? 'form' : 'forms'}`].filter(Boolean);

  mount($('#enquiries-body'), html`
    ${result.counts.attention ? notice('warn', html`<p><strong>${plural(result.counts.attention, ['enquiry needs', 'enquiries need'])} attention:</strong> ${reasons.join(', ')}.</p>`) : ''}
    ${missing.length ? notice('bad', html`<p>Could not load ${missing.join(', ')}. Those parts show as not verified; nothing is assumed to be done.</p>`) : ''}
    <div class="row-between enquiry-controls"><nav class="row trail-filter" aria-label="Show enquiries">${FILTERS.map(([key, label]) => html`<a class="btn btn-small ${key === filter ? 'btn-primary' : ''}" href="${link(key, origin)}" ${key === filter ? raw('aria-current="page"') : ''}>${label} (${counts[key]})</a>`)}</nav>
      <nav class="row trail-filter" aria-label="Started from"><span class="muted">Started from</span>${[['any', 'Anywhere'], ['response', 'A form'], ['booking', 'A direct booking']].map(([key, label]) => html`<a class="btn btn-small ${key === origin ? 'btn-primary' : ''}" href="${link(filter, key)}" ${key === origin ? raw('aria-current="page"') : ''}>${label}</a>`)}</nav></div>
    <p class="hint">Built from ${coverage.join(', ')}. Older records may not appear. Needs attention comes first, then the most recent: responses by when they arrived, direct bookings by their appointment time.</p>
    ${shown.length ? html`<ul class="list enquiry-list">${shown.map(enquiry => html`<li class="enquiry" data-state="${enquiry.state}">
      <div class="enquiry-head"><span class="readiness-icon" aria-hidden="true">${STATE_TEXT[enquiry.state][1]}</span>
        <div class="enquiry-main"><div class="list-title">${enquiry.title}</div>
          <div class="meta"><span>${enquiry.origin === 'response' ? `Form: ${enquiry.source}` : `Booked directly: ${enquiry.source}`}</span><span>${enquiry.origin === 'response' ? `Received ${fmtDateTime(enquiry.at)}` : `Appointment ${fmtDateTime(enquiry.at)}`}</span>${enquiry.booking && enquiry.origin === 'response' ? html`<span>Booking ${enquiry.booking.reference}</span>` : ''}</div>
          ${enquiry.trail.attention.length ? html`<p class="attention-note">${enquiry.trail.attention.join(' · ')}</p>` : ''}</div>
        <span class="enquiry-state">${STATE_TEXT[enquiry.state][0]}</span></div>
      <details class="enquiry-detail"><summary>What happened<span class="visually-hidden"> for ${enquiry.title}</span></summary>${trailList(enquiry.trail, `trail-${enquiry.id}`)}
        ${enquiry.origin === 'response' ? html`<p class="trail-links"><a href="/forms/${enquiry.formId}/responses">Open the form's responses</a></p>` : html`<p class="trail-links"><a href="/meet?tab=meetings">Open Meetings</a></p>`}</details></li>`)}</ul>`
      : html`<div class="empty section-gap">${result.counts.all ? 'Nothing matches this filter.' : html`No enquiries yet. They appear when someone responds to a published form or books a time. <a href="/forms">Forms</a> · <a href="/meet">Meet</a>`}</div>`}`);
}
