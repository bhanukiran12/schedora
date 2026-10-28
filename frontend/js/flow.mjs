import { $, $$, api, ask, badge, boot, errorBlock, fmtDateTime, handleSubmit, html, isAdmin, loading, mount, notice, raw, session, toast, workspace, wsPath } from './core.mjs';
import { needsSession, setTitle, signInPrompt } from './pages.mjs';
import { FLOW_STARTERS } from './flow-starters.mjs';
import { emailEvidence } from './email-evidence.mjs';

const TRIGGERS = { 'meet.booking.created': 'A Meet appointment is booked', 'forms.response.created': 'A Forms response is submitted' };
const ACTIONS = { email: 'Send an email', task: 'Create a follow-up task' };
const DUE_CHOICES = [[4, '4 hours'], [24, '1 day'], [48, '2 days'], [72, '3 days'], [168, '1 week']];
const dueLabel = hours => DUE_CHOICES.find(([value]) => value === hours)?.[1] || `${hours} hours`;
// Preset deadlines, plus a saved custom value so editing never silently changes it.
const dueOptions = current => [['', 'No deadline'], ...DUE_CHOICES.map(([value, label]) => [String(value), `${label} after it is created`]),
  ...(current && !DUE_CHOICES.some(([value]) => value === current) ? [[String(current), `${current} hours after it is created`]] : [])];
const configuredEmailHint = () => boot.providers.email === 'outbox'
  ? 'This server currently records email in its local outbox. It is not delivered to an inbox.'
  : 'This server currently uses an email provider. Acceptance does not prove inbox delivery.';
const PLACEHOLDERS = {
  'meet.booking.created': ['invitee.name', 'invitee.email', 'booking.start', 'booking.start_host', 'booking.reference', 'event.title', 'event.location', 'host.name'],
  'forms.response.created': ['form.title', 'response.id']
};

export async function dashboard(ctx) {
  setTitle('Flow by Schedora');
  if (!session.user) return mount(ctx.main, signInPrompt(ctx, { product: 'flow', title: 'Give every enquiry a clear next step.', lead: 'Turn a Meet booking or Forms response into an email or a task. Review each run, investigate failures and retry supported actions.' }));
  if (!needsSession(ctx)) return;
  const tab = ctx.params[0] || 'flows';
  mount(ctx.main, html`<div class="container page">
    <div class="row-between"><div><span class="tag">Flow · ${workspace().name}</span><h1>Automations</h1></div><div class="row"><a class="btn" href="/enquiries?show=attention">Enquiries needing attention</a>${isAdmin() ? html`<a class="btn btn-primary" href="/flow/new">New flow</a>` : ''}</div></div>
    ${workspace().entitlements.flow.active ? '' : notice('warn', html`<p>This workspace has no active Flow or Suite plan, so flows cannot run. <a href="/billing">Review plans</a>.</p>`)}

    <section id="panel">${loading()}</section></div>`);
  const panel = $('#panel');
  try {
    if (tab === 'runs') await runsTab(ctx, panel);
    else if (tab === 'tasks') await tasksTab(ctx, panel);
    else await flowsTab(ctx, panel);
  } catch (error) { if (ctx.alive()) mount(panel, errorBlock(error)); }
}

