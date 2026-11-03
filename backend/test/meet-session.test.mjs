// Session offers in Schedora meeting rooms (docs/MEET_SESSION_OFFERS.md): host-only control,
// durable state for late joiners, seat-bound submissions through the ordinary Forms path,
// one response per seat and offer, private status, replacement, removal, closure and the note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.mjs';
import { openPostgres } from '../src/postgres.mjs';
import { signUp } from './helpers.mjs';
import { videoSetup, tokenFrom } from './video-helpers.mjs';

const definition = title => ({ title, presentation: 'classic', fields: [{ id: 'goal', type: 'short_text', label: 'What do you want from this session?', required: true }] });

async function meeting(env) {
  const host = env.client();
  const account = await signUp(host, 'Session');
  const ws = account.ws;
  const room = (await host.post(`/api/workspaces/${ws.id}/meet-video/rooms`, { title: 'Client kickoff' })).body;
  const form = async (title, publish = true) => {
    const created = (await host.post(`/api/workspaces/${ws.id}/forms`, { definition: definition(title) })).body;
    if (publish) assert.equal((await host.post(`/api/workspaces/${ws.id}/forms/${created.id}/publish`, {})).status, 200);
    return created;
  };
  // A connected host lets guests in (host-first admission).
  const hostJoin = await host.post(`/api/meet-video/rooms/${room.public_id}/join`, { display_name: 'Host' });
  await env.event('participant_joined', env.room(room.public_id).room_name, { sid: 'PA_host', identity: hostJoin.body.identity });
  await env.tick();
  const token = tokenFrom((await host.post(`/api/meet-video/rooms/${room.public_id}/invites`, { seats: 5 })).body.url);
  const guest = async name => {
    const http = env.client();
    const join = await http.post('/api/public/meet-video/join/' + token, { display_name: name });
    assert.equal(join.status, 200, JSON.stringify(join.body));
    const seat = join.body.participant_id;
    return {
      http, seat,
      session: () => http.get(`/api/public/meet-video/join/${token}/session?participant=${seat}`),
      mark: (offer_id, event) => http.post(`/api/public/meet-video/join/${token}/session/receipts`, { participant: seat, offer_id, event })
    };
  };
  const path = `/api/meet-video/rooms/${room.public_id}/session`;
  return { host, ws, room, form, guest, token, path };
}

const submit = (http, slug, ticket, submission_id, goal = 'Agree the launch plan') => http.post(`/api/public/forms/${slug}/responses`, { answers: { goal }, submission_id, session_ticket: ticket });

