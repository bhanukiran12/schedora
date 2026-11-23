import { randomUUID } from 'node:crypto';
import { fail } from '../http.mjs';
import { can } from '../platform/workspaces.mjs';
import { queueEmail } from '../platform/email.mjs';
import { claude, getTranscript } from './service.mjs';

// Reviewed post-meeting follow-ups (docs/MEET_VIDEO.md, "Reviewed AI follow-up").
//
// - A draft is generated from one transcript the member can already read (meet.manage_own). Every source
//   quote and every task's quote must appear word for word in the transcript; anything that does not is
//   removed before the draft is shown, and the number removed is reported to the reviewer.
// - The draft is only text: editing it changes nothing outside Schedora. Sending is a separate, explicit
//   action that names the revision the person reviewed. Emails go only to the recipients they confirmed and
//   tasks are created only when they ask for them. Nothing is sent or created automatically.
// - Generation is idempotent per request ID, measured (input/output tokens) and limited per workspace per
//   day. Sending is idempotent: a repeated send returns the first result and never sends twice.

const DAILY_LIMIT = 20;
const LIMITS = { subject: 200, body: 8000, recipients: 20, tasks: 20, task: 300, quote: 500 };
const since = app => Math.floor(app.now() / 86400000) * 86400000;
const normalize = value => String(value || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['subject', 'body', 'tasks', 'sources'],
  properties: {
    subject: { type: 'string' },
    body: { type: 'string', description: 'Plain-text follow-up email from the host to the other participants.' },
    tasks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'owner', 'due', 'quote'], properties: {
      title: { type: 'string' }, owner: { type: 'string', description: 'Person responsible as named in the transcript, or "Unassigned".' },
      due: { type: 'string', description: 'Timing as stated, or "Not set".' }, quote: { type: 'string', description: 'Exact words from the transcript that support this task.' } } } },
    sources: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['quote', 'supports'], properties: {
      quote: { type: 'string', description: 'Exact words copied from the transcript.' }, supports: { type: 'string', description: 'Which statement in the email this quote supports.' } } } }
  }
};

export function followupUsage(app, workspaceId) {
  const used = Number(app.db.get('SELECT COUNT(*) AS count FROM meeting_followups WHERE workspace_id = ? AND created_at >= ?', workspaceId, since(app)).count);
  return { available: Boolean(app.anthropic), used, limit: DAILY_LIMIT, remaining: Math.max(0, DAILY_LIMIT - used), resets_at: since(app) + 86400000 };
}

const parse = value => { try { return JSON.parse(value); } catch { return []; } };
const present = row => row && {
  id: row.id, transcript_id: row.transcript_id, status: row.status, subject: row.subject, body: row.body, recipients: parse(row.recipients), tasks: parse(row.tasks), sources: parse(row.sources),
  removed_unsupported: row.removed_unsupported, revision: row.revision, edited: Boolean(row.edited), error: row.error, created_by: row.created_by,
  usage: { input_tokens: row.input_tokens, output_tokens: row.output_tokens }, reviewed_at: row.reviewed_at, sent_at: row.sent_at,
  sent_emails: row.sent_emails, created_tasks: row.created_tasks, created_at: row.created_at, updated_at: row.updated_at
};

// Attendees of the transcript's meeting, as suggestions the reviewer confirms or removes.
function meetingRecipients(app, transcript) {
  if (!transcript.meeting_id) return [];
  const emails = new Set();
  for (const booking of app.db.all("SELECT invitee_email, guests FROM bookings WHERE meeting_id = ? AND workspace_id = ? AND status <> 'canceled' AND anonymized_at IS NULL", transcript.meeting_id, transcript.workspace_id)) {
    if (EMAIL.test(booking.invitee_email || '')) emails.add(booking.invitee_email.toLowerCase());
    for (const guest of parse(booking.guests || '[]')) if (typeof guest === 'string' && EMAIL.test(guest)) emails.add(guest.toLowerCase());
  }
  return [...emails].slice(0, LIMITS.recipients);
}

