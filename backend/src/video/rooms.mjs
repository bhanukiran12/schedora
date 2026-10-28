import { createHash, createHmac, randomUUID } from 'node:crypto';
import { fail } from '../http.mjs';
import { text } from '../validate.mjs';
import { newToken, sha256 } from '../platform/auth.mjs';
import { can } from '../platform/workspaces.mjs';
import { entitlementsFor } from '../billing/entitlements.mjs';
import { queueEmail } from '../platform/email.mjs';
import { UNITS_PER_CREDIT } from './config.mjs';
import { chargeOverrun, grantAllowance, reserve, settleReservation, spendableUnits } from './credits.mjs';

// Schedora Meet native video rooms.
//
// Admission rules (all decided on the server inside one transaction):
// - Members: workspace membership from the session. Host = assigned (active) booking host, the
//   creator of an instant room, or a workspace owner/admin. Other members may join instant
//   rooms as participants; scheduled rooms are visible only to their hosts and administrators.
// - Guests: a scoped attendance credential (hash stored) for one room, separate from booking
//   management tokens. Booking credentials stop working when the booking is canceled or
//   rescheduled, and require the booking to be confirmed (paid bookings: paid).
// - Time window: from join_opens_at (start minus the early-join minutes) to max_ends_at.
// - Guests wait until a host has actually connected when guest_policy = host_first.
// - Limits: room participants, invitation seats, workspace concurrent rooms/participants,
//   global participants, monthly estimated-cost budget, and the kill switch.
// - Funding: one reservation block of credits is held before any token is issued.
// Client-supplied roles, identities, room names or billing owners are never accepted.

const MINUTE = 60000;
const ACTIVE = "(p.status = 'joined' OR (p.status = 'admitted' AND p.token_expires_at > ?))";
const TERMINAL_ROOM = ['ended', 'canceled'];

const inviteKey = app => {
  if (!app.config.encryptionKey && app.config.production) fail(503, 'video_unavailable', 'Meeting links need APP_ENCRYPTION_KEY on the server.');
  return createHash('sha256').update('schedora-video-invite:' + (app.config.encryptionKey || 'schedora-development-only-key')).digest();
};
// Attendance secrets are derived (not stored): only their SHA-256 is in the database.
export const inviteToken = (app, invite) => createHmac('sha256', inviteKey(app)).update(`${invite.id}:${invite.nonce}`).digest('base64url');
export const joinUrl = (app, token) => `${app.config.baseUrl}/meet/join/${token}`;
export const hostUrl = (app, room) => `${app.config.baseUrl}/meet/room/${room.public_id}`;
const memberIdentity = (roomId, userId) => 'm-' + createHash('sha256').update(roomId + ':' + userId).digest('hex').slice(0, 24);
const guestIdentity = () => 'g-' + randomUUID().replace(/-/g, '').slice(0, 24);
const videoFail = (status, code, message, details) => fail(status, code, message, details);

export const isNativeVideo = location => (typeof location === 'string' ? JSON.parse(location) : location)?.type === 'schedora_meet';

function videoReady(app) {
  if (!app.config.video.enabled || !app.config.video.deployment) videoFail(503, 'video_unavailable', 'Schedora Meet video is not available right now. Your appointment is unaffected; contact the host for another way to meet.');
  if (app.config.video.killSwitch !== 'off') videoFail(503, 'video_unavailable', 'Schedora Meet video is temporarily paused. Please try again later.');
}

export function videoProvider(app, deployment) {
  const provider = app.video.providers.get(deployment);
  if (!provider) throw Object.assign(new Error(`Video deployment ${deployment} is not configured.`), { code: 'deployment_unavailable' });
  return provider;
}

function maxEnd(app, startsAt, endsAt) {
  const video = app.config.video;
  return Math.max(endsAt, Math.min(endsAt + video.overtimeMinutes * MINUTE, startsAt + video.maxRoomMinutes * MINUTE));
}

function insertRoom(app, { workspaceId, meetingId = null, kind, title, createdBy = null, startsAt, endsAt, status }) {
  const now = app.now();
  const deployment = app.config.video.deployment || 'unassigned';
  const provider = app.video.providers.get(deployment)?.name || 'unassigned';
  const room = {
    id: randomUUID(), workspace_id: workspaceId, meeting_id: meetingId, public_id: newToken(16), kind, title, created_by: createdBy,
    provider, deployment, room_name: 'sch-' + randomUUID().replace(/-/g, ''), status, guest_policy: app.config.video.guestPolicy,
    max_participants: app.config.video.maxParticipants, join_opens_at: kind === 'instant' ? now : startsAt - app.config.video.joinEarlyMinutes * MINUTE,
    starts_at: startsAt, ends_at: endsAt, max_ends_at: maxEnd(app, startsAt, endsAt), created_at: now, updated_at: now
  };
  const result = app.db.run(`INSERT OR IGNORE INTO video_rooms (${Object.keys(room).join(', ')}) VALUES (${Object.keys(room).map(() => '?').join(', ')})`, ...Object.values(room));
  return result.changes ? room : null;
}

