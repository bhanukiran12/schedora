import { randomBytes, randomUUID } from 'node:crypto';
import { fail } from '../http.mjs';
import { addDays, isValidTimeZone, localDate, weekday } from '../time.mjs';
import { email as validEmail, invalid, integer, text } from '../validate.mjs';
import { sha256, newToken } from '../platform/auth.mjs';
import { can } from '../platform/workspaces.mjs';
import { cancelPendingEmails, emailStatusFor, queueEmail, VIDEO_PLACEHOLDER } from '../platform/email.mjs';
import { upsertContact } from '../platform/contacts.mjs';
import { consumeQuota, requireEntitlement } from '../billing/entitlements.mjs';
import { validateSubmission, answerText } from '../shared/forms-logic.mjs';
import { bufferedBlock, conflicts, generateSlots } from './availability.mjs';
import { AUTO_VIDEO, hostsFor, hydrate, locationDisplay, scheduleFor } from './event-types.mjs';
import { bookingIcs } from './ics.mjs';
import { cancelScheduledWorkflows, runWorkflows } from './workflows.mjs';

const DAY = 86400000;
const MINUTE = 60000;
const HOLD_MINUTES = 15;
const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const reference = () => 'SCH-' + [...randomBytes(6)].map(byte => REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length]).join('');
const unavailable = () => fail(409, 'slot_unavailable', 'That time is no longer available. Please choose another time.');

export function formatInstant(ms, timeZone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'full', timeStyle: 'short' }).format(new Date(ms)) + ` (${timeZone})`;
}

export function loadEventType(app, id) {
  const row = hydrate(app.db.get(`SELECT e.*, w.slug AS workspace_slug, w.name AS workspace_name, w.brand_color, w.logo, w.welcome_message,
      u.name AS host_name, u.email AS host_email
    FROM event_types e JOIN workspaces w ON w.id = e.workspace_id JOIN users u ON u.id = e.host_id WHERE e.id = ?`, id));
  return row && { ...row, hosts: hostsFor(app, id) };
}

// ---- Availability ----------------------------------------------------------------------------

function hostSchedule(app, eventType, hostId) {
  if (eventType.use_host_schedules) {
    const personal = app.db.get('SELECT timezone, rules, overrides FROM user_schedules WHERE workspace_id = ? AND user_id = ?', eventType.workspace_id, hostId);
    if (personal) return { timezone: personal.timezone, rules: JSON.parse(personal.rules), overrides: JSON.parse(personal.overrides).map(o => o.unavailable ? { date: o.date, start_min: null, end_min: null } : o) };
  }
  const { rules, overrides } = scheduleFor(app, eventType.id);
  return { timezone: eventType.timezone, rules, overrides: overrides.map(o => o.unavailable ? { date: o.date, start_min: null, end_min: null } : o) };
}

const weekKey = date => addDays(date, -((weekday(date) + 6) % 7));

function applyLimits(app, eventType, hostId, slots, timeZone, exempt) {
  const limits = [['max_per_day', date => date], ['max_per_week', weekKey], ['max_per_month', date => date.slice(0, 7)]].filter(([field]) => eventType[field]);
  if (!limits.length || !slots.length) return slots;
  const meetings = app.db.all(`SELECT m.starts_at FROM meetings m JOIN meeting_hosts h ON h.meeting_id = m.id AND h.host_id = ?
    WHERE m.event_type_id = ? AND m.status = 'active' AND m.starts_at BETWEEN ? AND ?`, hostId, eventType.id, slots[0] - 32 * DAY, slots[slots.length - 1] + 32 * DAY);
  return slots.filter(slot => {
    if (exempt.has(slot)) return true;
    const date = localDate(slot, timeZone);
    return limits.every(([field, keyOf]) => {
      const key = keyOf(date);
      return meetings.filter(meeting => keyOf(localDate(meeting.starts_at, timeZone)) === key).length < eventType[field];
    });
  });
}