async function flowsTab(ctx, panel) {
  const flows = await api('GET', wsPath('/flows'));
  if (!ctx.alive()) return;
  if (!flows.length) return mount(panel, html`<div class="empty flow-empty"><h2>No flows yet</h2><p>A flow connects one trigger to one action: when an appointment is booked or a form is submitted, send an email or create a task.</p>
    ${isAdmin() ? html`<p class="flow-empty-lead">Start from an outcome. Each opens as an unsaved draft you can edit; nothing runs until you enable it.</p>
      <ul class="flow-starter-links">${FLOW_STARTERS.map(starter => html`<li><a href="/flow/new?starter=${starter.id}"><strong>${starter.name}</strong><span>${starter.description}</span></a></li>`)}</ul>
      <div class="row"><a class="btn" href="/flow/new">Start from scratch</a><a class="btn" href="/setup/flow">Guided setup</a></div>` : html`<p>Ask a workspace administrator to create one.</p>`}</div>`);
  mount(panel, html`<ul class="list">${flows.map(flow => html`<li class="row-between"><div>
      <div class="list-title">${flow.name}</div>
      <div class="meta"><span>${TRIGGERS[flow.trigger_type]} → ${ACTIONS[flow.action_type]}</span><span>${flow.run_count} runs</span>${flow.failed_count ? html`<a href="/flow/runs">${flow.failed_count} failed</a>` : ''}</div></div>
    <div class="row">${badge(flow.status)}${isAdmin() ? html`
      ${flow.status === 'enabled' ? html`<button class="btn btn-small" data-status="paused" data-id="${flow.id}">Pause</button>` : html`<button class="btn btn-small" data-status="enabled" data-id="${flow.id}">${flow.status === 'paused' ? 'Resume' : 'Enable flow'}</button>`}
      <a class="btn btn-small" href="/flow/${flow.id}">Edit</a>` : ''}</div></li>`)}</ul>
    <p class="muted">Paused flows keep new events queued and run them when resumed. Draft flows ignore events.</p>`);
  $$('[data-status]', panel).forEach(button => button.onclick = async () => {
    try { await api('PATCH', wsPath('/flows/' + button.dataset.id), { status: button.dataset.status }); toast(button.dataset.status === 'enabled' ? 'Flow enabled.' : 'Flow paused.'); ctx.render(); }
    catch (error) { toast(error.message); }
  });
}