function createInvite(app, room, { bookingId = null, kind, seats, createdBy = null }) {
  const invite = { id: randomUUID(), room_id: room.id, workspace_id: room.workspace_id, booking_id: bookingId, kind, nonce: newToken(16), seats, created_by: createdBy, expires_at: room.max_ends_at, created_at: app.now() };
  const token = inviteToken(app, invite);
  const result = app.db.run(`INSERT OR IGNORE INTO video_invites (id, room_id, workspace_id, booking_id, kind, nonce, token_hash, seats, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    invite.id, invite.room_id, invite.workspace_id, invite.booking_id, invite.kind, invite.nonce, sha256(token), invite.seats, invite.created_by, invite.expires_at, invite.created_at);
  return result.changes ? { invite, token } : null;
}

// ---- Rooms ----------------------------------------------------------------------------------

export function createInstantRoom(app, actor, body) {
  videoReady(app);
  if (!entitlementsFor(app, actor.workspace.id).meet.active) videoFail(402, 'entitlement_required', 'This workspace needs an active Meet or Suite plan to start video meetings.');
  const title = text(body.title || 'Instant meeting', 'title', { min: 1, max: 120 });
  const now = app.now();
  return app.db.transaction(() => {
    const open = app.db.get("SELECT COUNT(*) AS count FROM video_rooms WHERE workspace_id = ? AND kind = 'instant' AND created_by = ? AND status IN ('open', 'scheduled') AND max_ends_at > ?", actor.workspace.id, actor.userId, now).count;
    if (open >= 5) videoFail(409, 'too_many_rooms', 'End one of your open instant meetings before starting another.');
    return insertRoom(app, { workspaceId: actor.workspace.id, kind: 'instant', title, createdBy: actor.userId, startsAt: now, endsAt: now + app.config.video.maxRoomMinutes * MINUTE, status: 'open' });
  });
}

// Inside the booking transaction when a booking with the Schedora Meet location is confirmed
// (after payment for paid event types). Database only: provider resources are created when the
// first participant is admitted. One room per meeting occurrence, shared by group bookings.
export function ensureBookingVideo(app, booking, eventType) {
  if (!isNativeVideo(booking.location)) return null;
  const meeting = app.db.get('SELECT id, starts_at, ends_at FROM meetings WHERE id = ?', booking.meeting_id);
  insertRoom(app, { workspaceId: booking.workspace_id, meetingId: meeting.id, kind: 'scheduled', title: eventType.title, startsAt: meeting.starts_at, endsAt: meeting.ends_at, status: 'scheduled' });
  const room = app.db.get('SELECT * FROM video_rooms WHERE meeting_id = ?', meeting.id);
  const guests = JSON.parse(typeof booking.guests === 'string' ? booking.guests : JSON.stringify(booking.guests || []));
  createInvite(app, room, { bookingId: booking.id, kind: 'booking', seats: Math.min(11, 1 + guests.length) });
  return room;
}

export function bookingJoinUrl(app, bookingId) {
  const invite = app.db.get('SELECT i.* FROM video_invites i JOIN bookings b ON b.id = i.booking_id WHERE i.booking_id = ? AND i.revoked_at IS NULL AND b.status = ?', bookingId, 'confirmed');
  return invite ? joinUrl(app, inviteToken(app, invite)) : null;
}

// The attendance window the server enforces for a booking's room (join_opens_at to max_ends_at),
// or null when the booking has no usable link (canceled, rescheduled, revoked or video off).
export function bookingJoinWindow(app, bookingId) {
  const room = app.db.get(`SELECT r.join_opens_at, r.max_ends_at, r.guest_policy FROM video_rooms r JOIN bookings b ON b.meeting_id = r.meeting_id
    JOIN video_invites i ON i.booking_id = b.id AND i.revoked_at IS NULL WHERE b.id = ? AND b.status = 'confirmed' AND r.status NOT IN ('ended', 'ending', 'canceled')`, bookingId);
  return room ? { opens_at: room.join_opens_at, closes_at: room.max_ends_at, waits_for_host: room.guest_policy === 'host_first' } : null;
}

export function meetingHostUrl(app, meetingId) {
  const room = app.db.get('SELECT public_id FROM video_rooms WHERE meeting_id = ?', meetingId);
  return room ? hostUrl(app, room) : null;
}

function enqueueOp(app, room, op, identity, key) {
  const now = app.now();
  app.db.run(`INSERT OR IGNORE INTO video_provider_ops (id, room_id, op, identity, op_key, status, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    randomUUID(), room.id, op, identity ?? null, key, now, now, now);
}

function removeParticipantRow(app, room, participant, reason) {
  app.db.run("UPDATE video_participants SET status = 'removed', removed_reason = ?, left_at = COALESCE(left_at, ?), updated_at = ? WHERE id = ? AND status <> 'removed'", reason, app.now(), app.now(), participant.id);
  if (room.provisioned_at) enqueueOp(app, room, 'remove_participant', participant.identity, `remove:${participant.id}:${reason}:${app.now()}`);
}

// Booking canceled or rescheduled: its attendance credential stops working immediately; any guest
// admitted with it is removed at the provider. If no attendee remains, the room is canceled.
export function revokeBookingVideo(app, booking, reason) {
  const invite = app.db.get('SELECT * FROM video_invites WHERE booking_id = ?', booking.id);
  if (!invite) return;
  app.db.run('UPDATE video_invites SET revoked_at = COALESCE(revoked_at, ?), revoke_reason = COALESCE(revoke_reason, ?) WHERE id = ?', app.now(), reason, invite.id);
  const room = app.db.get('SELECT * FROM video_rooms WHERE id = ?', invite.room_id);
  for (const participant of app.db.all("SELECT * FROM video_participants WHERE invite_id = ? AND status IN ('admitted', 'joined')", invite.id)) removeParticipantRow(app, room, participant, 'booking_' + reason);
  const meeting = room.meeting_id && app.db.get('SELECT status FROM meetings WHERE id = ?', room.meeting_id);
  if (meeting?.status === 'canceled') endRoomTx(app, room, 'booking_canceled', 'canceled');
}

function endRoomTx(app, room, reason, finalStatus = 'ended') {
  if (TERMINAL_ROOM.includes(room.status)) return false;
  const now = app.now();
  for (const participant of app.db.all("SELECT * FROM video_participants WHERE room_id = ? AND status IN ('admitted', 'joined')", room.id)) {
    app.db.run("UPDATE video_participants SET status = 'removed', removed_reason = ?, left_at = COALESCE(left_at, ?), updated_at = ? WHERE id = ?", reason, now, now, participant.id);
  }
  app.db.run('UPDATE video_invites SET revoked_at = COALESCE(revoked_at, ?), revoke_reason = COALESCE(revoke_reason, ?) WHERE room_id = ?', now, reason, room.id);
  // Deleting the provider room disconnects everyone. Until it succeeds the room is 'ending'.
  const status = room.provisioned_at && finalStatus === 'ended' ? 'ending' : finalStatus;
  app.db.run('UPDATE video_rooms SET status = ?, ended_at = COALESCE(ended_at, ?), end_reason = COALESCE(end_reason, ?), updated_at = ? WHERE id = ?', status, now, reason, now, room.id);
  if (room.provisioned_at) enqueueOp(app, room, 'delete_room', null, `delete:${room.id}:${reason}`);
  return true;
}

export function endRoom(app, room, reason) {
  try { return app.db.transaction(() => endRoomTx(app, app.db.get('SELECT * FROM video_rooms WHERE id = ?', room.id), reason)); }
  finally { app.nudge?.(); }
}

// ---- Lookup and views -----------------------------------------------------------------------

export function roomForMember(app, actor, publicId) {
  const room = typeof publicId === 'string' && app.db.get('SELECT * FROM video_rooms WHERE public_id = ? AND workspace_id = ?', publicId, actor.workspace.id);
  if (!room) videoFail(404, 'not_found', 'Meeting not found.');
  const admin = can(actor.role, 'meet.manage_all');
  let host = admin;
  if (room.kind === 'instant') host ||= room.created_by === actor.userId;
  else host ||= Boolean(room.meeting_id && app.db.get('SELECT 1 FROM meeting_hosts WHERE meeting_id = ? AND host_id = ? AND active = 1', room.meeting_id, actor.userId));
  // Scheduled rooms are private to their hosts and administrators, like the bookings themselves.
  if (room.kind === 'scheduled' && !host) videoFail(404, 'not_found', 'Meeting not found.');
  return { room, role: host ? 'host' : 'participant' };
}

export function inviteByToken(app, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) videoFail(404, 'not_found', 'This meeting link is not valid.');
  const invite = app.db.get('SELECT * FROM video_invites WHERE token_hash = ?', sha256(token));
  if (!invite) videoFail(404, 'not_found', 'This meeting link is not valid.');
  return { invite, room: app.db.get('SELECT * FROM video_rooms WHERE id = ?', invite.room_id) };
}

function guestState(app, invite, room) {
  const now = app.now();
  if (invite.booking_id) {
    const booking = app.db.get('SELECT status, rescheduled_to FROM bookings WHERE id = ?', invite.booking_id);
    if (!booking || booking.status === 'canceled') return booking?.rescheduled_to ? 'rescheduled' : 'canceled';
    if (booking.status !== 'confirmed') return 'payment_pending';
  }
  if (room.status === 'canceled') return 'canceled';
  if (invite.revoked_at) return 'revoked';
  if (['ended', 'ending'].includes(room.status) || now >= room.max_ends_at || now >= invite.expires_at) return 'ended';
  if (now < room.join_opens_at) return 'too_early';
  return 'open';
}

