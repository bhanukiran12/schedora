import { randomBytes, randomUUID } from 'node:crypto';
import { fail } from '../http.mjs';
import { addDays, isValidTimeZone, localDate } from '../time.mjs';
import { email as validEmail, invalid, text } from '../validate.mjs';
import { sha256, newToken } from '../platform/auth.mjs';
import { can } from '../platform/workspaces.mjs';
import { cancelPendingEmails, emailStatusFor, queueEmail } from '../platform/email.mjs';
import { consumeQuota, requireEntitlement } from '../billing/entitlements.mjs';
import { bufferedBlock, generateSlots } from './availability.mjs';
import { scheduleFor } from './event-types.mjs';
import { bookingIcs } from './ics.mjs';

const DAY = 86400000;
const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const reference = () => 'SCH-' + [...randomBytes(6)].map(byte => REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length]).join('');

export function formatInstant(ms, timeZone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'full', timeStyle: 'short' }).format(new Date(ms)) + ` (${timeZone})`;
}

function hostConflicts(app, hostId, from, to) {
  return {
    bookings: app.db.all("SELECT starts_at, ends_at, block_start, block_end FROM bookings WHERE host_id = ? AND status = 'confirmed' AND block_end > ? AND block_start < ?", hostId, from, to),
    busy: app.db.all('SELECT starts_at, ends_at FROM busy_blocks WHERE host_id = ? AND ends_at > ? AND starts_at < ?', hostId, from, to)
  };
}

// Available UTC slot starts for a published event type. fromDate/toDate are host-local dates.
export function availableSlots(app, eventType, { fromDate, toDate } = {}) {
  const now = app.now();
  const { rules, overrides } = scheduleFor(app, eventType.id);
  const windowEnd = now + (eventType.horizon_days + 2) * DAY;
  const { bookings, busy } = hostConflicts(app, eventType.host_id, now - DAY, windowEnd);
  return generateSlots({ eventType, rules, overrides: overrides.map(o => o.unavailable ? { date: o.date, start_min: null, end_min: null } : o), bookings, busy, now, fromDate, toDate });
}

function isSlotAvailable(app, eventType, start) {
  const date = localDate(start, eventType.timezone);
  return availableSlots(app, eventType, { fromDate: addDays(date, -1), toDate: addDays(date, 1) }).includes(start);
}

function parseStart(value) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/.test(value)) invalid('start', 'Choose an available time.');
  return ms;
}

function inviteeInput(body) {
  const timezone = body.timezone;
  if (!isValidTimeZone(timezone)) invalid('timezone', 'Choose a valid time zone.');
  return {
    name: text(body.name, 'name', { min: 1, max: 100 }),
    email: validEmail(body.email),
    notes: text(body.notes, 'notes', { max: 1000, multiline: true }),
    timezone
  };
}

function manageUrl(app, token) {
  return `${app.config.baseUrl}/meet/manage/${token}`;
}

