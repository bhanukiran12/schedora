import { can } from '../platform/workspaces.mjs';
import { answerText, leadScore } from '../shared/forms-logic.mjs';
import { baseFields, TRIGGERS } from '../shared/flow-logic.mjs';
import { formatInstant } from '../meet/bookings.mjs';

// What a Flow run knows about its record (docs/FLOW_V1_IMPLEMENTATION.md, "Context"). Values are read
// fresh each time the run resumes, so a condition after a wait sees the current state (for example a
// later no-show). Everything is plain text keyed by the field names the builder offers.

const lower = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
export const subjectOf = type => TRIGGERS[type]?.subject || 'none';

function contactValues(app, workspaceId, email) {
  const contact = email && app.db.get('SELECT c.*, u.name AS owner_name, u.email AS owner_email FROM contacts c LEFT JOIN users u ON u.id = c.owner_id WHERE c.workspace_id = ? AND lower(c.email) = ?', workspaceId, lower(email));
  return {
    contact,
    values: contact ? { 'owner.id': contact.owner_id || '', 'contact.owner': contact.owner_name || '', 'owner.name': contact.owner_name || '', 'owner.email': contact.owner_email || '', 'contact.company': contact.company || '', 'contact.tags': JSON.parse(contact.tags || '[]').join(', ') } : {}
  };
}

function bookingContext(app, workspaceId, bookingId) {
  const row = app.db.get(`SELECT b.*, e.title AS event_title, e.timezone AS host_timezone, u.name AS host_name, u.email AS host_email, a.status AS attendance
    FROM bookings b JOIN event_types e ON e.id = b.event_type_id JOIN users u ON u.id = b.host_id LEFT JOIN booking_attendance a ON a.booking_id = b.id
    WHERE b.id = ? AND b.workspace_id = ?`, bookingId, workspaceId);
  if (!row || row.anonymized_at) return null;
  const { contact, values } = contactValues(app, workspaceId, row.invitee_email);
  // A booking made from a form's booking handoff carries that response's answers and private lead score
  // (for host preparation). The latest recap of this meeting, if any, is available for follow-ups.
  const handoff = app.db.get('SELECT response_id FROM form_handoffs WHERE booking_id = ? AND workspace_id = ?', row.id, workspaceId);
  const response = handoff && responseContext(app, workspaceId, handoff.response_id);
  const answers = response ? Object.entries(response.values).filter(([name]) => name.startsWith('answer.')).map(([name, value]) => `${response.definition.fields.find(field => 'answer.' + field.id === name)?.label || name}: ${value}`).join(String.fromCharCode(10)) : '';
  const recap = row.meeting_id && app.db.get('SELECT r.summary FROM recaps r JOIN transcripts t ON t.id = r.transcript_id WHERE t.meeting_id = ? AND t.workspace_id = ? ORDER BY r.created_at DESC LIMIT 1', row.meeting_id, workspaceId);
  return {
    kind: 'booking', bookingStatus: row.status, email: row.invitee_email, phone: row.invitee_phone, name: row.invitee_name, hostId: row.host_id, contact, eventTypeId: row.event_type_id, bookingId: row.id,
    whatsappConsent: Boolean(app.db.get('SELECT whatsapp FROM booking_message_consent WHERE booking_id = ?', row.id)?.whatsapp),
    values: {
      'contact.name': row.invitee_name, 'contact.email': row.invitee_email, 'contact.phone': row.invitee_phone || '', ...values,
      'booking.start': formatInstant(row.starts_at, row.invitee_timezone), 'booking.start_host': formatInstant(row.starts_at, row.host_timezone), 'booking.reference': row.reference,
      'booking.status': row.status, 'event.title': row.event_title, 'host.name': row.host_name, 'host.email': row.host_email, attendance: row.attendance || '',
      'form.answers': answers, ...(response?.values['lead.band'] ? { 'lead.band': response.values['lead.band'], 'lead.score': response.values['lead.score'] } : {}), 'meeting.recap': recap?.summary || ''
    },
    recipients: { host: row.host_email }
  };
}