// Coarse, non-sensitive reasons a room ended, safe to show every participant.
const END_CAUSES = { ended_by_host: 'host', max_duration: 'time_limit', kill_switch: 'paused', booking_canceled: 'canceled' };
// What happened to one participant, for their own client after a disconnect. Matched by room AND
// the caller's own credential (their guest invite or their account), so it reveals nobody else.
function selfStatus(app, room, participantId, { guestInvite, userId }) {
  if (typeof participantId !== 'string' || !participantId) return null;
  const row = app.db.get('SELECT status, removed_reason FROM video_participants WHERE id = ? AND room_id = ? AND (invite_id = ? OR user_id = ?)',
    participantId, room.id, guestInvite?.id ?? '', userId ?? '');
  return row ? { status: row.status, removed_reason: row.status === 'removed' ? row.removed_reason : null } : null;
}

export function roomView(app, room, { role = null, guestInvite = null, participantId = null, userId = null } = {}) {
  const workspace = app.db.get('SELECT name, brand_color, logo FROM workspaces WHERE id = ?', room.workspace_id);
  const now = app.now();
  const state = guestInvite ? guestState(app, guestInvite, room)
    : room.status === 'canceled' ? 'canceled' : ['ended', 'ending'].includes(room.status) || now >= room.max_ends_at ? 'ended' : now < room.join_opens_at ? 'too_early' : 'open';
  const view = {
    public_id: guestInvite ? undefined : room.public_id, kind: room.kind, title: room.title, status: room.status, state,
    starts_at: room.kind === 'scheduled' ? room.starts_at : null, ends_at: room.kind === 'scheduled' ? room.ends_at : null,
    join_opens_at: room.join_opens_at, max_ends_at: room.max_ends_at, host_present: Boolean(room.host_joined_at), guest_policy: room.guest_policy,
    workspace: { name: workspace.name, brand_color: workspace.brand_color, logo: workspace.logo },
    video: { available: app.config.video.enabled && Boolean(app.config.video.deployment) && app.config.video.killSwitch === 'off', max_video_height: app.config.video.maxVideoHeight },
    role, end_cause: room.end_reason ? END_CAUSES[room.end_reason] || 'other' : null,
    you: selfStatus(app, room, participantId, { guestInvite, userId })
  };
  if (role === 'host') {
    view.host_url = hostUrl(app, room);
    view.low_balance = Boolean(room.low_balance_at);
    view.end_reason = room.end_reason;
    view.participants = app.db.all(`SELECT id, identity, display_name, role, principal, status, joined_at, left_at, funding_state FROM video_participants WHERE room_id = ? AND status IN ('admitted', 'joined') ORDER BY admitted_at`, room.id);
  }
  return view;
}

export function listRooms(app, actor, scope = 'current') {
  const now = app.now();
  const admin = can(actor.role, 'meet.manage_all');
  const rows = app.db.all(`SELECT r.* FROM video_rooms r WHERE r.workspace_id = ? AND (${scope === 'past' ? "(r.status IN ('ended', 'canceled') OR r.max_ends_at <= ?)" : "r.status NOT IN ('ended', 'canceled') AND r.max_ends_at > ?"})
    AND (? = 1 OR r.created_by = ? OR EXISTS (SELECT 1 FROM meeting_hosts h WHERE h.meeting_id = r.meeting_id AND h.host_id = ? AND h.active = 1))
    ORDER BY r.starts_at ${scope === 'past' ? 'DESC' : 'ASC'} LIMIT 100`, actor.workspace.id, now, admin ? 1 : 0, actor.userId, actor.userId);
  return rows.map(room => ({ ...roomView(app, room, { role: 'host' }), participants: undefined }));
}

export function createRoomInvite(app, actor, publicId, body) {
  const { room, role } = roomForMember(app, actor, publicId);
  if (role !== 'host') videoFail(403, 'forbidden', 'Only hosts can invite guests.');
  if (TERMINAL_ROOM.includes(room.status) || room.max_ends_at <= app.now()) videoFail(409, 'meeting_ended', 'This meeting has ended.');
  const seats = body.seats === undefined ? 5 : Number(body.seats);
  if (!Number.isInteger(seats) || seats < 1 || seats > 20) videoFail(400, 'validation_failed', 'Choose from 1 to 20 guests for this link.', { field: 'seats' });
  const { token, invite } = app.db.transaction(() => {
    const count = app.db.get("SELECT COUNT(*) AS count FROM video_invites WHERE room_id = ? AND kind = 'link'", room.id).count;
    if (count >= 20) videoFail(409, 'too_many_links', 'This meeting already has the maximum number of guest links.');
    return createInvite(app, room, { kind: 'link', seats, createdBy: actor.userId });
  });
  return { url: joinUrl(app, token), seats, expires_at: invite.expires_at, id: invite.id };
}

// ---- Admission ------------------------------------------------------------------------------

function activeCount(app, where, ...params) {
  return app.db.get(`SELECT COUNT(*) AS count FROM video_participants p WHERE ${ACTIVE} AND ${where}`, app.now(), ...params).count;
}

export function estimatedMonthCostMicros(app) {
  const date = new Date(app.now());
  const since = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const settled = app.db.get('SELECT CAST(COALESCE(SUM(estimated_cost_micros), 0) AS BIGINT) AS micros FROM video_usage_records WHERE created_at >= ?', since).micros;
  const held = app.db.get("SELECT CAST(COALESCE(SUM(units_reserved), 0) AS BIGINT) AS units FROM credit_reservations WHERE status = 'held' AND room_id IS NOT NULL").units;
  return settled + Math.ceil(held * app.config.video.costPerParticipantMinuteMicros / UNITS_PER_CREDIT);
}

// Ensures the participant is funded through at least renewBefore from now. Windows for one
// participant never overlap, so the same connected second is never charged twice.
function fundParticipant(app, room, participant, { minSeconds }) {
  const now = app.now();
  const latest = app.db.get('SELECT MAX(covers_until) AS until FROM credit_reservations WHERE participant_id = ?', participant.id).until;
  if (latest && latest - now > app.config.video.renewBeforeSeconds * 1000) return latest;
  const from = Math.max(now, latest || 0);
  const reservation = reserve(app, { workspaceId: room.workspace_id, roomId: room.id, participantId: participant.id, coversFrom: from, seconds: app.config.video.blockSeconds, minSeconds, key: `fund:${participant.id}:${from}` });
  return reservation ? reservation.covers_until : null;
}

