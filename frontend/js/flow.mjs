import { $, $$, api, ask, badge, boot, errorBlock, fmtDateTime, handleSubmit, html, isAdmin, loading, mount, notice, raw, session, toast, workspace, wsPath } from './core.mjs';
import { needsSession, setTitle, signInPrompt } from './pages.mjs';
import { FLOW_STARTERS } from './flow-starters.mjs';

const TRIGGERS = { 'meet.booking.created': 'A Meet appointment is booked', 'forms.response.created': 'A Forms response is submitted' };
const ACTIONS = { email: 'Send an email', task: 'Create a follow-up task' };
const emailOutcome = () => boot.providers.email === 'outbox'
  ? 'Recorded in the local outbox. It is not delivered to an inbox.'
  : 'Accepted by the email provider. Inbox delivery is not tracked here.';
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
  if (!flows.length) return mount(panel, html`<div class="empty flow-empty"><h2>No flows yet</h2><p>A flow connects one trigger to one action: when an appointment is booked or a form is submitted, send an email or create a task.</p>
    ${isAdmin() ? html`<p class="flow-empty-lead">Start from an outcome. Each opens as an unsaved draft you can edit; nothing runs until you enable it.</p>
      <ul class="flow-starter-links">${FLOW_STARTERS.map(starter => html`<li><a href="/flow/new?starter=${starter.id}"><strong>${starter.name}</strong><span>${starter.description}</span></a></li>`)}</ul>
      <a class="btn" href="/flow/new">Start from scratch</a>` : html`<p>Ask a workspace administrator to create one.</p>`}</div>`);
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
  const draw = runs => mount(panel, html`<div class="row-between"><p class="muted">A run succeeds when its task is created or its email is handed over. ${boot.providers.email === 'outbox' ? 'Email goes to the local outbox on this server and is not delivered.' : 'For email, that means the provider accepted it; inbox delivery is not tracked.'} Retrying reuses the same run, so a created task or accepted email is not repeated.</p><button class="btn btn-small" id="refresh">Refresh</button></div>
    ${runs.length ? html`<div class="table-wrap stack-on-mobile"><table><thead><tr><th>Started</th><th>Flow</th><th>Trigger</th><th>Status</th><th>Attempts</th><th>Outcome</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>
    ${runs.map(run => html`<tr><td data-label="Started">${fmtDateTime(run.created_at)}</td><td data-label="Flow">${run.flow_name}${run.flow_status === 'paused' && ['queued', 'retrying'].includes(run.status) ? html`<div class="muted">Held while paused</div>` : ''}</td>
      <td data-label="Trigger">${run.event_type === 'meet.booking.created' ? 'Booking' : 'Response'}</td><td data-label="Status">${badge(run.status)}</td><td data-label="Attempts">${run.attempts}</td>
      <td data-label="Outcome">${run.last_error ? html`<span>${run.last_error}</span>` : run.result?.task ? html`Task created · <a href="/flow/tasks">View tasks</a>` : run.result?.email ? emailOutcome() : ''}${run.status === 'retrying' ? html`<div class="muted">Next try ${fmtDateTime(run.next_attempt_at)}</div>` : ''}</td>
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
    const what = state.action_type === 'task' ? `create a task titled “${config.title || 'Untitled task'}” in Flow › Tasks` : `email ${who}`;
    const status = { draft: 'It is a draft: nothing runs until you enable it.', paused: 'It is paused: new events are held and run when you resume it.', enabled: 'Once saved as enabled, new matching events run it. Earlier events are not replayed.' }[state.status];
    return html`<p class="flow-summary-sentence">${when}, ${what}.</p><p>${status}${state.action_type === 'email' ? ' ' + emailOutcome() : ''}</p>`;
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
              <label for="details">Details</label><textarea id="details" name="details" maxlength="2000">${config.details || ''}</textarea>`}
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
      else state.action_config = { title: data.title ?? '', details: data.details ?? '' };
    };
    form.addEventListener('change', event => {
      const name = event.target.name;
      if (!['trigger_type', 'trigger_source', 'action_type', 'to', 'status'].includes(name)) return;
      capture();
      if (name === 'trigger_type') { state.trigger_type = event.target.value; state.trigger_source = null; if (state.action_type === 'email') state.action_config.to = ''; }
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
