import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { signUp } from './helpers.mjs';
import { videoSetup } from './video-helpers.mjs';
import { adjustCredits, allowanceWindow, expireLots, grantAllowance, grantPurchase, reconcileWallet, reserve, settleReservation, walletSummary } from '../src/video/credits.mjs';

const DAY = 86400000;
const lots = (app, ws) => app.db.all('SELECT kind, units_granted, units_available, units_held, status, expires_at FROM credit_lots WHERE workspace_id = ? ORDER BY created_at, rowid', ws);

test('allowance windows are monthly for monthly and annual subscriptions', () => {
  const end = Date.UTC(2027, 0, 31, 10);
  assert.deepEqual(allowanceWindow(end, Date.UTC(2027, 0, 15)), { start: Date.UTC(2026, 11, 31, 10), end });
  const annual = Date.UTC(2027, 9, 15);
  const window = allowanceWindow(annual, Date.UTC(2026, 10, 20));
  assert.equal(new Date(window.start).toISOString().slice(0, 10), '2026-11-15');
  assert.equal(new Date(window.end).toISOString().slice(0, 10), '2026-12-15');
  assert.equal(allowanceWindow(end, end), null, 'no window once the paid period is over');
});

test('evaluation allowance: once per month, expires; purchased credits roll over; subscription credits are spent first', async () => {
  const env = await videoSetup({ video: { allowances: { evaluation: 100 } } });
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Wallet');
    const { app, clock } = env;
    grantAllowance(app, ws.id); grantAllowance(app, ws.id);
    assert.equal(lots(app, ws.id).length, 1, 'replays do not duplicate the monthly grant');
    grantPurchase(app, { workspaceId: ws.id, orderId: 'order-1', units: 3000 });
    grantPurchase(app, { workspaceId: ws.id, orderId: 'order-1', units: 3000 });
    assert.equal(lots(app, ws.id).length, 2, 'one grant per purchase');
    // Spend: subscription/evaluation lot first.
    const r1 = reserve(app, { workspaceId: ws.id, coversFrom: clock.now, seconds: 600, key: 'r1' });
    settleReservation(app, r1.id, 600);
    let [allowance, purchase] = lots(app, ws.id);
    assert.equal(allowance.units_available, 6000 - 600);
    assert.equal(purchase.units_available, 3000);
    // Month end: unused allowance expires, purchased credits stay; next month gets a fresh allowance.
    clock.now = Date.UTC(2026, 10, 1, 0, 5);
    grantAllowance(app, ws.id);
    [allowance, purchase] = lots(app, ws.id);
    assert.equal(allowance.status, 'expired');
    assert.equal(purchase.units_available, 3000);
    const summary = walletSummary(app, ws.id);
    assert.equal(summary.subscription.credits, 100);
    assert.equal(summary.purchased.credits, 50);
    assert.equal(lots(app, ws.id).filter(lot => lot.kind === 'evaluation' && lot.status === 'active').length, 1);
    assert.deepEqual(reconcileWallet(app, ws.id), []);
    const ledger = await owner.get(`/api/workspaces/${ws.id}/meet-video/wallet/ledger?limit=2`);
    assert.equal(ledger.body.entries.length, 2);
    const next = await owner.get(`/api/workspaces/${ws.id}/meet-video/wallet/ledger?limit=2&before=${encodeURIComponent(ledger.body.next)}`);
    assert.ok(next.body.entries.every(entry => !ledger.body.entries.some(seen => seen.id === entry.id)), 'pagination does not repeat entries');
    assert.throws(() => app.db.run("UPDATE credit_ledger SET units = 1"), /credit_ledger_immutable/);
  } finally { await env.close(); }
});