function admitTx(app, room, who) {
  return app.db.transaction(() => {
    room = app.db.get('SELECT * FROM video_rooms WHERE id = ?', room.id);
    const now = app.now();
    videoReady(app);
    // Guests get the most specific reason first (their booking was canceled or rescheduled).
    const invite = who.invite && app.db.get('SELECT * FROM video_invites WHERE id = ?', who.invite.id);
    if (invite) {
      const messages = { canceled: [410, 'booking_canceled', 'This appointment was canceled, so its meeting link no longer works.'], rescheduled: [410, 'booking_rescheduled', 'This appointment was rescheduled. Use the link in your newest confirmation email.'],
        payment_pending: [409, 'payment_pending', 'Complete payment for this appointment to join.'], revoked: [410, 'link_revoked', 'This meeting link is no longer valid.'], ended: [410, 'meeting_ended', 'This meeting has ended.'] };
      const state = guestState(app, invite, room);
      if (messages[state]) videoFail(...messages[state]);
    }
    if (room.status === 'canceled') videoFail(410, 'meeting_canceled', 'This meeting was canceled.');
    if (['ended', 'ending'].includes(room.status) || now >= room.max_ends_at) videoFail(410, 'meeting_ended', 'This meeting has ended.');
    if (now < room.join_opens_at) videoFail(409, 'too_early', 'This meeting is not open yet.', { opens_at: room.join_opens_at });
    if (room.meeting_id && app.db.get('SELECT status FROM meetings WHERE id = ?', room.meeting_id)?.status !== 'active') videoFail(410, 'meeting_canceled', 'This meeting was canceled.');
    if (invite && room.guest_policy === 'host_first' && !room.host_joined_at) videoFail(409, 'waiting_for_host', 'The host has not joined yet. This page will let you in when they arrive.');
    if (who.userId && !app.db.get('SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ?', room.workspace_id, who.userId)) videoFail(404, 'not_found', 'Meeting not found.');
    if (!entitlementsFor(app, room.workspace_id).meet.active) videoFail(402, 'entitlement_required', who.invite ? 'This meeting is not available right now. Please contact the host.' : 'This workspace needs an active Meet or Suite plan for video meetings.');

    // Existing principal: a member's stable identity, or a guest resuming their own seat in this tab.
    let participant = who.userId
      ? app.db.get('SELECT * FROM video_participants WHERE room_id = ? AND identity = ?', room.id, memberIdentity(room.id, who.userId))
      : who.resume && app.db.get('SELECT * FROM video_participants WHERE id = ? AND room_id = ? AND invite_id = ? AND status IN (?, ?)', who.resume, room.id, who.invite.id, 'admitted', 'joined');
    // Only a host's removal is permanent; people removed for credits, time limits or revoked access may rejoin once allowed.
    if (participant?.status === 'removed' && participant.removed_reason === 'removed_by_host') videoFail(403, 'removed_from_meeting', 'A host removed you from this meeting.');
    const reusing = participant && (participant.status === 'joined' || (participant.status === 'admitted' && participant.token_expires_at > now));
    if (!reusing) {
      if (activeCount(app, 'p.room_id = ?', room.id) >= room.max_participants) videoFail(409, 'room_full', 'This meeting is full.');
      if (who.invite && activeCount(app, 'p.invite_id = ?', who.invite.id) >= who.invite.seats) videoFail(409, 'room_full', 'Everyone invited with this link has already joined.');
      if (activeCount(app, 'p.workspace_id = ?', room.workspace_id) >= app.config.video.maxWorkspaceParticipants) videoFail(429, 'workspace_limit', 'This workspace has reached its limit of people in video meetings at once.');
      if (!activeCount(app, 'p.room_id = ?', room.id) && app.db.get(`SELECT COUNT(DISTINCT p.room_id) AS count FROM video_participants p WHERE ${ACTIVE} AND p.workspace_id = ?`, now, room.workspace_id).count >= app.config.video.maxConcurrentRooms) {
        videoFail(429, 'workspace_limit', 'This workspace has reached its limit of video meetings running at once.');
      }
      if (activeCount(app, '1 = 1') >= app.config.video.maxGlobalParticipants) videoFail(503, 'capacity_limit', 'Schedora Meet video is at capacity. Please try again shortly.');
      if (app.config.video.monthlyCostBudgetMicros && estimatedMonthCostMicros(app) >= app.config.video.monthlyCostBudgetMicros) videoFail(503, 'capacity_limit', 'Schedora Meet video is at capacity. Please try again later.');
    }
    if (!participant) {
      participant = {
        id: randomUUID(), room_id: room.id, workspace_id: room.workspace_id, principal: who.userId ? 'member' : 'guest', user_id: who.userId || null, invite_id: who.invite?.id || null,
        role: who.role, identity: who.userId ? memberIdentity(room.id, who.userId) : guestIdentity(), display_name: who.name, status: 'admitted',
        admitted_at: now, token_expires_at: now, funded_until: now, created_at: now, updated_at: now
      };
      app.db.run(`INSERT INTO video_participants (${Object.keys(participant).join(', ')}) VALUES (${Object.keys(participant).map(() => '?').join(', ')})`, ...Object.values(participant));
    }
    grantAllowance(app, room.workspace_id);
    const fundedUntil = fundParticipant(app, room, participant, { minSeconds: app.config.video.blockSeconds });
    if (!fundedUntil) videoFail(402, 'insufficient_credits', who.invite ? 'This meeting cannot start right now. Please contact the host.' : 'There are not enough Meet credits for this meeting. A workspace owner can recharge credits on the Plans page.');
    const tokenExpires = now + app.config.video.tokenTtlSeconds * 1000;
    app.db.run(`UPDATE video_participants SET status = CASE WHEN status = 'joined' THEN 'joined' ELSE 'admitted' END, role = ?, display_name = ?, admitted_at = ?, token_expires_at = ?, funded_until = ?, funding_state = 'funded', left_at = CASE WHEN status = 'joined' THEN left_at ELSE NULL END, updated_at = ? WHERE id = ?`,
      who.role, who.name, now, tokenExpires, fundedUntil, now, participant.id);
    if (room.status === 'scheduled') app.db.run("UPDATE video_rooms SET status = 'open', updated_at = ? WHERE id = ?", now, room.id);
    // A room that never reached the provider may move to the current deployment; a provisioned
    // room always stays on the deployment that created it.
    if (!room.provisioned_at && !app.video.providers.has(room.deployment) && app.config.video.deployment) {
      app.db.run('UPDATE video_rooms SET deployment = ?, provider = ? WHERE id = ? AND provisioned_at IS NULL', app.config.video.deployment, videoProvider(app, app.config.video.deployment).name, room.id);
    }
    return { participant: app.db.get('SELECT * FROM video_participants WHERE id = ?', participant.id), room: app.db.get('SELECT * FROM video_rooms WHERE id = ?', room.id) };
  });
}

// Issues the provider token after the admission transaction. Provider calls never run inside a
// database transaction. If the provider fails, the admission is withdrawn and its credits released.
async function issue(app, room, participant) {
  let provider;
  try {
    provider = videoProvider(app, room.deployment);
    if (!room.provisioned_at) {
      await provider.createRoom({ name: room.room_name, maxParticipants: room.max_participants });
      app.db.run('UPDATE video_rooms SET provisioned_at = COALESCE(provisioned_at, ?), updated_at = ? WHERE id = ?', app.now(), app.now(), room.id);
    }
    const token = await provider.issueToken({ room: room.room_name, identity: participant.identity, name: participant.display_name, ttlSeconds: app.config.video.tokenTtlSeconds });
    return { token, url: provider.clientUrl, participant_id: participant.id, identity: participant.identity, role: participant.role, expires_in: app.config.video.tokenTtlSeconds, funded_until: participant.funded_until };
  } catch (error) {
    app.log('warn', 'video_admission_provider_failed', { room: room.id, deployment: room.deployment, error: error.message });
    app.db.transaction(() => {
      if (participant.status !== 'joined') app.db.run("UPDATE video_participants SET status = 'expired', token_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'admitted'", app.now(), app.now(), participant.id);
      for (const reservation of app.db.all("SELECT id FROM credit_reservations WHERE participant_id = ? AND status = 'held' AND created_at >= ?", participant.id, participant.admitted_at)) {
        if (!app.db.get('SELECT 1 FROM video_usage_intervals WHERE participant_id = ?', participant.id)) settleAndRecord(app, reservation.id, 0, 0);
      }
    });
    videoFail(503, 'video_unavailable', 'The video service is not responding. Please try again in a moment.');
  }
}

