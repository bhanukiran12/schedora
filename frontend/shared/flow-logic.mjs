// Flow v1 workflow definitions (docs/FLOW_V1_IMPLEMENTATION.md). Shared by the server, which validates
// and executes them, and the builder, which edits and describes them. No I/O here.

export const FLOW_LIMITS = { steps: 30, paths: 3, rules: 10, text: 5000, subject: 200, waitMinutes: 60 * 24 * 60, timeoutMinutes: 60 * 24 * 30, approvalHours: 24 * 14, labels: 8, aiInstruction: 1000 };

// Triggers. `subject` says what each run is about; `source` names what the trigger can be limited to.
export const TRIGGERS = {
  'meet.booking.created': { label: 'A booking is made', subject: 'booking', source: 'event_type', job: 'meet' },
  'meet.booking.canceled': { label: 'A booking is canceled', subject: 'booking', source: 'event_type', job: 'meet' },
  'meet.booking.rescheduled': { label: 'A booking is rescheduled', subject: 'booking', source: 'event_type', job: 'meet' },
  'meet.booking.before_start': { label: 'Before a meeting starts', subject: 'booking', source: 'event_type', job: 'meet', offset: true },
  'meet.booking.after_end': { label: 'After a meeting ends', subject: 'booking', source: 'event_type', job: 'meet', offset: true },
  'meet.booking.ended': { label: 'A meeting’s scheduled end time passes', subject: 'booking', source: 'event_type', job: 'meet' },
  'meet.booking.no_show': { label: 'Someone is marked as a no-show', subject: 'booking', source: 'event_type', job: 'meet' },
  'forms.response.created': { label: 'A form response is completed', subject: 'response', source: 'form', job: 'forms' },
  'forms.response.edited': { label: 'A form response is edited', subject: 'response', source: 'form', job: 'forms' },
  'payments.captured': { label: 'A form payment is confirmed (Forms only)', subject: 'response', source: 'form', job: 'forms' },
  'sheets.row.added': { label: 'A row is added to a sheet', subject: 'row', source: 'workbook', job: 'sheets' },
  'sheets.cell.changed': { label: 'A column changes to a value', subject: 'row', source: 'workbook', job: 'sheets' },
  'sheets.row.manual': { label: 'Someone runs it on a row', subject: 'row', source: 'workbook', job: 'sheets' },
  'schedule': { label: 'On a schedule', subject: 'none', source: null, job: 'other' },
  'webhook.incoming': { label: 'Another app sends a webhook', subject: 'webhook', source: null, job: 'other' }
};

// What "wait until something happens" can wait for, matched to the same person (contact email).
export const WAIT_EVENTS = {
  'meet.booking.created': 'they book a meeting',
  'forms.response.created': 'they submit a form',
  'payments.captured': 'their form payment is confirmed'
};

export const ACTIONS = {
  send_email: { label: 'Send an email', provider: 'email', message: true },
  create_task: { label: 'Create a task', provider: null },
  send_whatsapp: { label: 'Send a WhatsApp template', provider: 'whatsapp', message: true },
  send_sms: { label: 'Send an SMS', provider: 'sms', message: true },
  sheet_row: { label: 'Add or update a sheet row', provider: null },
  update_contact: { label: 'Update the contact', provider: null },
  send_booking_link: { label: 'Send a booking link', provider: 'email', message: true },
  send_form: { label: 'Send a prefilled form', provider: 'email', message: true },
  assign_owner: { label: 'Assign an owner', provider: null },
  add_note: { label: 'Add a note to the contact', provider: null },
  slack: { label: 'Post to Slack', provider: 'slack', message: true },
  webhook: { label: 'Send a webhook', provider: 'webhook', message: true },
  ai_draft: { label: 'Draft a message with AI', provider: 'ai', ai: true },
  ai_summarize: { label: 'Summarize with AI', provider: 'ai', ai: true },
  ai_classify: { label: 'Classify with AI', provider: 'ai', ai: true }
};

