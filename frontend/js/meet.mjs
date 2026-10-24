import {
  $, $$, api, ask, badge, browserZone, copy, dateKey, errorBlock, fmt, fmtDateTime, fmtFull, fmtTime, handleSubmit, html, isAdmin,
  loading, minutesToTime, mount, notice, raw, session, showErrors, timeToMinutes, toast, uid, workspace, wsPath, zoneOptions
} from './core.mjs';
import { needsSession, setTitle, signInPrompt } from './pages.mjs';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const bookingUrl = (eventType, ws = workspace()) => `${location.origin}/meet/${ws.slug}/${eventType.slug}`;

// ---------------------------------------------------------------------------------------------
// Host dashboard

const TABS = [['types', 'Event types'], ['upcoming', 'Upcoming'], ['past', 'Past'], ['canceled', 'Canceled'], ['calendar', 'Calendar'], ['emails', 'Email delivery']];

export async function dashboard(ctx) {
  setTitle('Meet by Schedora');
  if (!session.user) {
    return mount(ctx.main, signInPrompt(ctx, { product: 'meet', title: 'A little less back-and-forth.', lead: 'Publish your availability once. Invitees choose a time in their own time zone, receive a confirmation, and can reschedule or cancel without emailing you.' }));
  }
  if (!needsSession(ctx)) return;
  const tab = TABS.some(([key]) => key === ctx.query.get('tab')) ? ctx.query.get('tab') : 'types';
  const ws = workspace();
  mount(ctx.main, html`<div class="container page">
    <div class="row-between"><div><span class="tag">Meet · ${ws.name}</span><h1>Scheduling</h1></div>
      <a class="btn btn-primary" href="/meet/event-types/new">New event type</a></div>
    ${ws.entitlements.meet.active ? '' : notice('warn', html`<p>This workspace has no active Meet or Suite plan, so booking pages are not accepting appointments. <a href="/billing">Review plans</a>.</p>`)}
    <nav class="tabs" aria-label="Meet sections">${TABS.map(([key, label]) => html`<a href="/meet?tab=${key}" ${key === tab ? raw('aria-current="page"') : ''}>${label}</a>`)}</nav>
    <section id="tab-panel" aria-live="polite">${loading()}</section></div>`);
  const panel = $('#tab-panel');
  try {
    if (tab === 'types') await eventTypesTab(ctx, panel);
    else if (tab === 'calendar') await calendarTab(ctx, panel);
    else if (tab === 'emails') await emailsTab(ctx, panel);
    else await bookingsTab(ctx, panel, tab);
  } catch (error) { if (ctx.alive()) mount(panel, errorBlock(error)); }
}

async function eventTypesTab(ctx, panel) {
  const types = await api('GET', wsPath('/event-types'));
  if (!ctx.alive()) return;
  if (!types.length) return mount(panel, html`<div class="empty"><h2>Create your first event type</h2><p>An event type is a kind of appointment people can book, such as a 30-minute introduction call.</p><a class="btn btn-primary" href="/meet/event-types/new">New event type</a></div>`);
  mount(panel, html`<ul class="list">${types.map(type => html`<li class="row-between">
    <div><div class="list-title">${type.title}</div><div class="meta"><span>${type.duration_min} min</span><span>${type.timezone}</span>${isAdmin() ? html`<span>Host: ${type.host_name}</span>` : ''}</div></div>
    <div class="row">${type.published ? badge('published') : badge('draft', 'Not published')}
      ${type.published ? html`<button class="btn btn-small" data-copy="${bookingUrl(type)}">Copy link</button><a class="btn btn-small" href="/meet/${workspace().slug}/${type.slug}">View page</a>` : ''}
      <a class="btn btn-small" href="/meet/event-types/${type.id}">Edit</a></div></li>`)}</ul>`);
  $$('[data-copy]', panel).forEach(button => button.onclick = () => copy(button.dataset.copy, 'Booking link'));
}