export async function admitMember(app, actor, publicId, body) {
  const { room, role } = roomForMember(app, actor, publicId);
  const name = text(body.display_name || actor.userName || 'Host', 'display_name', { min: 1, max: 60 });
  const { participant, room: fresh } = admitTx(app, room, { userId: actor.userId, role, name });
  try { return { ...(await issue(app, fresh, participant)), room: roomView(app, fresh, { role }) }; }
  finally { app.nudge?.(); }
}

export async function admitGuest(app, token, body) {
  const { invite, room } = inviteByToken(app, token);
  const name = text(body.display_name, 'display_name', { min: 1, max: 60 });
  const resume = typeof body.resume === 'string' && /^[0-9a-f-]{36}$/.test(body.resume) ? body.resume : null;
  const { participant, room: fresh } = admitTx(app, room, { invite, role: 'participant', name, resume });
  try { return { ...(await issue(app, fresh, participant)), room: roomView(app, fresh, { guestInvite: invite }) }; }
  finally { app.nudge?.(); }
}

export function removeParticipantByHost(app, actor, publicId, participantId) {
  const { room, role } = roomForMember(app, actor, publicId);
  if (role !== 'host') videoFail(403, 'forbidden', 'Only hosts can remove people.');
  app.db.transaction(() => {
    const participant = app.db.get("SELECT * FROM video_participants WHERE id = ? AND room_id = ? AND status IN ('admitted', 'joined')", participantId, room.id);
    if (!participant) videoFail(404, 'not_found', 'That person is not in this meeting.');
    if (participant.user_id === actor.userId) videoFail(409, 'cannot_remove_self', 'Leave the meeting instead of removing yourself.');
    removeParticipantRow(app, room, participant, 'removed_by_host');
    // A removed guest's link (all of its seats) stops working; the host can send a new link.
    if (participant.invite_id) app.db.run("UPDATE video_invites SET revoked_at = COALESCE(revoked_at, ?), revoke_reason = COALESCE(revoke_reason, 'removed_by_host') WHERE id = ?", app.now(), participant.invite_id);
  });
  app.nudge?.();
}

export function endRoomByHost(app, actor, publicId) {
  const { room, role } = roomForMember(app, actor, publicId);
  if (role !== 'host') videoFail(403, 'forbidden', 'Only hosts can end the meeting for everyone.');
  endRoom(app, room, 'ended_by_host');
}

// ---- Provider webhooks and event processing -------------------------------------------------