// Returns Map<start ms, host ids available at that start>, honoring the meeting kind:
// one-on-one and group use the single host; collective needs every host; round robin needs any.
export function computeAvailability(app, eventType, { fromDate, toDate, excludeMeetingId } = {}) {
  const now = app.now();
  const result = new Map();
  if (eventType.expires_at && eventType.expires_at < now) return { slots: result, joinable: new Map() };
  if (eventType.start_date && (!fromDate || fromDate < eventType.start_date)) fromDate = eventType.start_date;
  if (eventType.end_date && (!toDate || toDate > eventType.end_date)) toDate = eventType.end_date;
  if (fromDate && toDate && fromDate > toDate) return { slots: result, joinable: new Map() };
  const windowStart = now - DAY;
  const windowEnd = now + (eventType.horizon_days + 2) * DAY;
  const duration = eventType.duration_min * MINUTE;

  // Group events: meetings with free seats can be joined at their exact start time.
  const joinable = new Map();
  if (eventType.kind === 'group') {
    for (const meeting of app.db.all(`SELECT m.id, m.starts_at, m.ends_at, m.seats, (SELECT COUNT(*) FROM bookings b WHERE b.meeting_id = m.id AND b.status <> 'canceled') AS taken
      FROM meetings m WHERE m.event_type_id = ? AND m.status = 'active' AND m.starts_at > ?`, eventType.id, now)) {
      if (meeting.taken < meeting.seats && meeting.id !== excludeMeetingId) joinable.set(meeting.starts_at, meeting);
    }
  }
  const joinIds = new Set([...joinable.values()].map(meeting => meeting.id));

  const perHost = new Map();
  for (const host of eventType.hosts) {
    const schedule = hostSchedule(app, eventType, host.user_id);
    const blocks = app.db.all(`SELECT meeting_id, starts_at, ends_at, block_start, block_end FROM meeting_hosts WHERE host_id = ? AND active = 1 AND block_end > ? AND block_start < ?`,
      host.user_id, windowStart, windowEnd).filter(block => !joinIds.has(block.meeting_id) && block.meeting_id !== excludeMeetingId);
    const busy = app.db.all('SELECT starts_at, ends_at FROM busy_blocks WHERE host_id = ? AND ends_at > ? AND starts_at < ?', host.user_id, windowStart, windowEnd);
    const scoped = { ...eventType, timezone: schedule.timezone };
    let slots;
    if (eventType.offered_slots) {
      const earliest = now + eventType.min_notice_min * MINUTE;
      slots = eventType.offered_slots.map(Date.parse).filter(start => start >= earliest
        && (!fromDate || localDate(start, schedule.timezone) >= fromDate) && (!toDate || localDate(start, schedule.timezone) <= toDate)
        && !conflicts(eventType, start, start + duration, blocks, busy));
    } else {
      slots = generateSlots({ eventType: scoped, rules: schedule.rules, overrides: schedule.overrides, bookings: blocks, busy, now, fromDate, toDate });
    }
    // Joinable meetings occupy the host: other starts overlapping them are not offered.
    slots = slots.filter(start => [...joinable.values()].every(meeting => meeting.starts_at === start || !(start < meeting.ends_at && start + duration > meeting.starts_at)));
    perHost.set(host.user_id, applyLimits(app, eventType, host.user_id, slots, schedule.timezone, new Set(joinable.keys())));
  }

  if (eventType.kind === 'collective') {
    const [first, ...rest] = [...perHost.values()];
    for (const start of first || []) if (rest.every(set => set.includes(start))) result.set(start, eventType.hosts.map(host => host.user_id));
  } else if (eventType.kind === 'round_robin') {
    for (const [hostId, slots] of perHost) for (const start of slots) result.set(start, [...(result.get(start) || []), hostId]);
  } else {
    for (const start of perHost.get(eventType.hosts[0]?.user_id) || []) result.set(start, [eventType.hosts[0].user_id]);
  }
  return { slots: new Map([...result].sort((a, b) => a[0] - b[0])), joinable };
}

export function availableSlots(app, eventType, range = {}) {
  return [...computeAvailability(app, eventType, range).slots.keys()];
}

// Round robin: a known lead goes to their contact owner when available; otherwise the
// highest-priority available host, breaking ties by fewest recent meetings (equal distribution).
function chooseHost(app, eventType, candidates, inviteeEmail) {
  if (candidates.length === 1) return candidates[0];
  const owner = app.db.get('SELECT owner_id FROM contacts WHERE workspace_id = ? AND email = ?', eventType.workspace_id, inviteeEmail)?.owner_id;
  if (owner && candidates.includes(owner)) return owner;
  const since = app.now() - 30 * DAY;
  const load = Object.fromEntries(candidates.map(hostId => [hostId, app.db.get(`SELECT COUNT(*) AS count FROM meeting_hosts h JOIN meetings m ON m.id = h.meeting_id
    WHERE h.host_id = ? AND m.event_type_id = ? AND m.created_at > ? AND m.status = 'active'`, hostId, eventType.id, since).count]));
  const priority = Object.fromEntries(eventType.hosts.map(host => [host.user_id, host.priority]));
  return [...candidates].sort((a, b) => (eventType.rr_strategy === 'equal' ? 0 : priority[b] - priority[a]) || load[a] - load[b] || a.localeCompare(b))[0];
}

// ---- Input -------------------------------------------------------------------------------------

