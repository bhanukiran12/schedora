import { $, $$, api, ask, boot, canonicalZone, html, loading, mount, notice, raw, session, toast, workspace, wsPath, isAdmin } from './core.mjs';
import { needsSession, setTitle, signInPrompt } from './pages.mjs';
import { ACTIONS, describeFlow, FLOW_LIMITS, flowProblems, OPS, stepTitle, TRIGGERS, WAIT_EVENTS } from '../shared/flow-logic.mjs';

// Flow v1 builder (docs/FLOW_V1_IMPLEMENTATION.md, "Builder"): a vertical list of plain-language steps.
// Text fields show fields as [Field name] chips; they are stored as references, so nobody types tokens or
// JSON. Saving is explicit; publishing snapshots a version; turning on is separate.

const STATE = { draft: ['neutral', 'Draft'], on: ['ok', 'On'], paused: ['warn', 'Paused'], off: ['neutral', 'Off'] };
const KIND = { condition: 'Only if', branch: 'Choose a path', wait: 'Wait', wait_for: 'Wait until', approval: 'Ask for approval', stop: 'Stop', action: 'Then' };
const JOB_TRIGGERS = { meet: 'Meetings', forms: 'Forms and payments', sheets: 'Sheets', other: 'Other' };
const uid = prefix => prefix + Math.random().toString(36).slice(2, 8);
const clone = value => structuredClone(value);
const pill = ([kind, label]) => html`<span class="badge badge-${kind}">${label}</span>`;

// ---- Field chips: {{key}} in storage, [Label] while editing -----------------------------------------------
function chips(fields) {
  const byKey = new Map(fields.map(field => [field.key, field.label]));
  const byLabel = new Map(fields.map(field => [field.label.toLowerCase(), field.key]));
  return {
    show: text => String(text ?? '').replace(/\{\{\s*([a-z][a-z0-9_.-]{0,80})\s*\}\}/g, (_, key) => `[${byKey.get(key) || key}]`),
    store: text => String(text ?? '').replace(/\[([^\[\]]{1,120})\]/g, (whole, label) => byLabel.has(label.toLowerCase()) ? `{{${byLabel.get(label.toLowerCase())}}}` : /^[a-z][a-z0-9_.-]{0,80}$/.test(label) ? `{{${label}}}` : whole)
  };
}

function newStep(type, action) {
  const id = uid('s');
  if (type === 'condition') return { id, type, match: 'all', rules: [{ field: 'lead.band', op: 'equals', value: 'Hot' }] };
  if (type === 'branch') return { id, type, paths: [{ id: uid('p'), label: 'Path A', match: 'all', rules: [{ field: 'lead.band', op: 'equals', value: 'Hot' }], steps: [] }, { id: uid('p'), label: 'Otherwise', rules: [], steps: [] }] };
  if (type === 'wait') return { id, type, mode: 'duration', minutes: 1440 };
  if (type === 'wait_for') return { id, type, event: 'meet.booking.created', timeout_minutes: 1440 };
  if (type === 'approval') return { id, type, approver: 'admins', expires_hours: 48, title: 'Check before sending' };
  if (type === 'stop') return { id, type, reason: 'Nothing else to do' };
  const configs = {
    send_email: { to: 'contact', subject: '', body: '' }, create_task: { title: '', details: '', assign_to: 'none', due_in_hours: 24 }, send_whatsapp: { to: 'contact', template: '', variables: [] },
    send_sms: { to: 'contact', body: '' }, sheet_row: { workbook: '', sheet: '', mode: 'update', match_column: 'Email', match_value: '{{contact.email}}', values: {} }, update_contact: { add_tags: [] },
    send_booking_link: { to: 'contact', event_type: '', subject: 'Choose a time', body: '' }, send_form: { to: 'contact', form: '', prefill: {}, subject: '', body: '' }, assign_owner: { mode: 'round_robin', members: [] },
    add_note: { body: '' }, slack: { text: '' }, webhook: { url: 'https://', include: 'record' }, ai_draft: { instruction: '' }, ai_summarize: { instruction: '' }, ai_classify: { labels: ['Sales', 'Support'], instruction: '' }
  };
  return { id, type: 'action', action, config: clone(configs[action]) };
}

// Finds a list (the top level or a path's steps) and the index of a step id within it.
function locate(steps, id) {
  for (let index = 0; index < steps.length; index++) {
    if (steps[index].id === id) return { list: steps, index };
    if (steps[index].type === 'branch') for (const path of steps[index].paths) { const found = locate(path.steps, id); if (found) return found; }
  }
  return null;
}
const findPath = (steps, pathId) => { for (const step of steps) if (step.type === 'branch') { const path = step.paths.find(item => item.id === pathId); if (path) return path; } return null; };

