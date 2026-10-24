import { $, $$, ask, copy, handleSubmit, html, mount, raw, storage, toast, zoneOptions } from './core.mjs';
import { brand, button, icon, mark, metric, panel, pill, productNames } from './design-system.mjs';
import { csvCell, demoSlots, loadDemo, makeDemo, saveDemo, simulateWorkflow, validateHours } from './demo-store.mjs';
import { journey } from './ecosystem.mjs';
import { setTitle } from './pages.mjs';

const local = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) };
let data = loadDemo(local);
const commit = () => saveDemo(local, data);
const id = () => crypto.randomUUID();
const action = (label, name, value = '', primary = false) => html`<button class="btn btn-small ${primary ? 'btn-primary' : ''}" type="button" data-action="${name}" data-id="${value}">${label}</button>`;
const input = (label, name, value = '', type = 'text', required = true) => html`<label>${label}<input name="${name}" type="${type}" value="${value}" ${required ? raw('required') : ''} maxlength="200"></label>`;
const select = (label, name, value, options) => html`<label>${label}<select name="${name}">${options.map(option => { const [key, text] = Array.isArray(option) ? option : [option, option]; return html`<option value="${key}" ${String(key) === String(value) ? raw('selected') : ''}>${text}</option>`; })}</select></label>`;
const empty = (title, text, link = '') => html`<div class="ds-empty"><h3>${title}</h3><p>${text}</p>${link}</div>`;
const link = (text, href) => html`<a href="${href}">${text}</a>`;
const eventName = booking => data.events.find(event => event.id === booking.event)?.title || 'Appointment';
const initials = name => name.split(' ').map(word => word[0]).join('').slice(0, 2).toUpperCase();
const intro = (label, title, description, controls = '') => html`<div class="ds-intro"><p class="ds-eyebrow">${label}</p><div class="row-between"><h1>${title}</h1>${controls}</div><p>${description}</p></div>`;
const previewLink = event => `${location.origin}/demo/booking/${event.id}`;
const searchText = query => String(query || '').toLowerCase();
const findRows = (rows, query) => rows.filter(row => JSON.stringify(row).toLowerCase().includes(searchText(query)));
const formStatus = form => pill(form.status === 'published' ? 'Published' : 'Draft', form.status === 'published' ? 'accent' : 'neutral');

const navigation = {
  suite: [['Overview', '/demo', 'LayoutDashboard'], ['Activity', '/demo/activity', 'Activity'], ['Connections', '/demo/connections', 'Plug'], ['People', '/demo/people', 'Users']],
  meet: [['Overview', '/demo/meet', 'LayoutDashboard'], ['Bookings', '/demo/meet/bookings', 'CalendarDays'], ['Event types', '/demo/meet/events', 'Link'], ['Availability', '/demo/meet/availability', 'Clock'], ['Calendar connections', '/demo/meet/connections', 'CalendarCheck']],
  forms: [['Overview', '/demo/forms', 'LayoutDashboard'], ['All forms', '/demo/forms/all', 'Files'], ['Responses', '/demo/forms/responses', 'Inbox'], ['Templates', '/demo/forms/templates', 'LayoutTemplate']],
  flow: [['Overview', '/demo/flow', 'LayoutDashboard'], ['Workflows', '/demo/flow/workflows', 'Workflow'], ['Run history', '/demo/flow/runs', 'History'], ['Tasks', '/demo/flow/tasks', 'CheckCircle2'], ['Connections', '/demo/flow/connections', 'Plug']]
};

function shell(ctx, key, content) {
  document.body.dataset.product = key === 'suite' ? 'meet' : key;
  const current = ctx.path;
  return html`<div class="ds-workspace"><aside class="ds-sidebar"><a href="/" aria-label="Schedora home">${brand()}</a>
    <button class="ds-workspace-switch" data-action="workspace"><span class="ds-avatar">${initials(data.profile.workspace)}</span><span><strong>${data.profile.workspace}</strong><small>Demo workspace</small></span>${icon('ChevronsUpDown')}</button>
    <nav aria-label="Workspace products"><p class="ds-nav-label">WORKSPACE & PRODUCTS</p>${Object.entries(productNames).map(([product, name]) => html`<a class="ds-product-link ${product}" href="${product === 'suite' ? '/demo' : '/demo/' + product}" ${key === product ? raw('aria-current="page"') : ''}>${mark(product, 'small')}${product === 'suite' ? 'All products' : name}</a>`)}</nav>
    <nav aria-label="Product sections"><p class="ds-nav-label">${key === 'suite' ? 'WORKSPACE' : productNames[key].toUpperCase()}</p>${navigation[key].map(([label, href, image]) => html`<a href="${href}" ${current === href ? raw('aria-current="page"') : ''}>${icon(image)}${label}</a>`)}</nav>
    <div class="ds-sidebar-bottom"><a href="/demo/settings">${icon('Settings')}Settings</a><button class="ds-plain" data-action="help">${icon('CircleHelp')}Help & feedback</button><div class="ds-profile"><span class="ds-avatar">${initials(data.profile.name)}</span><span><strong>${data.profile.name}</strong><small>${data.profile.email}</small></span></div><a href="/meet">Open live product →</a></div>
  </aside><div class="ds-workspace-main"><header class="ds-appbar"><button class="ds-mobile-menu btn btn-small" data-action="menu" aria-expanded="false" aria-controls="demo-sidebar">Menu</button><span>${data.profile.workspace}<span class="ds-divider">/</span>${key === 'suite' ? 'Workspace' : productNames[key]}</span><div class="row"><form id="studio-search" role="search"><label class="visually-hidden" for="workspace-search">Search workspace</label><input id="workspace-search" name="q" placeholder="Search workspace" value="${ctx.query.get('q') || ''}" type="search"><button class="ds-search-go" aria-label="Search">${icon('Search')}</button></form><button class="ds-plain" data-action="notifications" aria-label="Notifications">${icon('Bell')}</button><a class="ds-avatar" href="/demo/settings" aria-label="Profile settings">${initials(data.profile.name)}</a></div></header>
  <div class="ds-demo-banner"><span>${pill('INTERACTIVE DEMO')} Sample data stays in this browser. No emails, charges or calendar events are sent.</span><a href="/start">Restart setup →</a></div>
  <div class="ds-content">${content}<div class="ds-concept-note"><span>SCHEDORA · FRONTEND PREVIEW · SAMPLE DATA</span><span>${data.timezone}</span></div></div></div></div>`;
}