test('reservations crossing the period end never resurrect expired allowance credits', async () => {
  const env = await videoSetup({ video: { allowances: { evaluation: 100 } } });
  try {
    const { ws } = await signUp(env.client(), 'Boundary');
    const { app, clock } = env;
    clock.now = Date.UTC(2026, 9, 31, 23, 55);
    grantAllowance(app, ws.id);
    grantPurchase(app, { workspaceId: ws.id, orderId: 'p', units: 6000 });
    // A 10-minute block 5 minutes before the period ends is cut at the boundary.
    const reservation = reserve(app, { workspaceId: ws.id, coversFrom: clock.now, seconds: 600, minSeconds: 60, key: 'cross' });
    assert.equal(reservation.covers_until, Date.UTC(2026, 10, 1));
    assert.equal(reservation.units_reserved, 300);
    clock.now = Date.UTC(2026, 10, 1, 0, 10);
    expireLots(app);
    settleReservation(app, reservation.id, 100);
    const allowance = app.db.get("SELECT * FROM credit_lots WHERE workspace_id = ? AND kind = 'evaluation' AND period_start = ?", ws.id, Date.UTC(2026, 9, 1));
    assert.equal(allowance.units_available, 0);
    assert.equal(allowance.units_expired, 6000 - 100);
    assert.equal(allowance.units_consumed, 100);
    assert.equal(app.db.get("SELECT units_expired FROM credit_reservations WHERE id = ?", reservation.id).units_expired, 200);
    assert.deepEqual(reconcileWallet(app, ws.id), []);
  } finally { await env.close(); }
});

test('subscriptions: monthly grant once, failed renewal grants nothing, upgrade tops up, downgrade waits, overlap and annual plans', async () => {
  const env = await videoSetup({ config: { billingMode: 'enforced' }, video: { allowances: { meet: 100, suite: 300, trial: 0 } } });
  try {
    const owner = env.client();
    const { ws, email } = await signUp(owner, 'Subs');
    const relogin = () => owner.post('/api/auth/login', { email, password: 'a sufficiently long password' });
    const { app, clock } = env;
    // Purchased credits alone never create video access.
    grantPurchase(app, { workspaceId: ws.id, orderId: 'early', units: 60000 });
    assert.equal((await owner.post(`/api/workspaces/${ws.id}/meet-video/rooms`, {})).body.error.code, 'entitlement_required');
    const checkout = await owner.post(`/api/workspaces/${ws.id}/billing/test-events`, { action: 'checkout', plan: 'meet' });
    assert.equal(checkout.body.result, 'applied');
    const subscription = app.db.get('SELECT * FROM subscriptions WHERE workspace_id = ?', ws.id);
    grantAllowance(app, ws.id); grantAllowance(app, ws.id);
    const allowance = () => app.db.all("SELECT * FROM credit_lots WHERE workspace_id = ? AND kind = 'subscription'", ws.id);
    assert.equal(allowance().length, 1);
    assert.equal(allowance()[0].units_granted, 6000);
    // Upgrade mid-period: one top-up to the higher allowance, idempotent.
    app.db.run("UPDATE subscriptions SET plan = 'suite' WHERE id = ?", subscription.id);
    grantAllowance(app, ws.id); grantAllowance(app, ws.id);
    assert.equal(allowance().reduce((sum, lot) => sum + lot.units_granted, 0), 18000);
    // Downgrade: nothing changes until the next period.
    app.db.run("UPDATE subscriptions SET plan = 'meet' WHERE id = ?", subscription.id);
    grantAllowance(app, ws.id);
    assert.equal(allowance().length, 2);
    // Overlapping second subscription: no duplicate allowance.
    app.db.run("INSERT INTO subscriptions (id, workspace_id, provider, external_id, plan, status, current_period_end, cancel_at_period_end, last_event_at, created_at) VALUES (?, ?, 'test', 'sub_overlap', 'suite', 'active', ?, 0, ?, ?)", randomUUID(), ws.id, clock.now + 20 * DAY, clock.now, clock.now);
    grantAllowance(app, ws.id);
    assert.equal(allowance().length, 2);
    app.db.run("DELETE FROM subscriptions WHERE external_id = 'sub_overlap'");
    // Renewal fails: past due with a grace period, period ends, no new allowance.
    await owner.post(`/api/workspaces/${ws.id}/billing/test-events`, { action: 'payment_failed', subscription: subscription.id });
    clock.now = subscription.current_period_end + DAY;
    await relogin();
    grantAllowance(app, ws.id);
    assert.equal(allowance().filter(lot => lot.status === 'active').length, 0, 'old allowance expired, none granted during grace');
    assert.equal(walletSummary(app, ws.id).purchased.credits, 1000, 'purchased credits preserved');
    // Renewal paid: the new period gets exactly one (downgraded) allowance.
    await owner.post(`/api/workspaces/${ws.id}/billing/test-events`, { action: 'renew', subscription: subscription.id });
    grantAllowance(app, ws.id); grantAllowance(app, ws.id);
    const active = allowance().filter(lot => lot.status === 'active');
    assert.equal(active.length, 1);
    assert.equal(active[0].units_granted, 6000);
    // Cancellation: purchased credits survive; no new allowance after the paid period.
    await owner.post(`/api/workspaces/${ws.id}/billing/test-events`, { action: 'end', subscription: subscription.id });
    clock.now += 40 * DAY;
    await relogin();
    grantAllowance(app, ws.id);
    assert.equal(allowance().filter(lot => lot.status === 'active').length, 0);
    assert.equal(walletSummary(app, ws.id).purchased.credits, 1000);
    assert.deepEqual(reconcileWallet(app, ws.id), []);
  } finally { await env.close(); }
});