async function runsTab(ctx, panel) {
  const draw = runs => mount(panel, html`<div class="row-between"><p class="muted">A run succeeds when its task is created or its email action is recorded. Each email outcome uses the sending method saved for that message, where available. Inbox delivery is not tracked. Retrying reuses the same run, so a created task or accepted email is not repeated.</p><button class="btn btn-small" id="refresh">Refresh</button></div>
    ${runs.length ? html`<div class="table-wrap stack-on-mobile"><table><thead><tr><th>Started</th><th>Flow</th><th>Trigger</th><th>Status</th><th>Attempts</th><th>Outcome</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>
    ${runs.map(run => html`<tr><td data-label="Started">${fmtDateTime(run.created_at)}</td><td data-label="Flow">${run.flow_name}${run.flow_status === 'paused' && ['queued', 'retrying'].includes(run.status) ? html`<div class="muted">Held while paused</div>` : ''}</td>
      <td data-label="Trigger">${run.event_type === 'meet.booking.created' ? 'Booking' : 'Response'}</td><td data-label="Status">${badge(run.status)}</td><td data-label="Attempts">${run.attempts}</td>
      <td data-label="Outcome"><div>${run.last_error ? html`<span>${run.last_error}</span>` : run.result?.task ? html`Task created · <a href="/flow/tasks">View tasks</a>` : run.result?.email ? emailEvidence(run).text : ''}${run.status === 'retrying' ? html`<div class="muted">Next try ${fmtDateTime(run.next_attempt_at)}</div>` : ''}</div></td>
      <td class="${run.status === 'failed' && isAdmin() ? '' : 'empty-cell'}">${run.status === 'failed' && isAdmin() ? html`<button class="btn btn-small" data-retry="${run.id}">Retry<span class="visually-hidden"> ${run.flow_name}</span></button>` : ''}</td></tr>`)}</tbody></table></div>`
    : html`<div class="empty">No runs yet. Runs appear when an enabled flow's trigger happens.</div>`}`);
  const load = async () => { const runs = await api('GET', wsPath('/runs')); if (ctx.alive()) draw(runs); };
  await load();
  panel.addEventListener('click', async event => {
    if (event.target.id === 'refresh') return load();
    const id = event.target.dataset.retry;
    if (!id) return;
    try { await api('POST', wsPath(`/runs/${id}/retry`)); toast('Run queued for retry.'); setTimeout(load, 800); }
    catch (error) { toast(error.message); }
  });
}

async function tasksTab(ctx, panel) {
  const mine = ctx.query.get('assignee') === 'me';
  const [tasks, members] = await Promise.all([api('GET', wsPath('/tasks' + (mine ? '?assignee=me' : ''))), api('GET', wsPath('/members'))]);
  if (!ctx.alive()) return;
  const now = Date.now();
  const due = task => task.due_at ? html`<span class="${task.status === 'open' && task.due_at <= now ? 'attention-note' : ''}">${task.status === 'open' && task.due_at <= now ? 'Overdue' : 'Due'} ${fmtDateTime(task.due_at)}</span>` : html`<span>No deadline</span>`;
  // datetime-local works in local time without a zone suffix.
  const localValue = at => { const date = new Date(at - new Date(at).getTimezoneOffset() * 60000); return date.toISOString().slice(0, 16); };
  mount(panel, html`<nav class="row trail-filter" aria-label="Show tasks">${[['all', 'All tasks', '/flow/tasks'], ['me', 'Assigned to me', '/flow/tasks?assignee=me']].map(([key, label, href]) => html`<a class="btn btn-small ${(key === 'me') === mine ? 'btn-primary' : ''}" href="${href}" ${(key === 'me') === mine ? raw('aria-current="page"') : ''}>${label}</a>`)}</nav>
    ${tasks.length ? html`<ul class="list task-list">${tasks.map(task => html`<li><label class="check"><input type="checkbox" id="task-${task.id}" data-task="${task.id}" ${task.status === 'done' ? raw('checked') : ''}>
      <span><span class="list-title">${task.title}</span><span class="meta"><span>Created ${fmtDateTime(task.created_at)}</span>${due(task)}<span>${task.assignee_name ? `Assigned to ${task.assignee_name}` : 'Unassigned'}</span>${task.status === 'done' ? html`<span>Done</span>` : ''}</span></span></label>
      ${task.details ? html`<p class="muted">${task.details}</p>` : ''}
      ${task.status === 'open' ? html`<div class="row task-controls">
        <label for="assignee-${task.id}">Assignee<span class="visually-hidden"> for ${task.title}</span></label><select id="assignee-${task.id}" data-assignee="${task.id}"><option value="">Unassigned</option>${members.map(item => html`<option value="${item.id}" ${item.id === task.assignee_id ? raw('selected') : ''}>${item.name}</option>`)}</select>
        <label for="due-${task.id}">Deadline<span class="visually-hidden"> for ${task.title}</span></label><input id="due-${task.id}" type="datetime-local" data-due="${task.id}" value="${task.due_at ? localValue(task.due_at) : ''}">
        ${task.due_at ? html`<button class="btn btn-small" type="button" data-clear-due="${task.id}">Clear deadline<span class="visually-hidden"> for ${task.title}</span></button>` : ''}</div>` : ''}</li>`)}</ul>`
    : html`<div class="empty">${mine ? 'No tasks are assigned to you.' : 'No tasks yet. A flow with the “Create a follow-up task” action adds them here.'}</div>`}`);
  // The list is redrawn after each change; keep keyboard focus on the same control (or the deadline
  // field when "Clear deadline" disappears).
  const save = async (id, body, undo) => {
    const focused = document.activeElement?.id;
    try {
      await api('PATCH', wsPath('/tasks/' + id), body);
      await tasksTab(ctx, panel);
      (document.getElementById(focused) || document.getElementById('due-' + id))?.focus();
      toast('Task updated.');
    } catch (error) { undo?.(); toast(error.message); }
  };
  $$('[data-task]', panel).forEach(input => input.onchange = () => save(input.dataset.task, { status: input.checked ? 'done' : 'open' }, () => { input.checked = !input.checked; }));
  $$('[data-assignee]', panel).forEach(select => select.onchange = () => save(select.dataset.assignee, { assignee_id: select.value || null }));
  $$('[data-due]', panel).forEach(input => input.onchange = () => {
    const at = input.value ? new Date(input.value).getTime() : null;
    if (input.value && !Number.isFinite(at)) return toast('Choose a valid date and time.');
    save(input.dataset.due, { due_at: at });
  });
  $$('[data-clear-due]', panel).forEach(button => button.onclick = () => save(button.dataset.clearDue, { due_at: null }));
}

export async function editor(ctx) {
  if (!session.user) return mount(ctx.main, signInPrompt(ctx, { product: 'flow', title: 'Sign in to edit flows', lead: 'Flows belong to your workspace.' }));
  if (!needsSession(ctx)) return;
  const isNew = ctx.params[0] === 'new';
  setTitle((isNew ? 'New flow' : 'Edit flow') + ' · Flow by Schedora');
  mount(ctx.main, html`<div class="container page">${loading()}</div>`);
  let flow, eventTypes, forms, members;
  try {
    [flow, eventTypes, forms, members] = await Promise.all([
      isNew ? { name: '', trigger_type: 'meet.booking.created', trigger_source: null, action_type: 'task', action_config: { title: 'Prepare for {{invitee.name}} ({{booking.start_host}})', details: 'Reference {{booking.reference}}' }, status: 'draft' } : api('GET', wsPath('/flows/' + ctx.params[0])),
      api('GET', wsPath('/event-types')), api('GET', wsPath('/forms')), api('GET', wsPath('/members'))
    ]);
  } catch (error) { return mount(ctx.main, html`<div class="container page">${errorBlock(error)}<a href="/flow">Back to Flow</a></div>`); }
  if (!ctx.alive()) return;
  const state = structuredClone(flow);
  const admin = isAdmin();
  let selectedStarter = '';
  // Only the flow's own fields are copied from a starter; it always starts as an unsaved draft.
  const applyStarter = starter => {
    Object.assign(state, { name: starter.name, trigger_type: starter.trigger_type, trigger_source: null, action_type: starter.action_type, action_config: structuredClone(starter.action_config), status: 'draft' });
    selectedStarter = starter.id;
  };

  const formFields = () => {
    const form = forms.find(item => item.id === state.trigger_source);
    return form ? form.draft.fields.filter(field => field.type !== 'page_break') : [];
  };
  const placeholders = () => [...PLACEHOLDERS[state.trigger_type], ...(state.trigger_type === 'forms.response.created' ? formFields().map(field => 'answer.' + field.id) : [])];

  // One sentence that names the actual source, action and recipient, so the result is predictable
  // before saving. It describes configuration only; nothing here runs or sends.
  const summary = (recipients, to) => {
    const source = state.trigger_type === 'meet.booking.created'
      ? eventTypes.find(item => item.id === state.trigger_source)?.title : forms.find(item => item.id === state.trigger_source)?.draft.title;
    const when = state.trigger_type === 'meet.booking.created'
      ? `When an appointment is booked${source ? ` for “${source}”` : ' for any event type'}`
      : `When a response is submitted${source ? ` to “${source}”` : ' to any form'}`;
    const config = state.action_config || {};
    const who = to.startsWith('address:') ? (to.slice(8) || 'an address you have not entered yet') : { invitee: 'the invitee', host: 'the host' }[to] || (recipients.find(([value]) => value === to)?.[1].toLowerCase() ?? 'a recipient you have not chosen yet');
    const assignee = config.assign_to === 'host' ? 'the booking\'s host' : members.find(item => 'member:' + item.id === config.assign_to)?.name;
    const what = state.action_type === 'task'
      ? `create a task titled “${config.title || 'Untitled task'}” in Flow › Tasks${config.due_in_hours ? `, due ${dueLabel(config.due_in_hours)} after it is created` : ', with no deadline'}${assignee ? `, assigned to ${assignee}` : ', unassigned'}`
      : `email ${who}`;
    const status = { draft: 'It is a draft: nothing runs until you enable it.', paused: 'It is paused: new events are held and run when you resume it.', enabled: 'Once saved as enabled, new matching events run it. Earlier events are not replayed.' }[state.status];
    return html`<p class="flow-summary-sentence">${when}, ${what}.</p><p>${status}${state.action_type === 'email' ? ' ' + configuredEmailHint() : ''}</p>`;
  };

  const draw = () => {
    const sources = state.trigger_type === 'meet.booking.created' ? eventTypes.map(item => [item.id, item.title]) : forms.map(item => [item.id, item.draft.title]);
    const config = state.action_config || {};
    const recipients = state.trigger_type === 'meet.booking.created'
      ? [['invitee', 'The invitee'], ['host', 'The host']]
      : formFields().filter(field => field.type === 'email').map(field => ['field:' + field.id, `Answer to “${field.label.slice(0, 40)}”`]);
    const to = config.to || recipients[0]?.[0] || 'address:';
    mount(ctx.main, html`<div class="container page"><a href="/flow">← Back to Flow</a><h1>${isNew ? 'New flow' : state.name}</h1>
      ${isNew && admin ? html`<section class="flow-start-section" aria-labelledby="starter-heading"><h2 id="starter-heading">Start with an outcome</h2><p>Choose a starting point, then review the details. Every template starts as a draft.</p><div class="flow-starters">${FLOW_STARTERS.map(starter => html`<button type="button" class="flow-starter" data-starter="${starter.id}" aria-pressed="${selectedStarter === starter.id}"><strong>${starter.name}</strong><span>${starter.description}</span></button>`)}</div><button type="button" class="btn btn-small" id="blank-flow">Start from scratch</button></section>` : ''}
      ${admin ? '' : notice('info', html`<p>Only workspace administrators can change flows.</p>`)}
      <section id="flow-outcome" class="card card-plain flow-summary" aria-labelledby="flow-summary-heading"><h2 id="flow-summary-heading">What this flow will do</h2>${summary(recipients, to)}<p class="hint">${isNew ? 'Not saved yet. ' : document.body.dataset.dirty ? 'Unsaved changes. ' : ''}This describes the settings below; changes apply only after you save.</p></section>
      <form id="flow-form" novalidate><fieldset ${admin ? '' : raw('disabled')}>
        <label for="name">Flow name</label><input id="name" name="name" required maxlength="120" value="${state.name}" placeholder="Prepare for new appointments">
        <div class="flow-steps">
          <div class="flow-step"><h3><span class="step-number">1</span> When this happens</h3>
            <label for="trigger_type">Trigger</label><select id="trigger_type" name="trigger_type">${Object.entries(TRIGGERS).map(([key, label]) => html`<option value="${key}" ${key === state.trigger_type ? raw('selected') : ''}>${label}</option>`)}</select>
            <label for="trigger_source">${state.trigger_type === 'meet.booking.created' ? 'Event type' : 'Form'}</label>
            <select id="trigger_source" name="trigger_source"><option value="">${state.trigger_type === 'meet.booking.created' ? 'Any event type' : 'Any form'}</option>${sources.map(([id, label]) => html`<option value="${id}" ${id === state.trigger_source ? raw('selected') : ''}>${label}</option>`)}</select></div>
          <div class="flow-connector" aria-hidden="true"></div>
          <div class="flow-step"><h3><span class="step-number">2</span> Do this</h3>
            <fieldset><legend class="visually-hidden">Action</legend>${Object.entries(ACTIONS).map(([key, label]) => html`<label class="check"><input type="radio" name="action_type" value="${key}" ${key === state.action_type ? raw('checked') : ''}> ${label}</label>`)}</fieldset>
            ${state.action_type === 'email' ? html`
              <label for="to">Send to</label><select id="to" name="to">${recipients.map(([value, label]) => html`<option value="${value}" ${value === to ? raw('selected') : ''}>${label}</option>`)}<option value="address:" ${to.startsWith('address:') ? raw('selected') : ''}>A specific address</option></select>
              ${to.startsWith('address:') ? html`<label for="address">Email address</label><input id="address" name="address" type="email" value="${to.slice(8)}">` : ''}
              ${state.trigger_type === 'forms.response.created' && !recipients.length ? html`<p class="hint">To email the respondent, choose a form with an Email question.</p>` : ''}
              <label for="subject">Subject</label><input id="subject" name="subject" maxlength="200" value="${config.subject || ''}">
              <label for="body">Message</label><textarea id="body" name="body" maxlength="5000">${config.body || ''}</textarea>`
            : html`<label for="task-title">Task title</label><input id="task-title" name="title" maxlength="200" value="${config.title || ''}">
              <label for="details">Details</label><textarea id="details" name="details" maxlength="2000">${config.details || ''}</textarea>
              <label for="due_in_hours">Deadline</label><select id="due_in_hours" name="due_in_hours">${dueOptions(config.due_in_hours).map(([value, label]) => html`<option value="${value}" ${String(config.due_in_hours ?? '') === value ? raw('selected') : ''}>${label}</option>`)}</select>
              <label for="assign_to">Assign to</label><select id="assign_to" name="assign_to"><option value="none">Nobody: any member can pick it up</option>${state.trigger_type === 'meet.booking.created' ? html`<option value="host" ${config.assign_to === 'host' ? raw('selected') : ''}>The booking's host</option>` : ''}${members.map(item => html`<option value="member:${item.id}" ${config.assign_to === 'member:' + item.id ? raw('selected') : ''}>${item.name}</option>`)}</select>
              <p class="hint">Enquiries show an open task as waiting until its deadline, then as overdue. A task without a deadline always needs attention.</p>`}
            <p class="hint">Insert details with placeholders: ${placeholders().map(item => html`<code>{{${item}}}</code> `)}</p></div>
          <div class="flow-connector" aria-hidden="true"></div>
          <div class="flow-step"><h3><span class="step-number">3</span> Status</h3>
            <select id="status" name="status" aria-label="Flow status">${[['draft', 'Draft: ignore events'], ['enabled', 'Enabled: run for new events'], ['paused', 'Paused: hold new events']].map(([key, label]) => html`<option value="${key}" ${key === state.status ? raw('selected') : ''}>${label}</option>`)}</select></div>
        </div>
        <div data-form-status tabindex="-1"></div>
        <div class="actions"><button class="btn btn-primary" type="submit">${state.status === 'enabled' ? 'Save and keep enabled' : 'Save flow'}</button>
          ${isNew ? '' : html`<button class="btn" type="button" id="simulate">Simulate</button><button class="btn btn-danger" type="button" id="delete-flow">Delete</button>`}</div>
        ${isNew ? html`<p class="hint">Save the draft to simulate it with sample data. Simulation never sends an email or creates a task.</p>` : ''}
      </fieldset></form><div id="simulation" aria-live="polite"></div></div>`);

    const form = $('#flow-form');
    $$('[data-starter]').forEach(button => button.onclick = async () => {
      const starter = FLOW_STARTERS.find(item => item.id === button.dataset.starter);
      if (!starter || !admin || selectedStarter === starter.id) return;
      if (document.body.dataset.dirty && !(await ask({ title: 'Replace this unsaved draft?', body: 'The template replaces the current name, trigger and action. It will remain a draft.', confirm: 'Use template' }))) return;
      applyStarter(starter);
      document.body.dataset.dirty = '1';
      draw();
      $('#name').focus();
    });
    $('#blank-flow')?.addEventListener('click', async () => {
      if (document.body.dataset.dirty && !(await ask({ title: 'Start a blank draft?', body: 'This clears the unsaved template and its settings.', confirm: 'Start blank' }))) return;
      Object.assign(state, { name: '', trigger_type: 'meet.booking.created', trigger_source: null, action_type: 'task', action_config: { title: '', details: '' }, status: 'draft' });
      selectedStarter = '';
      document.body.dataset.dirty = '1'; draw(); $('#name').focus();
    });
    const capture = () => {
      const data = Object.fromEntries(new FormData(form));
      state.name = data.name ?? state.name;
      state.status = data.status ?? state.status;
      if (state.action_type === 'email') state.action_config = { to: data.to === 'address:' ? 'address:' + (data.address || '') : data.to, subject: data.subject ?? '', body: data.body ?? '' };
      else state.action_config = { title: data.title ?? '', details: data.details ?? '', due_in_hours: data.due_in_hours ? Number(data.due_in_hours) : null, assign_to: data.assign_to || 'none' };
    };
    form.addEventListener('change', event => {
      const name = event.target.name;
      if (!['trigger_type', 'trigger_source', 'action_type', 'to', 'status', 'due_in_hours', 'assign_to'].includes(name)) return;
      capture();
      if (name === 'trigger_type') {
        state.trigger_type = event.target.value; state.trigger_source = null;
        if (state.action_type === 'email') state.action_config.to = '';
        else if (state.action_config.assign_to === 'host' && !state.trigger_type.startsWith('meet.booking.')) state.action_config.assign_to = 'none';
      }
      if (name === 'trigger_source') state.trigger_source = event.target.value || null;
      if (name === 'action_type') { state.action_type = event.target.value; state.action_config = state.action_type === 'email' ? { to: '', subject: 'Thanks', body: '' } : { title: '', details: '' }; }
      document.body.dataset.dirty = '1';
      draw();
      $(`[name="${name}"]`)?.focus();
    });
    form.addEventListener('input', () => {
      document.body.dataset.dirty = '1';
      capture();
      mount($('#flow-outcome'), html`<h2 id="flow-summary-heading">What this flow will do</h2>${summary(recipients, state.action_config?.to || to)}<p class="hint">${isNew ? 'Not saved yet.' : 'Unsaved changes.'} This describes the settings below; changes apply only after you save.</p>`);
    });
    handleSubmit(form, async () => {
      capture();
      const body = { name: state.name, trigger_type: state.trigger_type, trigger_source: state.trigger_source, action_type: state.action_type, action_config: state.action_config, status: state.status };
      const saved = isNew ? await api('POST', wsPath('/flows'), body) : await api('PATCH', wsPath('/flows/' + flow.id), body);
      delete document.body.dataset.dirty;
      toast(saved.status === 'enabled' ? 'Flow saved and enabled.' : 'Flow saved.');
      ctx.navigate('/flow/' + saved.id, { replace: isNew });
    });
    $('#simulate')?.addEventListener('click', async () => {
      try {
        const result = await api('POST', wsPath(`/flows/${flow.id}/simulate`));
        mount($('#simulation'), html`<div class="card card-plain"><h2>Simulation</h2>${notice('info', html`<p>${result.note} It uses sample data and the last saved version of this flow.${document.body.dataset.dirty ? ' Your unsaved changes are not included.' : ''}</p>`)}
          ${result.action === 'email' ? html`<p><strong>To:</strong> ${result.to}</p><p><strong>Subject:</strong> ${result.subject}</p><pre class="preview">${result.body}</pre>` : html`<p><strong>Task:</strong> ${result.title}</p><pre class="preview">${result.details}</pre>`}</div>`);
        $('#simulation').scrollIntoView({ block: 'nearest' });
      } catch (error) { toast(error.message); }
    });
    $('#delete-flow')?.addEventListener('click', async () => {
      if (!(await ask({ title: 'Delete this flow?', body: 'Its run history is deleted too. Tasks and sent emails remain.', confirm: 'Delete flow', danger: true }))) return;
      await api('DELETE', wsPath('/flows/' + flow.id));
      delete document.body.dataset.dirty;
      ctx.navigate('/flow', { replace: true });
    });
  };
  const requested = isNew && admin && FLOW_STARTERS.find(item => item.id === ctx.query.get('starter'));
  if (requested) {
    applyStarter(requested);
  }
  draw();
}
