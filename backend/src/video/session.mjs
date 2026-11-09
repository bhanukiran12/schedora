// Session offers and pinned notes in Schedora meeting rooms (docs/MEET_SESSION_OFFERS.md).
// A host attaches one published form to a room; every admitted attendee, including late joiners,
// reads it from durable server state. Receipts record prompted/opened/submitted per attendee seat
// and a response id, never answers. Submissions go through the ordinary Forms path with a signed
// session ticket that binds the response to one offer and one seat.
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { fail } from '../http.mjs';
import { text } from '../validate.mjs';
import { can } from '../platform/workspaces.mjs';
import { availability } from '../forms/service.mjs';
import { guestState, inviteByToken, memberIdentity, roomForMember } from './rooms.mjs';

const MODES = ['auto', 'manual'];
const EVENTS = { prompted: 'prompted_at', opened: 'opened_at' };
const ID = /^[0-9a-f-]{36}$/;
const IN_ROOM = "status IN ('admitted', 'joined')";

const ticketKey = app => {
  if (!app.config.encryptionKey && app.config.production) fail(503, 'video_unavailable', 'Session forms need APP_ENCRYPTION_KEY on the server.');
  return createHash('sha256').update('schedora-session-offer:' + (app.config.encryptionKey || 'schedora-development-only-key')).digest();
};
const mac = (app, payload) => createHmac('sha256', ticketKey(app)).update(payload).digest('base64url');
const ticketFor = (app, offerId, participantId, expiresAt) => { const payload = `${offerId}.${participantId}.${expiresAt}`; return `${payload}.${mac(app, payload)}`; };

/** Verifies a session ticket from a form submission; refuses anything altered, malformed or expired. */
export function verifyTicket(app, ticket) {
  const parts = typeof ticket === 'string' ? ticket.split('.') : [];
  const refuse = () => fail(400, 'session_invalid', 'This meeting form link is no longer valid. Reopen the form from the meeting. Nothing was submitted.');
  if (parts.length !== 4 || !ID.test(parts[0]) || !ID.test(parts[1]) || !/^\d{1,16}$/.test(parts[2])) refuse();
  const expected = Buffer.from(mac(app, parts.slice(0, 3).join('.')));
  const given = Buffer.from(parts[3]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given) || Number(parts[2]) <= app.now()) refuse();
  return { offerId: parts[0], participantId: parts[1] };
}

/**
 * Inside the submission transaction, before the response is written: the ticket's offer must be
 * for this form, the seat must still be in the room, and the seat must not have answered already.
 */
export function assertSessionClaim(app, claim, formId) {
  const offer = app.db.get('SELECT room_id, form_id FROM video_session_offers WHERE id = ?', claim.offerId);
  if (!offer || offer.form_id !== formId) fail(400, 'session_invalid', 'This meeting form link is no longer valid. Reopen the form from the meeting. Nothing was submitted.');
  const room = app.db.get('SELECT * FROM video_rooms WHERE id = ?', offer.room_id);
  const participant = app.db.get(`SELECT * FROM video_participants WHERE id = ? AND room_id = ? AND ${IN_ROOM}`, claim.participantId, offer.room_id);
  // Admission rows may remain present until the video worker reconciles a revocation. A
  // previously issued ticket must not extend that admission or bypass current membership.
  const invite = participant?.invite_id && app.db.get('SELECT * FROM video_invites WHERE id = ?', participant.invite_id);
  const membership = participant?.principal === 'member'
    && app.db.get('SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ?', room?.workspace_id, participant.user_id);
  if (!room || !roomOpen(room) || app.now() >= room.max_ends_at || !participant
    || (participant.principal === 'member' && !membership)
    || (participant.principal === 'guest' && (!invite || guestState(app, invite, room) !== 'open'))) {
    fail(403, 'not_in_meeting', 'You are no longer in this meeting, so this form cannot be submitted from it. Nothing was submitted.');
  }
  if (app.db.get('SELECT 1 FROM video_session_receipts WHERE offer_id = ? AND participant_id = ? AND submitted_at IS NOT NULL', claim.offerId, claim.participantId)) {
    fail(409, 'session_already_submitted', 'You already answered this form in this meeting. Nothing new was submitted.');
  }
}