function bookingList(rows, controls = true) {
  return rows.length ? html`<div class="ds-booking-list">${rows.map(booking => html`<article class="ds-booking-row"><div class="ds-booking-time"><strong>${booking.time}</strong><small>${booking.date}</small></div><div><h3>${eventName(booking)}</h3><p>${booking.name} · ${booking.email}</p><small>${data.events.find(event => event.id === booking.event)?.location || 'Location to be confirmed'}</small></div><div>${pill(booking.status, booking.status === 'confirmed' ? 'accent' : 'neutral')}${controls ? action('View details →', 'booking', booking.id) : ''}</div></article>`)}</div>` : empty('A little space in your schedule.', 'Create an event and try a demo booking.', button('View event types', '/demo/meet/events'));
}
function eventCards() {
  return html`<div class="ds-event-grid">${data.events.map(event => html`<article class="ds-panel ds-event-card"><div class="row-between"><span class="ds-event-line"></span>${action('Edit', 'event', event.id)}</div><h3>${event.title}</h3><p>${event.duration} min · ${event.location}</p><small>${event.published ? 'Published in demo' : 'Draft'}</small><div class="ds-event-footer"><span>/${event.id.slice(0, 24)}</span><div class="row">${action('Copy', 'copy-event', event.id)}${button('Preview', '/demo/booking/' + event.id)}</div></div></article>`)}</div>`;
}
function activityList() {
  return html`<div class="ds-activity">${data.runs.slice(0, 5).map(run => html`<div>${icon(run.status === 'failed' ? 'CircleAlert' : 'CircleCheck')}<div><strong>${data.workflows.find(flow => flow.id === run.workflow)?.title || 'Workflow'} · ${run.name}</strong><small>${run.detail}</small></div>${pill(run.status, run.status === 'failed' ? 'warning' : 'accent')}</div>`)}</div>`;
}
function workspaceOverview() {
  const upcoming = data.bookings.filter(booking => booking.status === 'confirmed');
  return html`${intro('YOUR WORKSPACE', `Good things ahead, ${data.profile.name.split(' ')[0]}.`, 'A clear view of your day. Your time, responses and workflows, all together.', action('+ Quick create', 'quick-create', '', true))}
    <div class="ds-metrics four">${metric('Demo bookings', upcoming.length, 'Confirmed in this preview')}${metric('Form responses', data.responses.length, 'Across your demo forms', 'forms')}${metric('Successful runs', data.runs.filter(run => run.status === 'success').length, 'Local workflow simulations', 'flow')}${metric('Needs your attention', data.runs.filter(run => run.status === 'failed').length, 'Workflow runs to review', 'flow')}</div>
    <div class="ds-columns"><div>${panel('Your next conversations', bookingList(upcoming.slice(0, 3)), link('Open Meet →', '/demo/meet'))}${panel('Across your workspace', activityList(), link('View all activity', '/demo/activity'))}</div><div>${panel('Your products', html`<div class="ds-product-summary">${[['meet', 'Ready for your next booking', `${data.events.length} event types`], ['forms', 'The answers are coming in', `${data.responses.length} responses`], ['flow', 'Work is moving behind the scenes', `${data.workflows.filter(flow => flow.status === 'active').length} active workflows`]].map(([key, title, detail]) => html`<a href="/demo/${key}">${mark(key)}<div><strong>${title}</strong><small>${detail}</small><span>Open ${productNames[key]} →</span></div></a>`)}</div>`)}<section class="ds-connected"><p class="ds-eyebrow">WORKING BETTER TOGETHER</p><h2>From a booking<br>to a better brief.</h2><div class="row">${mark('meet')} → ${mark('forms')} → ${mark('flow')}</div><p>Your Client welcome workflow brings the appointment and its context into one place.</p><a href="/demo/flow">View workflow in Flow →</a></section></div></div>`;
}
function meetOverview() {
  const upcoming = data.bookings.filter(booking => booking.status === 'confirmed');
  return html`${intro('MEET / OVERVIEW', 'Make time for what matters.', `Your schedule, with a little more breathing room. Here’s what’s coming up at ${data.profile.workspace}.`, action('+ New event type', 'event', '', true))}
    <div class="ds-link-banner"><div>${icon('Link')}<span><strong>Your demo booking page is ready</strong><small>${data.events[0] ? previewLink(data.events[0]) : 'Create an event to begin'}</small></span></div><div class="row">${data.events[0] ? html`${action('Copy link', 'copy-event', data.events[0].id)}${button('View page', '/demo/booking/' + data.events[0].id)}` : ''}</div></div>
    <div class="ds-metrics">${metric('Confirmed bookings', upcoming.length, 'In your demo workspace')}${metric('Time for conversations', `${(upcoming.reduce((sum, booking) => sum + (data.events.find(event => event.id === booking.event)?.duration || 0), 0) / 60).toFixed(1)} h`, 'Across confirmed appointments')}${metric('Active event types', data.events.filter(event => event.published).length, 'Using your weekly availability')}</div>
    <div class="ds-columns">${panel('Upcoming bookings', bookingList(upcoming), link('View all bookings →', '/demo/meet/bookings'))}${panel('Your availability', html`<div class="ds-panel-body"><p>${icon('Clock')} Working hours</p><div class="ds-weekdays">${data.hours.map(day => html`<span class="${day.enabled ? 'on' : ''}">${day.day[0]}</span>`)}</div><p>${data.hours.filter(day => day.enabled).map(day => day.day).join(', ')}</p><small>${data.timezone}</small><hr><h3>Google Calendar</h3>${pill(data.calendar ? 'Demo connection enabled' : 'Not connected', data.calendar ? 'accent' : 'neutral')}<p class="ds-note">Preview connection only. No Google data is accessed.</p></div>`, link('Edit →', '/demo/meet/availability'))}</div>
    <div class="ds-section-heading"><h2>A link for every kind of conversation</h2><a href="/demo/meet/events">Manage event types →</a></div>${eventCards()}`;
}
function bookingPage(ctx) {
  const scope = ctx.query.get('status') || 'all';
  const rows = findRows(data.bookings, ctx.query.get('q')).filter(booking => scope === 'all' || booking.status === scope).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return html`${intro('MEET / BOOKINGS', 'Your conversations, in one place.', 'Search, review, reschedule or cancel a demo appointment.')}
    <form class="ds-toolbar" id="booking-filter"><label class="visually-hidden" for="booking-query">Find a booking</label><input id="booking-query" name="q" type="search" placeholder="Find a booking" value="${ctx.query.get('q') || ''}">${select('Status', 'status', scope, ['all', 'confirmed', 'canceled'])}<button class="btn">Apply filters</button></form>${panel(`${rows.length} bookings`, bookingList(rows))}`;
}
function hoursFields() {
  return html`<label>Time zone<select name="timezone">${zoneOptions(data.timezone)}</select></label><div class="ds-hours">${data.hours.map((day, i) => html`<div><label class="check"><input type="checkbox" name="day${i}" ${day.enabled ? raw('checked') : ''}>${day.day}</label><input type="time" name="start${i}" value="${day.start}" aria-label="${day.day} start" required><span>—</span><input type="time" name="end${i}" value="${day.end}" aria-label="${day.day} end" required></div>`)}</div><p class="ds-note">These hours affect the demo booking page only.</p>`;
}
function availability() {
  return html`${intro('MEET / AVAILABILITY', 'Your time, your terms.', 'Set the weekly hours people can choose in your demo booking page.')}<form id="availability-form" class="ds-panel ds-panel-body ds-form-width">${hoursFields()}<div data-form-status></div><button class="btn btn-primary">Save availability</button></form>`;
}
function formsTable(ctx) {
  const status = ctx.query.get('status') || 'all';
  const rows = findRows(data.forms, ctx.query.get('q')).filter(form => status === 'all' || form.status === status);
  return html`<form id="form-filter" class="ds-toolbar"><div class="ds-filter-links">${['all', 'published', 'draft'].map(value => html`<a href="${ctx.path}?status=${value}" ${status === value ? raw('aria-current="page"') : ''}>${value === 'all' ? 'All forms' : value} ${data.forms.filter(form => value === 'all' || form.status === value).length}</a>`)}</div><input type="hidden" name="status" value="${status}"><label class="visually-hidden" for="form-query">Find a form</label><input id="form-query" name="q" type="search" placeholder="Find a form" value="${ctx.query.get('q') || ''}"><button class="btn btn-small">Search</button></form><div class="ds-table-scroll"><table class="ds-table"><thead><tr><th>Form name</th><th>Responses</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows.map(form => html`<tr><td><a class="ds-table-identity" href="/demo/forms/edit/${form.id}">${icon('FileText')}<span><strong>${form.title}</strong><small>${form.description}</small></span></a></td><td>${data.responses.filter(response => response.form === form.id).length}</td><td>${formStatus(form)}</td><td><div class="row">${link('Preview', '/demo/forms/preview/' + form.id)}${action('Duplicate', 'duplicate-form', form.id)}</div></td></tr>`)}</tbody></table>${rows.length ? '' : empty('No forms match this search.', 'Try another name or create a form.')}</div>`;
}
function responseTable(rows = data.responses) {
  return rows.length ? html`<div class="ds-table-scroll"><table class="ds-table"><thead><tr><th>Respondent</th><th>Form</th><th>At a glance</th><th>Actions</th></tr></thead><tbody>${rows.map(response => html`<tr><td><span class="ds-avatar">${initials(response.name)}</span> ${response.name}</td><td>${data.forms.find(form => form.id === response.form)?.title || 'Form'}</td><td>${Object.values(response.answers).slice(-1)[0]}</td><td>${action('View answers', 'response', response.id)}</td></tr>`)}</tbody></table></div>` : empty('Your answers will land here.', 'Preview a form and submit a demo response.', button('Explore forms', '/demo/forms/all'));
}
function formsOverview(ctx) {
  return html`${intro('FORMS / OVERVIEW', 'Good questions. Useful answers.', 'Keep a pulse on your forms and the people on the other side of them.', button('+ Create form', '/demo/forms/edit/new', true))}<div class="ds-metrics">${metric('Demo responses', data.responses.length, 'Answers stored in this browser', 'forms')}${metric('Published forms', data.forms.filter(form => form.status === 'published').length, 'Ready for local preview', 'forms')}${metric('Drafts taking shape', data.forms.filter(form => form.status === 'draft').length, 'Your next good question', 'forms')}</div><div class="ds-columns"><div>${panel('Your forms', formsTable(ctx), link('View all forms →', '/demo/forms/all'))}</div><div>${panel('Responses by form', html`<div class="ds-panel-body ds-response-chart">${data.forms.map(form => html`<div><span>${form.title}</span><strong>${data.responses.filter(response => response.form === form.id).length}</strong></div>`)}</div>`)}<section class="ds-connected forms"><div class="row">${mark('meet')} → ${mark('forms')}</div><h3>Meet with a little more context.</h3><p>Explore an intake form that collects useful details before a conversation.</p><a href="/demo/forms/preview/client-intake">View connected form →</a></section></div></div>${panel('Latest responses', responseTable(data.responses.slice(0, 5)), link('Open response inbox →', '/demo/forms/responses'))}`;
}
function builder(form) {
  if (!form) return empty('This form is no longer here.', 'Choose another form to continue.', button('All forms', '/demo/forms/all'));
  return html`${intro('FORMS / BUILDER', form.title, 'Add questions, choose a presentation and preview the respondent experience.', html`<div class="row">${button('Preview', '/demo/forms/preview/' + form.id)}${action(form.status === 'published' ? 'Unpublish' : 'Publish demo form', 'publish-form', form.id, true)}</div>`)}<div class="ds-builder"><form id="form-settings" class="ds-panel ds-panel-body">${input('Form title', 'title', form.title)}${input('Description', 'description', form.description, 'text', false)}${select('Presentation', 'presentation', form.presentation, [['classic', 'All questions on one page'], ['conversational', 'One question at a time']])}<div class="actions"><button class="btn btn-primary">Save form settings</button></div><div data-form-status></div></form><div><div class="ds-section-heading"><h2>Questions</h2>${action('+ Add question', 'add-field', form.id, true)}</div><div class="ds-question-list">${form.fields.map((field, index) => html`<article class="ds-panel ds-panel-body"><div class="row-between"><div><small>QUESTION ${index + 1} · ${field.type}</small><h3>${field.label}${field.required ? ' *' : ''}</h3></div><div class="row">${action('Edit', 'edit-field', field.id)}${index ? action('Move up', 'move-field', field.id) : ''}${action('Remove', 'remove-field', field.id)}</div></div><p class="ds-note">${field.options?.join(' · ') || 'Your respondent’s answer goes here.'}</p></article>`)}</div></div></div>`;
}

