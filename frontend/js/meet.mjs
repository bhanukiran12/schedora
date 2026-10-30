import {
  $, $$, api, ask, badge, boot, browserZone, copy, dateKey, errorBlock, fmt, fmtDateTime, fmtFull, fmtTime, handleSubmit, html, isAdmin,
  loading, minutesToTime, mount, notice, raw, session, showErrors, timeToMinutes, toast, uid, workspace, wsPath, zoneLabel, zoneOptions
} from './core.mjs';
import { needsSession, setTitle, signInPrompt } from './pages.mjs';
import { inputFor, readAnswer } from './forms.mjs';
import { checkAnswer, FIELD_TYPES } from '/shared/forms-logic.mjs';
import * as team from './meet-team.mjs';
import { deliveryEvidence } from './email-evidence.mjs';
import { videoTab } from './meet-video.mjs';
import { assessReadiness } from './meet-readiness.mjs';
import { readinessAreas } from './readiness-view.mjs';
import { hostReadinessView, matchingHostEvidence } from './host-readiness-view.mjs';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const KINDS = {
  one_on_one: ['One-on-one', 'One host meets one invitee.'],
  group: ['Group', 'One host meets several invitees at once.'],
  collective: ['Collective', 'Several hosts meet one invitee; only times when all are free.'],
  round_robin: ['Round robin', 'Meetings are shared out across a team.']
};
// One line per location choice, shown under the picker in the event editor.
const LOCATION_HELP = {
  video: 'Paste a meeting link you already have (any video service).', google_meet: 'A Google Meet link is created for each booking. Connect Google under Calendars & apps first.',
  zoom: 'A Zoom link is created for each booking. Connect Zoom under Calendars & apps first.', teams: 'A Teams link is created for each booking. Connect Microsoft under Calendars & apps first.',
  in_person: 'An address or place where you will meet.', phone_host_calls: 'The invitee gives a number and you call them.', phone_invitee_calls: 'You give a number and the invitee calls you.',
  custom: 'Any other instructions, shown to the invitee as written.', schedora_meet: 'Built-in video room. Each attendee gets a personal join link that opens shortly before the start. Connected time uses Meet credits.'
};
const LOCATION_LABELS = { video: 'Video link', google_meet: 'Google Meet (auto link)', zoom: 'Zoom (auto link)', teams: 'Microsoft Teams (auto link)', in_person: 'In person', phone_host_calls: 'Phone: host calls invitee', phone_invitee_calls: 'Phone: invitee calls host', custom: 'Custom', schedora_meet: 'Schedora Meet (built-in video)' };
const NEEDS_VALUE = ['video', 'in_person', 'phone_invitee_calls', 'custom'];
const QUESTION_TYPES = ['short_text', 'long_text', 'phone', 'email', 'single_choice', 'multiple_choice', 'date'];
const money = (cents, currency) => new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
const bookingUrl = (eventType, ws = workspace()) => `${location.origin}/meet/${ws.slug}/${eventType.slug}`;