function parseStart(value) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/.test(value)) invalid('start', 'Choose an available time.');
  return ms;
}

function inviteeInput(eventType, body) {
  if (!isValidTimeZone(body.timezone)) invalid('timezone', 'Choose a valid time zone.');
  const { answers, errors } = validateSubmission({ fields: eventType.questions }, body.answers && typeof body.answers === 'object' ? body.answers : {});
  if (Object.keys(errors).length) fail(400, 'validation_failed', 'Please check the highlighted answers.', { errors });
  const locations = eventType.locations;
  let location = null;
  if (locations.length) {
    const index = locations.length === 1 ? 0 : integer(body.location_index, 'location_index', 0, locations.length - 1);
    location = { ...locations[index] };
  }
  let phone = text(body.phone, 'phone', { max: 30 }) || null;
  if (phone && !/^\+?[0-9][0-9 ().-]{5,25}$/.test(phone)) invalid('phone', 'Enter a phone number with country code.');
  if (location?.type === 'phone_host_calls') {
    if (!phone) invalid('phone', 'Enter the number the host should call.');
    location.value = phone;
  }
  const phoneQuestion = eventType.questions.find(question => question.type === 'phone' && answers[question.id]);
  if (!phone && phoneQuestion) phone = answers[phoneQuestion.id];
  const guests = Array.isArray(body.guests) ? body.guests.slice(0, 10).map((guest, index) => validEmail(guest, `guests.${index}`)) : [];
  return {
    name: text(body.name, 'name', { min: 1, max: 100 }),
    email: validEmail(body.email),
    notes: text(body.notes, 'notes', { max: 1000, multiline: true }),
    timezone: body.timezone, answers, location, phone, guests
  };
}

// ---- Messages ------------------------------------------------------------------------------------

export function manageUrl(app, token) {
  return `${app.config.baseUrl}/meet/manage/${token}`;
}

function meetingHosts(app, meetingId) {
  return app.db.all('SELECT u.id, u.name, u.email FROM meeting_hosts h JOIN users u ON u.id = h.host_id WHERE h.meeting_id = ? ORDER BY u.name', meetingId);
}

function locationText(booking) {
  const location = typeof booking.location === 'string' ? JSON.parse(booking.location) : booking.location;
  if (!location) return 'To be confirmed by the host';
  if (AUTO_VIDEO.includes(location.type)) return VIDEO_PLACEHOLDER;
  if (location.type === 'phone_host_calls') return `The host will call you at ${location.value}`;
  return locationDisplay(location);
}

export function templateValues(app, booking, eventType, hosts, token) {
  const answers = typeof booking.answers === 'string' ? JSON.parse(booking.answers) : booking.answers || {};
  const values = {
    'invitee.name': booking.invitee_name, 'invitee.email': booking.invitee_email, 'invitee.phone': booking.invitee_phone || '',
    'event.title': eventType.title, 'event.location': locationText(booking), 'booking.reference': booking.reference,
    'booking.start': formatInstant(booking.starts_at, booking.invitee_timezone), 'booking.start_host': formatInstant(booking.starts_at, eventType.timezone),
    'host.name': hosts.map(host => host.name).join(', '), manage_url: token ? manageUrl(app, token) : ''
  };
  for (const question of eventType.questions) values['answer.' + question.id] = answerText(question, answers[question.id]);
  return values;
}

function answersSummary(eventType, booking) {
  const answers = typeof booking.answers === 'string' ? JSON.parse(booking.answers) : booking.answers || {};
  const lines = eventType.questions.filter(question => answers[question.id] !== undefined).map(question => `${question.label}: ${answerText(question, answers[question.id])}`);
  return lines.length ? '\n\nAnswers:\n' + lines.join('\n') : '';
}