function responseContext(app, workspaceId, responseId) {
  const row = app.db.get(`SELECT r.*, v.definition, p.status AS pay_status, p.amount_paid, p.completed_at AS pay_completed
    FROM responses r JOIN form_versions v ON v.form_id = r.form_id AND v.version = r.form_version LEFT JOIN form_payments p ON p.response_id = r.id
    WHERE r.id = ? AND r.workspace_id = ?`, responseId, workspaceId);
  if (!row) return null;
  const definition = JSON.parse(row.definition);
  const answers = JSON.parse(row.answers);
  const fields = definition.fields.filter(field => field.type !== 'page_break');
  const values = { 'form.title': definition.title, 'response.reference': row.id.replace(/-/g, '').slice(0, 8).toUpperCase(), 'response.id': row.id };
  for (const field of fields) values['answer.' + field.id] = answerText(field, answers[field.id]);
  const score = leadScore(definition, answers);
  if (score) Object.assign(values, { 'lead.score': String(score.score), 'lead.band': score.band });
  if (row.pay_status) Object.assign(values, { 'payment.status': row.pay_status, 'payment.amount': row.amount_paid ? (row.amount_paid / 100).toFixed(2) : '' });
  const emailField = fields.find(field => field.type === 'email' && answers[field.id]);
  const phoneField = fields.find(field => field.type === 'phone' && answers[field.id]);
  const name = typeof answers.name === 'string' ? answers.name : [answers.first_name, answers.last_name].filter(part => typeof part === 'string' && part).join(' ');
  const email = emailField ? answers[emailField.id] : null;
  const { contact, values: contactFields } = contactValues(app, workspaceId, email);
  const consent = app.db.get("SELECT phone, status FROM form_message_consents WHERE response_id = ? AND withdrawn_at IS NULL AND status IN ('consented', 'queued')", row.id);
  return {
    kind: 'response', email, phone: phoneField ? answers[phoneField.id] : null, name, contact, formId: row.form_id, responseId: row.id, definition, answers,
    paymentIncomplete: Boolean(row.pay_status && !row.pay_completed), whatsappConsent: Boolean(consent), whatsappPhone: consent?.phone || null,
    values: { 'contact.name': name || contact?.name || '', 'contact.email': email || '', 'contact.phone': phoneField ? String(answers[phoneField.id]) : contact?.phone || '', ...contactFields, ...values },
    recipients: {}
  };
}

// A sheet row as it was when the trigger fired (rows have no permanent identity in a workbook).
function rowContext(app, workspaceId, data) {
  const values = { 'row.number': String(data.row), 'sheet.name': data.sheet_name || '', 'workbook.title': data.workbook_title || '', 'change.column': data.column || '', 'change.value': data.value || '' };
  for (const [header, value] of Object.entries(data.values || {})) values['row.' + header.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60)] = String(value ?? '');
  const emailHeader = Object.keys(data.values || {}).find(header => /e-?mail/i.test(header) && /@/.test(String(data.values[header])));
  const email = emailHeader ? String(data.values[emailHeader]).trim() : null;
  const { contact, values: contactFields } = contactValues(app, workspaceId, email);
  const nameHeader = Object.keys(data.values || {}).find(header => /^name$|full name/i.test(header));
  return { kind: 'row', email, name: nameHeader ? String(data.values[nameHeader]) : contact?.name || '', contact, workbookId: data.workbook, row: data,
    values: { 'contact.name': nameHeader ? String(data.values[nameHeader]) : contact?.name || '', 'contact.email': email || '', 'contact.phone': contact?.phone || '', ...contactFields, ...values }, recipients: {} };
}