// Applies a workspace brand color to public pages (via CSSOM, as inline styles are blocked by CSP).
export function applyBrand(color) {
  if (!/^#[0-9a-f]{6}$/i.test(color || '')) return;
  const [r, g, b] = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const light = 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4;
  document.body.style.setProperty('--accent', color);
  document.body.style.setProperty('--on-accent', light ? '#13271b' : '#ffffff');
  document.body.style.setProperty('--accent-tint', color + '22');
}

// ---------------------------------------------------------------------------------------------
// Host dashboard

const TABS = [['types', 'Event types'], ['meetings', 'Meetings'], ['video', 'Video'], ['polls', 'Polls'], ['contacts', 'Contacts'], ['workflows', 'Workflows'],
  ['analytics', 'Analytics'], ['integrations', 'Calendars & apps'], ['insights', 'Notes & AI'], ['emails', 'Delivery']];
// Shown directly on narrow screens; the rest move into a "More" menu so nothing hides off-screen.
const PRIMARY_TABS = ['types', 'meetings', 'video'];
const TAB_LEADS = {
  types: 'The kinds of meetings people can book with you.', meetings: 'Appointments booked with you and your team.',
  video: 'Built-in Schedora Meet video rooms.', polls: 'Find a time that suits a group.', contacts: 'People who have booked or responded.',
  workflows: 'Reminders and follow-ups sent around meetings.', analytics: 'Bookings over time, by event type and host.',
  integrations: 'Calendars and video apps connected to Meet.', insights: 'Meeting notes, transcripts and AI recaps.', emails: 'Delivery status of every email Meet sent.'
};
const sentence = text => text ? text[0].toUpperCase() + text.slice(1).replace(/_/g, ' ') : text;

export async function dashboard(ctx) {
  setTitle('Meet by Schedora');
  if (!session.user) {
    return mount(ctx.main, signInPrompt(ctx, { product: 'meet', title: 'A little less back-and-forth.', lead: 'Publish your availability once. Invitees choose a time in their own time zone, receive a confirmation, and can reschedule or cancel without emailing you. Calendar, payment and AI features depend on your workspace setup.' }));
  }
  if (!needsSession(ctx)) return;
  const tab = TABS.some(([key]) => key === ctx.query.get('tab')) ? ctx.query.get('tab') : ctx.query.get('tab') === 'calendar' ? 'integrations' : 'types';
  const ws = workspace();
  const label = TABS.find(([key]) => key === tab)[1];
  setTitle(`${label} · Meet by Schedora`);
  const link = ([key, text], extra = '') => html`<a class="${extra}" href="/meet?tab=${key}" ${key === tab ? raw('aria-current="page"') : ''}>${text}</a>`;
  const secondary = TABS.filter(([key]) => !PRIMARY_TABS.includes(key));
  const inMore = secondary.some(([key]) => key === tab);
  // The video tab has its own primary action (start a meeting), so "New event type" steps back there.
  const primaryHere = tab !== 'video';
  mount(ctx.main, html`<div class="container page meet-dashboard">
    <header class="meet-head"><div><span class="tag">Meet · ${ws.name}</span><h1>${label}</h1><p class="meet-lead">${TAB_LEADS[tab]}</p></div>
      <div class="row meet-head-actions"><a class="btn" href="/meet/${ws.slug}" target="_blank" rel="noopener">Your booking page<span class="visually-hidden"> (opens in a new tab)</span></a><a class="btn ${primaryHere ? 'btn-primary' : ''}" href="/meet/event-types/new">New event type</a></div></header>
    ${ws.entitlements.meet.active ? '' : notice('warn', html`<p>This workspace has no active Meet or Suite plan, so booking pages are not accepting appointments. <a href="/billing">Review plans</a>.</p>`)}
    <section id="tab-panel" aria-live="polite" aria-label="${label}">${loading()}</section></div>`);
  const panel = $('#tab-panel');
  const views = { types: eventTypesTab, meetings: meetingsTab, video: videoTab, polls: team.pollsTab, contacts: team.contactsTab, workflows: team.workflowsTab, analytics: team.analyticsTab, integrations: team.integrationsTab, insights: team.insightsTab, emails: emailsTab };
  try { await views[tab](ctx, panel); }
  catch (error) { if (ctx.alive()) mount(panel, errorBlock(error)); }
}

async function eventTypesTab(ctx, panel) {
  const types = await api('GET', wsPath('/event-types'));
  if (!ctx.alive()) return;
  const templates = types.filter(type => type.managed_template);
  const regular = types.filter(type => !type.managed_template);
  const item = type => html`<li class="row-between">
    <div><div class="list-title">${type.title}</div><div class="meta"><span>${KINDS[type.kind][0]}</span><span>${type.duration_min} min</span>
      ${type.kind !== 'one_on_one' ? html`<span>${type.hosts.map(host => host.name).join(', ')}</span>` : ''}
      ${type.price_cents ? html`<span>${money(type.price_cents, type.currency)}</span>` : ''}${type.one_off ? html`<span>One-off link</span>` : ''}${type.secret && !type.one_off ? html`<span>Hidden</span>` : ''}
      ${type.managed_parent_title ? html`<span>Managed: ${type.managed_parent_title}</span>` : ''}</div></div>
    <div class="row">${type.managed_template ? badge('neutral', 'Template') : type.published ? badge('published') : badge('draft', 'Not published')}
      ${type.published && !type.managed_template ? html`<button class="btn btn-small" data-copy="${bookingUrl(type)}">Copy link</button>` : ''}
      <a class="btn btn-small" href="/meet/event-types/${type.id}">Edit</a></div></li>`;
  mount(panel, html`<div class="row"><a class="btn btn-small" href="/meet/event-types/new?one_off=1">New one-off link</a>${isAdmin() ? html`<a class="btn btn-small" href="/meet/event-types/new?kind=round_robin">New team event</a><a class="btn btn-small" href="/meet/event-types/new?template=1">New managed template</a>` : ''}</div>
    ${regular.length ? html`<ul class="list section-gap">${regular.map(item)}</ul>` : html`<div class="empty section-gap"><h2>Create your first event type</h2><p>An event type is a kind of meeting people can book, such as a 30-minute introduction call.</p><div class="actions"><a class="btn btn-primary" href="/meet/event-types/new">New event type</a><a class="btn" href="/setup/meet">Guided setup</a></div></div>`}
    ${templates.length ? html`<h2 class="section-gap">Managed templates</h2><ul class="list">${templates.map(item)}</ul>` : ''}`);
  $$('[data-copy]', panel).forEach(button => button.onclick = () => copy(button.dataset.copy, 'Booking link'));
}

async function meetingsTab(ctx, panel) {
  const scope = ['upcoming', 'past', 'canceled'].includes(ctx.query.get('scope')) ? ctx.query.get('scope') : 'upcoming';
  const [bookings, types] = await Promise.all([api('GET', wsPath('/bookings?scope=' + scope)), api('GET', wsPath('/event-types'))]);
  if (!ctx.alive()) return;
  mount(panel, html`<div class="row-between"><nav class="row" aria-label="Meeting list">${['upcoming', 'past', 'canceled'].map(key => html`<a class="btn btn-small ${key === scope ? 'btn-primary' : ''}" href="/meet?tab=meetings&scope=${key}">${key[0].toUpperCase() + key.slice(1)}</a>`)}</nav>
      <div class="row"><a class="btn" href="/enquiries">Enquiries</a><button class="btn" id="book-for">Schedule for someone</button></div></div>
    <div id="book-for-panel"></div>
    ${bookings.length ? html`<ul class="list section-gap booking-rows">${bookings.map(booking => html`<li>
      <div class="booking-row"><div class="booking-row-main">
        <div class="booking-when">${fmtDateTime(booking.starts_at, booking.host_timezone)}</div>
        <div class="list-title">${booking.event_title} <span class="booking-with">with ${booking.invitee_name}</span></div>
        <div class="meta"><span>${booking.invitee_email}</span>${fmtDateTime(booking.starts_at, booking.invitee_timezone) !== fmtDateTime(booking.starts_at, booking.host_timezone) ? html`<span>Their time: ${fmtDateTime(booking.starts_at, booking.invitee_timezone)} (${booking.invitee_timezone.replace(/_/g, ' ')})</span>` : ''}<span>Ref ${booking.reference}</span>
          <span>Host: ${booking.host_name}</span>${booking.location ? html`<span>${booking.location}</span>` : ''}${booking.guests.length ? html`<span>Guests: ${booking.guests.join(', ')}</span>` : ''}</div>
        ${booking.answers.length ? html`<dl class="answers">${booking.answers.map(answer => html`<dt>${answer.label}</dt><dd>${answer.value}</dd>`)}</dl>` : ''}
        ${booking.notes ? html`<p class="muted">Notes: ${booking.notes}</p>` : ''}
        ${booking.status === 'canceled' ? html`<p class="muted">${booking.rescheduled_to ? 'Rescheduled.' : `Canceled by the ${booking.canceled_by}.`}${booking.cancel_reason ? ' Reason: ' + booking.cancel_reason : ''}</p>` : ''}
        <div id="prep-${booking.id}"></div>
      </div>
      <div class="booking-row-side"><div class="row booking-status">${badge(booking.status, sentence(booking.status))}${booking.payment_status !== 'none' ? badge(booking.payment_status === 'paid' ? 'active' : 'pending', 'Payment ' + booking.payment_status) : ''}${booking.email ? badge(booking.email.status, 'Email ' + booking.email.status) : ''}</div>
        <div class="row booking-actions">${booking.video_room_url && scope === 'upcoming' ? html`<a class="btn btn-small btn-primary" href="${booking.video_room_url}" data-external>Join video</a>` : ''}
        ${scope === 'upcoming' ? html`<button class="btn btn-small" data-prep="${booking.id}" aria-label="Prepare for ${booking.event_title} with ${booking.invitee_name}">Prepare</button>` : ''}
        ${booking.contact_id ? html`<a class="btn btn-small" href="/meet/contacts/${booking.contact_id}" aria-label="Contact ${booking.invitee_name}">Contact</a>` : ''}
        ${scope === 'upcoming' ? html`<button class="btn btn-small btn-quiet" data-cancel="${booking.id}" aria-label="Cancel ${booking.event_title} with ${booking.invitee_name}">Cancel</button>` : ''}</div></div></div></li>`)}</ul>`
      : html`<div class="empty section-gap">${{ upcoming: 'No upcoming meetings yet. Share a booking link to get started.', past: 'No past meetings.', canceled: 'No canceled meetings.' }[scope]}</div>`}`);

  $('#book-for').onclick = () => bookForPanel(ctx, types.filter(type => !type.managed_template));
  // "Schedule a follow-up" from a contact profile arrives here with the invitee pre-filled.
  let pending = null;
  try { pending = JSON.parse(sessionStorage.getItem('schedora.bookFor')); sessionStorage.removeItem('schedora.bookFor'); } catch { pending = null; }
  if (pending) {
    await bookForPanel(ctx, types.filter(type => !type.managed_template));
    if ($('#bf-name')) { $('#bf-name').value = pending.name || ''; $('#bf-email').value = pending.email || ''; $('#bf-start').focus(); }
  }
  $$('[data-prep]', panel).forEach(button => button.onclick = () => showPrep(button.dataset.prep));
  $$('[data-cancel]', panel).forEach(button => button.onclick = async () => {
    const result = await ask({ title: 'Cancel this meeting?', body: 'The invitee will receive a cancellation email.', fields: html`<label for="cancel-reason">Reason (optional, shared with the invitee)</label><textarea id="cancel-reason" name="reason" maxlength="500"></textarea>
      <label class="check"><input type="checkbox" name="whole_meeting"> Cancel for every attendee (group events)</label>`, confirm: 'Cancel meeting', danger: true });
    if (!result) return;
    try { await api('POST', wsPath(`/bookings/${button.dataset.cancel}/cancel`), { reason: result.reason, whole_meeting: result.whole_meeting }); toast('Canceled. Invitees will be notified.'); ctx.render(); }
    catch (error) { toast(error.message); }
  });
}

async function showPrep(bookingId, withAi = false) {
  const target = $('#prep-' + bookingId);
  mount(target, loading(withAi ? 'Writing a brief…' : 'Loading history…'));
  try {
    const prep = await api('GET', wsPath(`/bookings/${bookingId}/prep${withAi ? '?ai=1' : ''}`));
    mount(target, html`<div class="notice notice-info">
      ${prep.brief ? html`<p><strong>Brief:</strong> ${prep.brief}</p>` : ''}
      ${prep.contact ? html`<p>Contact: ${prep.contact.name || prep.contact.email}${prep.contact.company ? ' · ' + prep.contact.company : ''}${prep.contact.tags.length ? ' · ' + prep.contact.tags.join(', ') : ''}</p>` : ''}
      <p>${prep.previous_meetings.length ? `${prep.previous_meetings.length} earlier meeting(s), most recently ${fmtDateTime(prep.previous_meetings[0].starts_at)} (${prep.previous_meetings[0].title}).` : 'First meeting with this person.'}</p>
      ${prep.notes.length ? html`<p>Latest note: ${prep.notes[0].body}</p>` : ''}
      ${prep.previous_recaps.length ? html`<p>Last recap: ${prep.previous_recaps[0].summary}</p>` : ''}
      ${!prep.brief && boot.integrations?.ai ? html`<button class="btn btn-small" data-ai-brief>Write an AI brief</button>` : ''}</div>`);
    target.querySelector('[data-ai-brief]')?.addEventListener('click', () => showPrep(bookingId, true));
  } catch (error) { mount(target, errorBlock(error)); }
}

async function bookForPanel(ctx, types) {
  const panel = $('#book-for-panel');
  if (!types.length) return mount(panel, notice('info', html`<p>Create an event type first.</p>`));
  mount(panel, html`<form class="card card-plain section-gap" id="book-for-form" novalidate><h2>Schedule for someone</h2>
    <div class="inline-fields"><div><label for="bf-type">Event type</label><select id="bf-type" name="event_type_id">${types.map(type => html`<option value="${type.id}">${type.title}</option>`)}</select></div>
      <div><label for="bf-start">Date and time (your time zone)</label><input id="bf-start" name="start_local" type="datetime-local" required></div></div>
    <div class="inline-fields"><div><label for="bf-name">Invitee name</label><input id="bf-name" name="name" required maxlength="100"></div>
      <div><label for="bf-email">Invitee email</label><input id="bf-email" name="email" type="email" required></div>
      <div><label for="bf-zone">Invitee time zone</label><select id="bf-zone" name="timezone">${zoneOptions(browserZone())}</select></div></div>
    <label class="check"><input type="checkbox" name="override"> Allow times outside working hours (double booking is still prevented)</label>
    <div data-form-status tabindex="-1"></div><div class="actions"><button class="btn btn-primary" type="submit">Book and send invitation</button></div></form>`);
  handleSubmit($('#book-for-form'), async data => {
    const start = new Date(data.start_local);
    if (Number.isNaN(start.getTime())) throw Object.assign(new Error('Choose a date and time.'), { details: { field: 'start_local' } });
    await api('POST', wsPath('/bookings'), { event_type_id: data.event_type_id, name: data.name, email: data.email, timezone: data.timezone, start: start.toISOString(), override: data.override }, { 'Idempotency-Key': uid() + uid() });
    toast('Booked. The invitee will get a confirmation email.');
    ctx.render();
  });
}

async function emailsTab(ctx, panel) {
  const emails = await api('GET', wsPath('/emails'));
  if (!ctx.alive()) return;
  const reports = boot.providers.email === 'http' ? (boot.providers.email_reports ? 'Delivery reports from the provider are connected.' : 'Delivery reports from the provider are not connected, so acceptance is the last step shown.') : 'This server uses the local outbox: messages are recorded here and never sent.';
  mount(panel, html`${notice('info', html`<p>Every confirmation, reminder, workflow email and SMS is tracked here. A failed message never affects the meeting it belongs to.</p><p><strong>Accepted</strong> means the email provider took the message. <strong>Delivered</strong> means the recipient's mail server accepted it, as reported by the provider. Schedora cannot see spam-folder placement or whether a message was read. ${reports}</p>`)}
    ${isAdmin() ? html`<form id="delivery-test" class="card"><h2>Check email delivery</h2><p>Send a test message to one of your own inboxes. Each inbox receives at most one test per hour.</p><label for="delivery-target">Test inbox</label><select id="delivery-target" name="target"><option value="account">My Schedora account email</option><option value="google">My connected Google email</option></select><div data-form-status tabindex="-1"></div><button class="btn" type="submit">Send test email</button></form>` : ''}
    ${emails.length ? html`<div class="table-wrap"><table><thead><tr><th>Created</th><th>Type</th><th>To</th><th>Subject</th><th>Status</th></tr></thead><tbody>
    ${emails.map(email => html`<tr><td>${fmtDateTime(email.created_at)}</td><td>${email.channel === 'sms' ? 'SMS · ' : ''}${email.kind.replace(/_/g, ' ')}</td><td>${email.to_address}</td><td>${email.subject || '—'}</td>
      <td>${badge(email.status)}${email.status === 'scheduled' ? html`<div class="muted">${fmtDateTime(email.next_attempt_at)}</div>` : ''}${email.status === 'sent' && email.channel === 'email' ? html`<div class="muted">${email.accepted_transport ? deliveryEvidence({ status: email.status, transport: email.accepted_transport, report: email.delivery_status }).text : 'Sent before the sending method was recorded; delivery is unknown.'}</div>` : ''}${email.last_error ? html`<div class="muted">${email.last_error}</div>` : ''}</td></tr>`)}
    </tbody></table></div>` : html`<div class="empty">No messages yet.</div>`}`);
  if ($('#delivery-test', panel)) handleSubmit($('#delivery-test', panel), async data => {
    const result = await api('POST', wsPath('/emails/test'), { target: data.target });
    toast(result.status === 'sent' ? `Test accepted by the email provider for ${result.to}. Check that inbox, including spam.${boot.providers.email_reports ? ' This list shows Delivered when the provider reports it.' : ''}` : `Test ${result.status}: ${result.error || 'check Delivery for updates'}`);
    await emailsTab(ctx, panel);
  });
}

// ---------------------------------------------------------------------------------------------
// Event type editor

export async function editor(ctx) {
  if (!session.user) return mount(ctx.main, signInPrompt(ctx, { product: 'meet', title: 'Sign in to edit event types', lead: 'Event types belong to your workspace.' }));
  if (!needsSession(ctx)) return;
  const isNew = ctx.params[0] === 'new';
  setTitle((isNew ? 'New event type' : 'Edit event type') + ' · Meet by Schedora');
  mount(ctx.main, html`<div class="container page">${loading()}</div>`);
  let type, members;
  try {
    [type, members] = await Promise.all([
      isNew ? {
        title: '', slug: '', description: '', locations: [], duration_min: 30, slot_interval_min: 30, timezone: browserZone(), min_notice_min: 240, horizon_days: 60, buffer_before_min: 0, buffer_after_min: 0,
        reminder_min: 1440, published: !ctx.query.get('template'), kind: ctx.query.get('kind') || 'one_on_one', seats: 10, hosts: [{ user_id: session.user.id, priority: 2 }], questions: [],
        max_per_day: null, max_per_week: null, max_per_month: null, start_date: null, end_date: null, price_cents: null, currency: 'inr', secret: Boolean(ctx.query.get('one_off')), one_off: Boolean(ctx.query.get('one_off')),
        single_use: Boolean(ctx.query.get('one_off')), expires_at: null, offered_slots: null, rr_strategy: 'availability', use_host_schedules: false, confirmation_message: '', redirect_url: null,
        managed_template: Boolean(ctx.query.get('template')), locked_fields: [], rules: [1, 2, 3, 4, 5].map(weekday => ({ weekday, start_min: 540, end_min: 1020 })), overrides: []
      } : api('GET', wsPath('/event-types/' + ctx.params[0])),
      api('GET', wsPath('/members'))
    ]);
  } catch (error) { return mount(ctx.main, html`<div class="container page">${errorBlock(error)}<a href="/meet">Back to Meet</a></div>`); }
  if (!ctx.alive()) return;
  const ws = workspace();
  const admin = isAdmin();
  const state = {
    kind: type.kind, hosts: type.hosts.map(host => ({ user_id: host.user_id, priority: host.priority })), locations: type.locations.map(location => ({ ...location })),
    questions: type.questions.map(question => ({ ...question, options: question.options?.map(option => ({ ...option })) })),
    rules: type.rules.map(rule => ({ ...rule })), overrides: type.overrides.map(override => ({ ...override })),
    offered: (type.offered_slots || []).map(slot => slot), locked: [...type.locked_fields]
  };
  const lockedForMe = field => type.managed_parent_id && !admin && type.locked_fields.includes(field);
  const lockAttr = field => lockedForMe(field) ? raw('disabled title="Managed by your administrator"') : '';
  let readiness = null;
  const markDirty = () => { document.body.dataset.dirty = '1'; readiness?.unsaved(); };

  mount(ctx.main, html`<div class="container page">
    <a href="/meet">← Back to Meet</a>
    <h1>${isNew ? (type.one_off ? 'New one-off link' : type.managed_template ? 'New managed template' : 'New event type') : type.title}</h1>
    ${type.managed_parent_id ? notice('info', html`<p>This event type is managed by your administrator from “${type.managed_parent_title}”. ${type.locked_fields.length ? `Locked settings: ${type.locked_fields.join(', ')}.` : ''}</p>`) : ''}
    ${isNew ? html`<p class="hint">After you save, <strong>Ready to share?</strong> checks the saved settings before you send the link.</p>` : html`<section class="card card-plain readiness" id="readiness" aria-labelledby="readiness-heading">
      <div class="row-between"><h2 id="readiness-heading" tabindex="-1">Ready to share?</h2><button class="btn btn-small" type="button" data-recheck>Check again</button></div>
      <p class="hint" id="readiness-checked">Statuses come from saved settings and checks on this server. Unsaved edits are not included.</p>
      <div id="readiness-unsaved"></div><div id="readiness-body"></div><p class="visually-hidden" id="readiness-status" role="status"></p></section>`}
    <form id="event-form" class="stack" novalidate>
      <section class="card card-plain"><h2>Meeting type</h2>
        <fieldset><legend class="visually-hidden">Meeting type</legend><div class="kind-grid">${Object.entries(KINDS).map(([key, [label, help]]) => html`<label class="kind-card">
          <input type="radio" name="kind" value="${key}" ${state.kind === key ? raw('checked') : ''} ${(!admin && ['collective', 'round_robin'].includes(key)) || type.managed_parent_id ? raw('disabled') : ''}><strong>${label}</strong><span class="muted">${help}</span></label>`)}</div></fieldset>
        <div id="kind-extra"></div>
      </section>
      <section class="card card-plain" id="section-details"><h2 tabindex="-1">Details</h2>
        <label for="title">Name <span class="required-mark" aria-hidden="true">*</span></label>
        <input id="title" name="title" required maxlength="120" value="${type.title}" placeholder="30-minute introduction" ${lockAttr('title')}>
        <label for="slug">Link</label><span class="hint" id="slug-hint">${location.origin}/meet/${ws.slug}/<strong id="slug-preview">${type.slug || 'your-link'}</strong></span>
        <input id="slug" name="slug" maxlength="60" value="${type.slug}" aria-describedby="slug-hint" placeholder="Created from the name if left blank">
        <label for="description">Description</label><textarea id="description" name="description" maxlength="2000" ${lockAttr('description')}>${type.description}</textarea>
        <div class="inline-fields">
          <div><label for="duration_min">Duration (minutes)</label><input id="duration_min" name="duration_min" type="number" min="5" max="720" step="5" required value="${type.duration_min}" ${lockAttr('duration_min')}></div>
          <div><label for="slot_interval_min">Start times every (minutes)</label><input id="slot_interval_min" name="slot_interval_min" type="number" min="5" max="720" step="5" required value="${type.slot_interval_min}"></div>
        </div>
        <h3 class="editor-subhead" id="location-heading">Where you meet</h3><p class="hint">Offer one or more options; invitees choose when there are several.</p><div id="locations" aria-labelledby="location-heading"></div>
        <label for="new-location">Add a location</label>
        <div class="row"><select id="new-location" aria-describedby="location-help${boot.video?.enabled ? '' : ' video-unavailable'}">${Object.entries(LOCATION_LABELS).map(([key, label]) => key === 'schedora_meet' && !boot.video?.enabled ? html`<option value="" disabled>${label}: not available yet</option>` : html`<option value="${key}">${label}</option>`)}</select><button class="btn btn-small" type="button" id="add-location" ${lockAttr('locations')}>Add location</button></div>
        <p class="hint" id="location-help" aria-live="polite">${LOCATION_HELP.video}</p>
        ${boot.video?.enabled ? '' : html`<p class="hint" id="video-unavailable">Schedora Meet built-in video is not enabled on this server yet, so it cannot be chosen. Use a connected video app or your own video link for now.</p>`}
      </section>
      <section class="card card-plain" id="section-availability"><h2 tabindex="-1">Availability</h2>
        <label for="timezone">Time zone</label><span class="hint">Weekly hours are in this time zone. Invitees see times converted to theirs, including daylight-saving changes.</span>
        <select id="timezone" name="timezone">${zoneOptions(type.timezone)}</select>
        ${type.one_off ? html`<h3 class="label">Specific times (optional)</h3><p class="hint">Offer only these times instead of your weekly hours. Times use your browser's time zone.</p><div id="offered"></div><button class="btn btn-small" type="button" id="add-offered">Add a time</button>` : ''}
        <h3 class="label">Weekly hours</h3><div id="weekly"></div>
        <h3 class="label">Date exceptions</h3><p class="hint">Block a date (holidays) or replace that day's hours.</p><div id="exceptions"></div>
        <button class="btn btn-small" type="button" id="add-exception">Add a date exception</button>
        <div class="inline-fields section-gap">
          <div><label for="start_date">Bookable from (optional)</label><input id="start_date" name="start_date" type="date" value="${type.start_date || ''}"></div>
          <div><label for="end_date">Bookable until (optional)</label><input id="end_date" name="end_date" type="date" value="${type.end_date || ''}"></div>
        </div>
      </section>
      <section class="card card-plain" id="section-limits"><h2 tabindex="-1">Limits and reminders</h2>
        <div class="inline-fields">
          <div><label for="min_notice_hours">Minimum notice (hours)</label><input id="min_notice_hours" name="min_notice_hours" type="number" min="0" max="720" step="0.5" value="${type.min_notice_min / 60}" ${lockAttr('min_notice_min')}></div>
          <div><label for="horizon_days">Bookable up to (days ahead)</label><input id="horizon_days" name="horizon_days" type="number" min="1" max="365" value="${type.horizon_days}" ${lockAttr('horizon_days')}></div>
          <div><label for="buffer_before_min">Buffer before (minutes)</label><input id="buffer_before_min" name="buffer_before_min" type="number" min="0" max="240" step="5" value="${type.buffer_before_min}" ${lockAttr('buffer_before_min')}></div>
          <div><label for="buffer_after_min">Buffer after (minutes)</label><input id="buffer_after_min" name="buffer_after_min" type="number" min="0" max="240" step="5" value="${type.buffer_after_min}" ${lockAttr('buffer_after_min')}></div>
          <div><label for="max_per_day">Max per day</label><input id="max_per_day" name="max_per_day" type="number" min="1" max="1000" value="${type.max_per_day ?? ''}" placeholder="No limit" ${lockAttr('max_per_day')}></div>
          <div><label for="max_per_week">Max per week</label><input id="max_per_week" name="max_per_week" type="number" min="1" max="1000" value="${type.max_per_week ?? ''}" placeholder="No limit" ${lockAttr('max_per_week')}></div>
          <div><label for="max_per_month">Max per month</label><input id="max_per_month" name="max_per_month" type="number" min="1" max="1000" value="${type.max_per_month ?? ''}" placeholder="No limit" ${lockAttr('max_per_month')}></div>
        </div>
        <label for="reminder_min">Reminder email to invitee</label>
        <select id="reminder_min" name="reminder_min">${[[null, 'No reminder'], [60, '1 hour before'], [240, '4 hours before'], [1440, '24 hours before'], [2880, '48 hours before']].map(([value, label]) => html`<option value="${value ?? ''}" ${value === type.reminder_min ? raw('selected') : ''}>${label}</option>`)}</select>
        <p class="hint">Add SMS reminders and follow-ups on the <a href="/meet?tab=workflows">Workflows</a> tab.</p>
      </section>
      <section class="card card-plain"><h2>Invitee questions</h2><p class="hint">Name and email are always asked. Answers appear in confirmations, the meeting list and workflows ({{answer.key}}).</p>
        <div id="questions"></div><button class="btn btn-small" type="button" id="add-question" ${lockAttr('questions')}>Add a question</button></section>
      <section class="card card-plain"><h2>Payment</h2>
        <div class="inline-fields"><div><label for="price">Price (leave empty for free)</label><input id="price" name="price" type="number" min="0.5" step="0.01" value="${type.price_cents ? type.price_cents / 100 : ''}" ${lockAttr('price_cents')}></div>
          <div><label for="currency">Currency</label><select id="currency" name="currency" ${lockAttr('price_cents')}>${['inr', 'usd', 'eur', 'gbp', 'aud', 'cad', 'sgd', 'aed'].map(code => html`<option value="${code}" ${code === (type.currency || 'inr') ? raw('selected') : ''}>${code.toUpperCase()}</option>`)}</select></div></div>
        <p class="hint">Invitees pay when booking. The payment page shows the hold deadline (20 minutes with Razorpay). Connect a payment provider under <a href="/meet?tab=integrations">Calendars &amp; apps</a>.</p></section>
      <section class="card card-plain"><h2>After booking</h2>
        <label for="confirmation_message">Message on the confirmation page and email</label><textarea id="confirmation_message" name="confirmation_message" maxlength="1000" ${lockAttr('confirmation_message')}>${type.confirmation_message}</textarea>
        <label for="redirect_url">Or send invitees to your own page (https://…)</label><input id="redirect_url" name="redirect_url" type="url" value="${type.redirect_url || ''}"></section>
      <section class="card card-plain" id="section-visibility"><h2 tabindex="-1">Visibility</h2>
        <label class="check"><input type="checkbox" name="published" ${type.published ? raw('checked') : ''}> Accept bookings on the link</label>
        <label class="check"><input type="checkbox" name="secret" ${type.secret ? raw('checked') : ''}> Hide from my booking page (only people with the link can book)</label>
        ${type.one_off ? html`<label class="check"><input type="checkbox" name="single_use" ${type.single_use ? raw('checked') : ''}> Close the link after one booking</label>
          <label for="expires_at">Link expires</label><input id="expires_at" name="expires_at" type="datetime-local" value="${type.expires_at ? new Date(type.expires_at - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''}">` : ''}
      </section>
      ${admin && !type.managed_parent_id ? html`<section class="card card-plain"><h2>Managed template</h2>
        <label class="check"><input type="checkbox" name="managed_template" ${type.managed_template ? raw('checked') : ''}> Use as a template that I assign to members</label>
        <fieldset id="locked"><legend class="label">Members cannot change</legend><div class="check-grid">${['title', 'description', 'locations', 'duration_min', 'questions', 'buffer_before_min', 'buffer_after_min', 'min_notice_min', 'horizon_days', 'price_cents', 'confirmation_message', 'max_per_day', 'max_per_week', 'max_per_month'].map(field => html`
          <label class="check"><input type="checkbox" data-lock="${field}" ${state.locked.includes(field) ? raw('checked') : ''}> ${field.replace(/_min$/, '').replace(/_/g, ' ')}</label>`)}</div></fieldset>
        ${!isNew && type.managed_template ? html`<button class="btn" type="button" id="assign">Assign to members</button>` : ''}</section>` : ''}
      <div data-form-status tabindex="-1"></div>
      <div class="actions"><button class="btn btn-primary" type="submit">Save event type</button>
        ${isNew ? '' : html`<button class="btn" type="button" data-goto="readiness">Review readiness</button><a class="btn" href="/meet/${ws.slug}/${type.slug}" target="_blank" rel="noopener">${type.published ? 'View booking page' : 'Preview booking page'}</a><button class="btn btn-danger" type="button" id="delete-type">Delete</button>`}</div>
    </form></div>`);

  const form = $('#event-form');
  form.addEventListener('input', markDirty);
  form.addEventListener('click', event => { const goto = event.target.closest('[data-goto]'); if (goto) goToSection(goto.dataset.goto); });
  if (!isNew) readiness = readinessPanel(ctx, type);
  $('#title').addEventListener('input', () => { if (!$('#slug').value) $('#slug-preview').textContent = $('#title').value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'your-link'; });
  $('#slug').addEventListener('input', () => { $('#slug-preview').textContent = $('#slug').value || 'your-link'; });

  // Kind-specific settings: hosts, seats, round-robin strategy.
  const renderKind = () => {
    const team = ['collective', 'round_robin'].includes(state.kind);
    if (!team && state.hosts.length > 1) state.hosts = [state.hosts[0]];
    mount($('#kind-extra'), html`
      ${state.kind === 'group' ? html`<label for="seats">Seats per meeting</label><input id="seats" name="seats" type="number" min="2" max="500" value="${type.seats > 1 ? type.seats : 10}">` : ''}
      ${team ? html`<fieldset><legend class="label">Hosts</legend>${members.map(member => {
        const host = state.hosts.find(item => item.user_id === member.id);
        return html`<div class="range"><label class="check"><input type="checkbox" data-host="${member.id}" ${host ? raw('checked') : ''}> ${member.name}</label>
          ${state.kind === 'round_robin' && host ? html`<select data-priority="${member.id}" aria-label="Priority for ${member.name}">${[[4, 'Highest'], [3, 'High'], [2, 'Medium'], [1, 'Low'], [0, 'Lowest']].map(([value, label]) => html`<option value="${value}" ${host.priority === value ? raw('selected') : ''}>${label} priority</option>`)}</select>` : ''}</div>`;
      })}</fieldset>
      ${state.kind === 'round_robin' ? html`<label for="rr_strategy">Distribute meetings by</label><select id="rr_strategy" name="rr_strategy"><option value="availability" ${type.rr_strategy === 'availability' ? raw('selected') : ''}>Priority, then fewest recent meetings</option><option value="equal" ${type.rr_strategy === 'equal' ? raw('selected') : ''}>Equal distribution</option></select>
        <p class="hint">Known contacts with an owner are routed to that owner when they are free.</p>` : ''}
      <label class="check"><input type="checkbox" name="use_host_schedules" ${type.use_host_schedules ? raw('checked') : ''}> Use each host's personal working hours (set under Calendars &amp; apps)</label>` : ''}`);
  };
  renderKind();
  form.addEventListener('change', event => {
    if (event.target.name === 'kind') { state.kind = event.target.value; renderKind(); }
    if (event.target.dataset.host) {
      const id = event.target.dataset.host;
      if (event.target.checked) state.hosts.push({ user_id: id, priority: 2 }); else state.hosts = state.hosts.filter(host => host.user_id !== id);
      renderKind();
    }
    if (event.target.dataset.priority) state.hosts.find(host => host.user_id === event.target.dataset.priority).priority = Number(event.target.value);
    if (event.target.dataset.lock) state.locked = event.target.checked ? [...state.locked, event.target.dataset.lock] : state.locked.filter(field => field !== event.target.dataset.lock);
  });

  // Locations
  const renderLocations = () => mount($('#locations'), state.locations.length ? html`${state.locations.map((location, index) => html`<div class="range">
      <strong class="location-label">${LOCATION_LABELS[location.type]}</strong>
      ${NEEDS_VALUE.includes(location.type) ? html`<input aria-label="${LOCATION_LABELS[location.type]} details" data-location="${index}" value="${location.value || ''}" placeholder="${location.type === 'video' ? 'https://…' : location.type === 'phone_invitee_calls' ? '+91 …' : 'Details'}" ${lockAttr('locations')}>` : html`<span class="muted">${location.type === 'schedora_meet' ? 'A private video room with its own link for each attendee. Connected time uses Meet credits.' : ['google_meet', 'zoom', 'teams'].includes(location.type) ? 'A unique link is created for each booking (connect the app first).' : 'The invitee enters a phone number.'}</span>`}
      <button class="btn btn-small" type="button" data-remove-location="${index}" ${lockAttr('locations')}>Remove</button></div>`)}` : html`<p class="muted">No location. Add one so invitees know where to meet.</p>`);
  renderLocations();
  $('#new-location').addEventListener('change', () => { $('#location-help').textContent = LOCATION_HELP[$('#new-location').value] || ''; });
  $('#add-location').onclick = () => { state.locations.push({ type: $('#new-location').value, value: '' }); renderLocations(); markDirty(); };
  $('#locations').addEventListener('input', event => { if (event.target.dataset.location !== undefined) state.locations[Number(event.target.dataset.location)].value = event.target.value; });
  $('#locations').addEventListener('click', event => { if (event.target.dataset.removeLocation !== undefined) { state.locations.splice(Number(event.target.dataset.removeLocation), 1); renderLocations(); markDirty(); } });

  // Questions
  const renderQuestions = () => mount($('#questions'), state.questions.length ? html`${state.questions.map((question, index) => html`<div class="field-editor">
      <div class="field-editor-head"><strong>${index + 1}. ${FIELD_TYPES[question.type]}</strong><button class="btn btn-small btn-danger" type="button" data-remove-question="${index}" ${lockAttr('questions')}>Remove</button></div>
      <label for="q-label-${index}">Question</label><input id="q-label-${index}" data-question="${index}" data-prop="label" maxlength="300" value="${question.label}" ${lockAttr('questions')}>
      <div class="row"><label class="check"><input type="checkbox" data-question="${index}" data-prop="required" ${question.required ? raw('checked') : ''} ${lockAttr('questions')}> Required</label><span class="muted">Key: ${question.id}</span></div>
      ${question.type.endsWith('_choice') ? html`<label for="q-options-${index}">Options (one per line)</label><textarea id="q-options-${index}" data-question="${index}" data-prop="options" ${lockAttr('questions')}>${question.options.map(option => option.label).join('\n')}</textarea>` : ''}
    </div>`)}` : html`<p class="muted">No extra questions.</p>`);
  renderQuestions();
  $('#add-question').onclick = async () => {
    const result = await ask({ title: 'Add a question', fields: html`<label for="nq-type">Type</label><select id="nq-type" name="type">${QUESTION_TYPES.map(key => html`<option value="${key}">${FIELD_TYPES[key]}</option>`)}</select>
      <label for="nq-label">Question</label><input id="nq-label" name="label" required maxlength="300">`, confirm: 'Add question' });
    if (!result?.label) return;
    let id = result.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'question';
    if (['name', 'email', 'notes', 'phone_number'].includes(id)) id += '_answer';
    while (state.questions.some(question => question.id === id)) id += '_2';
    state.questions.push({ id, type: result.type, label: result.label, required: false, ...(result.type.endsWith('_choice') ? { options: [{ id: 'option_1', label: 'Option 1' }, { id: 'option_2', label: 'Option 2' }] } : {}) });
    renderQuestions();
    markDirty();
  };
  $('#questions').addEventListener('input', event => {
    const index = event.target.dataset.question;
    if (index === undefined) return;
    const question = state.questions[Number(index)];
    const prop = event.target.dataset.prop;
    if (prop === 'label') question.label = event.target.value;
    if (prop === 'required') question.required = event.target.checked;
    if (prop === 'options') question.options = event.target.value.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 50).map((label, position) => ({ id: label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) + '_' + position || 'option_' + position, label }));
  });
  $('#questions').addEventListener('change', event => { if (event.target.dataset.prop === 'required') state.questions[Number(event.target.dataset.question)].required = event.target.checked; });
  $('#questions').addEventListener('click', event => { if (event.target.dataset.removeQuestion !== undefined) { state.questions.splice(Number(event.target.dataset.removeQuestion), 1); renderQuestions(); markDirty(); } });

  // Offered specific times (one-off)
  const toLocalInput = iso => { const date = new Date(iso); return new Date(date - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  const renderOffered = () => $('#offered') && mount($('#offered'), state.offered.length ? html`${state.offered.map((slot, index) => html`<div class="range"><input type="datetime-local" aria-label="Offered time ${index + 1}" data-offered="${index}" value="${slot ? toLocalInput(slot) : ''}"><button class="btn btn-small" type="button" data-remove-offered="${index}">Remove</button></div>`)}` : html`<p class="muted">Using weekly hours.</p>`);
  renderOffered();
  $('#add-offered')?.addEventListener('click', () => { state.offered.push(''); renderOffered(); });
  $('#offered')?.addEventListener('change', event => { if (event.target.dataset.offered !== undefined) state.offered[Number(event.target.dataset.offered)] = event.target.value ? new Date(event.target.value).toISOString() : ''; });
  $('#offered')?.addEventListener('click', event => { if (event.target.dataset.removeOffered !== undefined) { state.offered.splice(Number(event.target.dataset.removeOffered), 1); renderOffered(); } });

  // Weekly hours and exceptions
  const renderWeekly = () => {
    mount($('#weekly'), html`${[1, 2, 3, 4, 5, 6, 0].map(day => {
      const ranges = state.rules.filter(rule => rule.weekday === day);
      return html`<div class="week-row"><label class="check"><input type="checkbox" data-day="${day}" ${ranges.length ? raw('checked') : ''}> ${WEEKDAYS[day]}</label>
        <div>${ranges.length ? ranges.map(rule => { const index = state.rules.indexOf(rule); return html`<div class="range">
          <label class="visually-hidden" for="rule-start-${index}">${WEEKDAYS[day]} start</label><input type="time" id="rule-start-${index}" data-rule="${index}" data-edge="start" value="${minutesToTime(rule.start_min)}" step="300">
          <span aria-hidden="true">–</span><label class="visually-hidden" for="rule-end-${index}">${WEEKDAYS[day]} end</label><input type="time" id="rule-end-${index}" data-rule="${index}" data-edge="end" value="${minutesToTime(rule.end_min)}" step="300">
          <button class="btn btn-small" type="button" data-remove-rule="${index}" aria-label="Remove ${WEEKDAYS[day]} range">Remove</button></div>`; }) : html`<span class="muted">Unavailable</span>`}
          ${ranges.length ? html`<button class="btn-link" type="button" data-add-range="${day}">Add hours</button>` : ''}</div></div>`;
    })}<p class="hint">An end time of 00:00 means midnight.</p>`);
  };
  const renderExceptions = () => {
    mount($('#exceptions'), state.overrides.length ? html`${state.overrides.map((override, index) => html`<div class="range">
      <label class="visually-hidden" for="ov-date-${index}">Date</label><input type="date" id="ov-date-${index}" data-ov="${index}" data-key="date" value="${override.date}">
      <label class="visually-hidden" for="ov-kind-${index}">Availability on this date</label><select id="ov-kind-${index}" data-ov="${index}" data-key="kind"><option value="off" ${override.unavailable ? raw('selected') : ''}>Unavailable</option><option value="hours" ${override.unavailable ? '' : raw('selected')}>Custom hours</option></select>
      ${override.unavailable ? '' : html`<input type="time" aria-label="Start" data-ov="${index}" data-key="start" value="${minutesToTime(override.start_min)}"><input type="time" aria-label="End" data-ov="${index}" data-key="end" value="${minutesToTime(override.end_min)}">`}
      <button class="btn btn-small" type="button" data-remove-ov="${index}">Remove</button></div>`)}` : html`<p class="muted">No exceptions.</p>`);
  };
  renderWeekly();
  renderExceptions();
  $('#weekly').addEventListener('change', event => {
    const target = event.target;
    if (target.dataset.day !== undefined) {
      const day = Number(target.dataset.day);
      if (target.checked) state.rules.push({ weekday: day, start_min: 540, end_min: 1020 });
      else state.rules = state.rules.filter(rule => rule.weekday !== day);
      renderWeekly();
    } else if (target.dataset.rule !== undefined) {
      state.rules[Number(target.dataset.rule)][target.dataset.edge === 'start' ? 'start_min' : 'end_min'] = timeToMinutes(target.value, target.dataset.edge === 'end');
    }
    markDirty();
  });
  $('#weekly').addEventListener('click', event => {
    const add = event.target.dataset.addRange;
    const remove = event.target.dataset.removeRule;
    if (add !== undefined) {
      const day = Number(add);
      const last = state.rules.filter(rule => rule.weekday === day).reduce((max, rule) => Math.max(max, rule.end_min), 0);
      if (last >= 1380) return toast('No room left in this day for another range.');
      state.rules.push({ weekday: day, start_min: last + 60, end_min: Math.min(1440, last + 180) });
    } else if (remove !== undefined) state.rules.splice(Number(remove), 1);
    else return;
    renderWeekly();
    markDirty();
  });
  $('#exceptions').addEventListener('change', event => {
    const index = event.target.dataset.ov;
    if (index === undefined) return;
    const override = state.overrides[Number(index)];
    const key = event.target.dataset.key;
    if (key === 'date') override.date = event.target.value;
    if (key === 'kind') {
      if (event.target.value === 'off') { delete override.start_min; delete override.end_min; override.unavailable = true; }
      else { delete override.unavailable; override.start_min = 540; override.end_min = 1020; }
      renderExceptions();
    }
    if (key === 'start') override.start_min = timeToMinutes(event.target.value, false);
    if (key === 'end') override.end_min = timeToMinutes(event.target.value, true);
    markDirty();
  });
  $('#exceptions').addEventListener('click', event => {
    if (event.target.dataset.removeOv === undefined) return;
    state.overrides.splice(Number(event.target.dataset.removeOv), 1);
    renderExceptions();
    markDirty();
  });
  $('#add-exception').onclick = () => {
    state.overrides.push({ date: dateKey(Date.now() + 7 * 86400000, $('#timezone').value), unavailable: true });
    renderExceptions();
    markDirty();
    $$('#exceptions input[type="date"]').pop()?.focus();
  };

  handleSubmit(form, async data => {
    if (state.overrides.some(override => !override.date)) throw Object.assign(new Error('Each date exception needs a date.'), { details: {} });
    const body = {
      title: data.title, description: data.description, duration_min: data.duration_min, slot_interval_min: data.slot_interval_min, timezone: data.timezone,
      min_notice_min: Math.round((data.min_notice_hours ?? 0) * 60), horizon_days: data.horizon_days, buffer_before_min: data.buffer_before_min ?? 0, buffer_after_min: data.buffer_after_min ?? 0,
      max_per_day: data.max_per_day, max_per_week: data.max_per_week, max_per_month: data.max_per_month, start_date: data.start_date || null, end_date: data.end_date || null,
      reminder_min: data.reminder_min === '' ? null : Number(data.reminder_min), published: data.published, secret: data.secret,
      locations: state.locations, questions: state.questions, rules: state.rules, overrides: state.overrides,
      price_cents: data.price ? Math.round(data.price * 100) : null, currency: data.currency,
      confirmation_message: data.confirmation_message, redirect_url: data.redirect_url || null
    };
    if (!type.managed_parent_id) Object.assign(body, { kind: state.kind, hosts: state.hosts });
    if (state.kind === 'group') body.seats = data.seats;
    if (state.kind === 'round_robin') body.rr_strategy = data.rr_strategy;
    if (['collective', 'round_robin'].includes(state.kind)) body.use_host_schedules = data.use_host_schedules;
    if (type.one_off) Object.assign(body, { one_off: true, single_use: data.single_use, expires_at: data.expires_at ? new Date(data.expires_at).toISOString() : null, offered_slots: state.offered.filter(Boolean).length ? state.offered.filter(Boolean) : null });
    if (admin && !type.managed_parent_id) Object.assign(body, { managed_template: data.managed_template, locked_fields: state.locked });
    if (data.slug) body.slug = data.slug;
    // Members may not send locked fields at all.
    if (type.managed_parent_id && !admin) for (const field of type.locked_fields) { delete body[field]; if (field === 'price_cents') delete body.currency; }
    const saved = isNew ? await api('POST', wsPath('/event-types'), body) : await api('PATCH', wsPath('/event-types/' + type.id), body);
    delete document.body.dataset.dirty;
    toast(saved.managed_template ? 'Template saved.' : saved.published ? 'Saved and published. Check “Ready to share?” before sending the link.' : 'Saved. Publish when you are ready to accept bookings.');
    ctx.navigate('/meet/event-types/' + saved.id, { replace: isNew });
  });
  $('#assign')?.addEventListener('click', async () => {
    const result = await ask({ title: 'Assign to members', body: 'Each selected member gets their own copy. Locked settings follow this template.', fields: html`<div class="check-grid">${members.map(member => html`<label class="check"><input type="checkbox" name="user_${member.id}"> ${member.name}</label>`)}</div>`, confirm: 'Assign' });
    if (!result) return;
    const ids = Object.entries(result).filter(([key, value]) => key.startsWith('user_') && value).map(([key]) => key.slice(5));
    if (!ids.length) return;
    try { const outcome = await api('POST', wsPath(`/event-types/${type.id}/assign`), { user_ids: ids }); toast(`Assigned to ${outcome.created} new member(s).`); }
    catch (error) { toast(error.message); }
  });
  $('#delete-type')?.addEventListener('click', async () => {
    if (!(await ask({ title: 'Delete this event type?', body: 'Its booking link stops working. Past meetings are deleted with it.', confirm: 'Delete event type', danger: true }))) return;
    try { await api('DELETE', wsPath('/event-types/' + type.id)); delete document.body.dataset.dirty; toast('Event type deleted.'); ctx.navigate('/meet', { replace: true }); }
    catch (error) { showErrors(form, error); }
  });
}

// "Ready to share?": statuses come from saved data and server checks (meet-readiness.mjs), never from
// unsaved form values. The editor re-renders after every successful save, which re-runs the check.
const SECTION_IDS = { details: 'section-details', availability: 'section-availability', limits: 'section-limits', visibility: 'section-visibility', readiness: 'readiness' };
const fmtDate = date => fmt(date + 'T12:00:00Z', 'UTC', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

function goToSection(key) {
  const section = document.getElementById(SECTION_IDS[key]);
  if (!section) return;
  section.scrollIntoView({ block: 'start' });
  section.querySelector('h2').focus({ preventScroll: true });
}

function readinessPanel(ctx, savedType) {
  const root = $('#readiness');
  const body = $('#readiness-body', root);
  let type = savedType;
  let announce = false;
  let checkSequence = 0;
  const settle = result => result.status === 'fulfilled' ? { ok: true, value: result.value } : { ok: false, error: result.reason };
  const share = () => {
    const url = bookingUrl(type);
    return html`<label for="share-link">Booking link</label>
      <div class="share-row"><input id="share-link" readonly value="${url}">${type.published ? html`<button class="btn btn-small" type="button" id="copy-share">Copy link</button>` : ''}
        <a class="btn btn-small" href="${url}" target="_blank" rel="noopener">Preview booking page<span class="visually-hidden"> (opens in a new tab)</span></a></div>
      <p class="hint">Preview opens the booking page in a new tab. It does not publish, book or send anything. ${type.published ? 'Copying the link does not show that booking, email or video works.' : 'Copy link appears once the event type is published.'}</p>
      <p class="copy-status" id="copy-status" role="status"></p>`;
  };
  const draw = (result, hosts) => {
    mount(body, html`${readinessAreas(result, { extra: area => area.key === 'sharing' && !type.managed_template ? share() : '' })}${hostReadinessView(hosts, type, session.user.id)}`);
    if (announce) $('#readiness-status', root).textContent = result.headline;
  };
  const check = async refetch => {
    const sequence = ++checkSequence;
    body.setAttribute('aria-busy', 'true');
    mount(body, loading('Checking saved settings…'));
    const sources = await Promise.allSettled([
      refetch ? api('GET', wsPath('/event-types/' + type.id)) : type,
      api('GET', wsPath(`/event-types/${type.id}/slots`)),
      api('GET', wsPath('/calendar')),
      api('GET', wsPath('/integrations')),
      api('GET', wsPath(`/event-types/${type.id}/host-readiness`))
    ]);
    if (!ctx.alive() || !root.isConnected || sequence !== checkSequence) return;
    body.removeAttribute('aria-busy');
    if (sources[0].status === 'rejected') {
      $('#readiness-status', root).textContent = 'Readiness could not be checked.';
      return mount(body, html`${notice('bad', html`<p>Readiness could not be checked: ${sources[0].reason.message} Nothing is marked ready.</p>`)}<button class="btn btn-small" type="button" data-recheck>Check again</button>`);
    }
    type = sources[0].value;
    const [, slots, calendar, integrations, hosts] = sources.map(settle);
    $('#readiness-checked', root).textContent = `Based on the settings saved ${fmtDateTime(type.updated_at)}, checked at ${fmtTime(Date.now())}. Unsaved edits are not included.`;
    const assessment = assessReadiness({
      type, viewer: { id: session.user.id, admin: isAdmin() }, slots, calendar, integrations,
      hostSummaryAvailable: type.hosts.length > 1 && matchingHostEvidence(hosts, type) && hosts.value.scope === 'all_hosts',
      flags: { videoEnabled: Boolean(boot.video?.enabled), emailProvider: boot.providers?.email, testPayments: Boolean(boot.integrations?.testPayments), meetActive: Boolean(workspace().entitlements?.meet?.active) },
      format: { dateTime: fmtDateTime, date: fmtDate, zone: zoneLabel, money }
    });
    draw(assessment, hosts);
  };
  root.addEventListener('click', async event => {
    const goto = event.target.closest('[data-goto]');
    if (goto) return goToSection(goto.dataset.goto);
    if (event.target.closest('[data-recheck]')) { announce = true; return check(true); }
    if (!event.target.closest('#copy-share')) return;
    const status = $('#copy-status', root);
    try { await navigator.clipboard.writeText(bookingUrl(type)); status.textContent = 'Link copied. This does not test booking, email or video.'; }
    catch { $('#share-link', root).select(); status.textContent = 'Copy failed. The link is selected so you can copy it yourself.'; }
  });
  check(false);
  return {
    unsaved() {
      const slot = $('#readiness-unsaved', root);
      if (slot && !slot.childElementCount) mount(slot, notice('warn', html`<p><strong>You have unsaved changes.</strong> This summary describes the last saved version. Save to check your changes.</p>`));
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Date and time picker shared by booking and rescheduling

function picker(container, state, onPick) {
  const byDate = new Map();
  for (const slot of state.slots) {
    const key = dateKey(slot, state.timezone);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(slot);
  }
  const dates = [...byDate.keys()];
  if (!state.month || (dates.length && !dates.some(date => date.startsWith(state.month)) && !state.monthChosen)) state.month = (state.date || dates[0] || dateKey(Date.now(), state.timezone)).slice(0, 7);
  if (state.date && !byDate.has(state.date)) state.date = null;
  const months = [...new Set(dates.map(date => date.slice(0, 7)))];
  const [year, month] = state.month.split('-').map(Number);
  const first = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthLabel = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(first);
  const dows = [...Array(7)].map((_, index) => new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + index))));
  const cells = [];
  for (let blank = 0; blank < first.getUTCDay(); blank++) cells.push(html`<span></span>`);
  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${state.month}-${String(day).padStart(2, '0')}`;
    const count = byDate.get(key)?.length || 0;
    const label = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(key + 'T00:00:00Z'));
    cells.push(count
      ? html`<button type="button" class="day" data-available data-date="${key}" aria-pressed="${state.date === key}" aria-label="${label}, ${count} ${count === 1 ? 'time' : 'times'} available">${day}</button>`
      : html`<button type="button" class="day" disabled aria-label="${label}, no times">${day}</button>`);
  }
  const prev = months.filter(item => item < state.month).pop();
  const next = months.find(item => item > state.month);
  mount(container, html`
    <div class="calendar-head"><button type="button" class="btn btn-small" data-month="${prev || ''}" ${prev ? '' : raw('disabled')} aria-label="Previous month">←</button>
      <h3 aria-live="polite">${monthLabel}</h3>
      <button type="button" class="btn btn-small" data-month="${next || ''}" ${next ? '' : raw('disabled')} aria-label="Next month">→</button></div>
    <div class="calendar" role="group" aria-label="Dates in ${monthLabel}">${dows.map(day => html`<span class="dow" aria-hidden="true">${day}</span>`)}${cells}</div>
    <div id="times" aria-live="polite">${!dates.length ? notice('info', html`<p>No times are available right now. Please check back later or contact the host.</p>`)
      : state.date ? html`<h3 class="label">${fmt(byDate.get(state.date)[0], state.timezone, { weekday: 'long', day: 'numeric', month: 'long' })}</h3>
        <div class="slots">${byDate.get(state.date).map(slot => html`<button type="button" class="slot" data-slot="${slot}" aria-pressed="${state.slot === slot}">${fmtTime(slot, state.timezone)}${state.seats?.[slot] ? html`<small class="seats">${state.seats[slot]} left</small>` : ''}</button>`)}</div>`
      : html`<p class="muted">Choose a highlighted date to see times.</p>`}</div>`);
  container.onclick = event => {
    const target = event.target.closest('button');
    if (!target || target.disabled) return;
    if (target.dataset.month) { state.month = target.dataset.month; state.monthChosen = true; picker(container, state, onPick); }
    else if (target.dataset.date) { state.date = target.dataset.date; state.slot = null; picker(container, state, onPick); container.querySelector('.slot')?.focus(); }
    else if (target.dataset.slot) { state.slot = target.dataset.slot; onPick(target.dataset.slot); }
  };
}

// ---------------------------------------------------------------------------------------------
// Public workspace page: /meet/<workspace>

export async function workspacePage(ctx) {
  mount(ctx.main, html`<div class="container page">${loading()}</div>`);
  let page;
  try { page = await api('GET', `/api/public/meet/${ctx.params[0]}`); }
  catch (error) {
    if (error.status === 404) return mount(ctx.main, html`<div class="container page"><h1>This page is not available</h1><p>Check the address and try again.</p></div>`);
    throw error;
  }
  if (!ctx.alive()) return;
  setTitle(`${page.name} · Meet by Schedora`);
  applyBrand(page.brand_color);
  mount(ctx.main, html`<div class="container page public-profile">
    <div class="profile-head">${page.logo ? html`<img class="brand-logo" src="${page.logo}" alt="${page.name} logo">` : ''}<div><h1>${page.name}</h1>${page.welcome_message ? html`<p class="lead">${page.welcome_message}</p>` : ''}</div></div>
    ${page.event_types.length ? html`<ul class="event-grid">${page.event_types.map(type => html`<li><a class="card event-card" href="/meet/${page.slug}/${type.slug}">
      <h2>${type.title}</h2><p class="meta"><span>${type.duration_min} min</span><span>${KINDS[type.kind][0]}</span>${type.price_cents ? html`<span>${money(type.price_cents, type.currency)}</span>` : ''}${type.kind === 'one_on_one' ? html`<span>${type.host_name}</span>` : ''}</p>
      ${type.description ? html`<p>${type.description.slice(0, 160)}${type.description.length > 160 ? '…' : ''}</p>` : ''}<span class="go">Choose a time →</span></a></li>`)}</ul>` : html`<div class="empty">No meetings are open for booking right now.</div>`}
  </div>`);
}

// ---------------------------------------------------------------------------------------------
// Public booking page (also embeddable at /embed/meet/<workspace>/<event>)

export async function booking(ctx) {
  const [wsSlug, slug] = ctx.params;
  const embed = ctx.path.startsWith('/embed/');
  if (embed) document.body.dataset.embed = '1';
  const base = `/api/public/meet/${wsSlug}/${slug}`;
  mount(ctx.main, html`<div class="container page">${loading('Loading availability…')}</div>`);
  let event, availability;
  try { [event, availability] = await Promise.all([api('GET', base), api('GET', base + '/slots')]); }
  catch (error) {
    if (error.status === 404) return mount(ctx.main, html`<div class="container page"><h1>This booking page is not available</h1><p>The link may be mistyped, or the host has stopped accepting appointments here.</p></div>`);
    throw error;
  }
  if (!ctx.alive()) return;
  setTitle(`${event.title} with ${event.host_name} · Meet by Schedora`);
  applyBrand(event.branding.color);
  const query = ctx.query;
  const state = { slots: availability.slots, seats: availability.seats_left, timezone: browserZone(), date: null, slot: null, month: null, key: null };
  const prefill = { name: query.get('name') || '', email: query.get('email') || '', answers: {} };
  for (const question of event.questions) {
    const value = query.get('a_' + question.id);
    if (value) prefill.answers[question.id] = question.type === 'multiple_choice' ? value.split(',') : value;
  }
  // A Forms handoff carries an opaque token, never personal details. It is removed from the address
  // bar straight away, and the server returns only what this page may pre-fill.
  let handoff = null;
  let handoffNote = '';
  if (query.has('handoff')) {
    const token = query.get('handoff');
    const clean = new URL(location.href);
    clean.searchParams.delete('handoff');
    history.replaceState(history.state, '', clean.pathname + clean.search + clean.hash);
    try {
      const details = await api('GET', `/api/public/form-handoffs/${encodeURIComponent(token)}`);
      if (details.status === 'offered' && details.event.workspace_slug === wsSlug && details.event.slug === slug) {
        handoff = token;
        Object.assign(prefill, { name: details.prefill.name || prefill.name, email: details.prefill.email || prefill.email, answers: { ...prefill.answers, ...details.prefill.answers } });
        handoffNote = notice('info', html`<p><strong>Your form response was received.</strong> Choose a time below to book; your details are filled in. Booking is optional.</p>`);
      } else if (details.status === 'booked') {
        handoffNote = notice('info', html`<p>Your form response was received, and a time was already booked from it. Your confirmation email has links to change it.</p>`);
      } else {
        handoffNote = notice('info', html`<p>This booking link has ${details.status === 'expired' ? 'expired' : 'stopped working'}. Any accepted form response is kept. Contact the team for the next step.</p>`);
      }
    } catch (error) {
      handoffNote = notice('info', html`<p>${error.status === 404 ? 'This booking link is not valid. If you submitted a form, your response is not affected.' : 'This booking link could not be verified. Any accepted form response is kept.'} Contact the team for the next step.</p>`);
    }
    if (!ctx.alive()) return;
    if (!handoff) return mount(ctx.main, html`<div class="container page"><h1>Booking link unavailable</h1>${handoffNote}</div>`);
  }
  const notifyParent = () => { if (embed) parent.postMessage({ type: 'schedora:height', height: document.documentElement.scrollHeight }, '*'); };

  mount(ctx.main, html`<div class="container page">${event.preview ? notice('warn', html`<p><strong>Preview.</strong> This event type is not published, so it cannot be booked yet.</p>`) : ''}${handoffNote}<div class="card booking-layout">
    <aside class="booking-summary" aria-label="Appointment summary">
      ${event.branding.logo ? html`<img class="brand-logo" src="${event.branding.logo}" alt="${event.workspace_name} logo">` : ''}
      <p class="muted">${event.host_name} · ${event.workspace_name}</p>
      <h1>${event.title}</h1>
      <ul class="summary-facts"><li>◷ ${event.duration_min} minutes</li>
        ${event.locations.length ? event.locations.map(location => html`<li>◎ ${location.display}</li>`) : html`<li>◎ Location shared after booking</li>`}
        ${event.kind === 'group' ? html`<li>◉ Group session, up to ${event.seats} people</li>` : ''}
        ${event.price ? html`<li>◈ ${money(event.price.amount_cents, event.price.currency)}, paid when booking</li>` : ''}</ul>
      ${event.description ? html`<p>${event.description}</p>` : ''}
      <div id="selection-summary" aria-live="polite"></div>
    </aside>
    <section class="booking-main" id="booking-main"></section></div></div>`);
  const main = $('#booking-main');
  const summary = $('#selection-summary');

  const showPicker = message => {
    summary.innerHTML = '';
    mount(main, html`<h2>Choose a date and time</h2>
      ${message || ''}
      ${availability.accepting ? '' : notice('warn', html`<p>This booking page is not accepting appointments right now.</p>`)}
      <label for="invitee-zone">Your time zone</label>
      <select id="invitee-zone">${zoneOptions(state.timezone, [event.timezone])}</select>
      <div id="picker"></div>`);
    $('#invitee-zone').onchange = () => { state.timezone = $('#invitee-zone').value; state.date = null; state.slot = null; state.monthChosen = false; picker($('#picker'), state, showDetails); notifyParent(); };
    picker($('#picker'), state, slot => { showDetails(slot); notifyParent(); });
    notifyParent();
  };

  const showDetails = slot => {
    state.slot = slot;
    state.key = uid() + uid();
    mount(summary, html`<div class="notice notice-info"><p><strong>${fmtFull(slot, state.timezone)}</strong><br>${zoneLabel(state.timezone, slot)}</p></div>`);
    const multiple = event.locations.length > 1;
    mount(main, html`<button type="button" class="btn-link" id="change-time">← Change time</button>
      <h2>Your details</h2>
      <form id="invitee-form" novalidate>
        <label for="name">Name <span class="required-mark" aria-hidden="true">*</span></label><input id="name" name="name" required maxlength="100" autocomplete="name" value="${prefill.name}">
        <label for="email">Email <span class="required-mark" aria-hidden="true">*</span></label><span class="hint" id="email-hint">Your confirmation and change links are sent here.</span>
        <input id="email" name="email" type="email" required maxlength="254" autocomplete="email" aria-describedby="email-hint" value="${prefill.email}">
        ${multiple ? html`<fieldset><legend class="label">Where should we meet?</legend><div class="choice-list">${event.locations.map((location, index) => html`<label class="check"><input type="radio" name="location_index" value="${index}" ${index === 0 ? raw('checked') : ''}> ${location.label}${location.auto_video || location.needs_phone ? '' : ': ' + location.display}</label>`)}</div></fieldset>` : ''}
        <div id="phone-field"></div>
        <div id="questions">${event.questions.map(question => html`<div class="question" data-field="${question.id}">${inputFor(question, prefill.answers[question.id], question.label)}</div>`)}</div>
        <label for="notes">Anything to share before the meeting?</label><textarea id="notes" name="notes" maxlength="1000"></textarea>
        <label for="guests">Add guests (optional)</label><span class="hint" id="guests-hint">Email addresses separated by commas. They receive the invitation too.</span><input id="guests" name="guests" aria-describedby="guests-hint" autocomplete="off">
        <input class="visually-hidden" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
        <div data-form-status tabindex="-1"></div>
        ${event.price?.fee_policy?.customer_pays_processing ? html`<p class="hint">Appointment price: ${money(event.price.amount_cents, event.price.currency)}. Razorpay will show its processing fee and applicable tax before you pay. No extra Schedora fee is added.</p>` : ''}
        <div class="actions"><button class="btn btn-primary" type="submit">${event.price ? `Continue to payment (${money(event.price.amount_cents, event.price.currency)}${event.price.fee_policy?.customer_pays_processing ? ' + Razorpay fees' : ''})` : 'Confirm appointment'}</button></div>
      </form>`);
    const form = $('#invitee-form');
    const updatePhone = () => {
      const index = multiple ? Number(form.querySelector('[name="location_index"]:checked')?.value ?? 0) : 0;
      const needsPhone = event.locations[index]?.needs_phone;
      mount($('#phone-field'), needsPhone ? html`<label for="phone">Phone number for the call <span class="required-mark" aria-hidden="true">*</span></label><input id="phone" name="phone" type="tel" required maxlength="30" autocomplete="tel" placeholder="+91 98765 43210">` : '');
    };
    updatePhone();
    form.addEventListener('change', event => { if (event.target.name === 'location_index') updatePhone(); });
    $('#change-time').onclick = () => showPicker();
    (prefill.name ? $('#email') : $('#name')).focus();
    form.addEventListener('input', () => { if (state.failedDefinitely) { state.key = uid() + uid(); state.failedDefinitely = false; } });
    handleSubmit(form, async data => {
      const answers = {};
      const errors = {};
      for (const question of event.questions) {
        const result = checkAnswer(question, readAnswer(form, question));
        if (result.error) errors[question.id] = result.error; else if (result.value !== '' && !(Array.isArray(result.value) && !result.value.length)) answers[question.id] = result.value;
      }
      if (Object.keys(errors).length) throw Object.assign(new Error('Please check the highlighted answers.'), { details: { errors } });
      const guests = String(data.guests || '').split(',').map(value => value.trim()).filter(Boolean);
      const button = form.querySelector('[type="submit"]');
      button.textContent = 'Booking…';
      try {
        const body = { name: data.name, email: data.email, notes: data.notes, start: slot, timezone: state.timezone, answers, guests, website: data.website };
        if (multiple) body.location_index = Number(data.location_index);
        if (data.phone) body.phone = data.phone;
        if (handoff) body.handoff = handoff;
        const result = await api('POST', base + '/bookings', body, { 'Idempotency-Key': state.key });
        if (result.checkout?.url) { location.href = result.checkout.url; return; }
        if (result.booking.status === 'pending' && result.manage_token) {
          if (result.checkout_error) toast(result.checkout_error);
          ctx.navigate(`/meet/manage/${result.manage_token}`); return;
        }
        showConfirmation(result);
      } catch (error) {
        button.textContent = 'Confirm appointment';
        if (error.code === 'slot_unavailable') {
          state.slots = error.details.slots || state.slots.filter(item => item !== slot);
          state.seats = error.details.seats_left || state.seats;
          state.slot = null;
          return showPicker(notice('warn', html`<p>Sorry, that time was just taken. Here are the times that are still open.</p>`));
        }
        // Network or server errors keep the same key so a retry cannot create a second booking.
        if (error.status >= 400 && error.status < 500) state.failedDefinitely = true;
        throw error;
      }
    });
    notifyParent();
  };

  const showConfirmation = ({ booking, manage_token: token }) => {
    if (event.redirect_url && !embed) { location.href = event.redirect_url; return; }
    summary.innerHTML = '';
    setTitle('Appointment confirmed · Meet by Schedora');
    mount(main, html`<div role="status"><h2 tabindex="-1">✓ You are scheduled</h2>
      <p>${booking.event.title} with ${booking.event.host_name} is confirmed and saved.</p>
      <dl class="confirm-facts"><dt>Starts</dt><dd>${fmtFull(booking.starts_at, booking.invitee_timezone)}</dd><dt>Time zone</dt><dd>${zoneLabel(booking.invitee_timezone, booking.starts_at)}</dd>
        <dt>Where</dt><dd>${booking.location?.display || 'The host will share the location'}</dd><dt>Reference</dt><dd>${booking.reference}</dd></dl>
      ${joinBlock(booking, booking.invitee_timezone, embed)}
      ${event.confirmation_message ? html`<p>${event.confirmation_message}</p>` : ''}
      <p>A confirmation email ${booking.email?.status === 'sent' ? 'was sent' : 'is being sent'} to <strong>${booking.invitee_email}</strong>. It includes links to reschedule or cancel.</p>
      ${token ? html`<div class="actions"><a class="btn" href="/api/public/bookings/${token}/ics" download>Add to calendar (.ics)</a><a class="btn" href="/meet/manage/${token}" ${embed ? raw('target="_blank" rel="noopener"') : ''}>Reschedule or cancel</a></div>` : ''}</div>`);
    main.querySelector('h2').focus();
    notifyParent();
  };

  // A start time in the link (from Meet Assist emails) jumps straight to the details step.
  const preselected = query.get('start') && new Date(query.get('start')).toISOString();
  if (preselected && state.slots.includes(preselected)) { state.date = dateKey(preselected, state.timezone); showPicker(); showDetails(preselected); }
  else showPicker(preselected ? notice('warn', html`<p>The time in your link is no longer available. Please choose another.</p>`) : '');
}

// Join instructions for a Schedora Meet booking. Times come from the room's server-enforced window;
// with no usable link the block says so instead of offering a button the server would refuse.
function joinBlock(booking, zone, embed = false) {
  if (booking.location?.type !== 'schedora_meet') return '';
  if (!booking.video?.join_url) return notice('info', html`<p>The video link for this appointment is not available right now. ${booking.event.host_name} will tell you how to join.</p>`);
  const opens = new Date(booking.video.opens_at).getTime();
  const open = Date.now() >= opens;
  return html`<section class="join-block" aria-labelledby="join-heading"><h3 id="join-heading">How to join the video meeting</h3>
    <dl class="confirm-facts"><dt>Link opens</dt><dd>${fmtFull(opens, zone)}<br><span class="muted">${zoneLabel(zone, opens)}</span></dd></dl>
    <p><a class="btn btn-primary" href="${booking.video.join_url}" data-external ${embed ? raw('target="_blank" rel="noopener"') : ''}>${open ? 'Join video meeting' : 'Open join page'}</a></p>
    <p class="hint">${open ? 'The meeting is open now.' : 'Before then, the join page shows when it opens.'}${booking.video.waits_for_host ? ' If you arrive before the host, you wait on the join page until they join.' : ''} This link is personal to this booking and is also in your confirmation email. It stops working if the appointment is canceled or rescheduled.</p></section>`;
}

// ---------------------------------------------------------------------------------------------
// Invitee: manage appointment, and the test payment page

export async function manage(ctx) {
  const token = ctx.params[0];
  setTitle('Manage appointment · Meet by Schedora');
  mount(ctx.main, html`<div class="container page">${loading()}</div>`);
  let data;
  try {
    data = await api('GET', `/api/public/bookings/${token}`);
    if (ctx.query.get('razorpay_payment_link_id')) {
      await api('POST', `/api/public/bookings/${token}/verify-payment`);
      data = await api('GET', `/api/public/bookings/${token}`);
    }
  }
  catch (error) {
    if (error.status === 404) return mount(ctx.main, html`<div class="container page"><h1>This link is not valid</h1><p>Check that you used the newest link from your confirmation email. If you rescheduled, an updated email contains a new link.</p></div>`);
    throw error;
  }
  if (!ctx.alive()) return;
  const { booking } = data;
  const zone = booking.invitee_timezone;
  const flash = ctx.query.get('done') || (ctx.query.get('paid') ? 'paid' : '');
  const status = booking.status === 'pending'
    ? notice('warn', html`<p><strong>Payment pending.</strong> This time is held until ${fmtDateTime(booking.payment.hold_expires_at, zone)}. Complete payment to confirm it.</p><button class="btn btn-primary" id="pay-now">Complete payment</button>`)
    : booking.status === 'canceled'
      ? notice('warn', html`<p>${booking.rescheduled ? 'This appointment was rescheduled. Use the link in your newest confirmation email to see the new time.' : booking.canceled_by === 'payment_timeout' ? 'This booking was released because payment was not completed in time.' : 'This appointment is canceled.'}</p>`)
      : data.expired ? notice('info', html`<p>This appointment has started or passed, so it can no longer be changed online. Contact ${booking.event.host_name} directly.</p>`)
        : !data.can_change ? notice('info', html`<p>Online changes are switched off for this event. Contact the host to change it.</p>`) : '';
  mount(ctx.main, html`<div class="container page"><div class="card">
    ${flash === 'rescheduled' ? notice('ok', html`<p>Rescheduled. A new confirmation email is on its way.</p>`) : flash === 'canceled' ? notice('ok', html`<p>Canceled. ${booking.event.host_name} has been notified.</p>`) : flash === 'paid' && booking.status === 'confirmed' ? notice('ok', html`<p>Payment received. Your appointment is confirmed.</p>`) : ''}
    <span class="tag">Your appointment</span><h1>${booking.event.title}</h1>
    <dl class="confirm-facts"><dt>With</dt><dd>${booking.event.host_name}</dd><dt>Starts</dt><dd>${fmtFull(booking.starts_at, zone)}</dd><dt>Time zone</dt><dd>${zoneLabel(zone, booking.starts_at)}</dd>
      <dt>Where</dt><dd>${booking.location?.display || 'The host will share the location'}</dd><dt>Reference</dt><dd>${booking.reference}</dd><dt>Status</dt><dd>${badge(booking.status)}</dd>
      ${booking.payment ? html`<dt>Appointment payment</dt><dd>${money(booking.payment.amount_cents, booking.payment.currency)} · ${booking.payment.status}</dd>` : ''}</dl>
    ${booking.status === 'canceled' && booking.payment?.status === 'paid' ? notice('warn', html`<p>A payment was received for this canceled appointment. Contact the host to review your refund. This time has not been rebooked.</p>`) : ''}
    ${status}
    ${booking.status === 'confirmed' && !data.expired ? joinBlock(booking, zone) : ''}
    ${data.can_change ? html`<div class="actions" id="manage-actions"><button class="btn btn-primary" id="reschedule">Reschedule</button><button class="btn btn-danger" id="cancel">Cancel appointment</button>
      <a class="btn" href="/api/public/bookings/${token}/ics" download>Add to calendar</a></div><div id="reschedule-panel"></div>` : ''}
  </div></div>`);
  $('#pay-now')?.addEventListener('click', async () => {
    try { location.href = (await api('POST', `/api/public/bookings/${token}/checkout`)).url; } catch (error) { toast(error.message); }
  });
  if (!data.can_change) return;

  $('#cancel').onclick = async () => {
    const result = await ask({ title: 'Cancel this appointment?', body: `${booking.event.host_name} will be notified by email.`, fields: html`<label for="reason">Reason (optional)</label><textarea id="reason" name="reason" maxlength="500"></textarea>`, confirm: 'Cancel appointment', danger: true });
    if (!result) return;
    try { await api('POST', `/api/public/bookings/${token}/cancel`, { reason: result.reason }); ctx.navigate(`/meet/manage/${token}?done=canceled`, { replace: true }); }
    catch (error) { toast(error.message); ctx.render(); }
  };
  $('#reschedule').onclick = async () => {
    const panel = $('#reschedule-panel');
    mount(panel, loading('Loading times…'));
    const availability = await api('GET', `/api/public/bookings/${token}/slots`);
    const state = { slots: availability.slots, seats: availability.seats_left, timezone: zone, date: null, slot: null, month: null };
    mount(panel, html`<hr><h2>Choose a new time</h2><p class="muted">Your current appointment stays booked until you confirm a new time.</p>
      <label for="new-zone">Time zone</label><select id="new-zone">${zoneOptions(zone)}</select><div id="new-picker"></div><div id="new-confirm"></div>`);
    const draw = () => picker($('#new-picker'), state, slot => {
      mount($('#new-confirm'), html`<div class="notice notice-info"><p>New time: <strong>${fmtFull(slot, state.timezone)}</strong></p>
        <button class="btn btn-primary" id="confirm-new">Confirm new time</button></div>`);
      $('#confirm-new').focus();
      $('#confirm-new').onclick = async () => {
        $('#confirm-new').setAttribute('aria-disabled', 'true');
        try {
          const result = await api('POST', `/api/public/bookings/${token}/reschedule`, { start: slot, timezone: state.timezone });
          ctx.navigate(`/meet/manage/${result.manage_token}?done=rescheduled`, { replace: true });
        } catch (error) {
          if (error.code === 'slot_unavailable') { state.slots = error.details.slots || state.slots.filter(item => item !== slot); state.slot = null; draw(); mount($('#new-confirm'), notice('warn', html`<p>That time was just taken. Please choose another.</p>`)); }
          else mount($('#new-confirm'), errorBlock(error));
        }
      };
    });
    $('#new-zone').onchange = () => { state.timezone = $('#new-zone').value; state.date = null; state.monthChosen = false; draw(); };
    draw();
  };
}

// Test payment page: available only while no payment provider is connected and outside production.
export async function pay(ctx) {
  const token = ctx.params[0];
  setTitle('Payment · Meet by Schedora');
  let data;
  try { data = await api('GET', `/api/public/bookings/${token}`); }
  catch (error) { return mount(ctx.main, html`<div class="container page"><h1>This link is not valid</h1>${errorBlock(error)}</div>`); }
  const { booking } = data;
  mount(ctx.main, html`<div class="container page narrow"><div class="card"><span class="tag">Test payment</span><h1>${booking.event.title}</h1>
    ${notice('warn', html`<p>No payment provider is connected, so this page simulates checkout. No money moves.</p>`)}
    <dl class="confirm-facts"><dt>Amount</dt><dd>${booking.payment ? money(booking.payment.amount_cents, booking.payment.currency) : '—'}</dd><dt>When</dt><dd>${fmtFull(booking.starts_at, booking.invitee_timezone)}</dd></dl>
    ${booking.status === 'pending' ? html`<div class="actions"><button class="btn btn-primary" id="simulate-pay">Simulate successful payment</button><a class="btn" href="/meet/manage/${token}">Not now</a></div>` : html`<p>This booking is ${booking.status}.</p><a class="btn" href="/meet/manage/${token}">View booking</a>`}
  </div></div>`);
  $('#simulate-pay')?.addEventListener('click', async () => {
    try { await api('POST', `/api/public/bookings/${token}/test-pay`); ctx.navigate(`/meet/manage/${token}?paid=1`, { replace: true }); }
    catch (error) { toast(error.message); }
  });
}