function grounded(transcript, draft) {
  const text = normalize(transcript.content);
  const found = quote => typeof quote === 'string' && normalize(quote).length >= 8 && text.includes(normalize(quote));
  const sources = (Array.isArray(draft.sources) ? draft.sources : []).filter(item => found(item?.quote))
    .map(item => ({ quote: String(item.quote).slice(0, LIMITS.quote), supports: String(item.supports || '').slice(0, 300) })).slice(0, 30);
  const tasks = (Array.isArray(draft.tasks) ? draft.tasks : []).filter(item => found(item?.quote) && typeof item.title === 'string' && item.title.trim())
    .map(item => ({ title: item.title.trim().slice(0, LIMITS.task), owner: String(item.owner || 'Unassigned').slice(0, 100), due: String(item.due || 'Not set').slice(0, 100), quote: String(item.quote).slice(0, LIMITS.quote) })).slice(0, LIMITS.tasks);
  const removed = (draft.sources?.length || 0) - sources.length + (draft.tasks?.length || 0) - tasks.length;
  return { sources, tasks, removed: Math.max(0, removed) };
}

export async function createFollowup(app, actor, transcriptId, body = {}) {
  if (!app.anthropic) fail(503, 'ai_not_configured', 'AI is not connected on this server. Your transcripts and recaps are unchanged.');
  const transcript = getTranscript(app, actor.workspace.id, transcriptId);
  const requestId = body.request_id ?? randomUUID();
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(requestId)) fail(400, 'validation_failed', 'Use a valid request ID.');
  const reserved = app.db.transaction(() => {
    const old = app.db.get('SELECT * FROM meeting_followups WHERE request_id = ?', requestId);
    if (old) {
      if (old.workspace_id !== actor.workspace.id || old.created_by !== actor.userId || old.transcript_id !== transcriptId) fail(409, 'ai_request_conflict', 'Start a new follow-up request.');
      if (old.status === 'generating') fail(409, 'ai_request_pending', 'This follow-up is still being written.');
      return { existing: old };
    }
    if (!followupUsage(app, actor.workspace.id).remaining) fail(429, 'ai_daily_limit', `This workspace has used its ${DAILY_LIMIT} daily AI follow-up drafts. The budget resets at 00:00 UTC.`);
    const id = randomUUID();
    const now = app.now();
    app.db.run("INSERT INTO meeting_followups (id, workspace_id, transcript_id, created_by, request_id, status, recipients, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'generating', ?, ?, ?)",
      id, actor.workspace.id, transcriptId, actor.userId, requestId, JSON.stringify(meetingRecipients(app, transcript)), now, now);
    return { id };
  });
  if (reserved.existing) return present(reserved.existing);
  let response;
  try {
    response = await claude(app, {
      max_tokens: 8000,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      system: 'You draft a follow-up email after a meeting, for the host to review and edit before anything is sent. Use only what the transcript says. '
        + 'Do not invent names, dates, prices or commitments. For every task and every factual statement, copy the exact supporting words from the transcript into a quote. '
        + 'If the transcript does not support something, leave it out. Write plain text, warm and concise.',
      messages: [{ role: 'user', content: `Meeting title: ${transcript.title}\n\n<transcript>\n${transcript.content}\n</transcript>` }]
    });
  } catch (error) {
    app.db.run("UPDATE meeting_followups SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", String(error.message).slice(0, 300), app.now(), reserved.id);
    throw error;
  }
  const tokens = [Math.max(0, Math.trunc(response.usage?.input_tokens || 0)), Math.max(0, Math.trunc(response.usage?.output_tokens || 0))];
  let draft;
  try { draft = JSON.parse(response.content.filter(item => item.type === 'text').map(item => item.text).join('')); } catch { draft = null; }
  if (!draft || typeof draft.subject !== 'string' || typeof draft.body !== 'string' || !draft.body.trim()) {
    app.db.run("UPDATE meeting_followups SET status = 'failed', error = 'The AI returned an unreadable draft.', input_tokens = ?, output_tokens = ?, updated_at = ? WHERE id = ?", ...tokens, app.now(), reserved.id);
    fail(502, 'ai_invalid_result', 'The AI returned an unreadable draft. Nothing was sent.');
  }
  const { sources, tasks, removed } = grounded(transcript, draft);
  app.db.run(`UPDATE meeting_followups SET status = 'draft', subject = ?, body = ?, tasks = ?, sources = ?, removed_unsupported = ?, input_tokens = ?, output_tokens = ?, updated_at = ? WHERE id = ?`,
    draft.subject.trim().slice(0, LIMITS.subject), draft.body.trim().slice(0, LIMITS.body), JSON.stringify(tasks), JSON.stringify(sources), removed, ...tokens, app.now(), reserved.id);
  return present(app.db.get('SELECT * FROM meeting_followups WHERE id = ?', reserved.id));
}