function workflowsTable(ctx) {
  const status = ctx.query.get('status') || 'all';
  const rows = findRows(data.workflows, ctx.query.get('q')).filter(flow => status === 'all' || flow.status === status);
  return html`<div class="ds-toolbar ds-filter-links">${['all', 'active', 'draft'].map(value => link(value === 'all' ? 'All workflows' : value, `${ctx.path}?status=${value}`))}</div><div class="ds-table-scroll"><table class="ds-table"><thead><tr><th>Workflow</th><th>Demo runs</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows.map(flow => html`<tr><td><a class="ds-table-identity" href="/demo/flow/edit/${flow.id}">${icon('Workflow')}<span><strong>${flow.title}</strong><small>${flow.trigger === 'booking' ? 'Meet' : 'Forms'} → Flow · ${flow.action}</small></span></a></td><td>${data.runs.filter(run => run.workflow === flow.id).length}</td><td>${pill(flow.status, flow.status === 'active' ? 'accent' : 'neutral')}</td><td>${action('Simulate', 'simulate', flow.id)}</td></tr>`)}</tbody></table>${rows.length ? '' : empty('No workflows here yet.', 'Create a workflow to give your next event a next step.')}</div>`;
}
function runsList(ctx, limit = 100) {
  const status = ctx.query.get('status') || 'all';
  const rows = data.runs.filter(run => status === 'all' || run.status === status).slice(0, limit);
  return rows.length ? html`<div class="ds-runs">${rows.map(run => html`<article>${icon(run.status === 'failed' ? 'CircleAlert' : 'CircleCheck')}<div><strong>${data.workflows.find(flow => flow.id === run.workflow)?.title || 'Workflow'} <small>#${run.id.slice(0, 8)}</small></strong><small>${run.name} · ${run.detail}</small></div>${pill(run.status, run.status === 'failed' ? 'warning' : 'accent')}${run.status === 'failed' ? action('Review & retry', 'retry', run.id) : ''}</article>`)}</div>` : empty('No runs match this view.', 'Simulate a workflow to see the result here.');
}
function flowOverview(ctx) {
  const successful = data.runs.filter(run => run.status === 'success').length;
  return html`${intro('FLOW / OVERVIEW', 'Keep good work moving.', 'See what’s running, what’s finished and what needs a look.', button('+ Create workflow', '/demo/flow/edit/new', true))}<div class="ds-metrics four">${metric('Active workflows', data.workflows.filter(flow => flow.status === 'active').length, 'Enabled in this preview', 'flow')}${metric('Demo runs', data.runs.length, 'Local simulations', 'flow')}${metric('Success rate', data.runs.length ? Math.round(successful / data.runs.length * 100) + '%' : '—', `${successful} successful simulations`, 'flow')}${metric('Needs attention', data.runs.filter(run => run.status === 'failed').length, 'Runs to review', 'flow')}</div><div class="ds-columns"><div>${panel('Your workflows', workflowsTable(ctx), link('View all →', '/demo/flow/workflows'))}${panel('Recent runs', runsList(ctx, 4), link('Run history →', '/demo/flow/runs'))}</div><div>${panel('Selected workflow', html`<div class="ds-panel-body"><h2>Client welcome</h2><p>From a booked conversation to a brief that’s ready before you meet.</p>${journey()}<p class="ds-note">Concept workflow. Test the local trigger and action simulator to explore the interaction.</p>${button('Open workflow →', '/demo/flow/edit/client-welcome')}</div>`)}<section class="ds-connected flow"><h3>A small fix keeps things moving.</h3><p>Add the missing email for failed runs, then try the simulation again.</p><a href="/demo/flow/runs?status=failed">Review failed runs →</a></section></div></div>`;
}
function flowEditor(flow) {
  if (!flow) return empty('Workflow not found.', 'Choose another workflow.', button('All workflows', '/demo/flow/workflows'));
  return html`${intro('FLOW / EDITOR', flow.title, 'Choose a trigger and a useful next step. All runs here are simulations.', action('Simulate workflow', 'simulate', flow.id))}<form id="flow-form" class="ds-editor-layout"><div class="ds-panel ds-panel-body">${input('Workflow name', 'title', flow.title)}${select('When this happens', 'trigger', flow.trigger, [['booking', 'Meet · New booking'], ['response', 'Forms · New response']])}${select('Do this next', 'action', flow.action, [['email', 'Prepare an email preview'], ['task', 'Create a local task']])}${input(flow.action === 'task' ? 'Task title' : 'Email subject', 'subject', flow.subject)}<label>Message<textarea name="message" maxlength="3000">${flow.message}</textarea></label>${select('Status', 'status', flow.status, ['draft', 'active'])}<div data-form-status></div><div class="actions"><button class="btn btn-primary">Save workflow</button>${action('Delete', 'delete-workflow', flow.id)}</div></div><aside class="ds-connected"><p class="ds-eyebrow">YOUR WORKFLOW</p>${mark(flow.trigger === 'booking' ? 'meet' : 'forms')}<h3>${flow.trigger === 'booking' ? 'Booking created' : 'Form submitted'}</h3><p>Then</p>${mark('flow')}<h3>${flow.action === 'email' ? 'Prepare email' : 'Create task'}</h3><p>Sample events are processed locally. Nothing is sent to an external service.</p></aside></form>`;
}