function queueBookingEmails(app, { booking, eventType, token, kind }) {
  const now = app.now();
  const when = formatInstant(booking.starts_at, booking.invitee_timezone);
  const hostWhen = formatInstant(booking.starts_at, eventType.timezone);
  const location = eventType.location || 'Location to be confirmed by the host';
  const manage = token ? `\n\nNeed to change plans? Reschedule or cancel: ${manageUrl(app, token)}` : '';
  const subjectVerb = kind === 'rescheduled' ? 'Rescheduled' : 'Confirmed';
  queueEmail(app, {
    workspaceId: booking.workspace_id, key: `booking:${booking.id}:invitee-confirmation`, kind: 'confirmation', relatedId: booking.id,
    to: booking.invitee_email,
    subject: `${subjectVerb}: ${eventType.title} with ${eventType.host_name}`,
    body: `Hi ${booking.invitee_name},\n\nYour appointment is ${kind === 'rescheduled' ? 'rescheduled' : 'confirmed'}.\n\n${eventType.title}\n${when}\nLocation: ${location}\nReference: ${booking.reference}${manage}\n\nSent by Meet by Schedora.`,
    ics: bookingIcs({ booking, eventType, hostName: eventType.host_name, now })
  });
  queueEmail(app, {
    workspaceId: booking.workspace_id, key: `booking:${booking.id}:host-notification`, kind: 'host_notification', relatedId: booking.id,
    to: eventType.host_email,
    subject: `${kind === 'rescheduled' ? 'Rescheduled' : 'New'} appointment: ${booking.invitee_name}`,
    body: `${booking.invitee_name} (${booking.invitee_email}) ${kind === 'rescheduled' ? 'moved their appointment to' : 'booked'} ${eventType.title}.\n${hostWhen}\nReference: ${booking.reference}${booking.notes ? '\n\nNotes:\n' + booking.notes : ''}`
  });
  if (eventType.reminder_min && booking.starts_at - eventType.reminder_min * 60000 > now) {
    queueEmail(app, {
      workspaceId: booking.workspace_id, key: `booking:${booking.id}:reminder`, kind: 'reminder', relatedId: booking.id,
      to: booking.invitee_email, sendAt: booking.starts_at - eventType.reminder_min * 60000,
      subject: `Reminder: ${eventType.title} with ${eventType.host_name}`,
      body: `Hi ${booking.invitee_name},\n\nThis is a reminder of your appointment.\n\n${eventType.title}\n${when}\nLocation: ${location}\nReference: ${booking.reference}${manage}`
    });
  }
}

function insertBooking(app, eventType, input, start, idempotencyKey, requestHash, rescheduledFrom) {
  const finish = start + eventType.duration_min * 60000;
  const [blockStart, blockEnd] = bufferedBlock(eventType, start, finish);
  const token = newToken();
  const booking = {
    id: randomUUID(), reference: reference(), workspace_id: eventType.workspace_id, event_type_id: eventType.id, host_id: eventType.host_id,
    starts_at: start, ends_at: finish, block_start: blockStart, block_end: blockEnd, status: 'confirmed',
    invitee_name: input.name, invitee_email: input.email, invitee_timezone: input.timezone, notes: input.notes,
    idempotency_key: idempotencyKey, request_hash: requestHash, manage_token_hash: sha256(token), manage_expires_at: start,
    rescheduled_from: rescheduledFrom ?? null, created_at: app.now()
  };
  try {
    app.db.run(`INSERT INTO bookings (${Object.keys(booking).join(', ')}) VALUES (${Object.keys(booking).map(() => '?').join(', ')})`, ...Object.values(booking));
  } catch (error) {
    if (/booking_overlap/.test(error.message)) fail(409, 'slot_unavailable', 'That time is no longer available. Please choose another time.');
    throw error;
  }
  return { booking, token };
}

// Creates a booking atomically. The availability check and insert run inside one write
// transaction, and a database trigger independently rejects overlapping confirmed bookings.
export function createBooking(app, eventType, body, idempotencyKey) {
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) fail(400, 'idempotency_key_required', 'An Idempotency-Key header (16–100 URL-safe characters) is required.');
  const input = inviteeInput(body);
  const start = parseStart(body.start);
  const requestHash = sha256(JSON.stringify([eventType.id, start, input.name, input.email, input.timezone, input.notes]));
  try {
    return app.db.transaction(() => {
      const existing = app.db.get('SELECT * FROM bookings WHERE event_type_id = ? AND idempotency_key = ?', eventType.id, idempotencyKey);
      if (existing) {
        if (existing.request_hash !== requestHash) fail(409, 'idempotency_conflict', 'This request key was already used for a different booking.');
        return { booking: existing, token: null, replay: true };
      }
      requireEntitlement(app, eventType.workspace_id, 'meet');
      if (!isSlotAvailable(app, eventType, start)) fail(409, 'slot_unavailable', 'That time is no longer available. Please choose another time.');
      consumeQuota(app, eventType.workspace_id, 'bookings');
      const { booking, token } = insertBooking(app, eventType, input, start, idempotencyKey, requestHash, null);
      app.db.run("INSERT INTO outbox (id, workspace_id, type, subject_id, source_id, created_at) VALUES (?, ?, 'meet.booking.created', ?, ?, ?)",
        randomUUID(), eventType.workspace_id, booking.id, eventType.id, app.now());
      queueBookingEmails(app, { booking, eventType, token, kind: 'created' });
      return { booking, token, replay: false };
    });
  } finally {
    app.nudge?.();
  }
}