async function bookingsTab(ctx, panel, scope) {
  const bookings = await api('GET', wsPath('/bookings?scope=' + scope));
  if (!ctx.alive()) return;
  if (!bookings.length) return mount(panel, html`<div class="empty">${{ upcoming: 'No upcoming appointments yet. Share a booking link to get started.', past: 'No past appointments.', canceled: 'No canceled appointments.' }[scope]}</div>`);
  mount(panel, html`<ul class="list">${bookings.map(booking => html`<li>
    <div class="row-between"><div>
      <div class="list-title">${fmtDateTime(booking.starts_at, booking.host_timezone)} · ${booking.event_title}</div>
      <div class="meta"><span>${booking.invitee_name} (${booking.invitee_email})</span><span>Invitee time: ${fmtDateTime(booking.starts_at, booking.invitee_timezone)} ${booking.invitee_timezone}</span><span>Ref ${booking.reference}</span>${isAdmin() ? html`<span>Host: ${booking.host_name}</span>` : ''}</div>
      ${booking.notes ? html`<p class="muted">Notes: ${booking.notes}</p>` : ''}
      ${booking.status === 'canceled' ? html`<p class="muted">${booking.rescheduled_to ? 'Rescheduled by the invitee.' : `Canceled by the ${booking.canceled_by}.`}${booking.cancel_reason ? ' Reason: ' + booking.cancel_reason : ''}</p>` : ''}
    </div>
    <div class="row">${badge(booking.status)}${booking.email ? badge(booking.email.status, 'Email ' + booking.email.status) : ''}
      ${scope === 'upcoming' ? html`<button class="btn btn-small btn-danger" data-cancel="${booking.id}">Cancel</button>` : ''}</div></div></li>`)}</ul>`);
  $$('[data-cancel]', panel).forEach(button => button.onclick = async () => {
    const result = await ask({ title: 'Cancel this appointment?', body: 'The invitee will receive a cancellation email.', fields: html`<label for="cancel-reason">Reason (optional, shared with the invitee)</label><textarea id="cancel-reason" name="reason" maxlength="500"></textarea>`, confirm: 'Cancel appointment', danger: true });
    if (!result) return;
    try { await api('POST', wsPath(`/bookings/${button.dataset.cancel}/cancel`), { reason: result.reason }); toast('Appointment canceled. The invitee will be notified.'); ctx.render(); }
    catch (error) { toast(error.message); }
  });
}

async function calendarTab(ctx, panel) {
  const { connection } = await api('GET', wsPath('/calendar'));
  if (!ctx.alive()) return;
  const status = connection && {
    active: notice('ok', html`<p>Connected. ${connection.busy_count} busy periods are hiding times from your booking pages. Last checked ${fmtDateTime(connection.last_synced_at)}.</p>`),
    revoked: notice('bad', html`<p><strong>Calendar access was revoked.</strong> ${connection.last_error} Busy times are no longer applied, so double bookings with that calendar are possible. Connect the calendar again.</p>`),
    error: notice('warn', html`<p>The last check failed: ${connection.last_error} We keep using the last busy times we read and will retry automatically.</p>`),
    pending: notice('info', html`<p>Waiting for the first check.</p>`)
  }[connection.status];
  mount(panel, html`<div class="card card-plain">
    <h2>Calendar busy times</h2>
    <p>Connect your calendar's private iCal address so busy times are removed from your booking pages. Schedora reads only start and end times, and checks every 15 minutes.</p>
    ${status || ''}
    <details><summary>Where do I find my calendar address?</summary><ul>
      <li>Google Calendar: Settings → your calendar → <em>Secret address in iCal format</em>.</li>
      <li>Outlook.com / Microsoft 365: Settings → Calendar → Shared calendars → <em>Publish a calendar</em> → ICS link.</li>
      <li>Apple iCloud: Calendar → share icon → <em>Public Calendar</em> link (starts with webcal://).</li></ul></details>
    <form id="calendar-form" novalidate>
      <label for="feed_url">Private calendar address</label>
      <input id="feed_url" name="feed_url" type="url" required placeholder="https://… or webcal://…" autocomplete="off">
      <div data-form-status tabindex="-1"></div>
      <div class="actions"><button class="btn btn-primary" type="submit">${connection ? 'Replace calendar' : 'Connect calendar'}</button>
      ${connection ? html`<button class="btn" type="button" id="sync-now">Check now</button><button class="btn btn-danger" type="button" id="disconnect">Disconnect</button>` : ''}</div>
    </form></div>`);
  handleSubmit($('#calendar-form'), async data => {
    const result = await api('POST', wsPath('/calendar'), { feed_url: data.feed_url });
    toast(result.connection.status === 'active' ? 'Calendar connected.' : 'Calendar saved, but the first check failed.');
    ctx.render();
  });
  $('#sync-now')?.addEventListener('click', async () => { try { await api('POST', wsPath('/calendar/sync')); ctx.render(); } catch (error) { toast(error.message); } });
  $('#disconnect')?.addEventListener('click', async () => {
    if (!(await ask({ title: 'Disconnect calendar?', body: 'Busy times from this calendar will stop hiding slots.', confirm: 'Disconnect', danger: true }))) return;
    await api('DELETE', wsPath('/calendar')); ctx.render();
  });
}