export const OPS = {
  equals: 'is', not_equals: 'is not', contains: 'contains', not_contains: 'does not contain',
  is_empty: 'is empty', is_not_empty: 'is not empty', greater_than: 'is more than', less_than: 'is less than'
};
const VALUELESS = ['is_empty', 'is_not_empty'];

export const RUN_STATUS = {
  queued: 'Queued', running: 'Running', retrying: 'Retrying', waiting: 'Waiting', needs_approval: 'Needs approval',
  succeeded: 'Succeeded', skipped: 'Skipped', failed: 'Failed', canceled: 'Canceled'
};
export const TERMINAL = ['succeeded', 'skipped', 'failed', 'canceled'];

const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const ID = /^[a-z0-9_-]{1,40}$/;
const FIELD = /^[a-z][a-z0-9_.-]{0,80}$/;

// ---- Fields ---------------------------------------------------------------------------------------

/** Fields every run of a trigger provides, with plain labels. Form answers and sheet columns are added by the server. */
export function baseFields(triggerType) {
  const subject = TRIGGERS[triggerType]?.subject;
  const common = [['contact.name', 'Contact name'], ['contact.email', 'Contact email'], ['contact.phone', 'Contact phone'], ['contact.owner', 'Contact owner']];
  if (subject === 'booking') return [...common, ['booking.start', 'Meeting time'], ['booking.reference', 'Booking reference'], ['event.title', 'Event'], ['host.name', 'Host name'], ['host.email', 'Host email'], ['attendance', 'Attendance']];
  if (subject === 'response') return [...common, ['form.title', 'Form'], ['response.reference', 'Receipt code'], ['lead.band', 'Lead priority (Hot, Warm, Cold)'], ['lead.score', 'Lead score'], ['payment.status', 'Payment status'], ['payment.amount', 'Amount paid']];
  if (subject === 'row') return [['row.number', 'Row number'], ['sheet.name', 'Sheet'], ['workbook.title', 'Workbook'], ['change.column', 'Changed column'], ['change.value', 'New value'], ...common];
  if (subject === 'webhook') return [['webhook.event', 'Webhook event name'], ...common];
  return [['now.date', 'Today’s date']];
}

/** Fields made available by earlier steps (AI output, wait results, assigned owner). */
export function stepFields(steps) {
  const fields = [];
  for (const step of flatten(steps)) {
    if (step.type === 'action' && ['ai_draft', 'ai_summarize'].includes(step.action)) fields.push([`steps.${step.id}.text`, `Text from “${stepTitle(step)}”`]);
    if (step.type === 'action' && step.action === 'ai_classify') fields.push([`steps.${step.id}.label`, `Category from “${stepTitle(step)}”`]);
    if (step.type === 'wait_for') fields.push([`steps.${step.id}.happened`, `Whether ${WAIT_EVENTS[step.event] || 'it happened'} (yes/no)`]);
    if (step.type === 'action' && step.action === 'assign_owner') fields.push(['owner.name', 'Assigned owner'], ['owner.email', 'Assigned owner email']);
    if (step.type === 'approval') fields.push([`steps.${step.id}.text`, `Approved text from “${stepTitle(step)}”`]);
  }
  return fields;
}

/** Every step in order, branch paths included (depth first). */
export function flatten(steps = []) {
  const out = [];
  for (const step of steps) {
    out.push(step);
    if (step?.type === 'branch') for (const path of step.paths || []) out.push(...flatten(path.steps));
  }
  return out;
}

// ---- Validation ----------------------------------------------------------------------------------

function ruleProblems(rules, where) {
  const problems = [];
  if (!Array.isArray(rules) || rules.length > FLOW_LIMITS.rules) return [`${where}: use up to ${FLOW_LIMITS.rules} rules.`];
  rules.forEach((rule, index) => {
    if (!isObject(rule) || typeof rule.field !== 'string' || !FIELD.test(rule.field)) problems.push(`${where}, rule ${index + 1}: choose a field.`);
    else if (!OPS[rule.op]) problems.push(`${where}, rule ${index + 1}: choose a comparison.`);
    else if (!VALUELESS.includes(rule.op) && (typeof rule.value !== 'string' || !rule.value.trim() || rule.value.length > 300)) problems.push(`${where}, rule ${index + 1}: enter a value.`);
  });
  return problems;
}