function confirmationMessages(app, { booking, eventType, hosts, token, kind }) {
  const values = templateValues(app, booking, eventType, hosts, token);
  const hostNames = values['host.name'];
  const manage = token ? `\n\nNeed to change plans? Reschedule or cancel: ${values.manage_url}` : '';
  const extra = eventType.confirmation_message ? `\n\n${eventType.confirmation_message}` : '';
  const verb = kind === 'rescheduled' ? 'Rescheduled' : 'Confirmed';
  const ics = bookingIcs({ booking, eventType, hostName: hostNames, now: app.now() });
  const inviteeBody = `Hi ${booking.invitee_name},\n\nYour appointment is ${verb.toLowerCase()}.\n\n${eventType.title} with ${hostNames}\n${values['booking.start']}\nLocation: ${values['event.location']}\nReference: ${booking.reference}${extra}${manage}\n\nSent by Meet by Schedora.`;
  queueEmail(app, { workspaceId: booking.workspace_id, key: `booking:${booking.id}:invitee-confirmation`, kind: 'confirmation', relatedId: booking.id, to: booking.invitee_email,
    subject: `${verb}: ${eventType.title} with ${hostNames}`, body: inviteeBody, ics });
  JSON.parse(typeof booking.guests === 'string' ? booking.guests : JSON.stringify(booking.guests || [])).forEach((guest, index) => queueEmail(app, {
    workspaceId: booking.workspace_id, key: `booking:${booking.id}:guest-${index}`, kind: 'guest_confirmation', relatedId: booking.id, to: guest,
    subject: `Invitation: ${eventType.title} with ${hostNames}`, ics,
    body: `${booking.invitee_name} added you to ${eventType.title} with ${hostNames}.\n${values['booking.start']}\nLocation: ${values['event.location']}\nReference: ${booking.reference}`
  }));
  for (const host of hosts) {
    queueEmail(app, { workspaceId: booking.workspace_id, key: `booking:${booking.id}:host-notification:${host.id}`, kind: 'host_notification', relatedId: booking.id, to: host.email,
      subject: `${kind === 'rescheduled' ? 'Rescheduled' : 'New'} appointment: ${booking.invitee_name}`, ics,
      body: `${booking.invitee_name} (${booking.invitee_email}) ${kind === 'rescheduled' ? 'moved their appointment to' : 'booked'} ${eventType.title}.\n${values['booking.start_host']}\nLocation: ${values['event.location']}\nReference: ${booking.reference}${booking.notes ? '\n\nNotes:\n' + booking.notes : ''}${answersSummary(eventType, booking)}` });
  }
  if (eventType.reminder_min && booking.starts_at - eventType.reminder_min * MINUTE > app.now()) {
    queueEmail(app, { workspaceId: booking.workspace_id, key: `booking:${booking.id}:reminder`, kind: 'reminder', relatedId: booking.id, to: booking.invitee_email,
      sendAt: booking.starts_at - eventType.reminder_min * MINUTE, subject: `Reminder: ${eventType.title} with ${hostNames}`,
      body: `Hi ${booking.invitee_name},\n\nThis is a reminder of your appointment.\n\n${eventType.title}\n${values['booking.start']}\nLocation: ${values['event.location']}\nReference: ${booking.reference}${manage}` });
  }
  runWorkflows(app, { booking, eventType, hosts, trigger: kind === 'rescheduled' ? 'rescheduled' : 'booked', values });
  runWorkflows(app, { booking, eventType, hosts, trigger: 'before_start', values });
  runWorkflows(app, { booking, eventType, hosts, trigger: 'after_end', values });
}