async function emailsTab(ctx, panel) {
  const emails = await api('GET', wsPath('/emails'));
  if (!ctx.alive()) return;
  mount(panel, html`${notice('info', html`<p>Every confirmation, reminder and automation email is tracked here. A failed email never affects the booking it belongs to.</p>`)}
    ${emails.length ? html`<div class="table-wrap"><table><thead><tr><th>Created</th><th>Type</th><th>To</th><th>Subject</th><th>Status</th></tr></thead><tbody>
    ${emails.map(email => html`<tr><td>${fmtDateTime(email.created_at)}</td><td>${email.kind.replace(/_/g, ' ')}</td><td>${email.to_address}</td><td>${email.subject}</td>
      <td>${badge(email.status)}${email.status === 'scheduled' ? html`<div class="muted">${fmtDateTime(email.next_attempt_at)}</div>` : ''}${email.last_error ? html`<div class="muted">${email.last_error}</div>` : ''}</td></tr>`)}
    </tbody></table></div>` : html`<div class="empty">No emails yet.</div>`}`);
}

// ---------------------------------------------------------------------------------------------
// Event type editor

export async function editor(ctx) {
  if (!session.user) return mount(ctx.main, signInPrompt(ctx, { product: 'meet', title: 'Sign in to edit event types', lead: 'Event types belong to your workspace.' }));
  if (!needsSession(ctx)) return;
  const isNew = ctx.params[0] === 'new';
  setTitle((isNew ? 'New event type' : 'Edit event type') + ' · Meet by Schedora');
  mount(ctx.main, html`<div class="container page">${loading()}</div>`);
  let type;
  try {
    type = isNew
      ? { title: '', slug: '', description: '', location: '', duration_min: 30, slot_interval_min: 30, timezone: browserZone(), min_notice_min: 240, horizon_days: 60, buffer_before_min: 0, buffer_after_min: 0, reminder_min: 1440, published: false,
          rules: [1, 2, 3, 4, 5].map(weekday => ({ weekday, start_min: 540, end_min: 1020 })), overrides: [] }
      : await api('GET', wsPath('/event-types/' + ctx.params[0]));
  } catch (error) { return mount(ctx.main, html`<div class="container page">${errorBlock(error)}<a href="/meet">Back to Meet</a></div>`); }
  if (!ctx.alive()) return;
  const schedule = { rules: type.rules.map(rule => ({ ...rule })), overrides: type.overrides.map(override => ({ ...override })) };
  const ws = workspace();

  mount(ctx.main, html`<div class="container page">
    <a href="/meet">← Back to Meet</a>
    <h1>${isNew ? 'New event type' : type.title}</h1>
    <form id="event-form" class="stack" novalidate>
      <section class="card card-plain"><h2>1. Details</h2>
        <label for="title">Name <span class="required-mark" aria-hidden="true">*</span></label>
        <input id="title" name="title" required maxlength="120" value="${type.title}" placeholder="30-minute introduction">
        <label for="slug">Link</label><span class="hint" id="slug-hint">${location.origin}/meet/${ws.slug}/<strong id="slug-preview">${type.slug || 'your-link'}</strong></span>
        <input id="slug" name="slug" maxlength="60" value="${type.slug}" aria-describedby="slug-hint" placeholder="Created from the name if left blank" pattern="[a-z0-9]+(-[a-z0-9]+)*">
        <label for="description">Description</label><textarea id="description" name="description" maxlength="2000">${type.description}</textarea>
        <label for="location">Location</label><span class="hint">A meeting link, phone number or address shared in confirmations.</span>
        <input id="location" name="location" maxlength="300" value="${type.location}" placeholder="https://… or office address">
        <div class="inline-fields">
          <div><label for="duration_min">Duration (minutes)</label><input id="duration_min" name="duration_min" type="number" min="5" max="720" step="5" required value="${type.duration_min}"></div>
          <div><label for="slot_interval_min">Start times every (minutes)</label><input id="slot_interval_min" name="slot_interval_min" type="number" min="5" max="720" step="5" required value="${type.slot_interval_min}"></div>
        </div>
      </section>
      <section class="card card-plain"><h2>2. Availability</h2>
        <label for="timezone">Your time zone</label><span class="hint">Weekly hours are in this time zone. Invitees see times converted to theirs, including daylight-saving changes.</span>
        <select id="timezone" name="timezone">${zoneOptions(type.timezone)}</select>
        <h3 class="label">Weekly hours</h3><div id="weekly"></div>
        <h3 class="label">Date exceptions</h3><p class="hint">Block a date (holidays) or replace that day's hours.</p><div id="exceptions"></div>
        <button class="btn btn-small" type="button" id="add-exception">Add a date exception</button>
      </section>
      <section class="card card-plain"><h2>3. Limits and reminders</h2>
        <div class="inline-fields">
          <div><label for="min_notice_hours">Minimum notice (hours)</label><input id="min_notice_hours" name="min_notice_hours" type="number" min="0" max="720" step="0.5" value="${type.min_notice_min / 60}"></div>
          <div><label for="horizon_days">Bookable up to (days ahead)</label><input id="horizon_days" name="horizon_days" type="number" min="1" max="365" value="${type.horizon_days}"></div>
          <div><label for="buffer_before_min">Buffer before (minutes)</label><input id="buffer_before_min" name="buffer_before_min" type="number" min="0" max="240" step="5" value="${type.buffer_before_min}"></div>
          <div><label for="buffer_after_min">Buffer after (minutes)</label><input id="buffer_after_min" name="buffer_after_min" type="number" min="0" max="240" step="5" value="${type.buffer_after_min}"></div>
        </div>
        <label for="reminder_min">Reminder email to invitee</label>
        <select id="reminder_min" name="reminder_min">${[[null, 'No reminder'], [60, '1 hour before'], [240, '4 hours before'], [1440, '24 hours before'], [2880, '48 hours before']].map(([value, label]) => html`<option value="${value ?? ''}" ${value === type.reminder_min ? raw('selected') : ''}>${label}</option>`)}</select>
      </section>
      <section class="card card-plain"><h2>4. Publish</h2>
        <label class="check"><input type="checkbox" name="published" ${type.published ? raw('checked') : ''}> Accept bookings on the public link</label>
        <p class="hint">Unpublished event types cannot be booked, even with the link.</p>
      </section>
      <div data-form-status tabindex="-1"></div>
      <div class="actions"><button class="btn btn-primary" type="submit">Save event type</button>
        ${isNew ? '' : html`<a class="btn" href="/meet/${ws.slug}/${type.slug}">View booking page</a><button class="btn btn-danger" type="button" id="delete-type">Delete</button>`}</div>
    </form></div>`);

  const form = $('#event-form');
  const markDirty = () => { document.body.dataset.dirty = '1'; };
  form.addEventListener('input', markDirty);
  $('#title').addEventListener('input', () => { if (!$('#slug').value) $('#slug-preview').textContent = $('#title').value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'your-link'; });
  $('#slug').addEventListener('input', () => { $('#slug-preview').textContent = $('#slug').value || 'your-link'; });

  const renderWeekly = () => {
    mount($('#weekly'), html`${[1, 2, 3, 4, 5, 6, 0].map(day => {
      const ranges = schedule.rules.filter(rule => rule.weekday === day);
      return html`<div class="week-row"><label class="check"><input type="checkbox" data-day="${day}" ${ranges.length ? raw('checked') : ''}> ${WEEKDAYS[day]}</label>
        <div>${ranges.length ? ranges.map(rule => { const index = schedule.rules.indexOf(rule); return html`<div class="range">
          <label class="visually-hidden" for="rule-start-${index}">${WEEKDAYS[day]} start</label><input type="time" id="rule-start-${index}" data-rule="${index}" data-edge="start" value="${minutesToTime(rule.start_min)}" step="300">
          <span aria-hidden="true">–</span><label class="visually-hidden" for="rule-end-${index}">${WEEKDAYS[day]} end</label><input type="time" id="rule-end-${index}" data-rule="${index}" data-edge="end" value="${minutesToTime(rule.end_min)}" step="300">
          <button class="btn btn-small" type="button" data-remove-rule="${index}" aria-label="Remove ${WEEKDAYS[day]} range">Remove</button></div>`; }) : html`<span class="muted">Unavailable</span>`}
          ${ranges.length ? html`<button class="btn-link" type="button" data-add-range="${day}">Add hours</button>` : ''}</div></div>`;
    })}<p class="hint">An end time of 00:00 means midnight.</p>`);
  };
  const renderExceptions = () => {
    mount($('#exceptions'), schedule.overrides.length ? html`${schedule.overrides.map((override, index) => html`<div class="range">
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
      if (target.checked) schedule.rules.push({ weekday: day, start_min: 540, end_min: 1020 });
      else schedule.rules = schedule.rules.filter(rule => rule.weekday !== day);
      renderWeekly();
    } else if (target.dataset.rule !== undefined) {
      schedule.rules[Number(target.dataset.rule)][target.dataset.edge === 'start' ? 'start_min' : 'end_min'] = timeToMinutes(target.value, target.dataset.edge === 'end');
    }
    markDirty();
  });
  $('#weekly').addEventListener('click', event => {
    const add = event.target.dataset.addRange;
    const remove = event.target.dataset.removeRule;
    if (add !== undefined) {
      const day = Number(add);
      const last = schedule.rules.filter(rule => rule.weekday === day).reduce((max, rule) => Math.max(max, rule.end_min), 0);
      if (last >= 1380) return toast('No room left in this day for another range.');
      schedule.rules.push({ weekday: day, start_min: last + 60, end_min: Math.min(1440, last + 180) });
    } else if (remove !== undefined) schedule.rules.splice(Number(remove), 1);
    else return;
    renderWeekly();
    markDirty();
  });
  $('#exceptions').addEventListener('change', event => {
    const index = event.target.dataset.ov;
    if (index === undefined) return;
    const override = schedule.overrides[Number(index)];
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
    schedule.overrides.splice(Number(event.target.dataset.removeOv), 1);
    renderExceptions();
    markDirty();
  });
  $('#add-exception').onclick = () => {
    schedule.overrides.push({ date: dateKey(Date.now() + 7 * 86400000, $('#timezone').value), unavailable: true });
    renderExceptions();
    markDirty();
    $$('#exceptions input[type="date"]').pop()?.focus();
  };

  handleSubmit(form, async data => {
    if (schedule.overrides.some(override => !override.date)) throw Object.assign(new Error('Each date exception needs a date.'), { details: {} });
    const body = {
      title: data.title, description: data.description, location: data.location,
      duration_min: data.duration_min, slot_interval_min: data.slot_interval_min, timezone: data.timezone,
      min_notice_min: Math.round((data.min_notice_hours ?? 0) * 60), horizon_days: data.horizon_days,
      buffer_before_min: data.buffer_before_min ?? 0, buffer_after_min: data.buffer_after_min ?? 0,
      reminder_min: data.reminder_min === '' ? null : Number(data.reminder_min), published: data.published,
      rules: schedule.rules, overrides: schedule.overrides
    };
    if (data.slug) body.slug = data.slug;
    const saved = isNew ? await api('POST', wsPath('/event-types'), body) : await api('PATCH', wsPath('/event-types/' + type.id), body);
    delete document.body.dataset.dirty;
    toast(saved.published ? 'Saved. Your booking page is live.' : 'Saved. Publish when you are ready to accept bookings.');
    ctx.navigate('/meet/event-types/' + saved.id, { replace: isNew });
  });
  $('#delete-type')?.addEventListener('click', async () => {
    if (!(await ask({ title: 'Delete this event type?', body: 'Its booking link stops working. Past appointments are deleted with it.', confirm: 'Delete event type', danger: true }))) return;
    try { await api('DELETE', wsPath('/event-types/' + type.id)); delete document.body.dataset.dirty; toast('Event type deleted.'); ctx.navigate('/meet', { replace: true }); }
    catch (error) { showErrors(form, error); }
  });
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
  if (!state.month || (dates.length && !dates.some(date => date.startsWith(state.month)) && !state.monthChosen)) state.month = (dates[0] || dateKey(Date.now(), state.timezone)).slice(0, 7);
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
  const monthIndex = months.indexOf(state.month);
  const prev = monthIndex > 0 ? months[monthIndex - 1] : months.filter(item => item < state.month).pop();
  const next = months.find(item => item > state.month);
  mount(container, html`
    <div class="calendar-head"><button type="button" class="btn btn-small" data-month="${prev || ''}" ${prev ? '' : raw('disabled')} aria-label="Previous month">←</button>
      <h3 aria-live="polite">${monthLabel}</h3>
      <button type="button" class="btn btn-small" data-month="${next || ''}" ${next ? '' : raw('disabled')} aria-label="Next month">→</button></div>
    <div class="calendar" role="group" aria-label="Dates in ${monthLabel}">${dows.map(day => html`<span class="dow" aria-hidden="true">${day}</span>`)}${cells}</div>
    <div id="times" aria-live="polite">${!dates.length ? notice('info', html`<p>No times are available right now. Please check back later or contact the host.</p>`)
      : state.date ? html`<h3 class="label">${fmt(byDate.get(state.date)[0], state.timezone, { weekday: 'long', day: 'numeric', month: 'long' })}</h3>
        <div class="slots">${byDate.get(state.date).map(slot => html`<button type="button" class="slot" data-slot="${slot}" aria-pressed="${state.slot === slot}">${fmtTime(slot, state.timezone)}</button>`)}</div>`
      : html`<p class="muted">Choose a highlighted date to see times.</p>`}</div>`);
  container.onclick = event => {
    const target = event.target.closest('button');
    if (!target || target.disabled) return;
    if (target.dataset.month) { state.month = target.dataset.month; state.monthChosen = true; picker(container, state, onPick); container.querySelector('.calendar-head h3').focus?.(); }
    else if (target.dataset.date) { state.date = target.dataset.date; state.slot = null; picker(container, state, onPick); container.querySelector('.slot')?.focus(); }
    else if (target.dataset.slot) { state.slot = target.dataset.slot; onPick(target.dataset.slot); }
  };
}