/** Inside the same transaction, after the response is written. */
export function recordSessionSubmission(app, claim, responseId) {
  app.db.run(`INSERT INTO video_session_receipts (offer_id, participant_id, submitted_at, response_id) VALUES (?, ?, ?, ?)
    ON CONFLICT (offer_id, participant_id) DO UPDATE SET submitted_at = excluded.submitted_at, response_id = excluded.response_id`, claim.offerId, claim.participantId, app.now(), responseId);
}

// ---- Who is asking ----

const roomOpen = room => !['ended', 'ending', 'canceled'].includes(room.status);
const gone = () => fail(410, 'meeting_ended', 'This meeting has ended.');

function memberContext(app, actor, publicId) {
  const { room, role } = roomForMember(app, actor, publicId);
  const participant = app.db.get(`SELECT id, display_name FROM video_participants WHERE room_id = ? AND identity = ? AND ${IN_ROOM}`, room.id, memberIdentity(room.id, actor.userId));
  if (role !== 'host' && !participant) fail(404, 'not_found', 'Join the meeting to see its session details.');
  return { room, host: role === 'host', participant, actor };
}

function guestContext(app, token, participantId) {
  const { invite, room } = inviteByToken(app, token);
  if (guestState(app, invite, room) !== 'open') gone();
  const participant = typeof participantId === 'string' && ID.test(participantId)
    && app.db.get(`SELECT id, display_name FROM video_participants WHERE id = ? AND room_id = ? AND invite_id = ? AND ${IN_ROOM}`, participantId, room.id, invite.id);
  // Guests see session state only from an admitted seat of their own credential.
  if (!participant) fail(404, 'not_found', 'Join the meeting to see its session details.');
  return { room, host: false, participant };
}

const requireHost = context => {
  if (!context.host) fail(403, 'forbidden', 'Only a host of this meeting can change its session form or note.');
  if (!roomOpen(context.room)) gone();
  return context;
};

// ---- Views ----

function formSummary(app, workspaceId, formId) {
  const form = app.db.get('SELECT id, slug, published_version FROM forms WHERE id = ? AND workspace_id = ?', formId, workspaceId);
  if (!form) return null;
  const latest = app.db.get('SELECT definition FROM form_versions WHERE form_id = ? ORDER BY version DESC LIMIT 1', form.id);
  const title = latest ? JSON.parse(latest.definition).title || 'Untitled form' : 'Untitled form';
  const state = form.published_version == null ? 'closed' : availability(app, workspaceId);
  return { id: form.id, slug: form.slug, title, state };
}

const reference = responseId => responseId ? responseId.replace(/-/g, '').slice(0, 8).toUpperCase() : null;