function connections() {
  return html`${intro('WORKSPACE / CONNECTIONS', 'Bring your tools into the picture.', 'Explore connection states here. Use the live product to authorize a real account.')}<div class="ds-event-grid">${[['CalendarDays', 'Google Calendar', 'Check availability and add appointments.'], ['CalendarPlus', 'Microsoft Outlook', 'Explore a second calendar connection.'], ['Video', 'Video conferencing', 'Choose a location in an event’s settings.']].map(([image, title, text], index) => html`<article class="ds-panel ds-panel-body">${icon(image)}<h2>${title}</h2><p>${text}</p>${index === 0 ? html`${pill(data.calendar ? 'Demo connected' : 'Not connected', 'accent')}${action(data.calendar ? 'Disconnect demo' : 'Connect demo', 'calendar')}` : button('Explore event settings', '/demo/meet/events')}<p class="ds-note">Preview only · No authorization is requested.</p></article>`)}</div>`;
}
function settings() {
  return html`${intro('WORKSPACE / SETTINGS', 'Make this space yours.', 'These preferences apply only to your local demo.')}<form id="profile-form" class="ds-panel ds-panel-body ds-form-width">${input('Your name', 'name', data.profile.name)}${input('Demo email', 'email', data.profile.email, 'email')}${input('Workspace name', 'workspace', data.profile.workspace)}<p class="ds-note">Use sample details. Do not enter passwords, payment details or private customer data.</p><div data-form-status></div><div class="actions"><button class="btn btn-primary">Save preferences</button>${action('Reset sample data', 'reset')}</div></form>`;
}
function people() {
  return html`${intro('WORKSPACE / PEOPLE', 'Good work takes people.', 'Explore local team management. Demo invitations do not send email.', action('+ Add demo member', 'person', '', true))}${panel('Workspace members', html`<div class="ds-table-scroll"><table class="ds-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead><tbody>${data.people.map(person => html`<tr><td>${person.name}</td><td>${person.email}</td><td>${person.role}</td></tr>`)}</tbody></table></div>`)}`;
}

export async function studio(ctx) {
  const parts = ctx.path.split('/').filter(Boolean);
  const key = ['meet', 'forms', 'flow'].includes(parts[1]) ? parts[1] : 'suite';
  const screen = parts[2] || 'overview';
  let content;
  let editedForm;
  let editedFlow;
  if (parts[1] === 'booking') return bookingPreview(ctx, parts[2]);
  if (key === 'forms' && screen === 'preview') return respondentPreview(ctx, parts[3]);
  if (key === 'meet') content = screen === 'bookings' ? bookingPage(ctx) : screen === 'events' ? html`${intro('MEET / EVENT TYPES', 'A link for every conversation.', 'Create, edit and preview your demo appointment types.', action('+ New event type', 'event', '', true))}${eventCards()}` : screen === 'availability' ? availability() : screen === 'connections' ? connections() : meetOverview();
  else if (key === 'forms') {
    if (screen === 'edit') {
      if (parts[3] === 'new') { const newForm = { id: id(), title: 'Untitled form', description: '', status: 'draft', presentation: 'classic', fields: [] }; data.forms.unshift(newForm); commit(); return ctx.navigate('/demo/forms/edit/' + newForm.id); }
      editedForm = data.forms.find(form => form.id === parts[3]); content = builder(editedForm);
    } else if (screen === 'all') content = html`${intro('FORMS / ALL FORMS', 'A home for your questions.', 'Search, edit or duplicate a form.', button('+ Create form', '/demo/forms/edit/new', true))}${panel('All forms', formsTable(ctx))}`;
    else if (screen === 'responses') content = html`${intro('FORMS / RESPONSES', 'Every answer, ready to review.', 'Explore the sample response inbox.', action('Export CSV', 'export'))}${panel('Responses', responseTable())}`;
    else if (screen === 'templates') content = html`${intro('FORMS / TEMPLATES', 'Start with a good question.', 'Pick a starting point and make it yours.')}<div class="ds-event-grid">${data.forms.slice(0, 3).map(form => html`<article class="ds-panel ds-panel-body">${icon('LayoutTemplate')}<h2>${form.title}</h2><p>${form.description}</p>${action('Use template', 'duplicate-form', form.id, true)}</article>`)}</div>`;
    else content = formsOverview(ctx);
  } else if (key === 'flow') {
    if (screen === 'edit') {
      if (parts[3] === 'new') { const newFlow = { id: id(), title: 'Untitled workflow', trigger: 'response', action: 'task', subject: 'Follow up', message: '', status: 'draft' }; data.workflows.unshift(newFlow); commit(); return ctx.navigate('/demo/flow/edit/' + newFlow.id); }
      editedFlow = data.workflows.find(flow => flow.id === parts[3]); content = flowEditor(editedFlow);
    } else if (screen === 'workflows') content = html`${intro('FLOW / WORKFLOWS', 'Every next step, in one place.', 'Open a workflow to edit its trigger and action.', button('+ Create workflow', '/demo/flow/edit/new', true))}${panel('Workflows', workflowsTable(ctx))}`;
    else if (screen === 'runs') content = html`${intro('FLOW / RUN HISTORY', 'See how the work went.', 'Every result below is a local simulation.')}<nav class="ds-toolbar">${['all', 'success', 'failed'].map(status => button(status, '/demo/flow/runs?status=' + status))}</nav>${panel('Run history', runsList(ctx))}`;
    else if (screen === 'tasks') content = html`${intro('FLOW / TASKS', 'Keep the next action visible.', 'Tasks created by demo workflow simulations.')}${panel('Your tasks', data.tasks.length ? html`<div class="ds-panel-body">${data.tasks.map(task => html`<label class="check"><input type="checkbox" data-task="${task.id}" ${task.done ? raw('checked') : ''}>${task.title}</label>`)}</div>` : empty('Nothing on your list yet.', 'Simulate a workflow with a task action to add one.', button('Explore workflows', '/demo/flow/workflows')))}`;
    else if (screen === 'connections') content = connections();
    else content = flowOverview(ctx);
  } else if (parts[1] === 'connections') content = connections();
  else if (parts[1] === 'people') content = people();
  else if (parts[1] === 'settings') content = settings();
  else if (parts[1] === 'activity') content = html`${intro('WORKSPACE / ACTIVITY', 'The story across your workspace.', 'Sample workflow activity and results.')}${panel('Activity', activityList())}`;
  else if (parts[1] === 'search') {
    const query = ctx.query.get('q') || '';
    content = html`${intro('WORKSPACE / SEARCH', `Results for “${query}”`, 'Search event types, forms and workflows.')}<div class="ds-panel ds-panel-body">${[['events', 'meet', 'Meet event'], ['forms', 'forms', 'Form'], ['workflows', 'flow', 'Workflow']].map(([collection, product, label]) => html`<h2>${label}s</h2>${findRows(data[collection], query).map(item => html`<p><a href="${collection === 'events' ? '/demo/meet/events' : `/demo/${product}/edit/${item.id}`}">${item.title}</a></p>`)}`)}</div>`;
  } else content = workspaceOverview();
  setTitle(`${productNames[key]} workspace demo · Schedora`);
  mount(ctx.main, shell(ctx, key, content));
  $('.ds-sidebar').id = 'demo-sidebar';
  bind(ctx, editedForm, editedFlow);
}