const textOk = (value, max, required = true) => typeof value === 'string' && value.length <= max && (!required || value.trim().length > 0);
const recipientOk = value => typeof value === 'string' && (['contact', 'host', 'owner'].includes(value) || /^member:[A-Za-z0-9-]{1,64}$/.test(value) || /^field:[a-z][a-z0-9_.-]{0,80}$/.test(value) || /^address:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));

function actionProblems(step, where) {
  const config = step.config;
  if (!ACTIONS[step.action]) return [`${where}: choose what to do.`];
  if (!isObject(config)) return [`${where}: finish setting it up.`];
  const p = [];
  const need = (ok, message) => { if (!ok) p.push(`${where}: ${message}`); };
  switch (step.action) {
    case 'send_email': need(recipientOk(config.to), 'choose who receives it.'); need(textOk(config.subject, FLOW_LIMITS.subject), 'write a subject.'); need(textOk(config.body, FLOW_LIMITS.text), 'write the message.'); break;
    case 'send_booking_link': need(recipientOk(config.to), 'choose who receives it.'); need(typeof config.event_type === 'string' && config.event_type.length > 0, 'choose the booking page.'); need(textOk(config.subject, FLOW_LIMITS.subject), 'write a subject.'); need(textOk(config.body ?? '', FLOW_LIMITS.text, false), 'keep the message shorter.'); break;
    case 'send_form': need(recipientOk(config.to), 'choose who receives it.'); need(typeof config.form === 'string' && config.form.length > 0, 'choose the form.'); need(textOk(config.subject, FLOW_LIMITS.subject), 'write a subject.'); need(config.prefill == null || (isObject(config.prefill) && Object.keys(config.prefill).length <= 20), 'prefill up to 20 questions.'); break;
    case 'create_task': need(textOk(config.title, 200), 'give the task a title.'); need(textOk(config.details ?? '', 2000, false), 'keep the details shorter.'); need(['none', 'host', 'owner'].includes(config.assign_to ?? 'none') || /^member:[A-Za-z0-9-]{1,64}$/.test(config.assign_to), 'choose who it is assigned to.'); need(config.due_in_hours == null || (Number.isInteger(config.due_in_hours) && config.due_in_hours >= 1 && config.due_in_hours <= 720), 'choose a deadline of 1 hour to 30 days.'); break;
    case 'send_whatsapp': need(recipientOk(config.to) && !['host', 'owner'].includes(config.to), 'choose whose number receives it.'); need(typeof config.template === 'string' && /^[a-z0-9_]{1,40}$/.test(config.template), 'choose an approved template.'); need(Array.isArray(config.variables) && config.variables.length <= 10 && config.variables.every(item => textOk(item, 500)), 'fill in every template variable.'); break;
    case 'send_sms': need(recipientOk(config.to) && !['host', 'owner'].includes(config.to), 'choose whose number receives it.'); need(textOk(config.body, 600), 'write a message of up to 600 characters.'); break;
    case 'sheet_row': need(typeof config.workbook === 'string' && config.workbook.length > 0 && typeof config.sheet === 'string' && config.sheet.length > 0, 'choose an editable sheet.'); need(['add', 'update', 'upsert'].includes(config.mode), 'choose add or update.'); need(isObject(config.values) && Object.keys(config.values).length > 0 && Object.keys(config.values).length <= 30 && Object.values(config.values).every(value => textOk(value, 2000, false)), 'choose the columns to fill in.'); if (config.mode !== 'add') need(textOk(config.match_column, 100) && textOk(config.match_value, 500), 'choose the column that finds the row and its value.'); break;
    case 'update_contact': need(['name', 'phone', 'company'].some(key => typeof config[key] === 'string') || (Array.isArray(config.add_tags) && config.add_tags.length) || isObject(config.custom), 'choose what to change.'); need(config.add_tags == null || (Array.isArray(config.add_tags) && config.add_tags.length <= 10 && config.add_tags.every(tag => textOk(tag, 40))), 'use up to 10 tags of 40 characters.'); break;
    case 'assign_owner': need(config.mode === 'round_robin' ? Array.isArray(config.members) && config.members.length >= 1 && config.members.length <= 20 : config.mode === 'member' && typeof config.member === 'string', 'choose the people to assign.'); break;
    case 'add_note': need(textOk(config.body, 2000), 'write the note.'); break;
    case 'slack': need(textOk(config.text, 3000), 'write the message.'); break;
    case 'webhook': need(typeof config.url === 'string' && /^https:\/\/[^\s]{4,500}$/.test(config.url), 'enter an https:// address.'); need(['record', 'minimal'].includes(config.include ?? 'record'), 'choose what to include.'); break;
    case 'ai_draft': case 'ai_summarize': need(textOk(config.instruction, FLOW_LIMITS.aiInstruction), 'say what the AI should write.'); break;
    case 'ai_classify': need(Array.isArray(config.labels) && config.labels.length >= 2 && config.labels.length <= FLOW_LIMITS.labels && config.labels.every(label => textOk(label, 40)), `give 2 to ${FLOW_LIMITS.labels} categories.`); need(textOk(config.instruction ?? '', FLOW_LIMITS.aiInstruction, false), 'keep the instruction shorter.'); break;
  }
  return p;
}