function webhookContext(app, workspaceId, data) {
  const values = { 'webhook.event': String(data.event || '') };
  for (const [key, value] of Object.entries(data.fields || {})) values['webhook.' + key] = String(value);
  const email = typeof data.fields?.email === 'string' && /@/.test(data.fields.email) ? data.fields.email : null;
  const { contact, values: contactFields } = contactValues(app, workspaceId, email);
  return { kind: 'webhook', email, name: data.fields?.name || contact?.name || '', contact, values: { 'contact.name': data.fields?.name || contact?.name || '', 'contact.email': email || '', ...contactFields, ...values }, recipients: {} };
}

/** The record behind a run, or null when it no longer exists (deleted or anonymized by retention). */
export function loadContext(app, run) {
  const subject = subjectOf(run.event_type);
  const data = run.trigger_data ? JSON.parse(run.trigger_data) : {};
  let context;
  if (subject === 'booking') context = bookingContext(app, run.workspace_id, run.subject_id);
  else if (subject === 'response') context = responseContext(app, run.workspace_id, run.subject_id);
  else if (subject === 'row') context = rowContext(app, run.workspace_id, data);
  else if (subject === 'webhook') context = webhookContext(app, run.workspace_id, data);
  else context = { kind: 'none', values: {}, recipients: {} };
  if (!context) return null;
  context.values['now.date'] = new Date(app.now()).toISOString().slice(0, 10);
  return context;
}

/** The key a "wait until they …" step listens for, and the keys an event satisfies. */
export const waitKey = context => context?.email ? 'email:' + lower(context.email) : context?.responseId ? 'response:' + context.responseId : null;

export function eventKeys(app, event) {
  const keys = [];
  if (event.type === 'meet.booking.created') {
    const booking = app.db.get('SELECT invitee_email FROM bookings WHERE id = ? AND workspace_id = ?', event.subject_id, event.workspace_id);
    if (booking) keys.push('email:' + lower(booking.invitee_email));
    // A booking made through a form's booking handoff also answers that response's wait.
    const handoff = app.db.get('SELECT response_id FROM form_handoffs WHERE booking_id = ?', event.subject_id);
    if (handoff) keys.push('response:' + handoff.response_id);
  } else if (event.type === 'forms.response.created' || event.type === 'payments.captured') {
    const context = responseContext(app, event.workspace_id, event.subject_id);
    if (context?.email) keys.push('email:' + lower(context.email));
    keys.push('response:' + event.subject_id);
  }
  return keys;
}

// ---- Builder support: fields, samples and recent records (permission-checked) ---------------------

const mask = value => {
  const text = String(value ?? '');
  if (/@/.test(text)) { const [user, domain] = text.split('@'); return `${user.slice(0, 1)}***@${domain}`; }
  if (/^\+?[0-9 ()-]{7,}$/.test(text)) return text.slice(0, 3) + '•••' + text.slice(-2);
  return text.length > 120 ? text.slice(0, 117) + '…' : text;
};
export { mask as maskValue };

/** Recent records an author may test with: bookings they can see, responses, or none. */
export function recentRecords(app, actor, definition, limit = 5) {
  const trigger = definition?.trigger;
  const subject = subjectOf(trigger?.type);
  const workspaceId = actor.workspace.id;
  if (subject === 'booking') {
    const admin = can(actor.role, 'meet.manage_all');
    return app.db.all(`SELECT b.id, b.invitee_name AS label, b.starts_at AS at FROM bookings b WHERE b.workspace_id = ? AND b.anonymized_at IS NULL AND (? IS NULL OR b.event_type_id = ?)
      AND (? = 1 OR EXISTS (SELECT 1 FROM meeting_hosts h WHERE h.meeting_id = b.meeting_id AND h.host_id = ?)) ORDER BY b.created_at DESC, b.id DESC LIMIT ?`,
    workspaceId, trigger.source ?? null, trigger.source ?? null, admin ? 1 : 0, actor.userId, limit).map(row => ({ id: row.id, label: `${row.label} · ${new Date(row.at).toISOString().slice(0, 16).replace('T', ' ')} UTC` }));
  }
  if (subject === 'response') {
    return app.db.all('SELECT id, created_at FROM responses WHERE workspace_id = ? AND (? IS NULL OR form_id = ?) ORDER BY created_at DESC, id DESC LIMIT ?', workspaceId, trigger.source ?? null, trigger.source ?? null, limit)
      .map(row => ({ id: row.id, label: `Response ${row.id.replace(/-/g, '').slice(0, 8).toUpperCase()} · ${new Date(row.created_at).toISOString().slice(0, 16).replace('T', ' ')} UTC` }));
  }
  if (subject === 'row' && trigger.source && trigger.config?.sheet) {
    const book = app.db.get('SELECT sheets FROM workbooks WHERE id = ? AND workspace_id = ?', trigger.source, workspaceId);
    const sheet = book && JSON.parse(book.sheets).find(item => item.id === trigger.config.sheet);
    if (!sheet) return [];
    const rows = [...new Set(Object.keys(sheet.cells).map(address => Number(/\d+$/.exec(address)[0])))].filter(row => row > 1).sort((a, b) => b - a).slice(0, limit);
    return rows.map(row => ({ id: `row:${row}`, label: `Row ${row}` }));
  }
  return [];
}