function readHours(values) {
  const hours = data.hours.map((day, i) => ({ day: day.day, enabled: values['day' + i], start: values['start' + i], end: values['end' + i] }));
  if (!validateHours(hours)) throw new Error('For each available day, choose an end time later than its start time.');
  data.hours = hours; data.timezone = values.timezone;
}
function bind(ctx, editedForm, editedFlow) {
  const refresh = () => { commit(); ctx.render(); };
  const wire = (selector, handler) => { const form = $(selector); if (form) handleSubmit(form, handler); };
  wire('#studio-search', values => ctx.navigate('/demo/search?q=' + encodeURIComponent(values.q)));
  wire('#booking-filter', values => ctx.navigate('/demo/meet/bookings?' + new URLSearchParams(values)));
  wire('#form-filter', values => ctx.navigate(ctx.path + '?' + new URLSearchParams(values)));
  wire('#availability-form', values => { readHours(values); commit(); toast('Demo availability saved.'); });
  wire('#profile-form', values => { data.profile = { name: values.name.trim(), email: values.email.trim(), workspace: values.workspace.trim() }; if (!data.profile.name || !data.profile.workspace) throw new Error('Add your name and workspace name.'); data.people[0] = { name: data.profile.name, email: data.profile.email, role: 'Owner' }; refresh(); toast('Demo preferences saved.'); });
  wire('#form-settings', values => { if (!values.title.trim()) throw new Error('Give your form a title.'); Object.assign(editedForm, { title: values.title.trim(), description: values.description, presentation: values.presentation }); refresh(); toast('Demo form saved.'); });
  wire('#flow-form', values => { if (!values.title.trim() || !values.subject.trim()) throw new Error('Add a workflow name and action title.'); Object.assign(editedFlow, values); refresh(); toast('Demo workflow saved.'); });
  $$('[data-task]').forEach(checkbox => checkbox.onchange = () => { data.tasks.find(task => task.id === checkbox.dataset.task).done = checkbox.checked; commit(); });
  $$('[data-action]').forEach(control => control.onclick = async () => {
    const name = control.dataset.action; const value = control.dataset.id;
    try {
      if (name === 'menu') { const open = $('.ds-sidebar').classList.toggle('is-open'); control.setAttribute('aria-expanded', String(open)); }
      else if (name === 'help') await ask({ title: 'A little help for your preview', body: 'Explore with sample details. Changes stay in this browser. Calendar connections, emails, payments and team invitations are simulations. Use “Open live product” for the connected application.', confirm: 'Got it' });
      else if (name === 'notifications') await ask({ title: 'Workspace notifications', body: `${data.runs.filter(run => run.status === 'failed').length} demo workflow runs need review. Open Flow → Run history to investigate. No real notifications are sent.`, confirm: 'Got it' });
      else if (name === 'quick-create') await ask({ title: 'What would you like to create?', fields: html`<div class="actions">${button('Event type', '/demo/meet/events')}${button('Form', '/demo/forms/edit/new')}${button('Workflow', '/demo/flow/edit/new')}</div>`, confirm: 'Close' });
      else if (name === 'workspace') { const values = await ask({ title: 'Your demo workspace', fields: input('Workspace name', 'workspace', data.profile.workspace), confirm: 'Save name' }); if (values?.workspace.trim()) { data.profile.workspace = values.workspace.trim(); refresh(); } }
      else if (name === 'calendar') { data.calendar = !data.calendar; refresh(); toast(data.calendar ? 'Demo connection enabled. No Google account was connected.' : 'Demo calendar disconnected.'); }
      else if (name === 'event') await editEvent(ctx, value);
      else if (name === 'copy-event') { const event = data.events.find(item => item.id === value); if (event) await copy(previewLink(event), 'Demo booking link'); }
      else if (name === 'booking') await editBooking(ctx, value);
      else if (name === 'publish-form') { const form = data.forms.find(item => item.id === value); if (!form.fields.length) throw new Error('Add at least one question before publishing.'); form.status = form.status === 'published' ? 'draft' : 'published'; refresh(); }
      else if (name === 'duplicate-form') { const form = structuredClone(data.forms.find(item => item.id === value)); form.id = id(); form.title += ' copy'; form.status = 'draft'; data.forms.unshift(form); commit(); ctx.navigate('/demo/forms/edit/' + form.id); }
      else if (name === 'add-field' || name === 'edit-field') await editField(ctx, editedForm, name === 'edit-field' ? value : null);
      else if (name === 'remove-field') { const approved = await ask({ title: 'Remove this question?', body: 'Existing demo response values are kept in the response inbox.', confirm: 'Remove question', danger: true }); if (approved) { editedForm.fields = editedForm.fields.filter(field => field.id !== value); refresh(); } }
      else if (name === 'move-field') { const index = editedForm.fields.findIndex(field => field.id === value); if (index > 0) { [editedForm.fields[index - 1], editedForm.fields[index]] = [editedForm.fields[index], editedForm.fields[index - 1]]; refresh(); } }
      else if (name === 'response') { const response = data.responses.find(item => item.id === value); await ask({ title: `${response.name}’s response`, fields: html`<dl>${Object.entries(response.answers).map(([key, answer]) => html`<dt>${data.forms.find(form => form.id === response.form)?.fields.find(field => field.id === key)?.label || key}</dt><dd>${answer}</dd>`)}</dl>`, confirm: 'Done' }); }
      else if (name === 'export') exportResponses();
      else if (name === 'simulate') { const flow = data.workflows.find(item => item.id === value); const values = await ask({ title: 'Simulate this workflow', body: 'No email is sent. A task action creates a local demo task.', fields: html`${input('Demo contact name', 'name', 'Sample contact')}${input('Demo contact email', 'email', 'sample@example.com', 'email', false)}`, confirm: 'Run simulation' }); if (values) { const run = simulateWorkflow(data, flow, values); refresh(); toast(run.detail); } }
      else if (name === 'retry') { const run = data.runs.find(item => item.id === value); const flow = data.workflows.find(item => item.id === run.workflow); if (!flow) throw new Error('This workflow has been deleted.'); const values = await ask({ title: 'Fix the missing email and retry', body: 'This creates a new local simulation; no email is sent.', fields: input('Demo email', 'email', '', 'email'), confirm: 'Retry simulation' }); if (values) { simulateWorkflow(data, flow, { ...values, name: run.name }); run.status = 'resolved'; run.detail = 'Reviewed and retried in a new simulation'; refresh(); toast('Workflow simulation retried. No email was sent.'); } }
      else if (name === 'delete-workflow') { const approved = await ask({ title: 'Delete this demo workflow?', body: 'Existing run history stays available.', confirm: 'Delete', danger: true }); if (approved) { data.workflows = data.workflows.filter(flow => flow.id !== value); commit(); ctx.navigate('/demo/flow/workflows'); } }
      else if (name === 'person') { const values = await ask({ title: 'Add a demo member', body: 'This only changes the local preview. No invitation is sent.', fields: html`${input('Name', 'name')}${input('Demo email', 'email', '', 'email')}${select('Role', 'role', 'Member', ['Member', 'Admin'])}`, confirm: 'Add locally' }); if (values) { data.people.push(values); refresh(); } }
      else if (name === 'reset') { const approved = await ask({ title: 'Reset the demo?', body: 'Your local preview edits will be replaced with the original sample data. Live product data is unaffected.', confirm: 'Reset sample data', danger: true }); if (approved) { data = makeDemo(); refresh(); } }
    } catch (error) { toast(error.message); }
  });
}