const emit = (app, type, booking) => app.db.run('INSERT INTO outbox (id, workspace_id, type, subject_id, source_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  randomUUID(), booking.workspace_id, type, booking.id, booking.event_type_id, app.now());

// Side effects of a booking becoming confirmed: event for Flow and webhooks, messages, single-use links.
function onConfirmed(app, booking, eventType, token, kind) {
  const hosts = meetingHosts(app, booking.meeting_id);
  emit(app, kind === 'rescheduled' ? 'meet.booking.rescheduled' : 'meet.booking.created', booking);
  confirmationMessages(app, { booking, eventType, hosts, token, kind });
  if (eventType.single_use && kind !== 'rescheduled') app.db.run('UPDATE event_types SET published = 0 WHERE id = ?', eventType.id);
}

// ---- Booking -------------------------------------------------------------------------------------

// Claims a slot inside the caller's transaction. Availability is recomputed here; the
// meeting_hosts trigger independently rejects any overlap for every host involved.
function claimSlot(app, eventType, start, input, { idempotencyKey, requestHash, source = 'page', bookedBy = null, override = false, preferredHost = null, rescheduledFrom = null, excludeMeetingId = null, payment = null }) {
  const now = app.now();
  const duration = eventType.duration_min * MINUTE;
  const finish = start + duration;
  let candidates;
  let joinable = new Map();
  if (override) {
    if (start < now) invalid('start', 'Choose a time in the future.');
    candidates = eventType.kind === 'collective' ? eventType.hosts.map(host => host.user_id)
      : [preferredHost && eventType.hosts.some(host => host.user_id === preferredHost) ? preferredHost : eventType.hosts[0].user_id];
    if (eventType.kind === 'group') {
      const meeting = app.db.get(`SELECT m.id, m.starts_at, m.seats, (SELECT COUNT(*) FROM bookings b WHERE b.meeting_id = m.id AND b.status <> 'canceled') AS taken
        FROM meetings m WHERE m.event_type_id = ? AND m.status = 'active' AND m.starts_at = ?`, eventType.id, start);
      if (meeting && meeting.taken < meeting.seats) joinable.set(start, meeting);
      else if (meeting) unavailable();
    }
  } else {
    const date = localDate(start, eventType.timezone);
    const availability = computeAvailability(app, eventType, { fromDate: addDays(date, -1), toDate: addDays(date, 1), excludeMeetingId });
    candidates = availability.slots.get(start);
    joinable = availability.joinable;
    if (!candidates) unavailable();
  }

  let meetingId;
  const existing = eventType.kind === 'group' ? joinable.get(start) : null;
  if (existing) {
    meetingId = existing.id;
  } else {
    const hostIds = eventType.kind === 'collective' ? candidates : [eventType.kind === 'round_robin' ? chooseHost(app, eventType, candidates, input.email) : candidates[0]];
    meetingId = randomUUID();
    const [blockStart, blockEnd] = bufferedBlock(eventType, start, finish);
    app.db.run("INSERT INTO meetings (id, workspace_id, event_type_id, starts_at, ends_at, status, seats, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
      meetingId, eventType.workspace_id, eventType.id, start, finish, eventType.seats, now);
    try {
      for (const hostId of hostIds) app.db.run('INSERT INTO meeting_hosts (meeting_id, host_id, starts_at, ends_at, block_start, block_end, active) VALUES (?, ?, ?, ?, ?, ?, 1)',
        meetingId, hostId, start, finish, blockStart, blockEnd);
    } catch (error) {
      if (/booking_overlap/.test(error.message)) unavailable();
      throw error;
    }
  }
  const primaryHost = app.db.get('SELECT host_id FROM meeting_hosts WHERE meeting_id = ? ORDER BY host_id LIMIT 1', meetingId).host_id;
  const contactId = upsertContact(app, eventType.workspace_id, { email: input.email, name: input.name, phone: input.phone, ownerId: primaryHost });
  const token = newToken();
  const pending = eventType.price_cents && !payment;
  const booking = {
    id: randomUUID(), reference: reference(), workspace_id: eventType.workspace_id, event_type_id: eventType.id, meeting_id: meetingId, host_id: primaryHost,
    starts_at: start, ends_at: finish, status: pending ? 'pending' : 'confirmed',
    invitee_name: input.name, invitee_email: input.email, invitee_timezone: input.timezone, invitee_phone: input.phone,
    notes: input.notes, answers: JSON.stringify(input.answers), location: input.location ? JSON.stringify(input.location) : null, guests: JSON.stringify(input.guests || []),
    idempotency_key: idempotencyKey, request_hash: requestHash, manage_token_hash: sha256(token), manage_expires_at: start, rescheduled_from: rescheduledFrom,
    payment_status: payment ? payment.status : pending ? 'pending' : 'none', payment_ref: payment?.ref ?? null,
    amount_cents: eventType.price_cents ?? null, currency: eventType.currency ?? null, hold_expires_at: pending ? now + HOLD_MINUTES * MINUTE : null,
    booked_by: bookedBy, contact_id: contactId, source, created_at: now
  };
  app.db.run(`INSERT INTO bookings (${Object.keys(booking).join(', ')}) VALUES (${Object.keys(booking).map(() => '?').join(', ')})`, ...Object.values(booking));
  return { booking, token };
}

function requireKey(idempotencyKey) {
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) fail(400, 'idempotency_key_required', 'An Idempotency-Key header (16–100 URL-safe characters) is required.');
}

// Public booking. Paid event types return a pending booking that holds the slot until payment.
export function createBooking(app, eventType, body, idempotencyKey, options = {}) {
  requireKey(idempotencyKey);
  const input = inviteeInput(eventType, body);
  const start = parseStart(body.start);
  const requestHash = sha256(JSON.stringify([eventType.id, start, input.name, input.email, input.timezone, input.notes, input.answers, input.location, input.guests]));
  try {
    return app.db.transaction(() => {
      const existing = app.db.get('SELECT * FROM bookings WHERE event_type_id = ? AND idempotency_key = ?', eventType.id, idempotencyKey);
      if (existing) {
        if (existing.request_hash !== requestHash) fail(409, 'idempotency_conflict', 'This request key was already used for a different booking.');
        return { booking: existing, token: null, replay: true };
      }
      requireEntitlement(app, eventType.workspace_id, 'meet');
      if (eventType.price_cents && !options.override && !app.payments.available(eventType.workspace_id)) fail(409, 'payments_unavailable', 'This event requires payment, but online payment is not set up yet. Contact the host.');
      consumeQuota(app, eventType.workspace_id, 'bookings');
      const { booking, token } = claimSlot(app, eventType, start, input, { idempotencyKey, requestHash, ...options, payment: options.override ? { status: eventType.price_cents ? 'pending' : 'none' } : null });
      if (booking.status === 'confirmed') onConfirmed(app, booking, eventType, token, 'created');
      return { booking, token, replay: false };
    });
  } finally {
    app.nudge?.();
  }
}