test('PostgreSQL: existing rooms and responses survive session-offer upgrade, reconnect and room cleanup', { skip: process.env.RUN_POSTGRES_TESTS !== 'true', timeout: 120000 }, () => {
  const config = loadConfig();
  const schemaName = 'schedora_test_' + randomUUID().replaceAll('-', '');
  let db = openPostgres(config.databaseUrl, { ca: config.databaseCa, schemaName });
  const at = 1793710000000;
  try {
    db.run("INSERT INTO workspaces (id, slug, name, created_at) VALUES ('legacy-ws', 'legacy-ws', 'Legacy workspace', ?)", at);
    db.run("INSERT INTO forms (id, workspace_id, slug, draft, created_by, created_at, updated_at) VALUES ('legacy-form', 'legacy-ws', 'legacy-form', '{}', 'host', ?, ?)", at, at);
    db.run("INSERT INTO responses (id, workspace_id, form_id, form_version, answers, idempotency_key, created_at) VALUES ('legacy-response', 'legacy-ws', 'legacy-form', 1, '{}', 'legacy-key', ?)", at);
    db.run(`INSERT INTO video_rooms (id, workspace_id, public_id, kind, title, provider, deployment, room_name, status, guest_policy, max_participants, join_opens_at, starts_at, ends_at, max_ends_at, created_at, updated_at)
      VALUES ('legacy-room', 'legacy-ws', 'legacy-public', 'instant', 'Existing kickoff', 'fake', 'fake-local', 'legacy-room', 'open', 'open', 2, ?, ?, ?, ?, ?, ?)`, at, at, at + 60000, at + 60000, at, at);
    // Simulate a populated database from before migration 015. Only the new empty tables go.
    db.exec('DROP TABLE video_session_receipts');
    db.exec('DROP TABLE video_session_notes');
    db.exec('DROP TABLE video_session_offers');
    db.run("DELETE FROM schema_migrations WHERE name = 'postgres_v14_session_offers'");
    db.close();
    db = openPostgres(config.databaseUrl, { ca: config.databaseCa, schemaName });
    assert.equal(db.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE name = 'postgres_v14_session_offers'").count, 1);
    assert.equal(db.get("SELECT title FROM video_rooms WHERE id = 'legacy-room'").title, 'Existing kickoff');
    assert.equal(db.get("SELECT answers FROM responses WHERE id = 'legacy-response'").answers, '{}');
    db.run(`INSERT INTO video_participants (id, room_id, workspace_id, principal, role, identity, display_name, status, admitted_at, token_expires_at, funded_until, created_at, updated_at)
      VALUES ('seat', 'legacy-room', 'legacy-ws', 'guest', 'participant', 'seat', 'Attendee', 'admitted', ?, ?, ?, ?, ?)`, at, at + 60000, at + 60000, at, at);
    const insertOffer = (id, status) => db.run(`INSERT INTO video_session_offers (id, room_id, workspace_id, form_id, mode, status, launched_at, created_by, created_at)
      VALUES (?, 'legacy-room', 'legacy-ws', 'legacy-form', 'auto', ?, ?, 'host', ?)`, id, status, at, at);
    insertOffer('offer', 'active');
    assert.throws(() => insertOffer('duplicate', 'active'), 'only one active offer per room');
    insertOffer('earlier', 'replaced');
    db.run("INSERT INTO video_session_receipts (offer_id, participant_id, submitted_at, response_id) VALUES ('offer', 'seat', ?, 'legacy-response')", at);
    db.run("INSERT INTO video_session_notes (room_id, workspace_id, body, updated_by, updated_at) VALUES ('legacy-room', 'legacy-ws', 'Agenda', 'host', ?)", at);
    db.close();
    db = openPostgres(config.databaseUrl, { ca: config.databaseCa, schemaName });
    assert.equal(db.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE name = 'postgres_v14_session_offers'").count, 1, 'upgrade is applied once');
    assert.equal(db.get("SELECT submitted_at FROM video_session_receipts WHERE offer_id = 'offer'").submitted_at, at, 'timestamps retain millisecond precision');
    db.run("DELETE FROM responses WHERE id = 'legacy-response'");
    assert.deepEqual(db.get("SELECT submitted_at, response_id FROM video_session_receipts WHERE offer_id = 'offer'"), { submitted_at: at, response_id: null }, 'deletion preserves status without a dangling response link');
    db.run("DELETE FROM video_rooms WHERE id = 'legacy-room'");
    for (const table of ['video_session_offers', 'video_session_receipts', 'video_session_notes']) assert.equal(db.get(`SELECT COUNT(*) AS count FROM ${table}`).count, 0, table);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM forms WHERE id = 'legacy-form'").count, 1, 'room cleanup does not delete the form');
  } finally { db.exec('DROP SCHEMA "' + schemaName + '" CASCADE'); db.close(); }
});

test('session offer: host attaches a published form; attendees and late joiners get it; one prompt; seat-bound submission; private status', async () => {
  const env = await videoSetup();
  try {
    const { host, ws, room, form, guest, path, token } = await meeting(env);
    const brief = await form('Client brief');
    const draft = await form('Unpublished', false);
    const other = env.client();
    const { ws: elsewhere } = await signUp(other, 'Elsewhere');
    const foreign = (await other.post(`/api/workspaces/${elsewhere.id}/forms`, { definition: definition('Foreign') })).body;
    await other.post(`/api/workspaces/${elsewhere.id}/forms/${foreign.id}/publish`, {});

    const empty = await host.get(path);
    assert.equal(empty.status, 200);
    assert.equal(empty.body.offer, null);
    assert.deepEqual(empty.body.forms.map(f => f.title), ['Client brief'], 'only published forms of this workspace are offered');
    assert.equal((await host.post(`${path}/offer`, { form_id: draft.id, mode: 'auto' })).status, 400, 'drafts cannot be offered');
    assert.equal((await host.post(`${path}/offer`, { form_id: foreign.id, mode: 'auto' })).status, 400, 'another workspace form cannot be offered');
    assert.equal((await host.post(`${path}/offer`, { form_id: brief.id, mode: 'sometimes' })).status, 400);

    const early = await guest('Early guest');
    const attached = await host.post(`${path}/offer`, { form_id: brief.id, mode: 'auto' });
    assert.equal(attached.status, 200, JSON.stringify(attached.body));
    const offerId = attached.body.offer.id;
    assert.equal((await host.post(`${path}/offer`, { form_id: brief.id, mode: 'auto' })).body.offer.id, offerId, 'the same choice again keeps the offer');

    // A guest cannot read session state without an admitted seat of their own link.
    assert.equal((await env.client().get(`/api/public/meet-video/join/${token}/session`)).status, 404);
    assert.equal((await env.client().get(`/api/public/meet-video/join/${token}/session?participant=${early.seat}`)).status, 200, 'the seat id is checked against the link, not a cookie');
    const late = await guest('Late guest');
    for (const attendee of [early, late]) {
      const view = (await attendee.session()).body;
      assert.equal(view.offer.id, offerId);
      assert.deepEqual(view.offer.form, { slug: brief.slug, title: 'Client brief', state: 'open' });
      assert.deepEqual(view.offer.you, { prompted: false, opened: false, submitted: false, reference: null });
      assert.match(view.offer.ticket, /\./);
      assert.equal(view.offer.evidence, undefined, 'attendees never see other people\'s status');
      assert.equal(view.forms, undefined);
    }
    // One automatic prompt per offer, recorded on the server (a reconnect reads it back).
    assert.equal((await late.mark(offerId, 'prompted')).status, 204);
    assert.equal((await late.mark(offerId, 'prompted')).status, 204);
    assert.equal((await late.mark(offerId, 'opened')).status, 204);
    assert.deepEqual((await late.session()).body.offer.you, { prompted: true, opened: true, submitted: false, reference: null });
    assert.equal((await late.mark('00000000-0000-4000-8000-000000000000', 'prompted')).status, 409);

    // Submission through the ordinary Forms path, bound to this seat and offer.
    const ticket = (await late.session()).body.offer.ticket;
    const accepted = await submit(late.http, brief.slug, ticket, 'session-submit-0001');
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    assert.equal((await submit(late.http, brief.slug, ticket, 'session-submit-0001')).status, 200, 'a retry of the same attempt returns the first receipt');
    const again = await submit(late.http, brief.slug, ticket, 'session-submit-0002', 'Something else');
    assert.deepEqual([again.status, again.body.error.code], [409, 'session_already_submitted']);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM responses WHERE form_id = ?', brief.id).count, 1, 'one response per seat and offer');
    const after = (await late.session()).body.offer;
    assert.equal(after.you.submitted, true);
    assert.equal(after.you.reference, accepted.body.reference);
    assert.equal(after.ticket, null, 'no ticket once submitted');
    assert.equal(JSON.stringify((await early.session()).body).includes('launch plan'), false, 'answers never reach other attendees');

    // Tampering: another seat, another offer or a forged signature is refused and writes nothing.
    const [offer, seat, expiry, signature] = ticket.split('.');
    const forged = [[offer, early.seat, expiry, signature], [offer, seat, String(Number(expiry) + 1), signature], [offer, seat, expiry, signature.slice(0, -2) + 'AA'], ['nonsense']];
    for (const parts of forged) assert.equal((await submit(early.http, brief.slug, parts.join('.'), 'forged-attempt-' + parts.length + parts[0].slice(0, 4))).body.error.code, 'session_invalid');
    const otherForm = await form('Different form');
    assert.equal((await submit(early.http, otherForm.slug, (await early.session()).body.offer.ticket, 'wrong-form-attempt-1')).body.error.code, 'session_invalid', 'a ticket names one form');
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM responses').count, 1);

    // Host evidence: status for everyone, the response linked for readers of responses; no answers.
    const evidence = (await host.get(path)).body.offer.evidence;
    assert.equal(evidence.submitted, 1);
    assert.equal(evidence.can_read_responses, true);
    const lateRow = evidence.attendees.find(row => row.name === 'Late guest');
    assert.deepEqual([lateRow.status, lateRow.response_id], ['submitted', accepted.body.id]);
    assert.equal(evidence.attendees.find(row => row.name === 'Early guest').status, 'not_yet');
    assert.equal(JSON.stringify(evidence).includes('launch plan'), false);
    // The response itself is an ordinary response of the form.
    assert.equal((await host.get(`/api/workspaces/${ws.id}/forms/${brief.id}/responses`)).body.responses.length, 1);

    // A removed attendee cannot submit from the meeting; a revoked link loses session access.
    const earlyTicket = (await early.session()).body.offer.ticket;
    await host.post(`/api/meet-video/rooms/${room.public_id}/participants/${early.seat}/remove`);
    const removed = await submit(early.http, brief.slug, earlyTicket, 'removed-attempt-00');
    assert.deepEqual([removed.status, removed.body.error.code], [403, 'not_in_meeting'], 'a valid ticket for a seat no longer in the meeting writes nothing');
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM responses').count, 1);
    assert.equal((await submit(early.http, brief.slug, ticket.replace(seat, early.seat), 'removed-attempt-01')).status, 400, 'a ticket is not transferable');
    assert.equal((await early.session()).status, 410, 'removing a guest revokes their link');
  } finally { await env.close(); }
});

test('session offer: manual launch, replacement keeps earlier receipts, removal stops late prompts, closure and member roles', async () => {
  const env = await videoSetup();
  try {
    const { host, ws, room, form, guest, path } = await meeting(env);
    const first = await form('Discovery questions');
    const second = await form('Proposal questions');
    const manual = (await host.post(`${path}/offer`, { form_id: first.id, mode: 'manual' })).body.offer;
    assert.equal(manual.launched, false);
    const attendee = await guest('Attendee');
    assert.equal((await attendee.session()).body.offer, null, 'a manual offer is invisible until the host offers it');
    assert.equal((await attendee.mark(manual.id, 'prompted')).status, 409);
    await host.post(`${path}/offer/launch`, { offer_id: manual.id });
    const launched = (await attendee.session()).body.offer;
    assert.equal(launched.id, manual.id);
    const answered = await submit(attendee.http, first.slug, launched.ticket, 'manual-offer-sub-1');
    assert.equal(answered.status, 201);

    // Replacing creates a new offer identity; the earlier receipt keeps its association.
    const replaced = (await host.post(`${path}/offer`, { form_id: second.id, mode: 'auto' })).body.offer;
    assert.notEqual(replaced.id, manual.id);
    assert.equal((await host.post(`${path}/offer/launch`, { offer_id: manual.id })).status, 409, 'the old offer is no longer active');
    const now = (await attendee.session()).body.offer;
    assert.deepEqual([now.id, now.form.title, now.you.submitted], [replaced.id, 'Proposal questions', false]);
    assert.equal(env.app.db.get('SELECT response_id FROM video_session_receipts WHERE offer_id = ?', manual.id).response_id, answered.body.id);
    // Even the same form attached again is a new offer: a fresh prompt, a fresh response allowed.
    const reattached = (await host.post(`${path}/offer`, { form_id: second.id, mode: 'manual' })).body.offer;
    assert.notEqual(reattached.id, replaced.id);

    // Closing the form keeps the offer visible as closed, with no ticket.
    await host.post(`${path}/offer/launch`, { offer_id: reattached.id });
    await host.post(`/api/workspaces/${ws.id}/forms/${second.id}/unpublish`);
    const closed = (await attendee.session()).body.offer;
    assert.deepEqual([closed.form.state, closed.ticket], ['closed', null]);
    assert.equal((await host.get(path)).body.offer.form.state, 'closed');

    // Removing stops it for everyone, including late joiners.
    assert.equal((await host.del(`${path}/offer`, { offer_id: reattached.id })).status, 200);
    assert.equal((await attendee.session()).body.offer, null);
    assert.equal((await (await guest('Later still')).session()).body.offer, null);

    // A plain member in an instant meeting is an attendee, not a host.
    const member = env.client(); const memberAccount = await signUp(member, 'Member');
    await host.post(`/api/workspaces/${ws.id}/members`, { email: memberAccount.email, role: 'member' });
    await member.get('/api/me');
    assert.equal((await member.get(path)).status, 404, 'ordinary members cannot read session resources before joining');
    assert.equal((await member.post(`/api/meet-video/rooms/${room.public_id}/join`, { display_name: 'Member' })).status, 200);
    assert.equal((await member.post(`${path}/offer`, { form_id: first.id, mode: 'auto' })).status, 403);
    assert.equal((await member.post(`${path}/note`, { body: 'Mine now' })).status, 403);
    const memberView = (await member.get(path)).body;
    assert.deepEqual([memberView.host, memberView.forms], [false, undefined]);
    const key = (await host.post(`/api/workspaces/${ws.id}/api-keys`, { name: 'No session tickets' })).body;
    assert.equal((await env.client().get(path, { Authorization: 'Bearer ' + key.token })).status, 403, 'API keys cannot obtain attendee tickets or private session status');
    // Outsiders and other workspaces get nothing.
    const stranger = env.client(); await signUp(stranger, 'Stranger');
    assert.equal((await stranger.get(path)).status, 404);
    // Ended meetings take session changes no more.
    await host.post(`/api/meet-video/rooms/${room.public_id}/end`);
    assert.equal((await host.post(`${path}/offer`, { form_id: first.id, mode: 'auto' })).status, 410);
    assert.equal((await attendee.session()).status, 410);
  } finally { await env.close(); }
});

test('session tickets recheck revoked invitations, removed membership and ended rooms before writing a response', async () => {
  const env = await videoSetup();
  try {
    const { host, ws, room, form, guest, path } = await meeting(env);
    const brief = await form('Private session brief');
    await host.post(`${path}/offer`, { form_id: brief.id, mode: 'auto' });
    const attendee = await guest('Guest');
    const guestTicket = (await attendee.session()).body.offer.ticket;
    const invite = env.app.db.get('SELECT invite_id FROM video_participants WHERE id = ?', attendee.seat);
    // Revocation is effective immediately, before the worker removes an admitted seat.
    env.app.db.run('UPDATE video_invites SET revoked_at = ? WHERE id = ?', env.clock.now, invite.invite_id);
    assert.equal((await submit(attendee.http, brief.slug, guestTicket, 'revoked-session-ticket-1')).status, 403);
    env.app.db.run('UPDATE video_invites SET revoked_at = NULL WHERE id = ?', invite.invite_id);

    const member = env.client();
    const account = await signUp(member, 'Departing');
    await host.post(`/api/workspaces/${ws.id}/members`, { email: account.email, role: 'member' });
    assert.equal((await member.post(`/api/meet-video/rooms/${room.public_id}/join`, { display_name: 'Departing' })).status, 200);
    const memberTicket = (await member.get(path)).body.offer.ticket;
    const user = (await member.get('/api/me')).body.user;
    env.app.db.run('DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?', ws.id, user.id);
    assert.equal((await submit(member, brief.slug, memberTicket, 'removed-member-ticket-1')).status, 403);

    await host.post(`/api/meet-video/rooms/${room.public_id}/end`);
    assert.equal((await submit(attendee.http, brief.slug, guestTicket, 'ended-session-ticket-1')).status, 403);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM responses').count, 0);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM video_session_receipts WHERE submitted_at IS NOT NULL').count, 0);
  } finally { await env.close(); }
});

