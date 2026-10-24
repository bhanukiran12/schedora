import { $, $$, api, ask, badge, errorBlock, fmtDateTime, handleSubmit, html, isAdmin, loading, mount, notice, raw, session, toast, workspace, wsPath } from './core.mjs';
import { needsSession, setTitle, signInPrompt } from './pages.mjs';

const TRIGGERS = { 'meet.booking.created': 'A Meet appointment is booked', 'forms.response.created': 'A Forms response is submitted' };
const ACTIONS = { email: 'Send an email', task: 'Create a follow-up task' };
const PLACEHOLDERS = {
  'meet.booking.created': ['invitee.name', 'invitee.email', 'booking.start', 'booking.start_host', 'booking.reference', 'event.title', 'event.location', 'host.name'],
  'forms.response.created': ['form.title', 'response.id']
};

export async function dashboard(ctx) {
  setTitle('Flow by Schedora');
  if (!session.user) return mount(ctx.main, signInPrompt(ctx, { product: 'flow', title: 'Give your next step a little momentum.', lead: 'When someone books a Meet appointment or submits a form, Flow sends the follow-up email or creates the task, exactly once, with a visible history and retries.' }));
  if (!needsSession(ctx)) return;
  const tab = ctx.params[0] || 'flows';
  mount(ctx.main, html`<div class="container page">
    <div class="row-between"><div><span class="tag">Flow · ${workspace().name}</span><h1>Automations</h1></div>${isAdmin() ? html`<a class="btn btn-primary" href="/flow/new">New flow</a>` : ''}</div>
    ${workspace().entitlements.flow.active ? '' : notice('warn', html`<p>This workspace has no active Flow or Suite plan, so flows cannot run. <a href="/billing">Review plans</a>.</p>`)}
    <nav class="tabs" aria-label="Flow sections">${[['flows', 'Flows', '/flow'], ['runs', 'Run history', '/flow/runs'], ['tasks', 'Tasks', '/flow/tasks']].map(([key, label, href]) => html`<a href="${href}" ${key === tab ? raw('aria-current="page"') : ''}>${label}</a>`)}</nav>
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
  if (!flows.length) return mount(panel, html`<div class="empty"><h2>No flows yet</h2><p>A flow connects one trigger to one action, for example: when an appointment is booked, create a preparation task.</p>${isAdmin() ? html`<a class="btn btn-primary" href="/flow/new">New flow</a>` : html`<p>Ask a workspace administrator to create one.</p>`}</div>`);
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
  const draw = runs => mount(panel, html`<div class="row-between"><p class="muted">Each event runs a flow once. Retries reuse the same run, so emails and tasks are never duplicated.</p><button class="btn btn-small" id="refresh">Refresh</button></div>
    ${runs.length ? html`<div class="table-wrap"><table><thead><tr><th>Started</th><th>Flow</th><th>Trigger</th><th>Status</th><th>Attempts</th><th>Details</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>
    ${runs.map(run => html`<tr><td>${fmtDateTime(run.created_at)}</td><td>${run.flow_name}${run.flow_status === 'paused' && ['queued', 'retrying'].includes(run.status) ? html`<div class="muted">Held while paused</div>` : ''}</td>
      <td>${run.event_type === 'meet.booking.created' ? 'Booking' : 'Response'}</td><td>${badge(run.status)}</td><td>${run.attempts}</td>
      <td>${run.last_error ? html`<span>${run.last_error}</span>` : run.result?.task ? 'Task created' : run.result?.email ? 'Email sent' : ''}${run.status === 'retrying' ? html`<div class="muted">Next try ${fmtDateTime(run.next_attempt_at)}</div>` : ''}</td>
      <td>${run.status === 'failed' && isAdmin() ? html`<button class="btn btn-small" data-retry="${run.id}">Retry</button>` : ''}</td></tr>`)}</tbody></table></div>`
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
  const tasks = await api('GET', wsPath('/tasks'));
  if (!ctx.alive()) return;
  mount(panel, tasks.length ? html`<ul class="list">${tasks.map(task => html`<li><label class="check"><input type="checkbox" data-task="${task.id}" ${task.status === 'done' ? raw('checked') : ''}>
      <span><span class="list-title">${task.title}</span><span class="meta"><span>${fmtDateTime(task.created_at)}</span>${task.status === 'done' ? html`<span>Done</span>` : ''}</span></span></label>
      ${task.details ? html`<p class="muted">${task.details}</p>` : ''}</li>`)}</ul>`
    : html`<div class="empty">No tasks yet. A flow with the “Create a follow-up task” action adds them here.</div>`);
  $$('[data-task]', panel).forEach(input => input.onchange = async () => {
    try { await api('PATCH', wsPath('/tasks/' + input.dataset.task), { status: input.checked ? 'done' : 'open' }); }
    catch (error) { input.checked = !input.checked; toast(error.message); }
  });
}

export async function editor(ctx) {
  if (!session.user) return mount(ctx.main, signInPrompt(ctx, { product: 'flow', title: 'Sign in to edit flows', lead: 'Flows belong to your workspace.' }));
  if (!needsSession(ctx)) return;
  const isNew = ctx.params[0] === 'new';
  setTitle((isNew ? 'New flow' : 'Edit flow') + ' · Flow by Schedora');
  mount(ctx.main, html`<div class="container page">${loading()}</div>`);
  let flow, eventTypes, forms;
  try {
    [flow, eventTypes, forms] = await Promise.all([
      isNew ? { name: '', trigger_type: 'meet.booking.created', trigger_source: null, action_type: 'task', action_config: { title: 'Prepare for {{invitee.name}} ({{booking.start_host}})', details: 'Reference {{booking.reference}}' }, status: 'draft' } : api('GET', wsPath('/flows/' + ctx.params[0])),
      api('GET', wsPath('/event-types')), api('GET', wsPath('/forms'))
    ]);
  } catch (error) { return mount(ctx.main, html`<div class="container page">${errorBlock(error)}<a href="/flow">Back to Flow</a></div>`); }
  if (!ctx.alive()) return;
  const state = structuredClone(flow);
  const admin = isAdmin();

  const formFields = () => {
    const form = forms.find(item => item.id === state.trigger_source);
    return form ? form.draft.fields.filter(field => field.type !== 'page_break') : [];
  };
  const placeholders = () => [...PLACEHOLDERS[state.trigger_type], ...(state.trigger_type === 'forms.response.created' ? formFields().map(field => 'answer.' + field.id) : [])];

  const draw = () => {
    const sources = state.trigger_type === 'meet.booking.created' ? eventTypes.map(item => [item.id, item.title]) : forms.map(item => [item.id, item.draft.title]);
    const config = state.action_config || {};
    const recipients = state.trigger_type === 'meet.booking.created'
      ? [['invitee', 'The invitee'], ['host', 'The host']]
      : formFields().filter(field => field.type === 'email').map(field => ['field:' + field.id, `Answer to “${field.label.slice(0, 40)}”`]);
    const to = config.to || recipients[0]?.[0] || 'address:';
    mount(ctx.main, html`<div class="container page"><a href="/flow">← Back to Flow</a><h1>${isNew ? 'New flow' : state.name}</h1>
      ${admin ? '' : notice('info', html`<p>Only workspace administrators can change flows.</p>`)}
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
              <label for="details">Details</label><textarea id="details" name="details" maxlength="2000">${config.details || ''}</textarea>`}
            <p class="hint">Insert details with placeholders: ${placeholders().map(item => html`<code>{{${item}}}</code> `)}</p></div>
          <div class="flow-connector" aria-hidden="true"></div>
          <div class="flow-step"><h3><span class="step-number">3</span> Status</h3>
            <select id="status" name="status" aria-label="Flow status">${[['draft', 'Draft: ignore events'], ['enabled', 'Enabled: run for new events'], ['paused', 'Paused: hold new events']].map(([key, label]) => html`<option value="${key}" ${key === state.status ? raw('selected') : ''}>${label}</option>`)}</select></div>
        </div>
        <div data-form-status tabindex="-1"></div>
        <div class="actions"><button class="btn btn-primary" type="submit">${state.status === 'enabled' ? 'Save and keep enabled' : 'Save flow'}</button>
          ${isNew ? '' : html`<button class="btn" type="button" id="simulate">Simulate</button><button class="btn btn-danger" type="button" id="delete-flow">Delete</button>`}</div>
      </fieldset></form><div id="simulation" aria-live="polite"></div></div>`);

    const form = $('#flow-form');
    const capture = () => {
      const data = Object.fromEntries(new FormData(form));
      state.name = data.name ?? state.name;
      state.status = data.status ?? state.status;
      if (state.action_type === 'email') state.action_config = { to: data.to === 'address:' ? 'address:' + (data.address || '') : data.to, subject: data.subject ?? '', body: data.body ?? '' };
      else state.action_config = { title: data.title ?? '', details: data.details ?? '' };
    };
    form.addEventListener('change', event => {
      const name = event.target.name;
      if (!['trigger_type', 'trigger_source', 'action_type', 'to'].includes(name)) return;
      capture();
      if (name === 'trigger_type') { state.trigger_type = event.target.value; state.trigger_source = null; if (state.action_type === 'email') state.action_config.to = ''; }
      if (name === 'trigger_source') state.trigger_source = event.target.value || null;
      if (name === 'action_type') { state.action_type = event.target.value; state.action_config = state.action_type === 'email' ? { to: '', subject: 'Thanks', body: '' } : { title: '', details: '' }; }
      document.body.dataset.dirty = '1';
      draw();
      form.isConnected && $(`[name="${name}"]`)?.focus();
    });
    form.addEventListener('input', () => { document.body.dataset.dirty = '1'; });
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
        mount($('#simulation'), html`<div class="card card-plain"><h2>Simulation</h2>${notice('info', html`<p>${result.note} It uses sample data and the last saved version of this flow.</p>`)}
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
  draw();
}