function stepProblems(step, where, { inBranch }) {
  if (!isObject(step) || typeof step.id !== 'string' || !ID.test(step.id)) return [`${where}: invalid step.`];
  switch (step.type) {
    case 'condition': return [...(['all', 'any'].includes(step.match) ? [] : [`${where}: choose all or any.`]), ...(step.rules?.length ? ruleProblems(step.rules, where) : [`${where}: add at least one rule.`])];
    case 'branch': {
      if (inBranch) return [`${where}: a path cannot contain another set of paths.`];
      if (!Array.isArray(step.paths) || step.paths.length < 2 || step.paths.length > FLOW_LIMITS.paths) return [`${where}: use 2 or 3 paths.`];
      const problems = [];
      step.paths.forEach((path, index) => {
        const name = `${where}, path ${index + 1}`;
        if (!isObject(path) || !ID.test(path.id || '')) { problems.push(`${name}: invalid path.`); return; }
        if (!textOk(path.label, 60)) problems.push(`${name}: give it a name.`);
        const last = index === step.paths.length - 1;
        if (!path.rules?.length && !last) problems.push(`${name}: only the last path can be “Otherwise”.`);
        if (path.rules?.length) { if (!['all', 'any'].includes(path.match)) problems.push(`${name}: choose all or any.`); problems.push(...ruleProblems(path.rules, name)); }
        if (!Array.isArray(path.steps)) problems.push(`${name}: invalid steps.`);
        else path.steps.forEach((inner, innerIndex) => problems.push(...stepProblems(inner, `${name}, step ${innerIndex + 1}`, { inBranch: true })));
      });
      return problems;
    }
    case 'wait':
      if (step.mode === 'duration') return Number.isInteger(step.minutes) && step.minutes >= 1 && step.minutes <= FLOW_LIMITS.waitMinutes ? [] : [`${where}: wait from 1 minute to 60 days.`];
      if (step.mode === 'until') return typeof step.at === 'string' && Number.isFinite(Date.parse(step.at)) ? [] : [`${where}: choose a date and time.`];
      return [`${where}: choose how long to wait.`];
    case 'wait_for':
      return [...(WAIT_EVENTS[step.event] ? [] : [`${where}: choose what to wait for.`]), ...(step.source == null || (typeof step.source === 'string' && step.source.length <= 64) ? [] : [`${where}: choose the form.`]),
        ...(Number.isInteger(step.timeout_minutes) && step.timeout_minutes >= 5 && step.timeout_minutes <= FLOW_LIMITS.timeoutMinutes ? [] : [`${where}: wait at most 30 days.`])];
    case 'approval':
      return [...(['admins', 'host', 'owner'].includes(step.approver) || /^member:[A-Za-z0-9-]{1,64}$/.test(step.approver || '') ? [] : [`${where}: choose who approves.`]),
        ...(Number.isInteger(step.expires_hours) && step.expires_hours >= 1 && step.expires_hours <= FLOW_LIMITS.approvalHours ? [] : [`${where}: approvals expire after 1 hour to 14 days.`]),
        ...(textOk(step.title, 200) ? [] : [`${where}: say what is being approved.`])];
    case 'stop': return textOk(step.reason ?? 'Stopped', 200) ? [] : [`${where}: keep the reason short.`];
    case 'action': return actionProblems(step, where);
    default: return [`${where}: unknown step.`];
  }
}