export async function builder(ctx) {
  setTitle('Workflow · Flow by Schedora');
  if (!session.user) return mount(ctx.main, signInPrompt(ctx, { product: 'flow', title: 'Sign in to build workflows', lead: 'Workflows belong to your workspace.' }));
  if (!needsSession(ctx)) return;
  mount(ctx.main, html`<div class="container page">${loading()}</div>`);
  const id = ctx.params[0];
  let flow;
  let refs;
  try {
    [flow, refs] = await Promise.all([api('GET', wsPath(`/flow/workflows/${id}`)), loadRefs()]);
  } catch (error) { return mount(ctx.main, html`<div class="container page">${notice('bad', html`<p>${error.message}</p>`)}<a class="btn" href="/flow?tab=flows">Back to workflows</a></div>`); }
  if (!ctx.alive()) return;
  const canEdit = isAdmin();
  let draft = clone(flow.definition);
  let name = flow.name;
  let autoPause = flow.auto_pause;
  let dirty = false;
  let open = new Set();
  let fields = [];
  let records = [];
  let chip = chips([]);
  let checked = null;

  const loadFields = async () => {
    try { const result = await api('GET', wsPath(`/flow/workflows/${id}/fields`)); fields = result.fields; records = result.records; }
    catch { fields = []; records = []; }
    chip = chips(fields);
  };
  await loadFields();
  const labels = () => Object.fromEntries(fields.map(field => [field.key, field.label]));
  const setDirty = value => { dirty = value; if (value) document.body.dataset.dirty = '1'; else delete document.body.dataset.dirty; };

  mount(ctx.main, html`<div class="container page flow-builder" id="flow-builder">
    <a href="/flow?tab=flows">← Workflows</a>
    <div class="flow-builder-head">
      <div class="flow-builder-title"><label for="flow-name" class="visually-hidden">Workflow name</label><input id="flow-name" maxlength="120" value="${name}" ${canEdit ? '' : raw('readonly')}><span id="flow-state"></span></div>
      <div class="row flow-builder-actions">${canEdit ? html`<button class="btn" type="button" id="flow-save">Save draft</button><button class="btn" type="button" id="flow-publish">Publish</button><span id="flow-switch"></span>` : html`<p class="hint">Only workspace admins can change workflows.</p>`}</div>
    </div>
    <p class="flow-sentence" id="flow-sentence" aria-live="polite"></p>
    <div id="flow-problems"></div>
    <ol class="flow-steps" id="flow-steps" aria-label="Workflow steps"></ol>
    <section class="card card-plain flow-test" aria-labelledby="flow-test-heading"><h2 id="flow-test-heading">Test before turning on</h2>
      <p class="hint">“Test with a recent record” runs every rule against real data and shows what each step would do. Nothing is sent, written or counted toward usage.</p>
      <div class="row"><label for="flow-record" class="visually-hidden">Record to test with</label><select id="flow-record"></select><button class="btn" type="button" id="flow-test">Test with this record</button></div>
      <div id="flow-test-result" aria-live="polite"></div></section>
    ${canEdit ? html`<section class="card card-plain"><h2>When runs fail</h2><label class="check"><input type="checkbox" id="flow-auto-pause" ${autoPause ? raw('checked') : ''}> Pause this workflow automatically after 3 failures in a row</label><p class="hint">You always get one email after 3 failures in a row. Saved with the draft.</p>
      ${flow.trigger_type === 'webhook.incoming' || draft.trigger?.type === 'webhook.incoming' ? html`<h2>Webhook address</h2><p class="hint">Other apps start this workflow by posting signed JSON to a private address. Creating a new address replaces the old one.</p><button class="btn btn-small" type="button" id="flow-webhook">Create webhook address</button><div id="flow-webhook-result"></div>` : ''}</section>` : ''}
  </div>`);

  // ---- Rendering ---------------------------------------------------------------------------------------
  const sourceOptions = type => {
    const source = TRIGGERS[type]?.source;
    if (source === 'form') return [['', 'Any form'], ...refs.forms.map(form => [form.id, form.draft?.title || form.title || 'Untitled form'])];
    if (source === 'event_type') return [['', 'Any event type'], ...refs.events.map(event => [event.id, event.title])];
    if (source === 'workbook') return [['', 'Choose a workbook'], ...refs.workbooks.map(book => [book.id, book.title])];
    return [];
  };
  const select = (attrs, options, value) => html`<select ${raw(attrs)}>${options.map(([optionValue, label]) => html`<option value="${optionValue}" ${String(optionValue) === String(value ?? '') ? raw('selected') : ''}>${label}</option>`)}</select>`;
  const fieldOptions = () => fields.map(field => [field.key, field.label + (field.sample ? ` (e.g. ${field.sample})` : '')]);
  const people = (allowNone = true, extra = []) => [...(allowNone ? [['none', 'Nobody yet']] : []), ...extra, ...refs.members.map(person => ['member:' + person.user_id, person.name])];
  const recipients = subject => [['contact', 'The contact (from this record)'], ...(subject === 'booking' ? [['host', 'The host']] : []), ['owner', 'The contact’s owner'], ...refs.members.map(person => ['member:' + person.user_id, person.name])];
  const textField = (stepId, key, label, value, { multiline = false, max = 5000, hint = '' } = {}) => html`<div class="flow-text"><label for="t-${stepId}-${key}">${label}</label>
    ${multiline ? html`<textarea id="t-${stepId}-${key}" data-text="${key}" rows="4" maxlength="${max}">${chip.show(value)}</textarea>` : html`<input id="t-${stepId}-${key}" data-text="${key}" maxlength="${max}" value="${chip.show(value)}">`}
    <div class="flow-insert"><label for="i-${stepId}-${key}" class="visually-hidden">Insert a field into ${label}</label>${select(`id="i-${stepId}-${key}" data-insert="t-${stepId}-${key}"`, [['', 'Insert a field…'], ...fields.map(field => [field.label, field.label + (field.sample ? ` · ${field.sample}` : '')])], '')}</div>${hint ? html`<p class="hint">${hint}</p>` : ''}</div>`;
  const rulesEditor = (owner, rules, match) => html`<fieldset class="flow-rules"><legend class="visually-hidden">Rules</legend>
    ${rules.length > 1 ? html`<label for="m-${owner}">Match</label>${select(`id="m-${owner}" data-match="${owner}"`, [['all', 'All of these'], ['any', 'Any of these']], match)}` : ''}
    ${rules.map((rule, index) => html`<div class="flow-rule" data-rule="${owner}:${index}">
      <label for="rf-${owner}-${index}" class="visually-hidden">Field</label>${select(`id="rf-${owner}-${index}" data-rule-field`, fieldOptions().some(([key]) => key === rule.field) ? fieldOptions() : [[rule.field, rule.field], ...fieldOptions()], rule.field)}
      <label for="ro-${owner}-${index}" class="visually-hidden">Comparison</label>${select(`id="ro-${owner}-${index}" data-rule-op`, Object.entries(OPS), rule.op)}
      ${['is_empty', 'is_not_empty'].includes(rule.op) ? '' : html`<label for="rv-${owner}-${index}" class="visually-hidden">Value</label><input id="rv-${owner}-${index}" data-rule-value maxlength="300" value="${rule.value || ''}">`}
      <button class="btn btn-link btn-small" type="button" data-remove-rule="${owner}:${index}">Remove<span class="visually-hidden"> rule ${index + 1}</span></button></div>`)}
    <button class="btn btn-small" type="button" data-add-rule="${owner}">Add a rule</button></fieldset>`;

  const subject = () => TRIGGERS[draft.trigger?.type]?.subject;
  function stepEditor(step) {
    const c = step.config || {};
    switch (step.type) {
      case 'condition': return html`<p class="hint">If the rules do not match, the run stops here and shows as Skipped with the reason.</p>${rulesEditor(step.id, step.rules, step.match)}`;
      case 'branch': return html`<p class="hint">The first path whose rules match runs. The last path can be “Otherwise”. Up to ${FLOW_LIMITS.paths} paths.</p>
        ${step.paths.map((path, index) => html`<fieldset class="flow-path-edit"><legend>Path ${index + 1}</legend><label for="pl-${path.id}">Name</label><input id="pl-${path.id}" data-path-label="${path.id}" maxlength="60" value="${path.label}">
          ${path.rules.length ? rulesEditor(path.id, path.rules, path.match) : html`<p class="hint">Otherwise: runs when no earlier path matches.</p>`}
          ${index === step.paths.length - 1 && path.rules.length === 0 ? '' : html`<button class="btn btn-link btn-small" type="button" data-toggle-otherwise="${path.id}">${path.rules.length ? 'Make this “Otherwise”' : 'Add rules'}</button>`}
          ${step.paths.length > 2 ? html`<button class="btn btn-link btn-small" type="button" data-remove-path="${step.id}:${path.id}">Remove path</button>` : ''}</fieldset>`)}
        ${step.paths.length < FLOW_LIMITS.paths ? html`<button class="btn btn-small" type="button" data-add-path="${step.id}">Add a path</button>` : ''}`;
      case 'wait': return html`<label for="w-${step.id}">Wait for</label><div class="row">${waitInput(step.id, step.minutes)}</div><p class="hint">The run waits on the server; restarts do not lose it.</p>`;
      case 'wait_for': return html`<label for="we-${step.id}">Wait until</label>${select(`id="we-${step.id}" data-key="event"`, Object.entries(WAIT_EVENTS), step.event)}
        ${step.event === 'forms.response.created' ? html`<label for="ws-${step.id}">Which form</label>${select(`id="ws-${step.id}" data-key="source"`, [['', 'Any form'], ...refs.forms.map(form => [form.id, form.draft?.title || 'Untitled form'])], step.source || '')}` : ''}
        <label for="w-${step.id}">For at most</label><div class="row">${waitInput(step.id, step.timeout_minutes, 'timeout_minutes')}</div>
        <p class="hint">Matched to this same person by their email, never to anyone else. Later steps can check whether it happened${step.event === 'forms.response.created' ? ' and use their answers' : ''}.</p>`;
      case 'approval': return html`<label for="ap-${step.id}">Who approves</label>${select(`id="ap-${step.id}" data-key="approver"`, [['admins', 'A workspace admin'], ...(subject() === 'booking' ? [['host', 'The host']] : []), ['owner', 'The contact’s owner'], ...refs.members.map(person => ['member:' + person.user_id, person.name])], step.approver)}
        <label for="at-${step.id}">What is being approved</label><input id="at-${step.id}" data-key="title" maxlength="200" value="${step.title}">
        <label for="ae-${step.id}">Expires after (hours)</label><input id="ae-${step.id}" data-key="expires_hours" data-number type="number" min="1" max="${FLOW_LIMITS.approvalHours}" value="${step.expires_hours}">
        <p class="hint">The approver can edit an AI draft before approving. Rejected runs show as Skipped; expired ones as Canceled.</p>`;
      case 'stop': return html`<label for="sr-${step.id}">Reason shown in run history</label><input id="sr-${step.id}" data-key="reason" maxlength="200" value="${step.reason || ''}">`;
    }
    const to = html`<label for="to-${step.id}">Send to</label>${select(`id="to-${step.id}" data-config="to"`, recipients(subject()), c.to)}`;
    switch (step.action) {
      case 'send_email': return html`${to}${textField(step.id, 'subject', 'Subject', c.subject, { max: 200 })}${textField(step.id, 'body', 'Message', c.body, { multiline: true })}${providerNote('email')}`;
      case 'send_booking_link': return html`${to}<label for="ev-${step.id}">Booking page</label>${select(`id="ev-${step.id}" data-config="event_type"`, [['', 'Choose a booking page'], ...refs.events.filter(event => event.published).map(event => [event.id, event.title])], c.event_type)}${textField(step.id, 'subject', 'Subject', c.subject, { max: 200 })}${textField(step.id, 'body', 'Message above the link', c.body, { multiline: true })}<p class="hint">The link fills in their name and email.</p>`;
      case 'send_form': return html`${to}<label for="fm-${step.id}">Form</label>${select(`id="fm-${step.id}" data-config="form"`, [['', 'Choose a published form'], ...refs.forms.filter(form => form.published_version).map(form => [form.id, form.draft?.title || 'Untitled form'])], c.form)}${textField(step.id, 'subject', 'Subject', c.subject, { max: 200 })}${textField(step.id, 'body', 'Message above the link', c.body, { multiline: true })}`;
      case 'create_task': return html`${textField(step.id, 'title', 'Task', c.title, { max: 200 })}${textField(step.id, 'details', 'Details', c.details, { multiline: true, max: 2000 })}
        <label for="as-${step.id}">Assign to</label>${select(`id="as-${step.id}" data-config="assign_to"`, people(true, [...(subject() === 'booking' ? [['host', 'The host']] : []), ['owner', 'The contact’s owner']]), c.assign_to || 'none')}
        <label for="du-${step.id}">Due within (hours, optional)</label><input id="du-${step.id}" data-config="due_in_hours" data-number type="number" min="1" max="720" value="${c.due_in_hours ?? ''}">`;
      case 'send_sms': return html`${to}${textField(step.id, 'body', 'Message (up to 600 characters)', c.body, { multiline: true, max: 600 })}${providerNote('sms')}`;
      case 'send_whatsapp': {
        const templates = refs.integrations.whatsapp?.templates || [];
        const template = templates.find(item => item.name === c.template);
        return html`${to}<label for="wt-${step.id}">Approved template</label>${select(`id="wt-${step.id}" data-config="template"`, [['', templates.length ? 'Choose a template' : 'No approved templates on this server'], ...templates.map(item => [item.name, item.name])], c.template)}
          ${(template?.variables || []).map((label, index) => textField(step.id, 'var' + index, label, c.variables?.[index] || '', { max: 500 }))}
          <p class="hint">Sent only to people who agreed to WhatsApp messages; others are skipped with the reason.</p>${providerNote('whatsapp')}`;
      }
      case 'sheet_row': {
        const book = refs.workbooks.find(item => item.id === c.workbook);
        return html`<label for="wb-${step.id}">Workbook</label>${select(`id="wb-${step.id}" data-config="workbook"`, [['', 'Choose an editable workbook'], ...refs.workbooks.map(item => [item.id, item.title])], c.workbook)}
          <label for="sh-${step.id}">Sheet</label>${select(`id="sh-${step.id}" data-config="sheet"`, [['', 'Choose a sheet'], ...(book?.sheets || []).map(sheet => [sheet.id, sheet.name])], c.sheet)}
          <label for="mo-${step.id}">Do</label>${select(`id="mo-${step.id}" data-config="mode"`, [['update', 'Update the matching row'], ['upsert', 'Update the matching row, or add one'], ['add', 'Always add a new row']], c.mode)}
          ${c.mode !== 'add' ? html`<label for="mc-${step.id}">Find the row where column</label><input id="mc-${step.id}" data-config="match_column" maxlength="100" value="${c.match_column || ''}">${textField(step.id, 'match_value', 'equals', c.match_value, { max: 500 })}` : ''}
          <fieldset><legend class="label">Columns to fill in (row 1 names)</legend>${Object.entries(c.values || {}).map(([header, value], index) => html`<div class="flow-rule"><label for="vh-${step.id}-${index}" class="visually-hidden">Column</label><input id="vh-${step.id}-${index}" data-value-header="${index}" maxlength="100" value="${header}"><label for="vv-${step.id}-${index}" class="visually-hidden">Value</label><input id="vv-${step.id}-${index}" data-value-text="${index}" maxlength="2000" value="${chip.show(value)}"><button class="btn btn-link btn-small" type="button" data-remove-value="${index}">Remove</button></div>`)}
          <button class="btn btn-small" type="button" data-add-value>Add a column</button></fieldset><p class="hint">Linked Form Responses and booking tabs are read-only and cannot be chosen. Changes made here never start sheet workflows.</p>`;
      }
      case 'update_contact': return html`<label for="tg-${step.id}">Add tags (comma separated)</label><input id="tg-${step.id}" data-config="add_tags" data-list maxlength="300" value="${(c.add_tags || []).join(', ')}">${textField(step.id, 'company', 'Company (optional)', c.company || '', { max: 150 })}`;
      case 'assign_owner': return html`<label for="am-${step.id}">How</label>${select(`id="am-${step.id}" data-config="mode"`, [['round_robin', 'In turn among these people'], ['member', 'Always this person']], c.mode)}
        ${c.mode === 'member' ? html`<label for="ao-${step.id}">Person</label>${select(`id="ao-${step.id}" data-config="member"`, people(false), c.member ? 'member:' + c.member : '')}`
          : html`<fieldset><legend class="label">People who take turns</legend>${refs.members.map(person => html`<label class="check"><input type="checkbox" data-member="${person.user_id}" ${(c.members || []).includes(person.user_id) ? raw('checked') : ''}> ${person.name}</label>`)}</fieldset>`}
        <p class="hint">The person assigned least gets the next contact; people who leave the workspace are skipped.</p>`;
      case 'add_note': return textField(step.id, 'body', 'Note', c.body, { multiline: true, max: 2000 });
      case 'slack': return html`${textField(step.id, 'text', 'Message', c.text, { multiline: true, max: 3000 })}${providerNote('slack')}`;
      case 'webhook': return html`<label for="wu-${step.id}">Address (https)</label><input id="wu-${step.id}" data-config="url" type="url" maxlength="500" value="${c.url}"><label for="wi-${step.id}">Send</label>${select(`id="wi-${step.id}" data-config="include"`, [['record', 'The record’s fields'], ['minimal', 'Only the run and step ids']], c.include || 'record')}<p class="hint">Signed with your workspace’s Flow signing key, with an Idempotency-Key header. Private addresses are refused. If the other app does not answer, the run asks you before sending again.</p>`;
      case 'ai_draft': case 'ai_summarize': return html`${textField(step.id, 'instruction', 'What should the AI write?', c.instruction, { multiline: true, max: 1000 })}<p class="hint">The AI reads this record as data only. Its text must go through an approval step before any message uses it.</p>`;
      case 'ai_classify': return html`<label for="cl-${step.id}">Categories (comma separated, 2–8)</label><input id="cl-${step.id}" data-config="labels" data-list maxlength="400" value="${(c.labels || []).join(', ')}">${textField(step.id, 'instruction', 'How to choose (optional)', c.instruction, { multiline: true, max: 1000 })}`;
      default: return '';
    }
  }
  const waitInput = (stepId, minutes, key = 'minutes') => {
    const [amount, unit] = minutes % 1440 === 0 ? [minutes / 1440, 1440] : minutes % 60 === 0 ? [minutes / 60, 60] : [minutes, 1];
    return html`<input id="w-${stepId}" data-wait-amount="${key}" type="number" min="1" max="1440" value="${amount}" aria-label="Amount"><label for="wu-${stepId}-${key}" class="visually-hidden">Unit</label>${select(`id="wu-${stepId}-${key}" data-wait-unit="${key}"`, [[1, 'minutes'], [60, 'hours'], [1440, 'days']], unit)}`;
  };
  const providerNote = provider => {
    const state = refs.integrations[provider];
    if (!state) return '';
    const text = { not_configured: `${state.label} is not configured on this server. You can test this step, but the workflow cannot be turned on with it.`, connected: `${state.label} is connected but not tested. Use “Send test to me” once before turning the workflow on.`, local: state.note, tested: `${state.label} is connected and tested.` }[state.state];
    return text ? html`<p class="hint" data-provider-state="${state.state}">${text}</p>` : '';
  };

  const addMenu = target => html`<div class="flow-add"><label for="add-${target}" class="visually-hidden">Add a step</label>${select(`id="add-${target}" data-add="${target}"`, [['', '+ Add a step…'],
    ['action:send_email', 'Then: send an email'], ['action:send_booking_link', 'Then: send a booking link'], ['action:send_form', 'Then: send a prefilled form'], ['action:create_task', 'Then: create a task'],
    ['action:send_whatsapp', 'Then: send a WhatsApp template'], ['action:send_sms', 'Then: send an SMS'], ['action:assign_owner', 'Then: assign an owner'], ['action:update_contact', 'Then: update the contact'], ['action:add_note', 'Then: add a note'],
    ['action:sheet_row', 'Then: add or update a sheet row'], ['action:slack', 'Then: post to Slack'], ['action:webhook', 'Then: send a webhook'], ['action:ai_draft', 'AI: draft a message'], ['action:ai_summarize', 'AI: summarize'], ['action:ai_classify', 'AI: choose a category'],
    ['condition', 'Only if…'], ...(target === 'root' ? [['branch', 'Choose a path (up to 3)']] : []), ['wait', 'Wait'], ['wait_for', 'Wait until something happens'], ['approval', 'Ask for approval'], ['stop', 'Stop']], '')}</div>`;

  function stepItem(step, index, list) {
    const editing = open.has(step.id);
    // Field references read as [Field name] everywhere, including labels for screen readers.
    const title = chip.show(stepTitle(step, labels()));
    return html`<li class="flow-step flow-step--${step.type}" data-step="${step.id}">
      <div class="flow-step-head"><span class="flow-step-kind">${step.type === 'action' && ACTIONS[step.action]?.ai ? 'AI' : KIND[step.type]}</span><span class="flow-step-title">${title}</span>
        ${canEdit ? html`<div class="flow-step-tools"><button class="btn btn-small" type="button" data-edit="${step.id}" aria-expanded="${editing}">${editing ? 'Done' : 'Edit'}<span class="visually-hidden"> step: ${title}</span></button>
          <button class="btn btn-small" type="button" data-move="${step.id}:-1" ${index === 0 ? raw('disabled') : ''} aria-label="Move up: ${title}">↑</button><button class="btn btn-small" type="button" data-move="${step.id}:1" ${index === list.length - 1 ? raw('disabled') : ''} aria-label="Move down: ${title}">↓</button>
          <button class="btn btn-small btn-danger" type="button" data-delete="${step.id}" aria-label="Delete step: ${title}">Delete</button></div>` : ''}</div>
      ${editing ? html`<div class="flow-step-edit" data-editor="${step.id}">${stepEditor(step)}</div>` : ''}
      ${step.type === 'branch' ? html`<ol class="flow-paths">${step.paths.map(path => html`<li class="flow-path"><p class="flow-path-label"><strong>${path.label}</strong> ${path.rules.length ? html`<span class="muted">if ${chip.show(path.rules.map(rule => `${labels()[rule.field] || rule.field} ${OPS[rule.op]} ${rule.value ?? ''}`).join(path.match === 'any' ? ' or ' : ' and '))}</span>` : html`<span class="muted">otherwise</span>`}</p>
        <ol class="flow-steps flow-steps--nested">${path.steps.map((inner, innerIndex) => stepItem(inner, innerIndex, path.steps))}</ol>${canEdit ? addMenu(path.id) : ''}</li>`)}</ol>` : ''}
    </li>`;
  }

  function zoneOptions(current) {
    let zones = [];
    try { zones = Intl.supportedValuesOf('timeZone'); } catch { /* older browsers: the current and UTC */ }
    // Browsers may report older names (Chrome in India: Asia/Calcutta); offer the current IANA names.
    const list = [...new Set(['UTC', current, Intl.DateTimeFormat().resolvedOptions().timeZone, ...zones].filter(Boolean).map(canonicalZone))];
    return list.map(zone => [zone, zone.replace(/_/g, ' ')]);
  }

  let previewKey = '';
  async function showNextRuns() {
    const box = $('#flow-next-runs');
    const config = draft.trigger?.type === 'schedule' ? draft.trigger.config || {} : null;
    if (!box || !config) return;
    const params = new URLSearchParams({ every: config.every || 'day', time: config.time || '09:00', timezone: config.timezone || 'UTC', ...(config.every === 'week' ? { weekday: String(config.weekday ?? 1) } : {}) });
    const key = params.toString();
    previewKey = key;
    try {
      const preview = await api('GET', wsPath('/flow/schedule-preview?' + key));
      if (previewKey !== key || !box.isConnected) return;
      const format = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: preview.timezone, timeZoneName: 'short' });
      box.textContent = 'Next runs: ' + preview.runs.map(at => format.format(new Date(at))).join(' · ') + (flow.status === 'enabled' ? '' : '. It runs only after it is published and turned on.');
    } catch (error) { if (previewKey === key && box.isConnected) box.textContent = error.message; }
  }

  function triggerCard() {
    const trigger = draft.trigger || {};
    const config = trigger.config || {};
    const grouped = Object.entries(JOB_TRIGGERS).map(([job, label]) => [label, Object.entries(TRIGGERS).filter(([, item]) => item.job === job)]);
    const book = refs.workbooks.find(item => item.id === trigger.source);
    return html`<li class="flow-step flow-step--trigger"><div class="flow-step-head"><span class="flow-step-kind">When</span><span class="flow-step-title">${TRIGGERS[trigger.type]?.label || 'Choose what starts it'}</span></div>
      ${canEdit ? html`<div class="flow-step-edit"><label for="trigger-type">Starts when</label><select id="trigger-type">${grouped.map(([label, items]) => html`<optgroup label="${label}">${items.map(([type, item]) => html`<option value="${type}" ${type === trigger.type ? raw('selected') : ''}>${item.label}</option>`)}</optgroup>`)}</select>
        ${TRIGGERS[trigger.type]?.source ? html`<label for="trigger-source">${{ form: 'Form', event_type: 'Event type', workbook: 'Workbook' }[TRIGGERS[trigger.type].source]}</label>${select('id="trigger-source"', sourceOptions(trigger.type), trigger.source || '')}` : ''}
        ${TRIGGERS[trigger.type]?.offset ? html`<label for="trigger-minutes">${trigger.type.endsWith('before_start') ? 'How long before it starts' : 'How long after it ends'} (minutes)</label><input id="trigger-minutes" type="number" min="0" max="10080" value="${config.minutes ?? 60}">` : ''}
        ${trigger.type?.startsWith('sheets.') ? html`<label for="trigger-sheet">Sheet</label>${select('id="trigger-sheet"', [['', 'Choose a sheet'], ...(book?.sheets || []).map(sheet => [sheet.id, sheet.name])], config.sheet || '')}` : ''}
        ${trigger.type === 'sheets.cell.changed' ? html`<label for="trigger-column">Column (row 1 name)</label><input id="trigger-column" maxlength="100" value="${config.column || ''}"><label for="trigger-value">Changes to</label><input id="trigger-value" maxlength="200" value="${config.value || ''}"><p class="hint">Edits by people start it; undo, redo and other workflows’ changes do not.</p>` : ''}
        ${trigger.type === 'schedule' ? html`<label for="trigger-every">Every</label>${select('id="trigger-every"', [['hour', 'Hour'], ['day', 'Day'], ['week', 'Week']], config.every || 'day')}<label for="trigger-time">${config.every === 'hour' ? 'At minute (time’s minutes are used)' : 'At'}</label><input id="trigger-time" type="time" value="${config.time || '09:00'}">${config.every === 'week' ? html`<label for="trigger-weekday">On</label>${select('id="trigger-weekday"', ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day, index) => [index, day]), config.weekday ?? 1)}` : ''}<label for="trigger-timezone">Time zone</label>${select('id="trigger-timezone"', zoneOptions(config.timezone), config.timezone || 'UTC')}<p class="hint" id="flow-next-runs" aria-live="polite">Working out the next runs…</p><p class="hint">Times follow the clock in this time zone, including daylight-saving changes. A time skipped when clocks go forward runs at the first time that exists; a repeated time runs once.</p>` : ''}
        ${trigger.type === 'meet.booking.ended' ? html`<p class="hint">Starts when the booking’s scheduled end time passes, whether or not a video call took place or was closed early. Canceled bookings never start it.</p>` : ''}
        ${trigger.type === 'payments.captured' ? html`<p class="hint">Only payments taken by a paid Schedora form, after Razorpay confirms them on the server. Meet session payments and plan billing do not start this.</p>` : ''}
        ${trigger.type === 'webhook.incoming' ? html`<p class="hint">Post JSON like <code>{"event": "signup", "fields": {"email": "a@example.com", "name": "Asha", "plan": "pro"}}</code>. Each field arrives as text: numbers, true/false and dates are compared as text, nested objects and lists are not read, and <code>email</code> and <code>name</code> identify the person.</p>` : ''}
        ${trigger.type === 'forms.response.created' ? html`<p class="hint">Paid forms start this only after the payment is confirmed.</p>` : ''}</div>` : ''}</li>`;
  }

  function render(focusSelector) {
    const state = STATE[flow.state] || STATE.draft;
    mount($('#flow-state'), html`${pill(state)}${flow.unpublished_changes ? pill(['warn', 'Unpublished changes']) : ''}${dirty ? pill(['warn', 'Not saved']) : ''}${flow.failing ? pill(['bad', 'Failing']) : ''}`);
    if (canEdit) mount($('#flow-switch'), flow.published_version == null ? '' : flow.status === 'enabled'
      ? html`<button class="btn" type="button" data-status="paused">Pause</button><button class="btn" type="button" data-status="draft">Turn off</button>`
      : boot.flowActivationHeld ? html`<button class="btn btn-primary" type="button" disabled aria-describedby="flow-held">${flow.status === 'paused' ? 'Resume' : 'Turn on'}</button><span class="hint" id="flow-held">Turning on is held until every server runs this release.</span>`
      : html`<button class="btn btn-primary" type="button" data-status="enabled">${flow.status === 'paused' ? 'Resume' : 'Turn on'}</button>`);
    $('#flow-sentence').textContent = chip.show(describeFlow(draft, { labels: labels() }));
    const problems = flowProblems(draft);
    mount($('#flow-problems'), problems.length || checked?.problems?.length || checked?.activation?.length ? notice(problems.length || checked?.problems?.length ? 'warn' : 'info', html`
      ${problems.length || checked?.problems?.length ? html`<p><strong>Before publishing:</strong></p><ul>${[...new Set([...problems, ...(checked?.problems || [])])].map(problem => html`<li>${problem}</li>`)}</ul>` : ''}
      ${checked?.activation?.length ? html`<p><strong>Before turning on:</strong></p><ul>${checked.activation.map(problem => html`<li>${problem}</li>`)}</ul>` : ''}`) : '');
    mount($('#flow-steps'), html`${triggerCard()}${draft.steps.map((step, index) => stepItem(step, index, draft.steps))}${canEdit ? html`<li class="flow-step flow-step--add">${addMenu('root')}</li>` : ''}`);
    mount($('#flow-record'), records.length ? html`${records.map(record => html`<option value="${record.id}">${record.label}</option>`)}` : html`<option value="">${subject() === 'none' || subject() === 'webhook' ? 'A sample record' : 'No recent record yet'}</option>`);
    // Focus returns to the control that changed; text fields keep the caret where it was (else at the end).
    const focused = focusSelector && $(focusSelector, ctx.main);
    if (focused) { focused.focus(); if (focused.tagName === 'TEXTAREA' || (focused.tagName === 'INPUT' && /^(text|url)$/.test(focused.type))) { const at = Math.min(caretAt.get(focused.id) ?? focused.value.length, focused.value.length); try { focused.setSelectionRange(at, at); } catch {} } }
    showNextRuns();
  }

  // ---- Editing -------------------------------------------------------------------------------------------
  const change = (focus) => { setDirty(true); render(focus); };
  const stepOf = element => { const id = element.closest('[data-step]')?.dataset.step; return id && locate(draft.steps, id)?.list[locate(draft.steps, id).index]; };
  const ruleTarget = owner => { const found = locate(draft.steps, owner); if (found) return found.list[found.index]; return findPath(draft.steps, owner); };

  // Where the caret last was in each text field, so "Insert a field…" can place the chip there.
  const caretAt = new Map();
  for (const type of ['keyup', 'mouseup', 'input', 'select']) {
    $('#flow-builder').addEventListener(type, event => {
      const target = event.target;
      if (target.matches?.('[data-text]') && target.isConnected && typeof target.selectionStart === 'number') caretAt.set(target.id, target.selectionStart);
    });
  }

  $('#flow-builder').addEventListener('change', async event => {
    const target = event.target;
    if (target.id === 'flow-name') { name = target.value; return change(); }
    if (target.id === 'flow-auto-pause') { autoPause = target.checked; return change(); }
    if (target.id === 'flow-record') return;
    if (target.id?.startsWith('trigger-')) {
      const trigger = draft.trigger || (draft.trigger = {});
      if (target.id === 'trigger-type') { draft.trigger = { type: target.value, ...(TRIGGERS[target.value].offset ? { config: { minutes: 60 } } : target.value === 'schedule' ? { config: { every: 'day', time: '09:00', timezone: canonicalZone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC') } } : {}) }; setDirty(true); await loadFields(); return render('#trigger-type'); }
      if (target.id === 'trigger-source') { if (target.value) trigger.source = target.value; else delete trigger.source; setDirty(true); return render('#trigger-source'); }
      const key = { 'trigger-minutes': 'minutes', 'trigger-sheet': 'sheet', 'trigger-column': 'column', 'trigger-value': 'value', 'trigger-every': 'every', 'trigger-time': 'time', 'trigger-weekday': 'weekday', 'trigger-timezone': 'timezone' }[target.id];
      trigger.config = { ...(trigger.config || {}), [key]: ['minutes', 'weekday'].includes(key) ? Number(target.value) : target.value };
      return change('#' + target.id);
    }
    if (target.dataset.add) {
      const [type, action] = target.value.split(':');
      if (!type) return;
      const step = newStep(type, action);
      const list = target.dataset.add === 'root' ? draft.steps : findPath(draft.steps, target.dataset.add).steps;
      list.push(step);
      open.add(step.id);
      return change(`[data-editor="${step.id}"] input, [data-editor="${step.id}"] select, [data-editor="${step.id}"] textarea`);
    }
    if (target.dataset.insert) {
      const input = $('#' + target.dataset.insert);
      if (!target.value || !input) return;
      // Choosing from the menu moves focus off the text, so use where the caret last was in it.
      const at = Math.min(document.activeElement === input ? input.selectionStart ?? input.value.length : caretAt.get(input.id) ?? input.value.length, input.value.length);
      const chipText = `[${target.value}]`;
      input.value = input.value.slice(0, at) + chipText + input.value.slice(at);
      caretAt.set(input.id, at + chipText.length);
      target.value = '';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return input.focus();
    }
    const step = stepOf(target);
    if (!step) return;
    const focus = '#' + target.id;
    if (target.matches('[data-rule-field], [data-rule-op], [data-rule-value]')) {
      const [owner, index] = target.closest('[data-rule]').dataset.rule.split(':');
      const rule = ruleTarget(owner).rules[Number(index)];
      if (target.matches('[data-rule-field]')) rule.field = target.value;
      else if (target.matches('[data-rule-op]')) { rule.op = target.value; if (['is_empty', 'is_not_empty'].includes(rule.op)) delete rule.value; else rule.value ??= ''; }
      else rule.value = target.value;
      return change(focus);
    }
    if (target.dataset.match) { ruleTarget(target.dataset.match).match = target.value; return change(focus); }
    if (target.dataset.pathLabel) { findPath(draft.steps, target.dataset.pathLabel).label = target.value; return change(focus); }
    if (target.dataset.waitAmount || target.dataset.waitUnit) {
      const key = target.dataset.waitAmount || target.dataset.waitUnit;
      const editor = target.closest('[data-editor]');
      const amount = Number($(`[data-wait-amount="${key}"]`, editor).value) || 1;
      const unit = Number($(`[data-wait-unit="${key}"]`, editor).value) || 1;
      step[key] = Math.max(1, Math.round(amount * unit));
      return change(focus);
    }
    if (target.dataset.key) { step[target.dataset.key] = target.dataset.number !== undefined ? Number(target.value) : target.value || undefined; if (target.dataset.key === 'source' && !target.value) delete step.source; return change(focus); }
    if (target.dataset.text) {
      const key = target.dataset.text;
      const value = chip.store(target.value);
      if (key.startsWith('var')) { step.config.variables ||= []; step.config.variables[Number(key.slice(3))] = value; }
      else step.config[key] = value;
      return change(focus);
    }
    if (target.dataset.config) {
      const key = target.dataset.config;
      let value = target.value;
      if (target.dataset.number !== undefined) value = value === '' ? undefined : Number(value);
      if (target.dataset.list !== undefined) value = value.split(',').map(item => item.trim()).filter(Boolean);
      if (key === 'member') value = value.replace(/^member:/, '');
      if (key === 'template') step.config.variables = [];
      if (value === undefined) delete step.config[key]; else step.config[key] = value;
      return change(focus);
    }
    if (target.dataset.member) {
      const members = new Set(step.config.members || []);
      if (target.checked) members.add(target.dataset.member); else members.delete(target.dataset.member);
      step.config.members = [...members];
      return change(`[data-member="${target.dataset.member}"]`);
    }
    if (target.dataset.valueHeader || target.dataset.valueText) {
      const entries = Object.entries(step.config.values || {});
      const index = Number(target.dataset.valueHeader ?? target.dataset.valueText);
      if (target.dataset.valueHeader) entries[index][0] = target.value; else entries[index][1] = chip.store(target.value);
      step.config.values = Object.fromEntries(entries);
      return change(focus);
    }
  });

  $('#flow-builder').addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button) return;
    const step = stepOf(button);
    if (button.dataset.edit) { if (open.has(button.dataset.edit)) open.delete(button.dataset.edit); else open.add(button.dataset.edit); return render(`[data-edit="${button.dataset.edit}"]`); }
    if (button.dataset.move) {
      const [id, delta] = button.dataset.move.split(':');
      const { list, index } = locate(draft.steps, id);
      const to = index + Number(delta);
      [list[index], list[to]] = [list[to], list[index]];
      // Keyboard users keep their place: at the top or bottom the pressed button is disabled, so focus
      // moves to the step's other move button.
      const canAgain = Number(delta) < 0 ? to > 0 : to < list.length - 1;
      return change(`[data-move="${id}:${canAgain ? delta : -Number(delta)}"]`);
    }
    if (button.dataset.delete) {
      if (!(await ask({ title: 'Delete this step?', body: 'It is removed from the draft. Published versions and runs already started are not affected.', confirm: 'Delete step', danger: true }))) return;
      const { list, index } = locate(draft.steps, button.dataset.delete);
      list.splice(index, 1);
      return change('#add-root');
    }
    if (button.dataset.addRule) { ruleTarget(button.dataset.addRule).rules.push({ field: fields[0]?.key || 'contact.email', op: 'is_not_empty' }); return change(`[data-add-rule="${button.dataset.addRule}"]`); }
    if (button.dataset.removeRule) { const [owner, index] = button.dataset.removeRule.split(':'); const target = ruleTarget(owner); target.rules.splice(Number(index), 1); return change(`[data-add-rule="${owner}"]`); }
    if (button.dataset.addPath) { const branch = step; branch.paths.splice(branch.paths.length - (branch.paths.at(-1).rules.length ? 0 : 1), 0, { id: uid('p'), label: `Path ${String.fromCharCode(65 + branch.paths.length - 1)}`, match: 'all', rules: [{ field: fields[0]?.key || 'contact.email', op: 'is_not_empty' }], steps: [] }); return change(`[data-add-path="${branch.id}"]`); }
    if (button.dataset.removePath) { const [branchId, pathId] = button.dataset.removePath.split(':'); const branch = locate(draft.steps, branchId); const target = branch.list[branch.index]; target.paths = target.paths.filter(path => path.id !== pathId); return change(); }
    if (button.dataset.toggleOtherwise) { const path = findPath(draft.steps, button.dataset.toggleOtherwise); path.rules = path.rules.length ? [] : [{ field: fields[0]?.key || 'contact.email', op: 'is_not_empty' }]; path.match = 'all'; return change(); }
    if (button.dataset.addValue !== undefined) { step.config.values = { ...(step.config.values || {}), ['Column ' + (Object.keys(step.config.values || {}).length + 1)]: '' }; return change(); }
    if (button.dataset.removeValue) { const entries = Object.entries(step.config.values || {}); entries.splice(Number(button.dataset.removeValue), 1); step.config.values = Object.fromEntries(entries); return change(); }
    if (button.dataset.testSend) return testSend(button.dataset.testSend);
    if (button.dataset.status) return setStatus(button.dataset.status, button);
  });

  async function save() {
    // Edits made while the save is in flight are kept: the page stays "Not saved" until they are saved too.
    const sent = { name, definition: clone(draft), auto_pause: autoPause };
    try {
      flow = await api('PUT', wsPath(`/flow/workflows/${id}/draft`), { revision: flow.draft_revision, ...sent });
      const changedSince = name !== sent.name || autoPause !== sent.auto_pause || JSON.stringify(draft) !== JSON.stringify(sent.definition);
      if (changedSince) { checked = null; render(); return true; }
      draft = clone(flow.definition);
      setDirty(false);
      checked = null;
      await loadFields();
      render();
      toast('Draft saved. The live workflow changes only when you publish.');
      return true;
    } catch (error) {
      if (error.code === 'flow_conflict') mount($('#flow-problems'), notice('bad', html`<p>${error.message} Your edits are still on this page; copy anything you need, then reload.</p>`));
      else toast(error.message);
      return false;
    }
  }
  async function setStatus(status, button) {
    if (dirty && !(await ask({ title: 'Unsaved changes', body: 'Turning on or off uses the published version. Your unsaved edits stay on this page.', confirm: 'Continue' }))) return;
    let cancel = false;
    if (status === 'draft' && flow.active_count) {
      const choice = await ask({ title: 'Turn off this workflow?', body: `${flow.active_count} run(s) are waiting. Turning off holds them; they continue if you turn it on again.`, fields: html`<label class="check"><input type="checkbox" name="cancel_active"> Cancel the waiting runs instead</label>`, confirm: 'Turn off' });
      if (!choice) return;
      cancel = Boolean(choice.cancel_active);
    }
    button.disabled = true;
    try { flow = await api('POST', wsPath(`/flow/workflows/${id}/status`), { status, cancel_active: cancel }); render(); toast(status === 'enabled' ? 'Workflow is on.' : status === 'paused' ? 'Workflow paused. Waiting runs hold until you resume.' : 'Workflow is off.'); }
    catch (error) { checked = { problems: [], activation: error.details?.problems || [error.message] }; render(); toast(error.message); }
    finally { if (button.isConnected) button.disabled = false; }
  }

  if (canEdit) {
    $('#flow-save').onclick = save;
    $('#flow-publish').onclick = async () => {
      if (dirty && !(await save())) return;
      if (dirty) return toast('You changed the workflow while it was saving. Save the draft again, then publish.');
      try { checked = await api('POST', wsPath(`/flow/workflows/${id}/publish-check`)); }
      catch (error) { return toast(error.message); }
      if (!checked.can_publish) { render(); return $('#flow-problems').scrollIntoView({ block: 'nearest' }); }
      if (!(await ask({ title: 'Publish this version?', body: 'Runs already in progress finish on the version they started with. New runs use this version.', confirm: 'Publish' }))) return;
      try { flow = await api('POST', wsPath(`/flow/workflows/${id}/publish`), { revision: flow.draft_revision }); render(); toast(`Version ${flow.published_version} published.${flow.status === 'enabled' ? '' : ' Turn it on when you are ready.'}`); }
      catch (error) { toast(error.message); }
    };
    $('#flow-webhook')?.addEventListener('click', async () => {
      if (!(await ask({ title: 'Create a webhook address?', body: 'Any earlier address for this workflow stops working.', confirm: 'Create address' }))) return;
      try { const hook = await api('POST', wsPath(`/flow/workflows/${id}/webhook`)); mount($('#flow-webhook-result'), html`<label for="hook-url">Address</label><input id="hook-url" readonly value="${hook.url}"><label for="hook-secret">Signing secret (shown once)</label><input id="hook-secret" readonly value="${hook.secret}"><p class="hint">${hook.signing}</p>`); }
      catch (error) { toast(error.message); }
    });
  }

  $('#flow-test').onclick = async () => {
    if (dirty && canEdit && !(await save())) return;
    if (dirty && canEdit) return toast('You changed the workflow while it was saving. Save the draft again, then test.');
    const result = $('#flow-test-result');
    mount(result, loading('Testing…'));
    try {
      const outcome = await api('POST', wsPath(`/flow/workflows/${id}/test`), { record_id: $('#flow-record').value || undefined });
      mount(result, html`<p>${pill(outcome.outcome === 'succeeded' ? ['ok', 'Would finish'] : ['warn', outcome.outcome === 'skipped' ? 'Would stop' : outcome.outcome])} ${outcome.reason || ''}</p>
        <ol class="flow-test-steps">${outcome.steps.map(step => html`<li><strong>${chip.show(step.title)}</strong> <span class="muted">— ${step.outcome}</span>
          ${step.preview ? html`<dl class="flow-preview">${Object.entries(step.preview).filter(([, value]) => value != null && value !== '').map(([key, value]) => html`<dt>${key.replace(/_/g, ' ')}</dt><dd>${typeof value === 'object' ? Object.entries(value).map(([name, item]) => `${name}: ${item}`).join('; ') : String(value)}</dd>`)}</dl>` : ''}
          ${canEdit && ['send_email', 'send_booking_link', 'send_form', 'send_sms', 'send_whatsapp', 'slack'].includes(flatStep(step.id)?.action) ? html`<button class="btn btn-small" type="button" data-test-send="${step.id}">Send test to me</button>` : ''}</li>`)}</ol>
        <p class="hint">${outcome.note}</p>`);
    } catch (error) { mount(result, notice('bad', html`<p>${error.message}</p>`)); }
  };
  const flatStep = stepId => { const found = locate(draft.steps, stepId); return found && found.list[found.index]; };
  async function testSend(stepId) {
    const step = flatStep(stepId);
    const phone = ['send_sms', 'send_whatsapp'].includes(step.action);
    const me = session.user.email;
    const choice = await ask({ title: 'Send a test to yourself?', body: phone ? 'Enter your own number. Only that number receives the test.' : step.action === 'slack' ? 'The test is posted to the connected Slack channel.' : `The test goes to your account email (${me}) only.`,
      fields: html`${phone ? html`<label for="test-destination">Your number with country code</label><input id="test-destination" name="destination" required maxlength="20" inputmode="tel">` : ''}<label class="check"><input type="checkbox" name="confirm" required> ${phone ? 'This number is mine' : 'I understand where the test goes'}</label>`, confirm: 'Send test' });
    if (!choice) return;
    if (!choice.confirm) return toast('Confirm the destination to send a test.');
    try {
      const result = await api('POST', wsPath(`/flow/workflows/${id}/test-send`), { step_id: stepId, confirm: true, destination: choice.destination, record_id: $('#flow-record').value || undefined });
      toast(result.status === 'accepted' ? result.note : `Test ${result.status}: ${result.error || ''}`);
      refs.integrations = await api('GET', wsPath('/flow/integrations'));
      render();
    } catch (error) { toast(error.message); }
  }

  render();
}

async function loadRefs() {
  const safe = promise => promise.catch(() => []);
  const [forms, events, books, members, integrations] = await Promise.all([safe(api('GET', wsPath('/forms'))), safe(api('GET', wsPath('/event-types'))), safe(api('GET', wsPath('/workbooks'))), safe(api('GET', wsPath('/members'))), api('GET', wsPath('/flow/integrations')).catch(() => ({}))]);
  const list = Array.isArray(books) ? books : books.workbooks || [];
  const workbooks = await Promise.all(list.slice(0, 30).map(async book => { try { const full = await api('GET', wsPath(`/workbooks/${book.id}`)); return { id: book.id, title: book.title, sheets: (full.sheets || []).map(sheet => ({ id: sheet.id, name: sheet.name })) }; } catch { return { id: book.id, title: book.title, sheets: [] }; } }));
  return { forms: Array.isArray(forms) ? forms : [], events: Array.isArray(events) ? events : [], workbooks, members: (Array.isArray(members) ? members : members.members || []).map(person => ({ user_id: person.user_id || person.id, name: person.name || person.email })), integrations };
}

/** Creates a draft (blank, from a template or from a description) and opens it in the builder. */
export async function startDraft(ctx, body) {
  const flow = await api('POST', wsPath('/flow/workflows'), body);
  ctx.navigate('/flow/build/' + flow.id);
}

export { workspace };
