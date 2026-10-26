import { fail } from './http.mjs';
import { requireMember } from './platform/workspaces.mjs';
import { admitGuest, admitMember, createInstantRoom, createRoomInvite, endRoomByHost, inviteByToken, listRooms, receiveWebhook, removeParticipantByHost, roomForMember, roomView } from './video/rooms.mjs';
import { grantAllowance, walletSummary } from './video/credits.mjs';
import { calculate, createRecharge, listRecharges, rechargeCatalog, refreshRecharge, testRechargeEvent } from './video/recharge.mjs';
import { UNITS_PER_CREDIT } from './video/config.mjs';

// Schedora Meet video routes. Browser tokens are returned only in no-store JSON responses (never
// in URLs) and are never logged: request logs record the route pattern and status only.
export function registerVideoRoutes(app, router, { member, limit }) {
  const { get, post } = router;
  const ws = path => `/api/workspaces/:ws/meet-video${path}`;

  // Members reach a room by its opaque public id; the workspace comes from the room and the
  // caller's membership of it is checked on the server (non-members get 404).
  const roomActor = (ctx, { session = false } = {}) => {
    if (session && ctx.apiKey) fail(403, 'forbidden', 'Join meetings from the Schedora web app.');
    const row = typeof ctx.params.room === 'string' && /^[A-Za-z0-9_-]{20,30}$/.test(ctx.params.room) && app.db.get('SELECT workspace_id FROM video_rooms WHERE public_id = ?', ctx.params.room);
    if (!row) fail(404, 'not_found', 'Meeting not found.');
    if (ctx.apiKey && ctx.apiKey.workspaceId !== row.workspace_id) fail(404, 'not_found', 'Meeting not found.');
    const access = requireMember(app, ctx.user, row.workspace_id, 'meet.manage_own');
    return { ...access, userId: ctx.user.id, userName: ctx.user.name };
  };

  get(ws('/rooms'), ctx => listRooms(app, member(ctx, 'meet.manage_own'), ctx.query.get('scope') === 'past' ? 'past' : 'current'));
  post(ws('/rooms'), async ctx => {
    if (ctx.apiKey) fail(403, 'forbidden', 'Start meetings from the Schedora web app.');
    const actor = member(ctx, 'meet.manage_own');
    limit(ctx, 'video-create', 10);
    const room = createInstantRoom(app, actor, await ctx.json());
    return { status: 201, body: roomView(app, room, { role: 'host' }) };
  });
  get('/api/meet-video/rooms/:room', ctx => {
    const { room, role } = roomForMember(app, roomActor(ctx), ctx.params.room);
    return roomView(app, room, { role });
  });
  post('/api/meet-video/rooms/:room/join', async ctx => {
    limit(ctx, 'video-join', 20);
    const actor = roomActor(ctx, { session: true });
    const retry = app.rateLimit('video-room:' + ctx.params.room, 120, 60000);
    if (retry) fail(429, 'rate_limited', 'Too many join attempts for this meeting. Please wait a moment.', { retry_after: retry });
    return admitMember(app, actor, ctx.params.room, await ctx.json());
  });
  post('/api/meet-video/rooms/:room/end', ctx => { endRoomByHost(app, roomActor(ctx, { session: true }), ctx.params.room); return { status: 204 }; });
  post('/api/meet-video/rooms/:room/participants/:participant/remove', ctx => { removeParticipantByHost(app, roomActor(ctx, { session: true }), ctx.params.room, ctx.params.participant); return { status: 204 }; });
  post('/api/meet-video/rooms/:room/invites', async ctx => { limit(ctx, 'video-invite', 20); return { status: 201, body: createRoomInvite(app, roomActor(ctx, { session: true }), ctx.params.room, await ctx.json()) }; });

  // ---- Guests: scoped attendance credential only (no account, no booking management rights) ----
  get('/api/public/meet-video/join/:token', ctx => {
    limit(ctx, 'video-guest', 120);
    const { invite, room } = inviteByToken(app, ctx.params.token);
    return roomView(app, room, { guestInvite: invite });
  }, { public: true });
  post('/api/public/meet-video/join/:token', async ctx => {
    limit(ctx, 'video-join', 20);
    const retry = app.rateLimit('video-guest-token:' + ctx.params.token.slice(0, 16), 30, 60000);
    if (retry) fail(429, 'rate_limited', 'Too many join attempts. Please wait a moment.', { retry_after: retry });
    return admitGuest(app, ctx.params.token, await ctx.json());
  }, { public: true });

  // ---- Provider webhooks: verified against the raw body, persisted before acknowledgement ----
  post('/api/meet-video/webhooks/:deployment', async ctx => {
    const raw = (await ctx.raw(256 * 1024)).toString('utf8');
    return { result: await receiveWebhook(app, ctx.params.deployment, raw, ctx.request.headers.authorization) };
  }, { public: true, csrfExempt: true });

  // ---- Credits ----
  get(ws('/wallet'), ctx => {
    const { workspace, role } = member(ctx, 'billing.read');
    grantAllowance(app, workspace.id);
    const date = new Date(app.now());
    const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    const usage = app.db.get('SELECT CAST(COALESCE(SUM(units_charged), 0) AS BIGINT) AS units, CAST(COALESCE(SUM(connected_ms), 0) AS BIGINT) AS ms FROM video_usage_records WHERE workspace_id = ? AND created_at >= ?', workspace.id, monthStart);
    return {
      role, wallet: walletSummary(app, workspace.id), catalog: rechargeCatalog(app),
      usage_this_month: { credits: Math.floor(usage.units / UNITS_PER_CREDIT * 10) / 10, participant_minutes: Math.floor(usage.ms / 60000) },
      recharges: listRecharges(app, workspace.id),
      policy: { subscription_credits: 'Reset at the end of each monthly allowance period; unused credits expire.', purchased_credits: 'Carry forward with no automatic expiry, through renewals, plan changes and cancellation.', spending_order: 'Subscription credits first, then purchased credits.' }
    };
  });
  get(ws('/wallet/ledger'), ctx => {
    const { workspace } = member(ctx, 'billing.read');
    const size = Math.min(100, Math.max(1, Number(ctx.query.get('limit')) || 25));
    const [beforeAt, beforeId] = String(ctx.query.get('before') || '').split('~');
    const cursor = /^\d+$/.test(beforeAt || '') && /^[0-9a-f-]{36}$/.test(beforeId || '') ? [Number(beforeAt), beforeId] : null;
    const rows = app.db.all(`SELECT id, entry_type, units, held_delta, reference_type, reference_id, note, created_at FROM credit_ledger WHERE workspace_id = ?
      AND (? = 0 OR created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`,
    workspace.id, cursor ? 1 : 0, cursor?.[0] ?? 0, cursor?.[0] ?? 0, cursor?.[1] ?? '', size + 1);
    const page = rows.slice(0, size);
    return { entries: page, next: rows.length > size ? `${page.at(-1).created_at}~${page.at(-1).id}` : null };
  });
  get(ws('/wallet/usage'), ctx => {
    const { workspace } = member(ctx, 'billing.read');
    return app.db.all(`SELECT u.id, u.period_from, u.period_until, u.connected_ms, u.units_charged, u.units_unfunded, u.created_at, r.title AS room_title, p.display_name, p.role
      FROM video_usage_records u LEFT JOIN video_rooms r ON r.id = u.room_id LEFT JOIN video_participants p ON p.id = u.participant_id
      WHERE u.workspace_id = ? AND (u.units_charged > 0 OR u.units_unfunded > 0) ORDER BY u.created_at DESC LIMIT 100`, workspace.id);
  });
  get(ws('/calculator'), ctx => {
    const { workspace } = member(ctx, 'billing.read');
    return calculate(app, workspace.id, { participants: ctx.query.get('participants'), minutes: ctx.query.get('minutes') });
  });
  post(ws('/recharges'), async ctx => {
    if (ctx.apiKey) fail(403, 'forbidden', 'Buy credits from the Schedora web app.');
    const actor = member(ctx, 'billing.manage');
    limit(ctx, 'billing-checkout', 6);
    const body = await ctx.json();
    return { status: 201, body: await createRecharge(app, actor.workspace.id, actor.userId, body.package_id, ctx.request.headers['idempotency-key']) };
  });
  post(ws('/recharges/:id/refresh'), async ctx => {
    const actor = member(ctx, 'billing.manage');
    limit(ctx, 'billing-refresh', 20);
    return refreshRecharge(app, actor.workspace.id, ctx.params.id);
  });
  post(ws('/recharges/:id/test-event'), async ctx => {
    const actor = member(ctx, 'billing.manage');
    return { result: testRechargeEvent(app, actor.workspace.id, ctx.params.id, await ctx.json()) };
  });
}