function sessionView(app, context) {
  const { room, host, participant } = context;
  const offer = app.db.get("SELECT * FROM video_session_offers WHERE room_id = ? AND status = 'active'", room.id);
  const note = app.db.get('SELECT body, link_url, link_label, updated_at FROM video_session_notes WHERE room_id = ?', room.id);
  const view = { offer: null, note: note || null, host };
  if (offer && (offer.launched_at != null || host)) {
    const form = formSummary(app, room.workspace_id, offer.form_id);
    const receipt = participant && app.db.get('SELECT prompted_at, opened_at, submitted_at, response_id FROM video_session_receipts WHERE offer_id = ? AND participant_id = ?', offer.id, participant.id);
    const submitted = Boolean(receipt?.submitted_at);
    view.offer = {
      id: offer.id, mode: offer.mode, launched: offer.launched_at != null, form: { slug: form.slug, title: form.title, state: form.state },
      you: participant ? { prompted: Boolean(receipt?.prompted_at), opened: Boolean(receipt?.opened_at), submitted, reference: submitted ? reference(receipt.response_id) : null } : null,
      ticket: participant && !submitted && form.state === 'open' && offer.launched_at != null ? ticketFor(app, offer.id, participant.id, room.max_ends_at) : null
    };
    if (host) {
      // Status only. The response itself is linked only for hosts who may read responses.
      const responses = can(context.actor?.role, 'responses.read');
      const attendees = app.db.all(`SELECT p.id, p.display_name, p.status AS presence, r.prompted_at, r.opened_at, r.submitted_at, r.response_id
        FROM video_participants p LEFT JOIN video_session_receipts r ON r.participant_id = p.id AND r.offer_id = ?
        WHERE p.room_id = ? AND (p.status IN ('admitted', 'joined') OR r.submitted_at IS NOT NULL) ORDER BY p.admitted_at`, offer.id, room.id);
      view.offer.form.id = form.id;
      view.offer.evidence = {
        can_read_responses: responses,
        submitted: attendees.filter(row => row.submitted_at).length,
        attendees: attendees.map(row => ({
          name: row.display_name, in_meeting: ['admitted', 'joined'].includes(row.presence),
          status: row.submitted_at ? 'submitted' : row.opened_at ? 'opened' : row.prompted_at ? 'prompted' : 'not_yet',
          response_id: responses && row.submitted_at ? row.response_id : null
        }))
      };
    }
  }
  if (host) {
    view.forms = app.db.all('SELECT id FROM forms WHERE workspace_id = ? AND published_version IS NOT NULL ORDER BY updated_at DESC LIMIT 100', room.workspace_id)
      .map(row => formSummary(app, room.workspace_id, row.id)).map(({ id, title, state }) => ({ id, title, state }));
  }
  return view;
}

// ---- Host actions ----

function attachOffer(app, context, body) {
  const { room, actor } = requireHost(context);
  const mode = MODES.includes(body.mode) ? body.mode : fail(400, 'validation_failed', 'Choose when attendees see the form.', { field: 'mode' });
  const form = typeof body.form_id === 'string' && app.db.get('SELECT id, published_version, access FROM forms WHERE id = ? AND workspace_id = ?', body.form_id, room.workspace_id);
  if (!form) fail(400, 'validation_failed', 'Choose a form from this workspace.', { field: 'form_id' });
  if (form.published_version == null) fail(400, 'validation_failed', 'Publish this form before offering it in a meeting.', { field: 'form_id' });
  // Attendees answer in the room with a meeting ticket, not a respondent sign-in (docs/FORMS.md, "Respondent sign-in").
  if (form.access === 'signin') fail(400, 'validation_failed', 'This form requires respondents to sign in, which is not available inside meetings yet. Choose a form anyone with the link can answer.', { field: 'form_id' });
  return app.db.transaction(() => {
    const now = app.now();
    const active = app.db.get("SELECT id, form_id, mode FROM video_session_offers WHERE room_id = ? AND status = 'active'", room.id);
    // The same choice again (a double click or a retry) keeps the current offer and its prompts.
    if (active && active.form_id === form.id && active.mode === mode) return { id: active.id, replaced: null };
    if (active) app.db.run("UPDATE video_session_offers SET status = 'replaced', ended_at = ?, ended_by = ? WHERE id = ?", now, actor.userId, active.id);
    const id = randomUUID();
    app.db.run("INSERT INTO video_session_offers (id, room_id, workspace_id, form_id, mode, status, launched_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)",
      id, room.id, room.workspace_id, form.id, mode, mode === 'auto' ? now : null, actor.userId, now);
    return { id, replaced: active?.id || null };
  });
}

function activeOffer(app, room, offerId) {
  const offer = typeof offerId === 'string' && app.db.get("SELECT * FROM video_session_offers WHERE id = ? AND room_id = ? AND status = 'active'", offerId, room.id);
  if (!offer) fail(409, 'offer_changed', 'This form offer changed. Reload the session panel.');
  return offer;
}

function launchOffer(app, context, body) {
  const { room } = requireHost(context);
  const offer = activeOffer(app, room, body.offer_id);
  app.db.run('UPDATE video_session_offers SET launched_at = COALESCE(launched_at, ?) WHERE id = ?', app.now(), offer.id);
}

function removeOffer(app, context, body) {
  const { room, actor } = requireHost(context);
  const offer = activeOffer(app, room, body.offer_id);
  app.db.run("UPDATE video_session_offers SET status = 'removed', ended_at = ?, ended_by = ? WHERE id = ? AND status = 'active'", app.now(), actor.userId, offer.id);
}

