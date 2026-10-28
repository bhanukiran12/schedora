// Enquiries: one list across Forms, Meet and Flow. Each form response or direct booking with what
// happened next (booking, follow-up runs, tasks) and whether it needs attention. Pages come from
// GET /enquiries, newest arrival first, so every record is reachable with "Load older"; states are
// derived from those records by enquiry-trail.mjs and the coverage note says what is loaded.
import { $, api, errorBlock, fmtDateTime, html, loading, mount, notice, raw, session, wsPath } from './core.mjs';
import { needsSession, setTitle, signInPrompt } from './pages.mjs';
import { buildFeedEnquiries, REASON_LABELS } from './enquiry-trail.mjs';
import { trailList } from './forms.mjs';

export const PAGE_SIZE = 50;
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

  const pages = [];
  const loadPage = async () => {
    const before = pages.at(-1)?.next;
    pages.push(await api('GET', wsPath(`/enquiries?limit=${PAGE_SIZE}${before ? '&before=' + encodeURIComponent(before) : ''}`)));
  };
  try { await loadPage(); } catch (error) { if (ctx.alive()) mount($('#enquiries-body'), errorBlock(error)); return; }
  if (!ctx.alive()) return;

  const draw = (status = '') => {
    const result = buildFeedEnquiries(pages);
    const complete = !pages.at(-1).next;
    const shown = result.enquiries.filter(enquiry => (filter === 'all' || enquiry.state === filter) && (origin === 'any' || enquiry.origin === origin));
    const link = (show, from) => `/enquiries${[show !== 'all' && `show=${show}`, from !== 'any' && `from=${from}`].filter(Boolean).join('&').replace(/^(?=.)/, '?')}`;
    const counts = { all: result.counts.all, attention: result.counts.attention, waiting: result.counts.waiting };
    const reasons = Object.entries(result.reasons).map(([key, n]) => plural(n, REASON_LABELS[key]));
    const scope = complete ? (result.counts.all ? `All ${plural(result.counts.all, ['enquiry is', 'enquiries are'])} loaded.` : '')
      : `Showing the newest ${result.counts.all} enquiries. Counts and filters cover what is loaded; load older enquiries to include more.`;
    mount($('#enquiries-body'), html`
      ${result.counts.attention ? notice('warn', html`<p><strong>${plural(result.counts.attention, ['enquiry needs', 'enquiries need'])} attention${complete ? '' : ' among those loaded'}:</strong> ${reasons.join(', ')}.</p>`) : ''}
      <div class="row-between enquiry-controls"><nav class="row trail-filter" aria-label="Show enquiries">${FILTERS.map(([key, label]) => html`<a class="btn btn-small ${key === filter ? 'btn-primary' : ''}" href="${link(key, origin)}" ${key === filter ? raw('aria-current="page"') : ''}>${label} (${counts[key]})</a>`)}</nav>
        <nav class="row trail-filter" aria-label="Started from"><span class="muted">Started from</span>${[['any', 'Anywhere'], ['response', 'A form'], ['booking', 'A direct booking']].map(([key, label]) => html`<a class="btn btn-small ${key === origin ? 'btn-primary' : ''}" href="${link(filter, key)}" ${key === origin ? raw('aria-current="page"') : ''}>${label}</a>`)}</nav></div>
      <p class="hint">${scope} Needs attention comes first, then the newest: responses by when they arrived, direct bookings by when they were booked. Each enquiry includes all of its follow-ups.</p>
      ${shown.length ? html`<ul class="list enquiry-list">${shown.map(enquiry => html`<li class="enquiry" data-state="${enquiry.state}">
        <div class="enquiry-head"><span class="readiness-icon" aria-hidden="true">${STATE_TEXT[enquiry.state][1]}</span>
          <div class="enquiry-main"><div class="list-title">${enquiry.title}</div>
            <div class="meta"><span>${enquiry.origin === 'response' ? `Form: ${enquiry.source}` : `Booked directly: ${enquiry.source}`}</span><span>${enquiry.origin === 'response' ? `Received ${fmtDateTime(enquiry.at)}` : `Booked ${fmtDateTime(enquiry.at)}`}</span>${enquiry.origin === 'booking' ? html`<span>Appointment ${fmtDateTime(enquiry.startsAt)}</span>` : enquiry.booking ? html`<span>Booking ${enquiry.booking.reference}</span>` : ''}</div>
            ${enquiry.trail.attention.length ? html`<p class="attention-note">${enquiry.trail.attention.join(' · ')}</p>` : ''}</div>
          <span class="enquiry-state">${STATE_TEXT[enquiry.state][0]}</span></div>
        <details class="enquiry-detail"><summary>What happened<span class="visually-hidden"> for ${enquiry.title}</span></summary>${trailList(enquiry.trail, `trail-${enquiry.id}`)}
          ${enquiry.origin === 'response' ? html`<p class="trail-links"><a href="/forms/${enquiry.formId}/responses">Open the form's responses</a></p>` : html`<p class="trail-links"><a href="/meet?tab=meetings">Open Meetings</a></p>`}</details></li>`)}</ul>`
        : html`<div class="empty section-gap">${result.counts.all ? 'Nothing matches this filter among the loaded enquiries.' : html`No enquiries yet. They appear when someone responds to a published form or books a time. <a href="/forms">Forms</a> · <a href="/meet">Meet</a>`}</div>`}
      <div class="section-gap">${complete ? '' : html`<button class="btn" type="button" id="load-older">Load older enquiries</button>`}<p class="muted" role="status" id="enquiries-status" tabindex="-1">${status}</p></div>`);
    $('#load-older')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = 'Loading…';
      const before = buildFeedEnquiries(pages).counts.all;
      try { await loadPage(); } catch (error) {
        if (!ctx.alive()) return;
        button.disabled = false;
        button.textContent = 'Load older enquiries';
        $('#enquiries-status').textContent = `Could not load older enquiries: ${error.message}`;
        return;
      }
      if (!ctx.alive()) return;
      const added = buildFeedEnquiries(pages).counts.all - before;
      draw(`Loaded ${plural(added, ['older enquiry', 'older enquiries'])}.`);
      ($('#load-older') || $('#enquiries-status')).focus();
    });
  };
  draw();
}