// Host or administrator books for someone. With override, working hours and notice are ignored,
// but double booking is still impossible.
export function hostBook(app, workspaceId, actor, body, idempotencyKey) {
  const eventType = loadEventType(app, body.event_type_id);
  if (!eventType || eventType.workspace_id !== workspaceId) fail(404, 'not_found', 'Event type not found.');
  const isHost = eventType.hosts.some(host => host.user_id === actor.userId);
  if (!isHost && !can(actor.role, 'meet.manage_all')) fail(404, 'not_found', 'Event type not found.');
  return createBooking(app, eventType, body, idempotencyKey || randomUUID().replace(/-/g, ''), { source: 'host', bookedBy: actor.userId, override: Boolean(body.override), preferredHost: body.host_id || actor.userId });
}

export function confirmPayment(app, bookingId, paymentRef, token) {
  return app.db.transaction(() => {
    const booking = app.db.get('SELECT * FROM bookings WHERE id = ?', bookingId);
    if (!booking) return 'unknown_booking';
    if (booking.payment_status === 'paid') return 'duplicate';
    if (booking.status === 'canceled') return 'booking_canceled';
    app.db.run("UPDATE bookings SET status = 'confirmed', payment_status = 'paid', payment_ref = ?, hold_expires_at = NULL WHERE id = ?", paymentRef, bookingId);
    onConfirmed(app, { ...booking, status: 'confirmed' }, loadEventType(app, booking.event_type_id), token && sha256(token) === booking.manage_token_hash ? token : null, 'created');
    return 'confirmed';
  });
}

export function expireHolds(app) {
  const expired = app.db.all("SELECT * FROM bookings WHERE status = 'pending' AND hold_expires_at < ?", app.now());
  for (const booking of expired) app.db.transaction(() => cancelAttendee(app, booking, loadEventType(app, booking.event_type_id), 'payment_timeout', 'Payment was not completed in time.', false));
  return expired.length;
}

// ---- Views ---------------------------------------------------------------------------------------

export function publicBooking(app, booking, eventType) {
  const location = typeof booking.location === 'string' ? JSON.parse(booking.location) : booking.location;
  const meeting = app.db.get('SELECT video_url FROM meetings WHERE id = ?', booking.meeting_id);
  return {
    id: booking.id, reference: booking.reference, status: booking.status,
    starts_at: new Date(booking.starts_at).toISOString(), ends_at: new Date(booking.ends_at).toISOString(),
    invitee_name: booking.invitee_name, invitee_email: booking.invitee_email, invitee_timezone: booking.invitee_timezone,
    location: location ? { type: location.type, display: AUTO_VIDEO.includes(location.type) ? meeting?.video_url || locationDisplay(location) : locationDisplay(location) } : null,
    event: { title: eventType.title, location: eventType.location, duration_min: eventType.duration_min, host_name: meetingHosts(app, booking.meeting_id).map(host => host.name).join(', ') || eventType.host_name,
      timezone: eventType.timezone, workspace_slug: eventType.workspace_slug, slug: eventType.slug, kind: eventType.kind, confirmation_message: eventType.confirmation_message, redirect_url: eventType.redirect_url },
    payment: booking.payment_status === 'none' ? null : { status: booking.payment_status, amount_cents: booking.amount_cents, currency: booking.currency, hold_expires_at: booking.hold_expires_at },
    canceled_by: booking.canceled_by, rescheduled: Boolean(booking.rescheduled_to),
    email: emailStatusFor(app, booking.id, 'confirmation')
  };
}

// Invitee capability lookup. Tokens are stored hashed; a link stops working once the appointment starts.
export function bookingByToken(app, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) fail(404, 'not_found', 'This link is not valid.');
  const booking = app.db.get('SELECT * FROM bookings WHERE manage_token_hash = ?', sha256(token));
  if (!booking || booking.anonymized_at) fail(404, 'not_found', 'This link is not valid.');
  return { booking, eventType: loadEventType(app, booking.event_type_id), expired: app.now() >= booking.manage_expires_at };
}

function assertManageable({ booking, expired }) {
  if (booking.status === 'canceled') fail(409, booking.rescheduled_to ? 'already_rescheduled' : 'already_canceled', booking.rescheduled_to ? 'This appointment was already rescheduled. Use the link in your newest confirmation email.' : 'This appointment is already canceled.');
  if (expired) fail(410, 'link_expired', 'This appointment has started or passed, so it can no longer be changed online. Contact the host.');
}