/** Structural problems with a definition (empty when it can be published, workspace checks aside). */
export function flowProblems(definition) {
  if (!isObject(definition)) return ['The workflow is missing.'];
  const problems = [];
  const trigger = definition.trigger;
  if (!isObject(trigger) || !TRIGGERS[trigger.type]) problems.push('Choose what starts the workflow.');
  else {
    const config = trigger.config || {};
    if (TRIGGERS[trigger.type].offset && !(Number.isInteger(config.minutes) && config.minutes >= 0 && config.minutes <= 10080)) problems.push('Choose how long before or after the meeting (up to 7 days).');
    if (trigger.type === 'sheets.cell.changed' && !(textOk(config.column, 100) && textOk(config.value, 200))) problems.push('Choose the column and the value it changes to.');
    if (trigger.type.startsWith('sheets.') && (!trigger.source || !textOk(config.sheet, 60))) problems.push('Choose the workbook and sheet.');
    if (trigger.type === 'schedule' && config.timezone !== undefined && !validTimeZone(config.timezone)) problems.push('Choose a valid time zone for the schedule.');
    if (trigger.type === 'schedule' && !(['hour', 'day', 'week'].includes(config.every) && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(config.time || '00:00') && (config.every !== 'week' || (Number.isInteger(config.weekday) && config.weekday >= 0 && config.weekday <= 6)))) problems.push('Choose how often it runs.');
  }
  if (!Array.isArray(definition.steps) || !definition.steps.length) return [...problems, 'Add at least one step.'];
  const all = flatten(definition.steps);
  if (all.length > FLOW_LIMITS.steps) problems.push(`Use up to ${FLOW_LIMITS.steps} steps.`);
  const ids = new Set();
  for (const step of all) { if (step?.id && ids.has(step.id)) problems.push('Two steps share an id. Duplicate the workflow again.'); if (step?.id) ids.add(step.id); }
  definition.steps.forEach((step, index) => problems.push(...stepProblems(step, `Step ${index + 1}`, { inBranch: false })));
  if (!all.some(step => step?.type === 'action')) problems.push('Add at least one action.');
  problems.push(...aiReviewProblems(definition.steps));
  return problems;
}

// AI-written text never leaves Schedora without a person approving it first: a message that uses an
// AI step's text must come after an approval step on the same path, after that AI step.
export function aiReviewProblems(steps) {
  const problems = [];
  const walk = (list, seenAi, approvedAi) => {
    for (const step of list) {
      if (step.type === 'action' && ACTIONS[step.action]?.ai && step.action !== 'ai_classify') seenAi = new Set([...seenAi, step.id]);
      if (step.type === 'approval') approvedAi = new Set([...approvedAi, ...seenAi]);
      if (step.type === 'action' && ACTIONS[step.action]?.message) {
        const used = JSON.stringify(step.config || {}).match(/steps\.([a-z0-9_-]{1,40})\.text/g) || [];
        for (const ref of used) {
          const id = ref.split('.')[1];
          if (seenAi.has(id) && !approvedAi.has(id)) problems.push(`“${stepTitle(step)}” sends AI-written text. Add an approval step after the AI step and before it.`);
        }
      }
      if (step.type === 'branch') for (const path of step.paths || []) walk(path.steps || [], seenAi, approvedAi);
    }
  };
  walk(steps, new Set(), new Set());
  return [...new Set(problems)];
}