async function editEvent(ctx, eventId) {
  const event = data.events.find(item => item.id === eventId) || { title: '', duration: 30, location: 'Google Meet', description: '', buffer: 15, notice: 2, published: true };
  const values = await ask({ title: eventId ? 'Edit event type' : 'Create an event type', fields: html`${input('Event name', 'title', event.title)}${select('Duration', 'duration', event.duration, [15, 30, 45, 60, 90].map(n => [n, n + ' minutes']))}${select('Location', 'location', event.location, ['Google Meet', 'Phone', 'In person', 'Custom video link'])}<label>Description<textarea name="description" maxlength="2000">${event.description}</textarea></label>${select('Buffer after', 'buffer', event.buffer, [0, 5, 10, 15, 30].map(n => [n, n + ' minutes']))}${select('Minimum notice', 'notice', event.notice, [0, 2, 12, 24].map(n => [n, n + ' hours']))}<label class="check"><input type="checkbox" name="published" ${event.published ? raw('checked') : ''}>Published in the demo</label>`, confirm: 'Save event type' });
  if (!values) return;
  if (!values.title.trim()) return toast('Give the event a name.');
  const saved = { ...event, ...values, title: values.title.trim(), duration: Number(values.duration), buffer: Number(values.buffer), notice: Number(values.notice) };
  if (eventId) Object.assign(event, saved); else data.events.push({ ...saved, id: id() });
  commit(); ctx.render(); toast('Demo event type saved.');
}
async function editBooking(ctx, bookingId) {
  const booking = data.bookings.find(item => item.id === bookingId);
  const values = await ask({ title: eventName(booking), body: `${booking.name} · ${booking.email}. Demo appointment in ${data.timezone}.`, fields: html`${input('Date', 'date', booking.date, 'date')}${input('Time', 'time', booking.time, 'time')}${select('Status', 'status', booking.status, ['confirmed', 'canceled'])}`, confirm: 'Save demo appointment' });
  if (values) {
    const event = data.events.find(item => item.id === booking.event);
    if (values.status === 'confirmed' && event && !demoSlots(data, event, values.date, booking.id).includes(values.time)) return toast('That time falls outside your demo availability or overlaps another appointment.');
    Object.assign(booking, values); commit(); ctx.render(); toast('Demo appointment updated. No notification was sent.');
  }
}
async function editField(ctx, form, fieldId) {
  const field = form.fields.find(item => item.id === fieldId) || { label: '', type: 'text', required: true, options: [] };
  const values = await ask({ title: fieldId ? 'Edit question' : 'Add a question', fields: html`${input('Question', 'label', field.label)}${select('Answer type', 'type', field.type, [['text', 'Short answer'], ['textarea', 'Long answer'], ['email', 'Email'], ['number', 'Number'], ['date', 'Date'], ['select', 'Dropdown']])}${input('Dropdown choices (separate with commas)', 'options', field.options?.join(', ') || '', 'text', false)}<label class="check"><input type="checkbox" name="required" ${field.required ? raw('checked') : ''}>Required answer</label>`, confirm: 'Save question' });
  if (!values) return;
  if (!values.label.trim()) return toast('Add a question label.');
  const options = values.options.split(',').map(text => text.trim()).filter(Boolean);
  if (values.type === 'select' && !options.length) return toast('Add at least one dropdown choice.');
  const saved = { ...values, label: values.label.trim(), options };
  if (fieldId) Object.assign(field, saved); else form.fields.push({ ...saved, id: id() });
  commit(); ctx.render();
}
function exportResponses() {
  const rows = [['Respondent', 'Form', 'Received', 'Answers'], ...data.responses.map(response => [response.name, data.forms.find(form => form.id === response.form)?.title, response.received, JSON.stringify(response.answers)])];
  const blob = new Blob(['\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'schedora-demo-responses.csv'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function previewFrame(title, content) {
  return html`<div class="ds-preview-page"><div class="ds-preview-top"><a href="/demo">${brand()}</a>${pill('LOCAL DEMO · NOTHING IS SENT')}<a href="/demo">Back to workspace →</a></div><div class="ds-preview-content"><h1 class="visually-hidden">${title}</h1>${content}</div></div>`;
}
function respondentInput(field, value = '') {
  const required = field.required ? raw('required') : '';
  return html`<label>${field.label}${field.required ? ' *' : ''}${field.type === 'textarea' ? html`<textarea name="${field.id}" ${required} maxlength="3000">${value}</textarea>` : field.type === 'select' ? html`<select name="${field.id}" ${required}><option value="">Choose an answer</option>${field.options.map(option => html`<option ${value === option ? raw('selected') : ''}>${option}</option>`)}</select>` : html`<input name="${field.id}" type="${field.type}" value="${value}" ${required} maxlength="500">`}</label>`;
}
function triggerDemo(trigger, payload) {
  data.workflows.filter(flow => flow.status === 'active' && flow.trigger === trigger).forEach(flow => simulateWorkflow(data, flow, payload));
}
function respondentPreview(ctx, formId) {
  const form = data.forms.find(item => item.id === formId);
  if (!form) { mount(ctx.main, previewFrame('Form not found', empty('Form not found.', 'Return to your demo workspace.', button('All forms', '/demo/forms/all')))); return; }
  setTitle(`${form.title} · Forms demo`);
  document.body.dataset.product = 'forms';
  let step = 0; const answers = {};
  const draw = () => {
    mount(ctx.main, previewFrame(form.title, html`<section class="ds-respondent ds-panel">${brand('forms')}${pill(form.status === 'draft' ? 'DRAFT PREVIEW' : 'DEMO FORM')}<h2>${form.title}</h2><p>${form.description}</p>${form.fields.length ? html`<form id="respondent-form">${form.presentation === 'conversational' ? html`<p class="ds-eyebrow">QUESTION ${step + 1} OF ${form.fields.length}</p>${respondentInput(form.fields[step], answers[form.fields[step].id])}` : form.fields.map(field => respondentInput(field))}<div data-form-status></div><div class="actions">${step && form.presentation === 'conversational' ? action('← Previous', 'previous') : ''}<button class="btn btn-primary">${form.presentation === 'conversational' && step < form.fields.length - 1 ? 'Continue →' : 'Submit demo response →'}</button></div></form>` : empty('Your first question goes here.', 'Add a question in the builder before trying the form.', button('Edit form', '/demo/forms/edit/' + form.id))}<p class="ds-note">Use sample answers. Stored in this browser only.</p></section>`));
    const formElement = $('#respondent-form');
    if (!formElement) return;
    $('[data-action="previous"]')?.addEventListener('click', () => { const field = form.fields[step]; answers[field.id] = formElement.elements.namedItem(field.id).value; step--; draw(); });
    handleSubmit(formElement, values => {
      Object.assign(answers, values);
      if (form.presentation === 'conversational' && step < form.fields.length - 1) { step++; return draw(); }
      if (Object.values(answers).some(answer => typeof answer === 'string' && answer.length > 3000)) throw new Error('Please keep each answer under 3,000 characters.');
      const name = answers.name || Object.values(answers)[0] || 'Demo respondent';
      data.responses.unshift({ id: id(), form: form.id, name: String(name), answers: { ...answers }, received: new Date().toISOString() });
      triggerDemo('response', { name: String(name), email: answers.email }); commit();
      mount(ctx.main, previewFrame('Response received', html`<section class="ds-respondent ds-panel">${icon('CircleCheck')}<h2>A good answer starts something.</h2><p>Your demo response is saved locally. No email was sent.</p>${button('View response inbox →', '/demo/forms/responses', true)}</section>`));
    });
  };
  draw();
}

export function availableDemoSlots(event, date) {
  return demoSlots(data, event, date);
}
function bookingPreview(ctx, eventId) {
  const event = data.events.find(item => item.id === eventId);
  document.body.dataset.product = 'meet';
  setTitle('Choose a time · Meet demo');
  if (!event || !event.published) { mount(ctx.main, previewFrame('Booking unavailable', empty('This demo event is not available.', 'Publish the event in the demo workspace to preview it.', button('Event types', '/demo/meet/events')))); return; }
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: data.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  let date = today; let selected = '';
  const draw = () => {
    const slots = availableDemoSlots(event, date);
    mount(ctx.main, previewFrame(event.title, html`<div class="ds-booking-preview ds-panel"><aside>${brand('meet')}<p>${data.profile.name} · ${data.profile.workspace}</p><h2>${event.title}</h2><p>${event.description}</p><p>${icon('Clock')}${event.duration} minutes</p><p>${icon('Video')}${event.location}</p><small>${data.timezone}</small><p class="ds-note">Preview availability only. No real calendar is checked and minimum-notice rules are not enforced here.</p></aside><section><h2>Choose a time</h2><label>Date<input id="demo-date" type="date" value="${date}" min="${today}"></label><div class="ds-slot-grid">${slots.map(time => html`<button class="btn ${selected === time ? 'btn-primary' : ''}" data-time="${time}">${time}</button>`)}</div>${slots.length ? '' : empty('No demo times on this day.', 'Try another date or change your weekly availability.')} ${selected ? html`<form id="demo-booking-form"><h3>${date} · ${selected}</h3>${input('Your name (sample)', 'name')}${input('Email (sample)', 'email', '', 'email')}<div data-form-status></div><button class="btn btn-primary">Confirm demo booking →</button></form>` : ''}</section></div>`));
    $('#demo-date').onchange = event => { if (!/^\d{4}-\d{2}-\d{2}$/.test(event.target.value) || event.target.value < today) return; date = event.target.value; selected = ''; draw(); };
    $$('[data-time]').forEach(button => button.onclick = () => { selected = button.dataset.time; draw(); $('#demo-booking-form input')?.focus(); });
    const form = $('#demo-booking-form');
    if (form) handleSubmit(form, values => {
      if (!availableDemoSlots(event, date).includes(selected)) throw new Error('That demo time is no longer available. Choose another time.');
      const booking = { id: id(), name: values.name, email: values.email, event: event.id, date, time: selected, status: 'confirmed' };
      data.bookings.push(booking); triggerDemo('booking', values); commit();
      mount(ctx.main, previewFrame('Demo booking confirmed', html`<section class="ds-respondent ds-panel">${icon('CircleCheck')}<h2>You’ve made a little time.</h2><p>${event.title} · ${date} · ${selected} (${data.timezone})</p><p>Demo booking saved locally. No calendar event or confirmation email was sent.</p>${button('Manage demo booking →', '/demo/meet/bookings', true)}</section>`));
    });
  };
  draw();
}

const setupSteps = [['products', 'Choose your products'], ['calendar', 'Connect your calendar'], ['availability', 'Set your availability'], ['share', 'Share your booking link']];
function setupFrame(step, content) {
  const index = setupSteps.findIndex(([key]) => key === step);
  return html`<div class="ds-setup"><header class="ds-setup-header"><a href="/">${brand()}</a><span>${data.profile.workspace} <span class="ds-divider">/</span> ${data.profile.name}</span></header><div class="ds-setup-body"><aside>${brand('meet')}<h2>A little setup.<br>A lot less back-and-forth.</h2><p>Let’s make time for your next great conversation.</p><nav aria-label="Setup progress">${setupSteps.map(([key, label], i) => html`<a href="/start/${key}" ${step === key ? raw('aria-current="step"') : ''}><span class="ds-step-number ${i <= index ? 'done' : ''}">${i < index ? html`${icon('Check')}` : i + 1}</span>${label}</a>`)}</nav><div class="ds-connected"><small>Your workspace</small><strong>${data.profile.workspace}</strong><p>One account. Add Forms and Flow whenever you need them.</p></div></aside><section><p class="ds-eyebrow">STEP ${index + 1} OF 4 · INTERACTIVE DEMO</p>${content}<p class="ds-note">FRONTEND PREVIEW · CHANGES STAY IN THIS BROWSER</p></section></div></div>`;
}
export function onboarding(ctx) {
  const step = ctx.path.split('/')[2] || 'welcome';
  setTitle('A little setup · Schedora demo');
  let content;
  if (step === 'welcome') {
    mount(ctx.main, html`<div class="ds-signup"><aside><a href="/">${brand()}</a><p class="ds-eyebrow">A LITTLE LESS BUSYWORK</p><h1>Better work<br>starts with<br>a little space.</h1><p>One account for your time, your information and everything that happens next.</p><div>${[['meet', 'Make time for the right conversations.'], ['forms', 'Collect the context that matters.'], ['flow', 'Keep the next step moving.']].map(([key, text]) => html`<div class="ds-signup-benefit">${mark(key)}<div><strong>${productNames[key]}</strong><small>${text}</small></div></div>`)}</div><small>EXPLORE THE SCHEDORA EXPERIENCE</small></aside><section><p class="ds-signin-link">Ready for the real thing? <a href="/account?mode=signup">Create a live account →</a></p><form id="demo-welcome"><p class="ds-eyebrow">WELCOME TO SCHEDORA</p><h2>Make the demo your own.</h2><p>One workspace. A little less busywork.</p>${pill('DEMO SETUP · NO ACCOUNT CREATED')}${input('Your name (sample)', 'name', data.profile.name)}${input('Email (sample)', 'email', data.profile.email, 'email')}${input('Workspace name', 'workspace', data.profile.workspace)}<p class="ds-note">Use sample details. No password is needed. This preview saves changes in your browser and does not create a real account.</p><div data-form-status></div><button class="btn btn-primary">Continue to your toolkit →</button><p class="ds-note"><a href="/demo">Skip setup and explore the workspace</a></p></form></section></div>`);
    handleSubmit($('#demo-welcome'), values => { if (!values.name.trim() || !values.workspace.trim()) throw new Error('Add your name and workspace name.'); data.profile = { name: values.name.trim(), email: values.email.trim(), workspace: values.workspace.trim() }; data.people[0] = { name: data.profile.name, email: data.profile.email, role: 'Owner' }; commit(); ctx.navigate('/start/products'); });
    return;
  }
  if (step === 'products') content = html`<h1>Start with what you need.</h1><p>Hi ${data.profile.name.split(' ')[0]}. Choose a product for ${data.profile.workspace}. You can always add more later.</p><form id="product-selection"><div class="ds-product-choices">${[['meet', 'Scheduling & bookings', 'A simple way to make time for people.', ['Booking pages & event types', 'Weekly availability', 'Calendar connection']], ['forms', 'Forms & data collection', 'Ask better questions. Keep useful answers.', ['Forms & surveys', 'Response management', 'Classic & conversational forms']], ['flow', 'Workflow automation', 'Move the next step off your to-do list.', ['Event-based workflows', 'Product connections', 'Run history & visibility']]].map(([key, subtitle, text, capabilities]) => html`<label class="ds-product-choice ${key}"><div class="row-between">${mark(key)}<input name="${key}" type="checkbox" ${data.products.includes(key) ? raw('checked') : ''}></div><h2>${productNames[key]}</h2><strong>${subtitle}</strong><p>${text}</p><ul class="eco-checklist">${capabilities.map(capability => html`<li>${icon('Check')}${capability}</li>`)}</ul>${pill('Frontend preview')}</label>`)}</div><div class="ds-link-banner"><div>${mark('meet')}${mark('forms')}${mark('flow')}<strong>The connected ecosystem bundle</strong></div>${action('Select all three', 'select-all')}</div><p class="ds-note">Choose one or more products. No subscription is purchased or payment collected.</p><div data-form-status></div><div class="actions"><button class="btn btn-primary">Continue →</button>${button('Back', '/start')}</div></form>`;
  else if (step === 'calendar') content = html`<h1>A clear view of your time.</h1><p>Explore how Meet checks for conflicts and adds new appointments.</p><div class="ds-columns"><div class="ds-panel ds-panel-body"><div class="row-between"><h2>${icon('CalendarDays')}Google Calendar</h2>${pill(data.calendar ? 'Demo connected' : 'Not connected', 'accent')}</div><p>${data.profile.email}</p>${action(data.calendar ? 'Disconnect demo calendar' : 'Connect demo calendar', 'calendar', '', true)}<hr><h3>Check these calendars for conflicts</h3><label class="check"><input type="checkbox" checked>Work calendar</label><label class="check"><input type="checkbox" checked>Personal · Busy times only</label>${select('Add new bookings to', 'calendar', 'Work calendar', ['Work calendar', 'Personal'])}<p class="ds-note">This preview does not access your Google account. Configure a real connection in the live product.</p></div><aside class="ds-connected">${icon('ShieldCheck')}<h2>Busy stays busy.<br>Private stays private.</h2><p>Invitees see your available times, not your calendar details.</p></aside></div><div class="actions">${button('← Back', '/start/products')}${button('Continue to availability →', '/start/availability', true)}</div>`;
  else if (step === 'availability') {
    const event = data.events[0];
    content = html`<h1>Make room for a good conversation.</h1><p>Set your weekly hours and create the first event on your demo booking page.</p><form id="setup-availability"><div class="ds-setup-columns"><section class="ds-panel ds-panel-body"><h2>When are you available?</h2>${hoursFields()}</section><section class="ds-panel ds-panel-body"><h2>Your first event</h2>${input('Event name', 'title', event?.title || 'Discovery call')}${select('Duration', 'duration', event?.duration || 30, [15, 30, 45, 60].map(n => [n, n + ' minutes']))}${select('Location', 'location', event?.location || 'Google Meet', ['Google Meet', 'Phone', 'In person'])}<label>Description<textarea name="description" maxlength="2000">${event?.description || ''}</textarea></label>${select('Buffer after', 'buffer', event?.buffer || 15, [0, 5, 15, 30].map(n => [n, n + ' minutes']))}${select('Minimum notice', 'notice', event?.notice || 2, [0, 2, 12, 24].map(n => [n, n + ' hours']))}</section></div><div data-form-status></div><div class="actions">${button('← Back', '/start/calendar')}<button class="btn btn-primary">Create event & continue →</button></div></form>`;
  } else if (step === 'share') {
    const event = data.events[0];
    content = html`${icon('CircleCheck')}<h1>Your next conversation starts here.</h1><p>Nice work, ${data.profile.name.split(' ')[0]}. Your demo event is ready to preview.</p>${event ? html`<div class="ds-link-banner"><div><strong>Your ${event.title} link</strong><small>${previewLink(event)}</small></div><div class="row">${action('Copy demo link', 'copy-event', event.id)}${button('Preview', '/demo/booking/' + event.id)}</div></div><div class="ds-setup-columns"><section class="ds-panel ds-panel-body"><h2>Everything is in place</h2><p>${icon('CalendarCheck')}${data.calendar ? 'Demo calendar connection enabled' : 'Calendar connection skipped'}</p><p>${icon('Clock')}Weekly availability saved</p><p>${icon('Video')}${event.title} · ${event.duration} min · ${event.location}</p><p>${icon('Globe')}${data.timezone}</p></section><section class="ds-panel ds-panel-body"><p class="ds-eyebrow">INVITEE PREVIEW</p>${brand('meet')}<p>${data.profile.name} · ${data.profile.workspace}</p><h2>${event.title}</h2><p>${event.description}</p><a href="/demo/booking/${event.id}">View availability →</a></section></div>` : empty('Create an event to share it.', 'Return to availability to finish setup.', button('Set availability', '/start/availability'))}<div class="actions">${button('Go to Meet dashboard →', '/demo/meet', true)}${button('Explore all products', '/demo')}</div>`;
  } else return ctx.navigate('/start');
  mount(ctx.main, setupFrame(step, content));
  bind(ctx);
  if ($('#product-selection')) {
    $('[data-action="select-all"]').onclick = () => $$('#product-selection input[type="checkbox"]').forEach(checkbox => { checkbox.checked = true; });
    handleSubmit($('#product-selection'), values => { const products = ['meet', 'forms', 'flow'].filter(key => values[key]); if (!products.length) throw new Error('Choose at least one product to continue.'); data.products = products; commit(); ctx.navigate(products.includes('meet') ? '/start/calendar' : '/demo/' + products[0]); });
  }
  if ($('#setup-availability')) handleSubmit($('#setup-availability'), values => { if (!values.title.trim()) throw new Error('Give your event a name.'); readHours(values); const event = { ...data.events[0], id: data.events[0]?.id || id(), title: values.title.trim(), duration: Number(values.duration), location: values.location, description: values.description, buffer: Number(values.buffer), notice: Number(values.notice), published: true }; if (data.events.length) data.events[0] = event; else data.events.push(event); commit(); ctx.navigate('/start/share'); });
}