test('pinned note: plain text, https links only, explicit replace and remove, visible to late joiners', async () => {
  const env = await videoSetup();
  try {
    const { host, guest, path } = await meeting(env);
    for (const link_url of ['javascript:alert(1)', 'http://example.com', 'https://user:pass@example.com/', 'data:text/html,hi', '/relative']) {
      const refused = await host.post(`${path}/note`, { body: 'Agenda', link_url });
      assert.deepEqual([refused.status, refused.body.error.field], [400, 'link_url'], link_url);
    }
    assert.equal((await host.post(`${path}/note`, { body: '' })).status, 400);
    assert.equal((await host.post(`${path}/note`, { body: 'x'.repeat(501) })).status, 400);
    const saved = await host.post(`${path}/note`, { body: '<b>Agenda</b>\nIntroductions, goals, next steps', link_url: 'https://example.com/agenda' });
    assert.equal(saved.status, 200);
    assert.deepEqual([saved.body.note.body, saved.body.note.link_label], ['<b>Agenda</b>\nIntroductions, goals, next steps', 'example.com'], 'stored as text; the client renders it as text');
    const late = await guest('Late joiner');
    assert.equal((await late.session()).body.note.link_url, 'https://example.com/agenda');
    await host.post(`${path}/note`, { body: 'Replaced note' });
    assert.deepEqual([(await late.session()).body.note.body, (await late.session()).body.note.link_url], ['Replaced note', null]);
    assert.equal((await host.del(`${path}/note`)).status, 200);
    assert.equal((await late.session()).body.note, null);
  } finally { await env.close(); }
});