test('annual subscriptions get one allowance per month; trials follow the trial allowance', async () => {
  const env = await videoSetup({ config: { billingMode: 'enforced' }, video: { allowances: { meet: 100, trial: 10 } } });
  try {
    const { ws } = await signUp(env.client(), 'Annual');
    const { app, clock } = env;
    const id = randomUUID();
    app.db.run("INSERT INTO subscriptions (id, workspace_id, provider, external_id, plan, status, current_period_end, cancel_at_period_end, last_event_at, created_at) VALUES (?, ?, 'test', 'sub_year', 'meet', 'trialing', ?, 0, ?, ?)", id, ws.id, clock.now + 365 * DAY, clock.now, clock.now);
    grantAllowance(app, ws.id);
    assert.equal(app.db.get("SELECT units_granted FROM credit_lots WHERE workspace_id = ?", ws.id).units_granted, 600);
    app.db.run("UPDATE subscriptions SET status = 'active' WHERE id = ?", id);
    for (let month = 1; month <= 3; month++) { clock.now += 31 * DAY; grantAllowance(app, ws.id); grantAllowance(app, ws.id); }
    const granted = app.db.all("SELECT period_start, units_granted FROM credit_lots WHERE workspace_id = ? AND kind = 'subscription' ORDER BY period_start", ws.id);
    assert.equal(granted.length, 4);
    assert.equal(new Set(granted.map(lot => lot.period_start)).size, 4);
    assert.deepEqual(reconcileWallet(app, ws.id), []);
  } finally { await env.close(); }
});

test('concurrent admissions never overspend; insufficient credits deny admission', async () => {
  const env = await videoSetup({ video: { allowances: { evaluation: 50 }, guestPolicy: 'open', maxParticipants: 20, maxWorkspaceParticipants: 50 } });
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Busy');
    const room = (await owner.post(`/api/workspaces/${ws.id}/meet-video/rooms`, {})).body;
    const link = await owner.post(`/api/meet-video/rooms/${room.public_id}/invites`, { seats: 15 });
    const token = link.body.url.split('/meet/join/')[1];
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => env.client().post('/api/public/meet-video/join/' + token, { display_name: 'Guest ' + index })));
    const statuses = results.map(result => result.status);
    // 50 credits = 3000 units = five 600-second blocks.
    assert.equal(statuses.filter(status => status === 200).length, 5, statuses.join());
    assert.ok(results.filter(result => result.status !== 200).every(result => result.body.error.code === 'insufficient_credits'));
    const account = env.app.db.get('SELECT * FROM credit_accounts WHERE workspace_id = ?', ws.id);
    assert.equal(account.available_units, 0);
    assert.equal(account.reserved_units, 3000);
    assert.deepEqual(reconcileWallet(env.app, ws.id), []);
    const calc = await owner.get(`/api/workspaces/${ws.id}/meet-video/calculator?participants=4&minutes=30`);
    assert.equal(calc.body.credits_required, 120);
    assert.equal(calc.body.shortfall_credits, 120);
    assert.ok(calc.body.suggested_package);
    // Admissions that never connect expire and return their credits.
    env.clock.now += 5 * 60000;
    await env.tick();
    assert.equal(env.app.db.get('SELECT available_units FROM credit_accounts WHERE workspace_id = ?', ws.id).available_units, 3000);
    assert.deepEqual(reconcileWallet(env.app, ws.id), []);
  } finally { await env.close(); }
});