// ---- Evaluation -----------------------------------------------------------------------------------

const asText = value => value == null ? '' : Array.isArray(value) ? value.join(', ') : String(value);

export function ruleHolds(rule, values) {
  const actual = asText(values[rule.field]).trim();
  const expected = asText(rule.value).trim();
  const lower = actual.toLowerCase();
  switch (rule.op) {
    case 'equals': return lower === expected.toLowerCase();
    case 'not_equals': return lower !== expected.toLowerCase();
    case 'contains': return lower.includes(expected.toLowerCase());
    case 'not_contains': return !lower.includes(expected.toLowerCase());
    case 'is_empty': return actual === '';
    case 'is_not_empty': return actual !== '';
    case 'greater_than': return actual !== '' && Number.isFinite(Number(actual)) && Number(actual) > Number(expected);
    case 'less_than': return actual !== '' && Number.isFinite(Number(actual)) && Number(actual) < Number(expected);
    default: return false;
  }
}

export const rulesHold = (match, rules, values) => match === 'any' ? rules.some(rule => ruleHolds(rule, values)) : rules.every(rule => ruleHolds(rule, values));

/** The path a branch takes: the first whose rules hold, else the “Otherwise” path, else none. */
export function choosePath(step, values) {
  return step.paths.find(path => path.rules?.length && rulesHold(path.match, path.rules, values)) || step.paths.find(path => !path.rules?.length) || null;
}

/** Fills {{field}} references. Values are inserted as plain text; nothing in them is interpreted. */
export const renderText = (template, values) => String(template ?? '').replace(/\{\{\s*([a-z][a-z0-9_.-]{0,80})\s*\}\}/g, (_, key) => asText(values[key]));

// ---- Plain language -------------------------------------------------------------------------------

const RECIPIENT = { contact: 'the contact', host: 'the host', owner: 'the owner' };
const recipientText = (to, labels = {}) => RECIPIENT[to] || (to?.startsWith('address:') ? to.slice(8) : to?.startsWith('member:') ? 'a team member' : to?.startsWith('field:') ? (labels[to.slice(6)] || 'an answer') : 'someone');
const duration = minutes => minutes % 1440 === 0 ? `${minutes / 1440} day${minutes === 1440 ? '' : 's'}` : minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `${minutes} minute${minutes === 1 ? '' : 's'}`;

export function stepTitle(step, labels = {}) {
  if (!step) return '';
  if (step.type === 'condition') return 'Only if ' + ruleSentence(step.match, step.rules, labels);
  if (step.type === 'branch') return `Choose a path (${(step.paths || []).map(path => path.label).join(', ')})`;
  if (step.type === 'wait') return step.mode === 'duration' ? `Wait ${duration(step.minutes)}` : `Wait until ${step.at}`;
  if (step.type === 'wait_for') return `Wait up to ${duration(step.timeout_minutes)} for ${WAIT_EVENTS[step.event] || 'something to happen'}`;
  if (step.type === 'approval') return `Ask ${step.approver === 'admins' ? 'an admin' : step.approver === 'host' ? 'the host' : step.approver === 'owner' ? 'the owner' : 'a team member'} to approve: ${step.title}`;
  if (step.type === 'stop') return 'Stop' + (step.reason ? `: ${step.reason}` : '');
  const config = step.config || {};
  switch (step.action) {
    case 'send_email': return `Email ${recipientText(config.to, labels)}: “${config.subject || ''}”`;
    case 'send_booking_link': return `Email a booking link to ${recipientText(config.to, labels)}`;
    case 'send_form': return `Email a prefilled form to ${recipientText(config.to, labels)}`;
    case 'create_task': return `Create a task${config.assign_to && config.assign_to !== 'none' ? ' for ' + recipientText(config.assign_to, labels) : ''}: “${config.title || ''}”`;
    case 'send_whatsapp': return `Send WhatsApp template “${config.template || ''}” to ${recipientText(config.to, labels)}`;
    case 'send_sms': return `Text ${recipientText(config.to, labels)}`;
    case 'sheet_row': return config.mode === 'add' ? 'Add a row to a sheet' : 'Update a row in a sheet';
    case 'assign_owner': return config.mode === 'round_robin' ? `Assign an owner in turn (${config.members?.length || 0} people)` : 'Assign an owner';
    default: return ACTIONS[step.action]?.label || 'Do something';
  }
}