/** A fictional record for triggers with nothing recent to test with. */
export function sampleTriggerData(definition) {
  if (subjectOf(definition.trigger.type) === 'webhook') return { event: 'sample', fields: { name: 'Sample Person', email: 'sample@example.com' } };
  return {};
}

/** Field list with one masked sample value each, from the latest record the author may see. */
export function fieldCatalog(app, actor, definition) {
  const type = definition?.trigger?.type;
  const fields = [...baseFields(type)];
  if (subjectOf(type) === 'response' && definition.trigger.source) {
    const form = app.db.get('SELECT COALESCE(v.definition, f.draft) AS definition FROM forms f LEFT JOIN form_versions v ON v.form_id = f.id AND v.version = f.published_version WHERE f.id = ? AND f.workspace_id = ?', definition.trigger.source, actor.workspace.id);
    if (form) for (const field of JSON.parse(form.definition).fields) if (field.type !== 'page_break') fields.push(['answer.' + field.id, `Answer: ${field.label}`]);
  }
  const record = recentRecords(app, actor, definition, 1)[0];
  let sample = {};
  if (record) {
    const runLike = subjectOf(type) === 'row'
      ? { event_type: type, workspace_id: actor.workspace.id, subject_id: definition.trigger.source, trigger_data: JSON.stringify(rowSnapshot(app, actor.workspace.id, definition.trigger.source, definition.trigger.config.sheet, Number(record.id.slice(4)))) }
      : { event_type: type, workspace_id: actor.workspace.id, subject_id: record.id };
    sample = loadContext(app, runLike)?.values || {};
    if (subjectOf(type) === 'row') for (const key of Object.keys(sample)) if (key.startsWith('row.') && !fields.some(([name]) => name === key)) fields.push([key, `Column: ${key.slice(4).replace(/_/g, ' ')}`]);
  }
  return fields.map(([key, label]) => ({ key, label, sample: sample[key] != null && sample[key] !== '' ? mask(sample[key]) : null }));
}

/** A sheet row's values by header, from a standalone workbook (canonical linked tabs are never rows here). */
export function rowSnapshot(app, workspaceId, workbookId, sheetId, rowNumber) {
  const book = app.db.get('SELECT title, sheets FROM workbooks WHERE id = ? AND workspace_id = ?', workbookId, workspaceId);
  const sheet = book && JSON.parse(book.sheets).find(item => item.id === sheetId);
  if (!sheet) return null;
  const values = {};
  for (const [address, value] of Object.entries(sheet.cells)) {
    const match = /^([A-Z]+)(\d+)$/.exec(address);
    if (!match || Number(match[2]) !== rowNumber) continue;
    const header = sheet.cells[match[1] + '1'];
    if (header) values[String(header).slice(0, 100)] = String(value ?? '').slice(0, 2000);
  }
  return { workbook: workbookId, workbook_title: book.title, sheet: sheetId, sheet_name: sheet.name, row: rowNumber, values };
}