export function publicBooking(app, booking, eventType) {
  return {
    id: booking.id, reference: booking.reference, status: booking.status,
    starts_at: new Date(booking.starts_at).toISOString(), ends_at: new Date(booking.ends_at).toISOString(),
    invitee_name: booking.invitee_name, invitee_email: booking.invitee_email, invitee_timezone: booking.invitee_timezone,
    event: { title: eventType.title, location: eventType.location, duration_min: eventType.duration_min, host_name: eventType.host_name, timezone: eventType.timezone, workspace_slug: eventType.workspace_slug, slug: eventType.slug },
    canceled_by: booking.canceled_by, rescheduled: Boolean(booking.rescheduled_to),
    email: emailStatusFor(app, booking.id, 'confirmation')
  };
}

function eventTypeForBooking(app, booking) {
  return app.db.get(`SELECT e.*, w.slug AS workspace_slug, w.name AS workspace_name, u.name AS host_name, u.email AS host_email
    FROM event_types e JOIN workspaces w ON w.id = e.workspace_id JOIN users u ON u.id = e.host_id WHERE e.id = ?`, booking.event_type_id);
}

// Invitee capability lookup. Tokens are stored hashed; a link stops working once the appointment starts.
export function bookingByToken(app, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) fail(404, 'not_found', 'This link is not valid.');
  const booking = app.db.get('SELECT * FROM bookings WHERE manage_token_hash = ?', sha256(token));
  if (!booking || booking.anonymized_at) fail(404, 'not_found', 'This link is not valid.');
  const eventType = eventTypeForBooking(app, booking);
  const expired = app.now() >= booking.manage_expires_at;
  return { booking, eventType, expired };
}

function assertManageable({ booking, expired }) {
  if (booking.status === 'canceled') fail(409, booking.rescheduled_to ? 'already_rescheduled' : 'already_canceled', booking.rescheduled_to ? 'This appointment was already rescheduled. Use the link in your newest confirmation email.' : 'This appointment is already canceled.');
  if (expired) fail(410, 'link_expired', 'This appointment has started or passed, so it can no longer be changed online. Contact the host.');
}

function cancelRecord(app, booking, eventType, by, reason, notify = true) {
  app.db.run("UPDATE bookings SET status = 'canceled', canceled_at = ?, canceled_by = ?, cancel_reason = ? WHERE id = ?", app.now(), by, reason || null, booking.id);
  cancelPendingEmails(app, booking.id, ['reminder', 'confirmation']);
  if (!notify) return;
  const canceled = { ...booking, status: 'canceled' };
  const when = formatInstant(booking.starts_at, booking.invitee_timezone);
  queueEmail(app, {
    workspaceId: booking.workspace_id, key: `booking:${booking.id}:invitee-cancellation`, kind: 'cancellation', relatedId: booking.id, to: booking.invitee_email,
    subject: `Canceled: ${eventType.title} with ${eventType.host_name}`,
    body: `Hi ${booking.invitee_name},\n\nYour appointment on ${when} has been canceled${by === 'host' ? ' by the host' : ''}.${reason ? '\nReason: ' + reason : ''}\nReference: ${booking.reference}`,
    ics: bookingIcs({ booking: canceled, eventType, hostName: eventType.host_name, method: 'CANCEL', now: app.now() })
  });
  queueEmail(app, {
    workspaceId: booking.workspace_id, key: `booking:${booking.id}:host-cancellation`, kind: 'host_cancellation', relatedId: booking.id, to: eventType.host_email,
    subject: `Canceled: ${booking.invitee_name}, ${eventType.title}`,
    body: `The appointment with ${booking.invitee_name} on ${formatInstant(booking.starts_at, eventType.timezone)} was canceled by the ${by}.${reason ? '\nReason: ' + reason : ''}\nReference: ${booking.reference}`
  });
}