// ---------------------------------------------------------------------------------------------
// Public booking page

export async function booking(ctx) {
  const [wsSlug, slug] = ctx.params;
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
  const state = { slots: availability.slots, timezone: browserZone(), date: null, slot: null, month: null, key: null };

  mount(ctx.main, html`<div class="container page"><div class="card booking-layout">
    <aside class="booking-summary" aria-label="Appointment summary">
      <p class="muted">${event.host_name} · ${event.workspace_name}</p>
      <h1>${event.title}</h1>
      <ul class="summary-facts"><li>◷ ${event.duration_min} minutes</li><li>◎ ${event.location || 'Location shared after booking'}</li></ul>
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
    $('#invitee-zone').onchange = () => { state.timezone = $('#invitee-zone').value; state.date = null; state.slot = null; state.monthChosen = false; picker($('#picker'), state, showDetails); };
    picker($('#picker'), state, showDetails);
  };

  const showDetails = slot => {
    state.slot = slot;
    state.key = uid() + uid();
    mount(summary, html`<div class="notice notice-info"><p><strong>${fmtFull(slot, state.timezone)}</strong><br>${state.timezone.replace(/_/g, ' ')}</p></div>`);
    mount(main, html`<button type="button" class="btn-link" id="change-time">← Change time</button>
      <h2>Your details</h2>
      <form id="invitee-form" novalidate>
        <label for="name">Name <span class="required-mark" aria-hidden="true">*</span></label><input id="name" name="name" required maxlength="100" autocomplete="name">
        <label for="email">Email <span class="required-mark" aria-hidden="true">*</span></label><span class="hint" id="email-hint">Your confirmation and change links are sent here.</span>
        <input id="email" name="email" type="email" required maxlength="254" autocomplete="email" aria-describedby="email-hint">
        <label for="notes">Anything to share before the appointment?</label><textarea id="notes" name="notes" maxlength="1000"></textarea>
        <input class="visually-hidden" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
        <div data-form-status tabindex="-1"></div>
        <div class="actions"><button class="btn btn-primary" type="submit">Confirm appointment</button></div>
      </form>`);
    $('#change-time').onclick = () => showPicker();
    $('#name').focus();
    const form = $('#invitee-form');
    form.addEventListener('input', () => { if (state.failedDefinitely) { state.key = uid() + uid(); state.failedDefinitely = false; } });
    handleSubmit(form, async data => {
      const button = form.querySelector('[type="submit"]');
      button.textContent = 'Booking…';
      try {
        const result = await api('POST', base + '/bookings', { ...data, start: slot, timezone: state.timezone }, { 'Idempotency-Key': state.key });
        showConfirmation(result);
      } catch (error) {
        button.textContent = 'Confirm appointment';
        if (error.code === 'slot_unavailable') {
          state.slots = error.details.slots || state.slots.filter(item => item !== slot);
          state.slot = null;
          return showPicker(notice('warn', html`<p>Sorry, that time was just taken. Here are the times that are still open.</p>`));
        }
        // Network or server errors keep the same key so a retry cannot create a second booking.
        if (error.status >= 400 && error.status < 500) state.failedDefinitely = true;
        throw error;
      }
    });
  };

  const showConfirmation = ({ booking, manage_token: token }) => {
    summary.innerHTML = '';
    setTitle('Appointment confirmed · Meet by Schedora');
    mount(main, html`<div role="status"><h2>✓ You are scheduled</h2>
      <p>${booking.event.title} with ${booking.event.host_name} is confirmed and saved.</p>
      <dl class="confirm-facts"><dt>When</dt><dd>${fmtFull(booking.starts_at, booking.invitee_timezone)}</dd><dt>Time zone</dt><dd>${booking.invitee_timezone.replace(/_/g, ' ')}</dd>
        <dt>Where</dt><dd>${booking.event.location || 'The host will share the location'}</dd><dt>Reference</dt><dd>${booking.reference}</dd></dl>
      <p>A confirmation email ${booking.email?.status === 'sent' ? 'was sent' : 'is being sent'} to <strong>${booking.invitee_email}</strong>. It includes links to reschedule or cancel.</p>
      ${token ? html`<div class="actions"><a class="btn" href="/api/public/bookings/${token}/ics" download>Add to calendar (.ics)</a><a class="btn" href="/meet/manage/${token}">Reschedule or cancel</a></div>` : ''}</div>`);
    main.querySelector('h2').setAttribute('tabindex', '-1');
    main.querySelector('h2').focus();
  };

  showPicker();
}

// ---------------------------------------------------------------------------------------------
// Invitee: manage appointment

export async function manage(ctx) {
  const token = ctx.params[0];
  setTitle('Manage appointment · Meet by Schedora');
  mount(ctx.main, html`<div class="container page">${loading()}</div>`);
  let data;
  try { data = await api('GET', `/api/public/bookings/${token}`); }
  catch (error) {
    if (error.status === 404) return mount(ctx.main, html`<div class="container page"><h1>This link is not valid</h1><p>Check that you used the newest link from your confirmation email. If you rescheduled, an updated email contains a new link.</p></div>`);
    throw error;
  }
  if (!ctx.alive()) return;
  const { booking } = data;
  const zone = booking.invitee_timezone;
  const flash = ctx.query.get('done');
  const status = booking.status === 'canceled'
    ? notice('warn', html`<p>${booking.rescheduled ? 'This appointment was rescheduled. Use the link in your newest confirmation email to see the new time.' : 'This appointment is canceled.'}</p>`)
    : data.expired ? notice('info', html`<p>This appointment has started or passed, so it can no longer be changed online. Contact ${booking.event.host_name} directly.</p>`)
    : !data.can_change ? notice('info', html`<p>Online changes are switched off for this event. Contact the host to change it.</p>`) : '';
  mount(ctx.main, html`<div class="container page"><div class="card">
    ${flash === 'rescheduled' ? notice('ok', html`<p>Rescheduled. A new confirmation email is on its way.</p>`) : flash === 'canceled' ? notice('ok', html`<p>Canceled. ${booking.event.host_name} has been notified.</p>`) : ''}
    <span class="tag">Your appointment</span><h1>${booking.event.title}</h1>
    <dl class="confirm-facts"><dt>With</dt><dd>${booking.event.host_name}</dd><dt>When</dt><dd>${fmtFull(booking.starts_at, zone)} (${zone.replace(/_/g, ' ')})</dd>
      <dt>Where</dt><dd>${booking.event.location || 'The host will share the location'}</dd><dt>Reference</dt><dd>${booking.reference}</dd><dt>Status</dt><dd>${badge(booking.status)}</dd></dl>
    ${status}
    ${data.can_change ? html`<div class="actions" id="manage-actions"><button class="btn btn-primary" id="reschedule">Reschedule</button><button class="btn btn-danger" id="cancel">Cancel appointment</button>
      <a class="btn" href="/api/public/bookings/${token}/ics" download>Add to calendar</a></div><div id="reschedule-panel"></div>` : ''}
  </div></div>`);
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
    const state = { slots: availability.slots, timezone: zone, date: null, slot: null, month: null };
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