test('budget exhaustion: renewal fails, funded grace runs out, participant removed at the provider; max duration ends rooms; kill switch', async () => {
  const env = await videoSetup({ video: { allowances: { evaluation: 15 }, guestPolicy: 'open' } });
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Low');
    const room = (await owner.post(`/api/workspaces/${ws.id}/meet-video/rooms`, {})).body;
    const join = await owner.post(`/api/meet-video/rooms/${room.public_id}/join`, {});
    assert.equal(join.status, 200);
    const stored = env.room(room.public_id);
    await env.event('participant_joined', stored.room_name, { sid: 'PA_1', identity: join.body.identity });
    await env.tick();
    // 15 credits = 900 units: first block 600, renewal can fund only 300 more seconds.
    env.clock.now += 7 * 60000;
    await env.tick();
    let participant = env.app.db.get('SELECT * FROM video_participants WHERE id = ?', join.body.participant_id);
    assert.equal(participant.funded_until, stored.created_at + 900000);
    // Next renewal is attempted when less than renewBefore (240s) remains: nothing left to reserve.
    env.clock.now = stored.created_at + 11 * 60000;
    await env.tick();
    participant = env.app.db.get('SELECT * FROM video_participants WHERE id = ?', join.body.participant_id);
    assert.equal(participant.funding_state, 'exhausted');
    assert.equal(participant.status, 'joined', 'the already-funded time is the grace period');
    assert.ok(env.room(room.public_id).low_balance_at);
    assert.ok(env.app.db.get("SELECT 1 FROM emails WHERE kind = 'video_low_balance'"));
    env.clock.now = stored.created_at + 900000;
    await env.tick();
    participant = env.app.db.get('SELECT * FROM video_participants WHERE id = ?', join.body.participant_id);
    assert.equal(participant.status, 'removed');
    assert.equal(participant.removed_reason, 'credits_exhausted');
    assert.ok(env.fake.calls.includes('removeParticipant'));
    // The removed identity cannot rejoin on a replayed token.
    env.fake.calls.length = 0;
    await env.event('participant_joined', stored.room_name, { sid: 'PA_2', identity: join.body.identity });
    await env.tick();
    assert.ok(env.fake.calls.includes('removeParticipant'));
    // Settlement charges what was connected (bounded by reservations) and nothing more.
    await env.event('participant_left', stored.room_name, { sid: 'PA_1', identity: join.body.identity, joinedAtMs: stored.created_at }, env.clock.now);
    await env.event('participant_left', stored.room_name, { sid: 'PA_2', identity: join.body.identity, joinedAtMs: env.clock.now }, env.clock.now);
    env.clock.now += 20 * 60000;
    await env.tick();
    assert.equal(env.app.db.get('SELECT available_units + reserved_units AS total FROM credit_accounts WHERE workspace_id = ?', ws.id).total, 0);
    assert.deepEqual(reconcileWallet(env.app, ws.id), []);
  } finally { await env.close(); }

  const limits = await videoSetup({ video: { maxRoomMinutes: 30, killSwitch: 'off' } });
  try {
    const owner = limits.client();
    const { ws } = await signUp(owner, 'Limits');
    const room = (await owner.post(`/api/workspaces/${ws.id}/meet-video/rooms`, {})).body;
    await owner.post(`/api/meet-video/rooms/${room.public_id}/join`, {});
    limits.clock.now += 31 * 60000;
    await limits.tick();
    assert.equal(limits.room(room.public_id).end_reason, 'max_duration');
    assert.ok(limits.fake.calls.includes('deleteRoom'));
    limits.app.config.video.killSwitch = 'admissions';
    const blocked = await owner.post(`/api/workspaces/${ws.id}/meet-video/rooms`, {});
    assert.equal(blocked.body.error.code, 'video_unavailable');
  } finally { await limits.close(); }
});