export async function receiveWebhook(app, deploymentId, raw, authorization) {
  const provider = app.video.providers.get(deploymentId);
  if (!provider) videoFail(404, 'not_found', 'Unknown video deployment.');
  let event;
  try { event = await provider.verifyWebhook(raw, authorization); }
  catch (error) { videoFail(error.status === 400 ? 400 : 401, 'invalid_signature', 'Webhook could not be verified.'); }
  // Persisted before acknowledging; duplicates are ignored by (deployment, event id).
  const inserted = app.db.run(`INSERT OR IGNORE INTO video_provider_events (id, deployment, event_id, type, room_name, created_at, payload, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    randomUUID(), deploymentId, event.id, event.type, event.room?.name ?? null, event.createdAtMs, JSON.stringify(event), app.now());
  app.nudge?.();
  return inserted.changes ? 'accepted' : 'duplicate';
}

const BILLABLE_KINDS = ['standard'];

function openInterval(app, room, participant, { sid, joinedAt, seenAt }) {
  const now = app.now();
  // A new connection for the same identity replaces the previous one (LiveKit disconnects it).
  app.db.run("UPDATE video_usage_intervals SET left_at = ?, close_source = 'replaced' WHERE room_id = ? AND identity = ? AND left_at IS NULL AND provider_sid <> ? AND joined_at <= ?", joinedAt, room.id, participant.identity, sid, joinedAt);
  app.db.run(`INSERT OR IGNORE INTO video_usage_intervals (id, room_id, workspace_id, participant_id, identity, provider_sid, joined_at, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    randomUUID(), room.id, room.workspace_id, participant.id, participant.identity, sid, joinedAt, seenAt, now);
  app.db.run("UPDATE video_participants SET status = CASE WHEN status IN ('admitted', 'left', 'expired') THEN 'joined' ELSE status END, joined_at = COALESCE(joined_at, ?), left_at = NULL, updated_at = ? WHERE id = ? AND status <> 'removed'", joinedAt, now, participant.id);
  app.db.run("UPDATE video_rooms SET started_at = COALESCE(started_at, ?), status = CASE WHEN status = 'scheduled' THEN 'open' ELSE status END, updated_at = ? WHERE id = ?", joinedAt, now, room.id);
  if (participant.role === 'host') app.db.run('UPDATE video_rooms SET host_joined_at = COALESCE(host_joined_at, ?) WHERE id = ?', joinedAt, room.id);
}

function closeInterval(app, room, interval, at, source) {
  app.db.run('UPDATE video_usage_intervals SET left_at = ?, close_source = ? WHERE id = ? AND left_at IS NULL', Math.max(interval.joined_at, at), source, interval.id);
  const others = app.db.get('SELECT 1 FROM video_usage_intervals WHERE room_id = ? AND identity = ? AND left_at IS NULL', room.id, interval.identity);
  if (!others) app.db.run("UPDATE video_participants SET status = CASE WHEN status = 'joined' THEN 'left' ELSE status END, left_at = COALESCE(left_at, ?), updated_at = ? WHERE room_id = ? AND identity = ?", at, app.now(), room.id, interval.identity);
}

// Is this provider participant allowed in this room right now?
function authorizedParticipant(app, room, identity, joinedAt = null) {
  if (!['open', 'scheduled'].includes(room.status)) return null;
  const participant = app.db.get('SELECT * FROM video_participants WHERE room_id = ? AND identity = ?', room.id, identity);
  if (!participant || participant.status === 'removed') return null;
  // An admission expired by the worker is still valid if the provider says it connected while its token was valid (late webhook).
  if (participant.status === 'expired' && !(joinedAt && joinedAt <= participant.token_expires_at + 5000)) return null;
  if (participant.funded_until <= app.now() && participant.funding_state === 'exhausted') return null;
  return participant;
}

function applyEvent(app, row, event, unknownRooms) {
  const now = app.now();
  if (event.createdAtMs > now + 5 * MINUTE) return 'invalid_timestamp';
  const room = event.room?.name && app.db.get('SELECT * FROM video_rooms WHERE deployment = ? AND room_name = ?', row.deployment, event.room.name);
  if (!room) {
    // A token holder can make the provider auto-create a room we do not know; remove it.
    if (['room_started', 'participant_joined'].includes(event.type) && event.room?.name) unknownRooms.push({ deployment: row.deployment, name: event.room.name });
    return 'unknown_room';
  }
  if (event.createdAtMs < room.created_at - 60 * MINUTE) return 'invalid_timestamp';
  const at = Math.min(event.createdAtMs, now);
  const info = event.participant;
  switch (event.type) {
    case 'room_started':
      if (TERMINAL_ROOM.includes(room.status) || room.status === 'ending') { enqueueOp(app, room, 'delete_room', null, `delete:${room.id}:recreated:${row.event_id}`); return 'deleted_recreated_room'; }
      return 'ok';
    case 'participant_joined': {
      if (!info?.sid || !info.identity) return 'invalid_participant';
      const participant = authorizedParticipant(app, room, info.identity, info.joinedAtMs);
      if (!participant || !BILLABLE_KINDS.includes(info.kind)) {
        // Replayed or forged tokens, removed people and unsupported participant types are removed.
        if (room.provisioned_at || room.status !== 'scheduled') enqueueOp(app, room, 'remove_participant', info.identity, `remove:event:${row.event_id}`);
        if (TERMINAL_ROOM.includes(room.status) || room.status === 'ending') enqueueOp(app, room, 'delete_room', null, `delete:${room.id}:late-join:${row.event_id}`);
        // Even unauthorized presence is metered so the provider usage is visible; billing uses participant rows only.
        return !BILLABLE_KINDS.includes(info.kind) ? 'unsupported_kind_removed' : 'unauthorized_removed';
      }
      const joinedAt = Math.min(info.joinedAtMs && info.joinedAtMs <= at + 5000 && info.joinedAtMs >= room.created_at - MINUTE ? info.joinedAtMs : at, at);
      openInterval(app, room, participant, { sid: info.sid, joinedAt, seenAt: at });
      return 'ok';
    }
    case 'participant_left':
    case 'participant_connection_aborted': {
      if (!info?.sid || !info.identity) return 'invalid_participant';
      let interval = app.db.get('SELECT * FROM video_usage_intervals WHERE room_id = ? AND provider_sid = ?', room.id, info.sid);
      if (!interval) {
        // Leave arrived without (or before) its join: rebuild the interval from the provider's join time.
        const participant = app.db.get('SELECT * FROM video_participants WHERE room_id = ? AND identity = ?', room.id, info.identity);
        if (!participant || !info.joinedAtMs || info.joinedAtMs > at || info.joinedAtMs < room.created_at - MINUTE) return 'unmatched_leave';
        openInterval(app, room, participant, { sid: info.sid, joinedAt: info.joinedAtMs, seenAt: at });
        interval = app.db.get('SELECT * FROM video_usage_intervals WHERE room_id = ? AND provider_sid = ?', room.id, info.sid);
      }
      if (interval.left_at != null) {
        // Reconciliation closes at the last confirmed presence; the provider's own leave time wins.
        if (interval.close_source === 'reconcile' && at > interval.left_at) {
          app.db.run('UPDATE video_usage_intervals SET left_at = ?, close_source = ? WHERE id = ?', at, event.type === 'participant_left' ? 'left' : 'aborted', interval.id);
          return 'corrected_leave';
        }
        return 'duplicate_leave';
      }
      closeInterval(app, room, interval, at, event.type === 'participant_left' ? 'left' : 'aborted');
      return 'ok';
    }
    case 'room_finished':
      for (const interval of app.db.all('SELECT * FROM video_usage_intervals WHERE room_id = ? AND left_at IS NULL AND joined_at <= ?', room.id, at)) closeInterval(app, room, interval, at, 'room_finished');
      if (room.status === 'ending') app.db.run("UPDATE video_rooms SET status = 'ended', updated_at = ? WHERE id = ?", now, room.id);
      return 'ok';
    default:
      return 'ignored';
  }
}

export async function processProviderEvents(app, limit = 200) {
  const rows = app.db.all('SELECT * FROM video_provider_events WHERE processed_at IS NULL ORDER BY created_at, received_at LIMIT ?', limit);
  const unknownRooms = [];
  for (const row of rows) {
    try {
      app.db.transaction(() => {
        const result = applyEvent(app, row, JSON.parse(row.payload), unknownRooms);
        app.db.run('UPDATE video_provider_events SET processed_at = ?, result = ?, attempts = attempts + 1 WHERE id = ?', app.now(), result, row.id);
      });
    } catch (error) {
      app.log('error', 'video_event_failed', { event: row.id, error: error.message });
      app.db.run('UPDATE video_provider_events SET attempts = attempts + 1, result = ? WHERE id = ?', String(error.message).slice(0, 200), row.id);
      if (row.attempts >= 10) app.db.run("UPDATE video_provider_events SET processed_at = ?, result = 'failed' WHERE id = ?", app.now(), row.id);
    }
  }
  for (const room of unknownRooms) {
    try { await app.video.providers.get(room.deployment)?.deleteRoom(room.name); }
    catch (error) { app.log('warn', 'video_unknown_room_delete_failed', { deployment: room.deployment, error: error.message }); }
  }
  return rows.length;
}

// ---- Durable provider operations ------------------------------------------------------------

export async function processProviderOps(app, limit = 50) {
  const now = app.now();
  const due = app.db.all("SELECT o.*, r.deployment, r.room_name, r.max_participants FROM video_provider_ops o JOIN video_rooms r ON r.id = o.room_id WHERE o.status = 'pending' AND o.next_attempt_at <= ? ORDER BY o.next_attempt_at LIMIT ?", now, limit);
  for (const op of due) {
    try {
      const provider = videoProvider(app, op.deployment);
      if (op.op === 'create_room') await provider.createRoom({ name: op.room_name, maxParticipants: op.max_participants });
      if (op.op === 'remove_participant') await provider.removeParticipant(op.room_name, op.identity);
      if (op.op === 'delete_room') await provider.deleteRoom(op.room_name);
      app.db.transaction(() => {
        app.db.run("UPDATE video_provider_ops SET status = 'done', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE id = ?", app.now(), op.id);
        if (op.op === 'delete_room') app.db.run("UPDATE video_rooms SET status = CASE WHEN status = 'ending' THEN 'ended' ELSE status END, updated_at = ? WHERE id = ?", app.now(), op.room_id);
      });
    } catch (error) {
      const attempts = op.attempts + 1;
      app.db.run('UPDATE video_provider_ops SET attempts = ?, status = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?',
        attempts, attempts >= 30 ? 'failed' : 'pending', app.now() + Math.min(600000, 2000 * 2 ** Math.min(attempts, 12)), String(error.message).slice(0, 300), app.now(), op.id);
      app.log(attempts >= 30 ? 'error' : 'warn', 'video_provider_op_failed', { op: op.op, room: op.room_id, attempts, error: error.message });
    }
  }
  return due.length;
}

// ---- Funding renewal, admission checks and limits -------------------------------------------

function stillAdmissible(app, room, participant) {
  if (!['open', 'scheduled'].includes(room.status) || app.now() >= room.max_ends_at) return 'meeting_ended';
  if (app.config.video.killSwitch === 'terminate') return 'kill_switch';
  if (!entitlementsFor(app, room.workspace_id).meet.active) return 'entitlement_lapsed';
  if (participant.principal === 'member' && !app.db.get('SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ?', room.workspace_id, participant.user_id)) return 'membership_ended';
  if (participant.invite_id) {
    const invite = app.db.get('SELECT * FROM video_invites WHERE id = ?', participant.invite_id);
    if (!invite || ['canceled', 'rescheduled', 'revoked', 'payment_pending'].includes(guestState(app, invite, room))) return 'invitation_revoked';
  }
  return null;
}

export function enforceVideo(app) {
  const now = app.now();
  const video = app.config.video;
  if (video.killSwitch === 'terminate') {
    for (const room of app.db.all("SELECT * FROM video_rooms WHERE status IN ('open', 'scheduled')")) app.db.transaction(() => endRoomTx(app, room, 'kill_switch'));
  }
  for (const room of app.db.all("SELECT * FROM video_rooms WHERE status IN ('open', 'scheduled') AND max_ends_at <= ?", now)) app.db.transaction(() => endRoomTx(app, room, 'max_duration'));
  // Admissions that never connected expire shortly after their token; their credits return.
  // Two minutes past token expiry leaves room for a delayed join webhook (see authorizedParticipant).
  for (const participant of app.db.all("SELECT * FROM video_participants WHERE status = 'admitted' AND token_expires_at < ?", now - 2 * MINUTE)) {
    app.db.transaction(() => {
      app.db.run("UPDATE video_participants SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'admitted'", now, participant.id);
      if (!app.db.get('SELECT 1 FROM video_usage_intervals WHERE participant_id = ?', participant.id)) {
        for (const reservation of app.db.all("SELECT id FROM credit_reservations WHERE participant_id = ? AND status = 'held'", participant.id)) settleAndRecord(app, reservation.id, 0, 0);
      }
    });
  }
  // Renew funding ahead of time; a participant who cannot be funded keeps the time already
  // reserved (the funded grace period) and is removed when it runs out.
  for (const participant of app.db.all("SELECT * FROM video_participants WHERE status IN ('joined', 'admitted') AND funded_until - ? <= ?", now, video.renewBeforeSeconds * 1000)) {
    app.db.transaction(() => {
      const room = app.db.get('SELECT * FROM video_rooms WHERE id = ?', participant.room_id);
      const fresh = app.db.get('SELECT * FROM video_participants WHERE id = ?', participant.id);
      if (!['joined', 'admitted'].includes(fresh.status)) return;
      const blocked = stillAdmissible(app, room, fresh);
      if (blocked) return removeParticipantRow(app, room, fresh, blocked);
      if (fresh.status === 'admitted') return; // not connected yet; expires above if it never connects
      if (fresh.funding_state === 'funded') {
        grantAllowance(app, room.workspace_id);
        const until = fundParticipant(app, room, fresh, { minSeconds: 60 });
        if (until) app.db.run('UPDATE video_participants SET funded_until = ?, updated_at = ? WHERE id = ?', until, now, fresh.id);
        else {
          app.db.run("UPDATE video_participants SET funding_state = 'exhausted', updated_at = ? WHERE id = ?", now, fresh.id);
          lowBalance(app, room);
        }
      }
      const current = app.db.get('SELECT * FROM video_participants WHERE id = ?', fresh.id);
      if (current.funded_until <= now) removeParticipantRow(app, room, current, 'credits_exhausted');
    });
  }
  for (const room of app.db.all("SELECT r.* FROM video_rooms r WHERE r.status = 'open' AND r.low_balance_at IS NULL AND EXISTS (SELECT 1 FROM video_participants p WHERE p.room_id = r.id AND p.status = 'joined')")) {
    if (spendableUnits(app, room.workspace_id) < video.lowBalanceCredits * UNITS_PER_CREDIT) app.db.transaction(() => lowBalance(app, room));
  }
}

function lowBalance(app, room) {
  if (room.low_balance_at) return;
  app.db.run('UPDATE video_rooms SET low_balance_at = ? WHERE id = ? AND low_balance_at IS NULL', app.now(), room.id);
  const owner = app.db.get("SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.role = 'owner' ORDER BY m.created_at LIMIT 1", room.workspace_id);
  if (owner) queueEmail(app, { workspaceId: room.workspace_id, key: `video-low-balance:${room.id}`, kind: 'video_low_balance', relatedId: room.id, to: owner.email,
    subject: 'Schedora Meet credits are running low',
    body: `A video meeting ("${room.title}") is using the last of this workspace's Meet credits. People are removed from the meeting when the reserved time runs out.\n\nRecharge credits: ${app.config.baseUrl}/billing` });
}

// ---- Reconciliation with the provider -------------------------------------------------------

export async function reconcileRooms(app, { force = false } = {}) {
  const now = app.now();
  if (!force && now - (app.video.lastReconcileAt || 0) < app.config.video.reconcileIntervalSeconds * 1000) return 0;
  app.video.lastReconcileAt = now;
  const rooms = app.db.all(`SELECT r.* FROM video_rooms r WHERE r.provisioned_at IS NOT NULL AND (
      EXISTS (SELECT 1 FROM video_usage_intervals i WHERE i.room_id = r.id AND i.left_at IS NULL)
      OR EXISTS (SELECT 1 FROM video_participants p WHERE p.room_id = r.id AND p.status IN ('joined', 'admitted'))
      OR r.status = 'ending') LIMIT 200`);
  for (const room of rooms) {
    let present;
    try { present = await videoProvider(app, room.deployment).listParticipants(room.room_name); }
    catch (error) { app.log('warn', 'video_reconcile_failed', { room: room.id, error: error.message }); continue; }
    app.db.transaction(() => {
      const seenAt = app.now();
      const live = new Map((present || []).map(item => [item.sid, item]));
      for (const interval of app.db.all('SELECT * FROM video_usage_intervals WHERE room_id = ? AND left_at IS NULL', room.id)) {
        // Missing leave event: close at the last time the provider confirmed presence.
        if (live.has(interval.provider_sid)) app.db.run('UPDATE video_usage_intervals SET last_seen_at = ? WHERE id = ?', seenAt, interval.id);
        else closeInterval(app, room, interval, interval.last_seen_at, 'reconcile');
      }
      for (const item of live.values()) {
        if (app.db.get('SELECT 1 FROM video_usage_intervals WHERE room_id = ? AND provider_sid = ?', room.id, item.sid)) continue;
        const participant = authorizedParticipant(app, app.db.get('SELECT * FROM video_rooms WHERE id = ?', room.id), item.identity, item.joinedAtMs);
        if (!participant || !BILLABLE_KINDS.includes(item.kind)) { enqueueOp(app, room, 'remove_participant', item.identity, `remove:reconcile:${room.id}:${item.sid}`); continue; }
        // Missing join event: start from the provider's join time.
        openInterval(app, room, participant, { sid: item.sid, joinedAt: item.joinedAtMs && item.joinedAtMs <= seenAt ? item.joinedAtMs : seenAt, seenAt });
      }
      if (['ended', 'canceled', 'ending'].includes(room.status) && present?.length) enqueueOp(app, room, 'delete_room', null, `delete:${room.id}:reconcile:${Math.floor(seenAt / 60000)}`);
      if (room.status === 'ending' && present === null) app.db.run("UPDATE video_rooms SET status = 'ended', updated_at = ? WHERE id = ?", seenAt, room.id);
    });
  }
  return rooms.length;
}

// ---- Settlement -----------------------------------------------------------------------------

// Union of connected intervals for one identity in one room, clipped to [from, until).
function connectedMs(intervals, from, until, now) {
  const spans = intervals.map(item => [Math.max(item.joined_at, from), Math.min(item.left_at ?? Math.max(item.last_seen_at, now), until)]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  let total = 0; let end = -Infinity;
  for (const [a, b] of spans) {
    if (a > end) { total += b - a; end = b; }
    else if (b > end) { total += b - end; end = b; }
  }
  return total;
}

function settleAndRecord(app, reservationId, connected, unitsCharged, extra = {}) {
  const reservation = app.db.get('SELECT * FROM credit_reservations WHERE id = ?', reservationId);
  const result = settleReservation(app, reservationId, unitsCharged);
  if (result.duplicate) return;
  app.db.run(`INSERT OR IGNORE INTO video_usage_records (id, workspace_id, room_id, participant_id, reservation_id, usage_key, period_from, period_until, connected_ms, units_charged, units_unfunded, estimated_cost_micros, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, randomUUID(), reservation.workspace_id, reservation.room_id, reservation.participant_id, reservationId, 'reservation:' + reservationId,
  reservation.covers_from, reservation.covers_until, connected, result.consumed, extra.unfunded || 0, Math.ceil(result.consumed * app.config.video.costPerParticipantMinuteMicros / UNITS_PER_CREDIT), app.now());
}

// Settles reservation windows once they are final: the window has ended, the finalization delay
// has passed (late webhooks), and every overlapping interval is closed or confirmed present past
// the window end. Rounding: one ceil to whole participant-seconds per window, at settlement only.
export function settleDue(app, limit = 200) {
  const now = app.now();
  const video = app.config.video;
  const due = app.db.all("SELECT r.*, p.identity, p.room_id AS p_room FROM credit_reservations r JOIN video_participants p ON p.id = r.participant_id WHERE r.status = 'held' AND r.covers_until + ? <= ? ORDER BY r.covers_until LIMIT ?", video.finalizeDelaySeconds * 1000, now, limit);
  let settled = 0;
  for (const reservation of due) {
    app.db.transaction(() => {
      if (app.db.get('SELECT status FROM credit_reservations WHERE id = ?', reservation.id).status !== 'held') return;
      const intervals = app.db.all('SELECT * FROM video_usage_intervals WHERE room_id = ? AND identity = ? AND joined_at < ? AND (left_at IS NULL OR left_at > ?)', reservation.p_room, reservation.identity, reservation.covers_until, reservation.covers_from);
      const unresolved = intervals.some(item => item.left_at == null && item.last_seen_at < reservation.covers_until);
      // Presence unknown (provider unreachable, leave not yet reconciled): wait, but never forever.
      if (unresolved && now - reservation.covers_until < 24 * 3600000) return;
      const ms = connectedMs(intervals.map(item => item.left_at == null && item.last_seen_at < reservation.covers_until ? { ...item, left_at: item.last_seen_at } : item), reservation.covers_from, reservation.covers_until, now);
      settleAndRecord(app, reservation.id, ms, Math.min(reservation.units_reserved, Math.ceil(ms / 1000)));
      settled++;
    });
  }
  settleOverruns(app, now);
  return settled;
}

// Connected time outside every funded window (removal delayed by the worker or the provider) is
// charged once per participant after they are gone, from whatever is spendable; the rest is
// recorded as unfunded for operations review. Balances never go negative.
function settleOverruns(app, now) {
  const candidates = app.db.all(`SELECT p.* FROM video_participants p WHERE p.status IN ('left', 'removed', 'expired') AND p.updated_at <= ?
    AND NOT EXISTS (SELECT 1 FROM video_usage_intervals i WHERE i.room_id = p.room_id AND i.identity = p.identity AND i.left_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM credit_reservations r WHERE r.participant_id = p.id AND r.status = 'held')
    AND EXISTS (SELECT 1 FROM video_usage_intervals i WHERE i.participant_id = p.id)
    LIMIT 100`, now - app.config.video.finalizeDelaySeconds * 1000);
  for (const participant of candidates) {
    app.db.transaction(() => {
      const since = app.db.get("SELECT MAX(period_until) AS until FROM video_usage_records WHERE participant_id = ? AND usage_key LIKE 'overrun:%'", participant.id).until || 0;
      const intervals = app.db.all('SELECT * FROM video_usage_intervals WHERE room_id = ? AND identity = ?', participant.room_id, participant.identity);
      const until = intervals.reduce((max, item) => Math.max(max, item.left_at), 0);
      if (until <= since) return;
      const windows = app.db.all('SELECT covers_from, covers_until FROM credit_reservations WHERE participant_id = ? ORDER BY covers_from', participant.id);
      const total = connectedMs(intervals, since, until, now);
      const covered = windows.reduce((sum, window) => sum + connectedMs(intervals, Math.max(window.covers_from, since), Math.min(window.covers_until, until), now), 0);
      const overrunMs = Math.max(0, total - covered);
      const key = `overrun:${participant.id}:${until}`;
      if (!overrunMs) {
        app.db.run(`INSERT OR IGNORE INTO video_usage_records (id, workspace_id, room_id, participant_id, usage_key, period_from, period_until, connected_ms, units_charged, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
          randomUUID(), participant.workspace_id, participant.room_id, participant.id, key, since, until, now);
        return;
      }
      const units = Math.ceil(overrunMs / 1000);
      const { charged, unfunded } = chargeOverrun(app, participant.workspace_id, units, key, participant.room_id);
      app.db.run(`INSERT OR IGNORE INTO video_usage_records (id, workspace_id, room_id, participant_id, usage_key, period_from, period_until, connected_ms, units_charged, units_unfunded, estimated_cost_micros, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        randomUUID(), participant.workspace_id, participant.room_id, participant.id, key, since, until, overrunMs, charged, unfunded, Math.ceil(units * app.config.video.costPerParticipantMinuteMicros / UNITS_PER_CREDIT), now);
      if (unfunded) app.log('warn', 'video_unfunded_usage', { workspace: participant.workspace_id, room: participant.room_id, units: unfunded });
    });
  }
}

// Worker entry point. Provider calls happen outside database transactions.
export async function videoTick(app) {
  if (!app.video) return;
  await processProviderEvents(app);
  enforceVideo(app);
  await processProviderOps(app);
  await reconcileRooms(app);
  settleDue(app);
}

export function videoHealth(app) {
  const now = app.now();
  return app.db.get(`SELECT
    (SELECT COUNT(*) FROM video_provider_events WHERE processed_at IS NULL) AS pending_events,
    (SELECT COUNT(*) FROM video_provider_ops WHERE status = 'pending') AS pending_ops,
    (SELECT COUNT(*) FROM video_provider_ops WHERE status = 'failed') AS failed_ops,
    (SELECT COUNT(*) FROM video_provider_ops WHERE status = 'pending' AND attempts >= 5) AS stuck_ops,
    (SELECT COUNT(*) FROM credit_reservations WHERE status = 'held' AND covers_until < ?) AS overdue_settlements,
    (SELECT COUNT(*) FROM video_participants WHERE status = 'joined') AS connected_participants,
    (SELECT CAST(COALESCE(SUM(units_unfunded), 0) AS BIGINT) FROM video_usage_records WHERE created_at > ?) AS unfunded_units_24h`, now - 3600000, now - 86400000);
}