export function listFollowups(app, actor, transcriptId) {
  getTranscript(app, actor.workspace.id, transcriptId);
  return { followups: app.db.all("SELECT * FROM meeting_followups WHERE transcript_id = ? AND workspace_id = ? AND status <> 'discarded' ORDER BY created_at DESC LIMIT 20", transcriptId, actor.workspace.id).map(present), usage: followupUsage(app, actor.workspace.id) };
}

function ownFollowup(app, actor, id) {
  const row = app.db.get('SELECT * FROM meeting_followups WHERE id = ? AND workspace_id = ?', id, actor.workspace.id);
  if (!row) fail(404, 'not_found', 'Follow-up not found.');
  if (row.created_by !== actor.userId && !can(actor.role, 'meet.manage_all')) fail(403, 'forbidden', 'Only the person who drafted this follow-up or a workspace admin can change or send it.');
  return row;
}

const cleanRecipients = list => {
  if (!Array.isArray(list) || list.length > LIMITS.recipients) fail(400, 'validation_failed', `Add up to ${LIMITS.recipients} recipients.`, { field: 'recipients' });
  const emails = [...new Set(list.map(item => String(item || '').trim().toLowerCase()).filter(Boolean))];
  const bad = emails.find(item => !EMAIL.test(item) || item.length > 254);
  if (bad) fail(400, 'validation_failed', `“${bad.slice(0, 80)}” is not an email address.`, { field: 'recipients' });
  return emails;
};

export function updateFollowup(app, actor, id, body) {
  return app.db.transaction(() => {
    const row = ownFollowup(app, actor, id);
    if (row.status !== 'draft') fail(409, 'followup_closed', row.status === 'sent' ? 'This follow-up was already sent.' : 'This follow-up can no longer be edited.');
    if (body.revision !== row.revision) fail(409, 'followup_conflict', 'This draft changed in another tab. Reload it to see the latest version.', { current: present(row) });
    const subject = typeof body.subject === 'string' ? body.subject.trim() : row.subject;
    const text = typeof body.body === 'string' ? body.body.trim() : row.body;
    if (!subject || subject.length > LIMITS.subject) fail(400, 'validation_failed', `Write a subject of up to ${LIMITS.subject} characters.`, { field: 'subject' });
    if (!text || text.length > LIMITS.body) fail(400, 'validation_failed', `Write a message of up to ${LIMITS.body.toLocaleString('en-US')} characters.`, { field: 'body' });
    const recipients = body.recipients === undefined ? parse(row.recipients) : cleanRecipients(body.recipients);
    let tasks = parse(row.tasks);
    if (body.tasks !== undefined) {
      if (!Array.isArray(body.tasks) || body.tasks.length > LIMITS.tasks) fail(400, 'validation_failed', `Keep up to ${LIMITS.tasks} tasks.`, { field: 'tasks' });
      // People may reword or remove tasks; each keeps the transcript quote it came from.
      const byQuote = new Map(tasks.map(task => [task.quote, task]));
      tasks = body.tasks.map(task => {
        const source = byQuote.get(task?.quote);
        if (!source) fail(400, 'validation_failed', 'Tasks can be edited or removed, but each must keep its transcript source.', { field: 'tasks' });
        const title = String(task.title || '').trim();
        if (!title || title.length > LIMITS.task) fail(400, 'validation_failed', `Give each task a title of up to ${LIMITS.task} characters.`, { field: 'tasks' });
        return { ...source, title, owner: String(task.owner || source.owner).slice(0, 100), due: String(task.due || source.due).slice(0, 100) };
      });
    }
    app.db.run('UPDATE meeting_followups SET subject = ?, body = ?, recipients = ?, tasks = ?, revision = revision + 1, edited = 1, updated_at = ? WHERE id = ? AND revision = ?',
      subject, text, JSON.stringify(recipients), JSON.stringify(tasks), app.now(), id, row.revision);
    return present(app.db.get('SELECT * FROM meeting_followups WHERE id = ?', id));
  });
}