test('audited adjustments and reconciliation', async () => {
  const env = await videoSetup();
  try {
    const { ws } = await signUp(env.client(), 'Adjust');
    adjustCredits(env.app, ws.id, { credits: 10, note: 'Goodwill for outage', actor: 'ops@example.test', key: 'adj-1' });
    assert.deepEqual(adjustCredits(env.app, ws.id, { credits: 10, note: 'Goodwill for outage', actor: 'ops@example.test', key: 'adj-1' }), { duplicate: true });
    adjustCredits(env.app, ws.id, { credits: -4, note: 'Correction', actor: 'ops@example.test', key: 'adj-2' });
    assert.equal(walletSummary(env.app, ws.id).purchased.credits, 6);
    assert.ok(env.app.db.all("SELECT * FROM credit_ledger WHERE workspace_id = ? AND entry_type = 'adjustment'", ws.id).every(entry => entry.actor && entry.note));
    assert.deepEqual(reconcileWallet(env.app, ws.id), []);
    // Tampering with the cache is detected.
    env.app.db.run('UPDATE credit_accounts SET available_units = available_units + 1 WHERE workspace_id = ?', ws.id);
    assert.equal(reconcileWallet(env.app, ws.id).length, 1);
  } finally { await env.close(); }
});

test('deleting a workspace removes its wallet, ledger and rooms; late join webhooks and credit removals are handled', async () => {
  const env = await videoSetup({ video: { allowances: { evaluation: 15 }, guestPolicy: 'open' } });
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Deletes');
    const room = (await owner.post(`/api/workspaces/${ws.id}/meet-video/rooms`, {})).body;
    const join = await owner.post(`/api/meet-video/rooms/${room.public_id}/join`, {});
    const stored = env.room(room.public_id);
    // The join webhook arrives after the worker expired the admission: still accepted (token was valid at join).
    env.clock.now += 5 * 60000;
    await env.tick();
    assert.equal(env.app.db.get('SELECT status FROM video_participants WHERE id = ?', join.body.participant_id).status, 'expired');
    await env.event('participant_joined', stored.room_name, { sid: 'PA_late', identity: join.body.identity, joinedAtMs: stored.created_at + 30000 });
    await env.tick();
    assert.equal(env.app.db.get('SELECT status FROM video_participants WHERE id = ?', join.body.participant_id).status, 'joined');
    // Removed for credits (not by a host): may rejoin once credits exist again.
    env.app.db.run("UPDATE video_participants SET status = 'removed', removed_reason = 'credits_exhausted' WHERE id = ?", join.body.participant_id);
    env.fake.disconnect(stored.room_name, join.body.identity);
    await env.event('participant_left', stored.room_name, { sid: 'PA_late', identity: join.body.identity, joinedAtMs: stored.created_at + 30000 });
    await env.tick();
    const { adjustCredits } = await import('../src/video/credits.mjs');
    adjustCredits(env.app, ws.id, { credits: 20, note: 'Test top-up', actor: 'test', key: 'rejoin' });
    assert.equal((await owner.post(`/api/meet-video/rooms/${room.public_id}/join`, {})).status, 200);
    env.clock.now += 30 * 60000;
    await env.tick();
    assert.ok(env.app.db.get('SELECT COUNT(*) AS c FROM credit_ledger WHERE workspace_id = ?', ws.id).c > 3);
    const removed = await owner.del(`/api/workspaces/${ws.id}`, { confirm: ws.name });
    assert.equal(removed.status, 204, JSON.stringify(removed.body));
    for (const table of ['credit_ledger', 'credit_lots', 'credit_reservations', 'video_rooms', 'video_participants', 'credit_accounts']) {
      assert.equal(env.app.db.get(`SELECT COUNT(*) AS c FROM ${table}`).c, 0, table);
    }
  } finally { await env.close(); }
});