// ---- Cancel and reschedule -------------------------------------------------------------------

function cancelAttendee(app, booking, eventType, by, reason, notify = true) {
  const wasConfirmed = booking.status === 'confirmed';
  app.db.run("UPDATE bookings SET status = 'canceled', canceled_at = ?, canceled_by = ?, cancel_reason = ?, hold_expires_at = NULL WHERE id = ?", app.now(), by, reason || null, booking.id);
  const remaining = app.db.get("SELECT COUNT(*) AS count FROM bookings WHERE meeting_id = ? AND status <> 'canceled'", booking.meeting_id).count;
  const hosts = meetingHosts(app, booking.meeting_id);
  if (!remaining) {
    app.db.run("UPDATE meetings SET status = 'canceled' WHERE id = ?", booking.meeting_id);
    app.db.run('UPDATE meeting_hosts SET active = 0 WHERE meeting_id = ?', booking.meeting_id);
  }
  cancelScheduledWorkflows(app, booking.id);
  cancelPendingEmails(app, booking.id, ['guest_confirmation', 'host_notification']);
  if (wasConfirmed && by !== 'reschedule') emit(app, 'meet.booking.canceled', booking);
  if (!notify || !wasConfirmed) return;
  const canceled = { ...booking, status: 'canceled' };
  const when = formatInstant(booking.starts_at, booking.invitee_timezone);
  const refund = booking.payment_status === 'paid' ? '\nA refund will be processed by the host.' : '';
  queueEmail(app, {
    workspaceId: booking.workspace_id, key: `booking:${booking.id}:invitee-cancellation`, kind: 'cancellation', relatedId: booking.id, to: booking.invitee_email,
    subject: `Canceled: ${eventType.title}`,
    body: `Hi ${booking.invitee_name},\n\nYour appointment on ${when} has been canceled${by === 'host' ? ' by the host' : ''}.${reason ? '\nReason: ' + reason : ''}${refund}\nReference: ${booking.reference}`,
    ics: bookingIcs({ booking: canceled, eventType, hostName: hosts.map(host => host.name).join(', '), method: 'CANCEL', now: app.now() })
  });
  for (const host of hosts) {
    queueEmail(app, {
      workspaceId: booking.workspace_id, key: `booking:${booking.id}:host-cancellation:${host.id}`, kind: 'host_cancellation', relatedId: booking.id, to: host.email,
      subject: `Canceled: ${booking.invitee_name}, ${eventType.title}`,
      body: `The appointment with ${booking.invitee_name} on ${formatInstant(booking.starts_at, eventType.timezone)} was canceled by the ${by}.${reason ? '\nReason: ' + reason : ''}${booking.payment_status === 'paid' ? '\nThis booking was paid; issue the refund from your payment provider.' : ''}\nReference: ${booking.reference}`
    });
  }
  runWorkflows(app, { booking, eventType, hosts, trigger: 'canceled', values: templateValues(app, booking, eventType, hosts, null) });
}

export function cancelByToken(app, token, body) {
  const reason = text(body.reason, 'reason', { max: 500, multiline: true });
  try {
    return app.db.transaction(() => {
      const found = bookingByToken(app, token);
      assertManageable(found);
      cancelAttendee(app, found.booking, found.eventType, 'invitee', reason);
      return publicBooking(app, { ...found.booking, status: 'canceled', canceled_by: 'invitee' }, found.eventType);
    });
  } finally { app.nudge?.(); }
}

// Moves a booking atomically: the old seat is released and the new one claimed in one
// transaction, so a failed reschedule leaves the original appointment intact.
export function rescheduleByToken(app, token, body) {
  const start = parseStart(body.start);
  try {
    return app.db.transaction(() => {
      const found = bookingByToken(app, token);
      assertManageable(found);
      const { booking: old, eventType } = found;
      if (!eventType.published && !eventType.one_off) fail(409, 'event_unavailable', 'This event type is no longer accepting appointments. Contact the host.');
      if (old.status === 'pending') fail(409, 'payment_pending', 'Complete payment before rescheduling.');
      cancelAttendee(app, old, eventType, 'reschedule', null, false);
      const input = {
        name: old.invitee_name, email: old.invitee_email, timezone: isValidTimeZone(body.timezone) ? body.timezone : old.invitee_timezone, notes: old.notes,
        answers: JSON.parse(old.answers), location: old.location ? JSON.parse(old.location) : null, phone: old.invitee_phone, guests: JSON.parse(old.guests)
      };
      const { booking, token: fresh } = claimSlot(app, eventType, start, input, {
        idempotencyKey: 'reschedule-' + old.id, requestHash: sha256('reschedule:' + old.id), source: old.source, bookedBy: old.booked_by,
        rescheduledFrom: old.id, excludeMeetingId: null, payment: { status: old.payment_status, ref: old.payment_ref }
      });
      app.db.run('UPDATE bookings SET rescheduled_to = ? WHERE id = ?', booking.id, old.id);
      onConfirmed(app, booking, eventType, fresh, 'rescheduled');
      return { booking: publicBooking(app, booking, eventType), token: fresh };
    });
  } finally { app.nudge?.(); }
}