export function ruleSentence(match, rules = [], labels = {}) {
  const parts = rules.map(rule => `${labels[rule.field] || rule.field} ${OPS[rule.op] || rule.op}${VALUELESS.includes(rule.op) ? '' : ` “${rule.value}”`}`);
  return parts.join(match === 'any' ? ' or ' : ' and ') || 'a rule matches';
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** True for an IANA time zone name this runtime knows (for example Asia/Kolkata). */
export function validTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone }); return true; } catch { return false; }
}

/** One sentence describing the whole workflow, shown above the builder. */
export function describeFlow(definition, { labels = {}, sourceName = '' } = {}) {
  if (!definition?.trigger?.type) return 'Choose what starts this workflow.';
  const trigger = TRIGGERS[definition.trigger.type];
  const config = definition.trigger.config || {};
  let start = trigger.label.replace(/^A /, 'a ').replace(/^Someone/, 'someone');
  if (trigger.offset) start = `${duration(config.minutes || 0)} ${definition.trigger.type.endsWith('before_start') ? 'before' : 'after'} a meeting${definition.trigger.type.endsWith('before_start') ? ' starts' : ' ends'}`;
  if (definition.trigger.type === 'sheets.cell.changed') start = `“${config.column}” changes to “${config.value}”`;
  if (definition.trigger.type === 'schedule') start = `every ${config.every === 'hour' ? `hour at minute ${(config.time || '00:00').slice(3)}` : `${config.every === 'week' ? WEEKDAYS[config.weekday ?? 1] : 'day'} at ${config.time || '09:00'}`} (${config.timezone || 'UTC'})`;
  const parts = [`When ${start}${sourceName ? ` (${sourceName})` : ''}`];
  const say = list => list.map(step => step.type === 'branch'
    ? `then choose a path: ${step.paths.map(path => `${path.rules?.length ? 'if ' + ruleSentence(path.match, path.rules, labels) : 'otherwise'}, ${path.steps.length ? say(path.steps) : 'do nothing'}`).join('; ')}`
    : step.type === 'condition' ? `only if ${ruleSentence(step.match, step.rules, labels)}` : stepTitle(step, labels).replace(/^./, c => c.toLowerCase())).join(', then ');
  return `${parts[0]}, ${say(definition.steps || [])}.`;
}

/** A legacy one-trigger/one-action flow as a v1 definition (used when it is first edited in the new builder). */
export function legacyDefinition(flow) {
  const config = flow.action_config || {};
  const to = config.to === 'invitee' ? 'contact' : config.to?.startsWith('field:') ? 'field:answer.' + config.to.slice(6) : config.to;
  const convert = template => String(template || '').replace(/\{\{\s*invitee\.(name|email)\s*\}\}/g, '{{contact.$1}}');
  const action = flow.action_type === 'task'
    ? { id: 'action', type: 'action', action: 'create_task', config: { title: convert(config.title), details: convert(config.details), assign_to: config.assign_to || 'none', ...(config.due_in_hours ? { due_in_hours: config.due_in_hours } : {}) } }
    : { id: 'action', type: 'action', action: 'send_email', config: { to, subject: convert(config.subject), body: convert(config.body) } };
  return { trigger: { type: flow.trigger_type, ...(flow.trigger_source ? { source: flow.trigger_source } : {}) }, steps: [action] };
}