/** Absolute https links only, without credentials; returned normalised. */
function safeLink(value) {
  if (value == null || value === '') return null;
  let url;
  try { url = new URL(String(value).trim()); } catch { url = null; }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.href.length > 500) fail(400, 'validation_failed', 'Use a full https:// link, for example https://example.com/agenda.', { field: 'link_url' });
  return url.href;
}

function saveNote(app, context, body) {
  const { room, actor } = requireHost(context);
  const note = text(body.body, 'body', { min: 1, max: 500, multiline: true });
  const linkUrl = safeLink(body.link_url);
  const linkLabel = linkUrl ? text(body.link_label, 'link_label', { max: 60 }) || new URL(linkUrl).host : null;
  app.db.run(`INSERT INTO video_session_notes (room_id, workspace_id, body, link_url, link_label, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (room_id) DO UPDATE SET body = excluded.body, link_url = excluded.link_url, link_label = excluded.link_label, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  room.id, room.workspace_id, note, linkUrl, linkLabel, actor.userId, app.now());
}

// ---- Attendee actions ----

function markReceipt(app, context, body) {
  const { room, participant } = context;
  if (!participant) fail(409, 'not_joined', 'Join the meeting first.');
  const column = EVENTS[body.event] || fail(400, 'validation_failed', 'Unknown event.', { field: 'event' });
  const offer = typeof body.offer_id === 'string' && app.db.get("SELECT id FROM video_session_offers WHERE id = ? AND room_id = ? AND status = 'active' AND launched_at IS NOT NULL", body.offer_id, room.id);
  if (!offer) fail(409, 'offer_changed', 'This form offer changed. Reload the session panel.');
  app.db.run(`INSERT INTO video_session_receipts (offer_id, participant_id, ${column}) VALUES (?, ?, ?)
    ON CONFLICT (offer_id, participant_id) DO UPDATE SET ${column} = COALESCE(video_session_receipts.${column}, excluded.${column})`, offer.id, participant.id, app.now());
}

// ---- Routes ----

export function registerSessionRoutes(app, router, { roomActor, limit }) {
  const { get, post, delete: del } = router;
  const room = '/api/meet-video/rooms/:room/session';
  const member = (ctx, options) => memberContext(app, roomActor(ctx, options), ctx.params.room);
  const fresh = (ctx, context) => sessionView(app, context); // JSON responses are no-store
  get(room, ctx => { limit(ctx, 'video-session', 240); return fresh(ctx, member(ctx, { session: true })); });
  post(`${room}/offer`, async ctx => { const context = member(ctx, { session: true }); attachOffer(app, context, await ctx.json()); return fresh(ctx, context); });
  post(`${room}/offer/launch`, async ctx => { const context = member(ctx, { session: true }); launchOffer(app, context, await ctx.json()); return fresh(ctx, context); });
  del(`${room}/offer`, async ctx => { const context = member(ctx, { session: true }); removeOffer(app, context, await ctx.json()); return fresh(ctx, context); });
  post(`${room}/note`, async ctx => { const context = member(ctx, { session: true }); saveNote(app, context, await ctx.json()); return fresh(ctx, context); });
  del(`${room}/note`, ctx => { const context = requireHost(member(ctx, { session: true })); app.db.run('DELETE FROM video_session_notes WHERE room_id = ?', context.room.id); return fresh(ctx, context); });
  post(`${room}/receipts`, async ctx => { const context = member(ctx, { session: true }); markReceipt(app, context, await ctx.json()); return { status: 204 }; });

  const guest = '/api/public/meet-video/join/:token/session';
  get(guest, ctx => { limit(ctx, 'video-session', 240); return fresh(ctx, guestContext(app, ctx.params.token, ctx.query.get('participant'))); }, { public: true });
  post(`${guest}/receipts`, async ctx => {
    limit(ctx, 'video-session', 240);
    const body = await ctx.json();
    markReceipt(app, guestContext(app, ctx.params.token, body.participant), body);
    return { status: 204 };
  }, { public: true });
}