const HOST_SCOPE = { upcoming: "b.status IN ('confirmed', 'pending') AND b.ends_at > ?", past: "b.status = 'confirmed' AND b.ends_at <= ?", canceled: "b.status = 'canceled' AND ? IS NOT NULL" };

export function listBookings(app, workspaceId, actor, scope, { eventTypeId, hostId, contactId } = {}) {
  const now = app.now();
  const conditions = HOST_SCOPE[scope];
  if (!conditions) fail(400, 'validation_failed', 'Scope must be upcoming, past or canceled.', { field: 'scope' });
  const all = can(actor.role, 'meet.manage_all');
  const rows = app.db.all(`SELECT b.id, b.reference, b.status, b.starts_at, b.ends_at, b.invitee_name, b.invitee_email, b.invitee_timezone, b.invitee_phone, b.notes, b.answers,
      b.location, b.guests, b.meeting_id, b.payment_status, b.amount_cents, b.currency, b.source, b.contact_id,
      b.canceled_by, b.cancel_reason, b.rescheduled_to, b.anonymized_at, e.title AS event_title, e.kind, e.timezone AS host_timezone, e.questions,
      (SELECT group_concat(u.name, ', ') FROM meeting_hosts h JOIN users u ON u.id = h.host_id WHERE h.meeting_id = b.meeting_id) AS host_name,
      m.video_url
    FROM bookings b JOIN event_types e ON e.id = b.event_type_id JOIN meetings m ON m.id = b.meeting_id
    WHERE b.workspace_id = ? AND ${conditions}
      AND (? = 1 OR EXISTS (SELECT 1 FROM meeting_hosts h WHERE h.meeting_id = b.meeting_id AND h.host_id = ?))
      AND (? IS NULL OR b.event_type_id = ?) AND (? IS NULL OR EXISTS (SELECT 1 FROM meeting_hosts h WHERE h.meeting_id = b.meeting_id AND h.host_id = ?))
      AND (? IS NULL OR b.contact_id = ?)
    ORDER BY b.starts_at ${scope === 'upcoming' ? 'ASC' : 'DESC'} LIMIT 300`,
  workspaceId, now, all ? 1 : 0, actor.userId, eventTypeId ?? null, eventTypeId ?? null, hostId ?? null, hostId ?? null, contactId ?? null, contactId ?? null);
  return rows.map(row => {
    const questions = JSON.parse(row.questions);
    const answers = JSON.parse(row.answers);
    const location = row.location ? JSON.parse(row.location) : null;
    return {
      ...row, questions: undefined,
      answers: questions.filter(question => answers[question.id] !== undefined).map(question => ({ label: question.label, value: answerText(question, answers[question.id]) })),
      location: location ? (AUTO_VIDEO.includes(location.type) ? row.video_url || locationDisplay(location) : locationDisplay(location)) : null,
      guests: JSON.parse(row.guests), email: emailStatusFor(app, row.id, 'confirmation')
    };
  });
}

export function hostCancel(app, workspaceId, actor, bookingId, body) {
  const reason = text(body.reason, 'reason', { max: 500, multiline: true });
  try {
    app.db.transaction(() => {
      const booking = app.db.get('SELECT * FROM bookings WHERE id = ? AND workspace_id = ?', bookingId, workspaceId);
      const isHost = booking && app.db.get('SELECT 1 FROM meeting_hosts WHERE meeting_id = ? AND host_id = ?', booking.meeting_id, actor.userId);
      if (!booking || (!isHost && !can(actor.role, 'meet.manage_all'))) fail(404, 'not_found', 'Appointment not found.');
      if (booking.status === 'canceled') fail(409, 'already_canceled', 'This appointment is already canceled.');
      const eventType = loadEventType(app, booking.event_type_id);
      const attendees = body.whole_meeting ? app.db.all("SELECT * FROM bookings WHERE meeting_id = ? AND status <> 'canceled'", booking.meeting_id) : [booking];
      for (const attendee of attendees) cancelAttendee(app, attendee, eventType, 'host', reason, attendee.ends_at > app.now());
    });
  } finally { app.nudge?.(); }
}