export function cancelByToken(app, token, body) {
  const reason = text(body.reason, 'reason', { max: 500, multiline: true });
  try {
    return app.db.transaction(() => {
      const found = bookingByToken(app, token);
      assertManageable(found);
      cancelRecord(app, found.booking, found.eventType, 'invitee', reason);
      return publicBooking(app, { ...found.booking, status: 'canceled', canceled_by: 'invitee' }, found.eventType);
    });
  } finally { app.nudge?.(); }
}

// Moves a booking atomically: the old interval is released and the new one claimed in a single
// transaction, so a failed reschedule leaves the original appointment intact.
export function rescheduleByToken(app, token, body) {
  const start = parseStart(body.start);
  try {
    return app.db.transaction(() => {
      const found = bookingByToken(app, token);
      assertManageable(found);
      const { booking: old, eventType } = found;
      if (!eventType.published) fail(409, 'event_unavailable', 'This event type is no longer accepting appointments. Contact the host.');
      app.db.run("UPDATE bookings SET status = 'canceled', canceled_at = ?, canceled_by = 'reschedule' WHERE id = ?", app.now(), old.id);
      if (!isSlotAvailable(app, eventType, start)) fail(409, 'slot_unavailable', 'That time is no longer available. Please choose another time.');
      const input = { name: old.invitee_name, email: old.invitee_email, timezone: isValidTimeZone(body.timezone) ? body.timezone : old.invitee_timezone, notes: old.notes };
      const { booking, token: newToken } = insertBooking(app, eventType, input, start, 'reschedule-' + old.id, sha256('reschedule:' + old.id), old.id);
      app.db.run('UPDATE bookings SET rescheduled_to = ? WHERE id = ?', booking.id, old.id);
      cancelPendingEmails(app, old.id, ['reminder', 'confirmation']);
      queueBookingEmails(app, { booking, eventType, token: newToken, kind: 'rescheduled' });
      return { booking: publicBooking(app, booking, eventType), token: newToken };
    });
  } finally { app.nudge?.(); }
}

export function listBookings(app, workspaceId, actor, scope) {
  const now = app.now();
  const conditions = { upcoming: "b.status = 'confirmed' AND b.ends_at > ?", past: "b.status = 'confirmed' AND b.ends_at <= ?", canceled: "b.status = 'canceled' AND ? IS NOT NULL" }[scope];
  if (!conditions) fail(400, 'validation_failed', 'Scope must be upcoming, past or canceled.', { field: 'scope' });
  const order = scope === 'upcoming' ? 'ASC' : 'DESC';
  const hostFilter = can(actor.role, 'meet.manage_all') ? '' : 'AND b.host_id = ?';
  const params = can(actor.role, 'meet.manage_all') ? [workspaceId, now] : [workspaceId, now, actor.userId];
  return app.db.all(`SELECT b.id, b.reference, b.status, b.starts_at, b.ends_at, b.invitee_name, b.invitee_email, b.invitee_timezone, b.notes,
      b.canceled_by, b.cancel_reason, b.rescheduled_to, b.anonymized_at, e.title AS event_title, e.timezone AS host_timezone, u.name AS host_name
    FROM bookings b JOIN event_types e ON e.id = b.event_type_id JOIN users u ON u.id = b.host_id
    WHERE b.workspace_id = ? AND ${conditions} ${hostFilter} ORDER BY b.starts_at ${order} LIMIT 200`, ...params)
    .map(row => ({ ...row, email: emailStatusFor(app, row.id, 'confirmation') }));
}

export function hostCancel(app, workspaceId, actor, bookingId, body) {
  const reason = text(body.reason, 'reason', { max: 500, multiline: true });
  try {
    app.db.transaction(() => {
      const booking = app.db.get('SELECT * FROM bookings WHERE id = ? AND workspace_id = ?', bookingId, workspaceId);
      if (!booking || (booking.host_id !== actor.userId && !can(actor.role, 'meet.manage_all'))) fail(404, 'not_found', 'Appointment not found.');
      if (booking.status !== 'confirmed') fail(409, 'already_canceled', 'This appointment is already canceled.');
      cancelRecord(app, booking, eventTypeForBooking(app, booking), 'host', reason, booking.ends_at > app.now());
    });
  } finally { app.nudge?.(); }
}