/**
 * The only way anything leaves a draft. The caller must confirm the exact revision they reviewed and choose
 * what to do: email the confirmed recipients, create the tasks, or both. Repeating it is safe.
 */
export function sendFollowup(app, actor, id, body) {
  return app.db.transaction(() => {
    const row = ownFollowup(app, actor, id);
    if (row.status === 'sent') return { ...present(row), replay: true };
    if (row.status !== 'draft') fail(409, 'followup_closed', 'This follow-up can no longer be sent.');
    if (body.confirm !== true) fail(400, 'review_required', 'Review the draft and confirm before sending.');
    if (body.revision !== row.revision) fail(409, 'followup_conflict', 'The draft changed after you reviewed it. Review the latest version, then send.', { current: present(row) });
    const sendEmail = body.send_email === true;
    const createTasks = body.create_tasks === true;
    if (!sendEmail && !createTasks) fail(400, 'validation_failed', 'Choose to send the email, create the tasks, or both.');
    const recipients = parse(row.recipients);
    const tasks = parse(row.tasks);
    if (sendEmail && !recipients.length) fail(400, 'validation_failed', 'Add at least one recipient before sending.', { field: 'recipients' });
    if (createTasks && !tasks.length) fail(400, 'validation_failed', 'There are no tasks to create.', { field: 'tasks' });
    const transcript = app.db.get('SELECT title FROM transcripts WHERE id = ?', row.transcript_id);
    const now = app.now();
    let emails = 0;
    let created = 0;
    if (sendEmail) for (const to of recipients) {
      queueEmail(app, { workspaceId: row.workspace_id, key: `meeting-followup:${row.id}:${to}`, kind: 'meeting_followup', relatedId: row.id, to, subject: row.subject, body: row.body });
      emails++;
    }
    if (createTasks) tasks.forEach((task, index) => {
      const details = `From the follow-up for "${transcript?.title || 'a meeting'}". Owner named in the meeting: ${task.owner}. Timing: ${task.due}.\n\nTranscript: “${task.quote}”`;
      created += app.db.run("INSERT OR IGNORE INTO tasks (id, workspace_id, source_run_id, title, details, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)",
        randomUUID(), row.workspace_id, `followup:${row.id}:${index}`, task.title.slice(0, 300), details.slice(0, 4000), now).changes;
    });
    app.db.run("UPDATE meeting_followups SET status = 'sent', reviewed_by = ?, reviewed_at = ?, sent_at = ?, sent_emails = ?, created_tasks = ?, updated_at = ? WHERE id = ? AND status = 'draft'", actor.userId, now, now, emails, created, now, row.id);
    app.nudge?.();
    return present(app.db.get('SELECT * FROM meeting_followups WHERE id = ?', row.id));
  });
}

export function discardFollowup(app, actor, id) {
  const row = ownFollowup(app, actor, id);
  if (row.status === 'sent') fail(409, 'followup_closed', 'A sent follow-up cannot be discarded.');
  app.db.run("UPDATE meeting_followups SET status = 'discarded', updated_at = ? WHERE id = ?", app.now(), id);
}
