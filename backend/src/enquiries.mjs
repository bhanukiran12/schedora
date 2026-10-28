import { fail } from './http.mjs';
import { can } from './platform/workspaces.mjs';
import { nextStepSummary } from './forms/service.mjs';
import { runsForSubjects } from './flow/service.mjs';

// Workspace-wide enquiry feed: every form response and every direct booking (not made from a
// response, not superseded by a reschedule), newest arrival first, with keyset pagination, so no
// record falls outside a loading window. Each page carries every Flow run and task for its own
// enquiries. Arrival is the server's created_at; offer expiry is the stored handoff expiry.
// Attention states are still derived by the client from these records (enquiry-trail.mjs).

const MAX_LIMIT = 100;
const MAX_RESCHEDULE_HOPS = 10;

function parseCursor(value) {
  if (!value) return { at: Number.MAX_SAFE_INTEGER, id: '' };
  const match = /^(\d{1,16})\.([A-Za-z0-9-]{1,64})$/.exec(value);
  if (!match) fail(400, 'validation_failed', 'Invalid cursor.', { field: 'before' });
  return { at: Number(match[1]), id: match[2] };
}

// A name or email answer when the form asks for one, otherwise the receipt (as in the per-form view).
function respondentLabel(answers, definition, id) {
  const fields = definition?.fields || [];
  const name = fields.find(field => field.type === 'short_text' && (field.id === 'name' || /\bname\b/i.test(field.label)));
  const email = fields.find(field => field.type === 'email');
  const value = (name && answers?.[name.id]) || (email && answers?.[email.id]);
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : `Response ${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

// Keyset condition: strictly older than the cursor, ties broken by id.
const OLDER = column => `(${column}.created_at < ? OR (${column}.created_at = ? AND ${column}.id < ?))`;

function responsesPage(app, workspaceId, cursor, limit) {
  const rows = app.db.all(`SELECT r.id, r.form_id, r.form_version, r.answers, r.created_at, f.draft, v.definition,
      h.status AS handoff_status, h.reason AS handoff_reason, h.booking_id, h.expires_at AS handoff_expires_at
    FROM responses r JOIN forms f ON f.id = r.form_id
    LEFT JOIN form_versions v ON v.form_id = r.form_id AND v.version = r.form_version
    LEFT JOIN form_handoffs h ON h.response_id = r.id
    WHERE r.workspace_id = ? AND ${OLDER('r')} ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
  workspaceId, cursor.at, cursor.at, cursor.id, limit + 1);
  return rows.map(row => {
    const draft = JSON.parse(row.draft);
    const definition = row.definition ? JSON.parse(row.definition) : draft;
    return { kind: 'response', id: row.id, at: row.created_at, form_id: row.form_id, form_title: draft.title, title: respondentLabel(JSON.parse(row.answers), definition, row.id), next_step: nextStepSummary(app, workspaceId, row) };
  });
}

// True when the booking, or one it was rescheduled from, was made through a form response.
function fromResponse(app, workspaceId, booking) {
  let current = booking;
  for (let hops = 0; current && hops <= MAX_RESCHEDULE_HOPS; hops++) {
    if (app.db.get('SELECT 1 AS linked FROM form_handoffs WHERE booking_id = ? AND workspace_id = ?', current.id, workspaceId)) return true;
    current = current.rescheduled_from && app.db.get('SELECT id, rescheduled_from FROM bookings WHERE id = ? AND workspace_id = ?', current.rescheduled_from, workspaceId);
  }
  return false;
}

function directBookingsPage(app, workspaceId, actor, cursor, limit) {
  const all = can(actor.role, 'meet.manage_all');
  const items = [];
  let next = cursor;
  // Bookings made from a response appear under that response, so keep reading until the page is full.
  for (;;) {
    const rows = app.db.all(`SELECT b.id, b.reference, b.status, b.starts_at, b.created_at, b.invitee_name, b.canceled_by, b.rescheduled_from, e.title AS event_title
      FROM bookings b JOIN event_types e ON e.id = b.event_type_id
      WHERE b.workspace_id = ? AND b.rescheduled_to IS NULL AND ${OLDER('b')}
        AND (? = 1 OR EXISTS (SELECT 1 FROM meeting_hosts h WHERE h.meeting_id = b.meeting_id AND h.host_id = ?))
      ORDER BY b.created_at DESC, b.id DESC LIMIT ?`, workspaceId, next.at, next.at, next.id, all ? 1 : 0, actor.userId, limit + 1);
    for (const row of rows) {
      if (fromResponse(app, workspaceId, row)) continue;
      const { rescheduled_from, created_at, ...booking } = row;
      items.push({ kind: 'booking', id: row.id, at: created_at, booking: { ...booking, rescheduled: Boolean(rescheduled_from) } });
      if (items.length > limit) return items;
    }
    if (rows.length <= limit) return items;
    const last = rows[rows.length - 1];
    next = { at: last.created_at, id: last.id };
  }
}

// Booking ids a member may see follow-ups for: all for admins, otherwise meetings they host.
function visibleBookings(app, workspaceId, actor, ids) {
  if (!ids.length) return new Set();
  if (can(actor.role, 'meet.manage_all')) return new Set(ids);
  return new Set(app.db.all(`SELECT b.id FROM bookings b WHERE b.workspace_id = ? AND b.id IN (${ids.map(() => '?').join(', ')})
    AND EXISTS (SELECT 1 FROM meeting_hosts h WHERE h.meeting_id = b.meeting_id AND h.host_id = ?)`, workspaceId, ...ids, actor.userId).map(row => row.id));
}

export function listEnquiries(app, actor, { before, limit } = {}) {
  const workspaceId = actor.workspace.id;
  const size = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || 50));
  const cursor = parseCursor(before);
  const merged = [...responsesPage(app, workspaceId, cursor, size), ...directBookingsPage(app, workspaceId, actor, cursor, size)]
    .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const items = merged.slice(0, size);
  const linked = items.map(item => item.next_step?.booking_id).filter(Boolean);
  const visible = visibleBookings(app, workspaceId, actor, linked);
  for (const item of items) if (item.next_step?.booking_id) item.next_step.booking_visible = visible.has(item.next_step.booking_id);
  // Follow-ups only for this page's enquiries; linked bookings the member cannot see stay hidden.
  const subjects = [...items.map(item => item.id), ...linked.filter(id => visible.has(id))];
  const runs = runsForSubjects(app, workspaceId, subjects);
  const taskIds = runs.map(run => run.result?.task).filter(Boolean);
  const tasks = taskIds.length ? app.db.all(`SELECT id, title, status, source_run_id, created_at, completed_at FROM tasks WHERE workspace_id = ? AND id IN (${taskIds.map(() => '?').join(', ')})`, workspaceId, ...taskIds) : [];
  const last = items[items.length - 1];
  return { items, next: merged.length > size ? `${last.at}.${last.id}` : null, runs, tasks, now: app.now() };
}
