import { randomUUID } from 'node:crypto';
import { fail } from '../http.mjs';
import { UNITS_PER_CREDIT, workspaceVideoConfig } from './config.mjs';

// Workspace credit wallet for Schedora Meet video.
//
// Policy: only purchased credits carry forward; subscription credits reset monthly.
// - Internal unit = 1 participant-second (integer). 1 customer credit = 60 units = 1 participant-minute.
// - Lots: 'subscription'/'evaluation' lots belong to one monthly allowance period and expire at its
//   end; 'purchase' lots never expire automatically; 'adjustment' lots are audited manual grants.
// - Spending order: subscription/evaluation lots (earliest expiry first), then adjustments, then
//   purchased lots (oldest first).
// - Every balance movement writes an immutable ledger row with a unique idempotency key:
//     units      = change to total balance (available + reserved)
//     held_delta = change to the reserved portion
// All functions here are synchronous and must run inside app.db.transaction (they nest safely).
// Never call a provider or payment API from inside them.

const MONTH_CAP = 1300;

function addMonths(ms, months) {
  const date = new Date(ms);
  const day = date.getUTCDate();
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.getTime();
}

// Monthly allowance window containing `now`, anchored on the subscription's paid-through date.
// Monthly and annual subscriptions both get one-month windows ending on the anchor's day of month.
export function allowanceWindow(periodEnd, now) {
  if (!(periodEnd > now)) return null;
  let k = 0;
  while (k < MONTH_CAP && addMonths(periodEnd, -(k + 1)) > now) k++;
  return { start: addMonths(periodEnd, -(k + 1)), end: addMonths(periodEnd, -k) };
}

function ledger(app, entry) {
  const result = app.db.run(`INSERT OR IGNORE INTO credit_ledger (id, workspace_id, lot_id, reservation_id, entry_type, units, held_delta, reference_type, reference_id, idempotency_key, note, actor, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, randomUUID(), entry.workspaceId, entry.lotId ?? null, entry.reservationId ?? null, entry.type, entry.units, entry.heldDelta ?? 0,
  entry.referenceType ?? null, entry.referenceId ?? null, entry.key, entry.note ?? null, entry.actor ?? null, app.now());
  if (!result.changes) throw new Error('Duplicate ledger key ' + entry.key + ' inside a balance change.');
}

// The account row is a cache of the lots, refreshed after every change in the same transaction.
export function refreshAccount(app, workspaceId) {
  const totals = app.db.get("SELECT CAST(COALESCE(SUM(units_available), 0) AS BIGINT) AS available, CAST(COALESCE(SUM(units_held), 0) AS BIGINT) AS held FROM credit_lots WHERE workspace_id = ? AND status = 'active'", workspaceId);
  const heldOnInactive = app.db.get("SELECT CAST(COALESCE(SUM(units_held), 0) AS BIGINT) AS held FROM credit_lots WHERE workspace_id = ? AND status <> 'active'", workspaceId).held;
  app.db.run(`INSERT INTO credit_accounts (workspace_id, available_units, reserved_units, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (workspace_id) DO UPDATE SET available_units = excluded.available_units, reserved_units = excluded.reserved_units, updated_at = excluded.updated_at`,
  workspaceId, totals.available, totals.held + heldOnInactive, app.now());
}

// ---- Monthly allowances ---------------------------------------------------------------------

// Which allowance applies now. Purchased credits never make a workspace eligible (policy rule 12),
// and a renewal that failed or is in its grace period does not open a new allowance period.
export function allowanceEligibility(app, workspaceId) {
  const now = app.now();
  const allowances = app.config.video.allowances;
  if (workspaceVideoConfig(app.config, workspaceId).pilot) {
    const date = new Date(now);
    return { kind: 'evaluation', plan: 'evaluation', credits: app.config.video.pilot.monthlyCredits, start: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1), end: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1), subscriptionId: null };
  }
  if (app.config.billingMode === 'open') {
    const date = new Date(now);
    return { kind: 'evaluation', plan: 'evaluation', credits: allowances.evaluation || 0, start: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1), end: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1), subscriptionId: null };
  }
  let best = null;
  for (const subscription of app.db.all("SELECT id, plan, status, current_period_end, created_at FROM subscriptions WHERE workspace_id = ? AND status IN ('active', 'trialing') AND current_period_end > ? ORDER BY created_at, id", workspaceId, now)) {
    const credits = subscription.status === 'trialing' ? allowances.trial || 0 : allowances[subscription.plan] || 0;
    const window = allowanceWindow(subscription.current_period_end, now);
    if (window && (!best || credits > best.credits)) best = { kind: 'subscription', plan: subscription.plan, credits, ...window, subscriptionId: subscription.id };
  }
  return best;
}

// Grants (or tops up after an upgrade) the allowance for the current period, exactly once.
// Downgrades take effect at the next period; the current period's lot is unchanged.
export function grantAllowance(app, workspaceId) {
  return app.db.transaction(() => {
    expireLots(app, workspaceId);
    const eligible = allowanceEligibility(app, workspaceId);
    if (!eligible || eligible.credits <= 0) return null;
    const now = app.now();
    const target = eligible.credits * UNITS_PER_CREDIT;
    // Any allowance lot already covering this instant counts, whichever subscription created it,
    // so overlapping subscriptions, plan changes and replays never duplicate an allowance.
    const covered = app.db.get("SELECT CAST(COALESCE(SUM(units_granted), 0) AS BIGINT) AS units FROM credit_lots WHERE workspace_id = ? AND kind IN ('subscription', 'evaluation') AND period_start <= ? AND expires_at > ?", workspaceId, now, now).units;
    if (covered >= target) return null;
    const id = randomUUID();
    const key = `${eligible.kind}:${workspaceId}:${eligible.start}:${eligible.credits}`;
    const inserted = app.db.run(`INSERT OR IGNORE INTO credit_lots (id, workspace_id, kind, source_key, plan, subscription_id, units_granted, units_available, period_start, expires_at, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`, id, workspaceId, eligible.kind, key, eligible.plan, eligible.subscriptionId, target - covered, target - covered, eligible.start, eligible.end, now);
    if (!inserted.changes) return null;
    ledger(app, { workspaceId, lotId: id, type: 'grant', units: target - covered, key: 'grant:' + key, referenceType: eligible.kind === 'evaluation' ? 'evaluation' : 'subscription', referenceId: eligible.subscriptionId, note: `${eligible.plan} allowance ${new Date(eligible.start).toISOString().slice(0, 10)} to ${new Date(eligible.end).toISOString().slice(0, 10)}` });
    refreshAccount(app, workspaceId);
    return id;
  });
}

// Expires unused allowance credits at the end of their period. Units still held by a reservation
// stay held; when that reservation settles, the unused part expires instead of returning.
export function expireLots(app, workspaceId = null) {
  return app.db.transaction(() => {
    const due = app.db.all(`SELECT * FROM credit_lots WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ? ${workspaceId ? 'AND workspace_id = ?' : ''}`, app.now(), ...(workspaceId ? [workspaceId] : []));
    for (const lot of due) {
      if (lot.units_available > 0) ledger(app, { workspaceId: lot.workspace_id, lotId: lot.id, type: 'expire', units: -lot.units_available, key: `expire:${lot.id}`, note: 'Monthly allowance period ended' });
      app.db.run("UPDATE credit_lots SET units_expired = units_expired + units_available, units_available = 0, status = 'expired' WHERE id = ?", lot.id);
      refreshAccount(app, lot.workspace_id);
    }
    return due.length;
  });
}

// ---- Spending -------------------------------------------------------------------------------

function spendableLots(app, workspaceId, validUntil) {
  return app.db.all(`SELECT * FROM credit_lots WHERE workspace_id = ? AND status = 'active' AND units_available > 0 AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY CASE kind WHEN 'subscription' THEN 0 WHEN 'evaluation' THEN 0 WHEN 'adjustment' THEN 1 ELSE 2 END, COALESCE(expires_at, 0), created_at, id`, workspaceId, validUntil);
}

export function spendableUnits(app, workspaceId) {
  return app.db.get("SELECT CAST(COALESCE(SUM(units_available), 0) AS BIGINT) AS units FROM credit_lots WHERE workspace_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)", workspaceId, app.now()).units;
}

// Reserves funding for one participant over [coversFrom, coversFrom + seconds). A window never
// outlives the allowance lots funding it: if the first lot to spend expires inside the window,
// the window ends there and the next renewal draws from the following period's lots.
// Returns the reservation, or null when fewer than minSeconds can be funded.
export function reserve(app, { workspaceId, roomId = null, participantId = null, coversFrom, seconds, minSeconds = seconds, key }) {
  return app.db.transaction(() => {
    const existing = app.db.get('SELECT * FROM credit_reservations WHERE idempotency_key = ?', key);
    if (existing) return existing;
    let until = coversFrom + seconds * 1000;
    const all = spendableLots(app, workspaceId, Math.max(coversFrom, app.now()));
    const first = all[0];
    if (first?.expires_at && first.expires_at < until && first.expires_at - coversFrom >= minSeconds * 1000) until = first.expires_at;
    const lots = all.filter(lot => !lot.expires_at || lot.expires_at >= until);
    const available = lots.reduce((sum, lot) => sum + lot.units_available, 0);
    let need = Math.ceil((until - coversFrom) / 1000);
    if (available < need) {
      if (available < minSeconds) return null;
      need = available;
      until = coversFrom + need * 1000;
    }
    const id = randomUUID();
    app.db.run(`INSERT INTO credit_reservations (id, workspace_id, room_id, participant_id, idempotency_key, covers_from, covers_until, units_reserved, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'held', ?)`, id, workspaceId, roomId, participantId, key, coversFrom, until, need, app.now());
    let remaining = need;
    let position = 0;
    for (const lot of lots) {
      if (!remaining) break;
      const take = Math.min(remaining, lot.units_available);
      if (!take) continue;
      const changed = app.db.run('UPDATE credit_lots SET units_available = units_available - ?, units_held = units_held + ? WHERE id = ? AND units_available >= ?', take, take, lot.id, take);
      if (!changed.changes) throw new Error('Credit lot changed during reservation.');
      app.db.run('INSERT INTO credit_allocations (reservation_id, lot_id, position, units_held) VALUES (?, ?, ?, ?)', id, lot.id, position++, take);
      ledger(app, { workspaceId, lotId: lot.id, reservationId: id, type: 'reserve', units: 0, heldDelta: take, key: `reserve:${id}:${lot.id}`, referenceType: 'video_room', referenceId: roomId });
      remaining -= take;
    }
    refreshAccount(app, workspaceId);
    return app.db.get('SELECT * FROM credit_reservations WHERE id = ?', id);
  });
}

// Settles a reservation once: consumes `units` (capped at the reserved amount) in allocation
// order, then releases the rest. Unused units of a lot that expired in the meantime expire
// instead of returning, so a release never resurrects expired allowance credits.
export function settleReservation(app, reservationId, units) {
  return app.db.transaction(() => {
    const reservation = app.db.get('SELECT * FROM credit_reservations WHERE id = ?', reservationId);
    if (!reservation || reservation.status !== 'held') return { consumed: 0, duplicate: true };
    const now = app.now();
    let toConsume = Math.max(0, Math.min(units, reservation.units_reserved));
    const totals = { consumed: 0, released: 0, expired: 0 };
    for (const allocation of app.db.all('SELECT a.*, l.status AS lot_status, l.expires_at FROM credit_allocations a JOIN credit_lots l ON l.id = a.lot_id WHERE a.reservation_id = ? ORDER BY a.position', reservationId)) {
      const consume = Math.min(toConsume, allocation.units_held);
      const rest = allocation.units_held - consume;
      toConsume -= consume;
      const lapsed = allocation.lot_status !== 'active' || (allocation.expires_at != null && allocation.expires_at <= now);
      if (consume) ledger(app, { workspaceId: reservation.workspace_id, lotId: allocation.lot_id, reservationId, type: 'consume', units: -consume, heldDelta: -consume, key: `consume:${reservationId}:${allocation.lot_id}`, referenceType: 'video_room', referenceId: reservation.room_id });
      if (rest) ledger(app, { workspaceId: reservation.workspace_id, lotId: allocation.lot_id, reservationId, type: lapsed ? 'expire' : 'release', units: lapsed ? -rest : 0, heldDelta: -rest, key: `${lapsed ? 'expire' : 'release'}:${reservationId}:${allocation.lot_id}`, referenceType: 'video_room', referenceId: reservation.room_id });
      app.db.run(`UPDATE credit_lots SET units_held = units_held - ?, units_consumed = units_consumed + ?, ${lapsed ? 'units_expired = units_expired + ?' : 'units_available = units_available + ?'} WHERE id = ?`,
        allocation.units_held, consume, rest, allocation.lot_id);
      app.db.run(`UPDATE credit_allocations SET units_held = 0, units_consumed = ?, ${lapsed ? 'units_expired' : 'units_released'} = ? WHERE reservation_id = ? AND lot_id = ?`, consume, rest, reservationId, allocation.lot_id);
      totals.consumed += consume;
      totals[lapsed ? 'expired' : 'released'] += rest;
    }
    app.db.run("UPDATE credit_reservations SET status = 'settled', units_consumed = ?, units_released = ?, units_expired = ?, settled_at = ? WHERE id = ?", totals.consumed, totals.released, totals.expired, now, reservationId);
    refreshAccount(app, reservation.workspace_id);
    return totals;
  });
}

// Charges usage that ran past every funded window (worker or provider delay) directly against
// spendable credits. Balances never go negative: anything that cannot be covered is returned as
// unfunded and recorded on the usage record for operations review.
export function chargeOverrun(app, workspaceId, units, key, roomId) {
  return app.db.transaction(() => {
    let remaining = units;
    for (const lot of spendableLots(app, workspaceId, app.now())) {
      if (!remaining) break;
      const take = Math.min(remaining, lot.units_available);
      app.db.run('UPDATE credit_lots SET units_available = units_available - ?, units_consumed = units_consumed + ? WHERE id = ?', take, take, lot.id);
      ledger(app, { workspaceId, lotId: lot.id, type: 'consume', units: -take, key: `${key}:${lot.id}`, referenceType: 'video_room', referenceId: roomId, note: 'Usage beyond the reserved window' });
      remaining -= take;
    }
    refreshAccount(app, workspaceId);
    return { charged: units - remaining, unfunded: remaining };
  });
}

// ---- Purchased credits, reversals and audited adjustments -----------------------------------

export function grantPurchase(app, { workspaceId, orderId, units, note }) {
  return app.db.transaction(() => {
    const id = randomUUID();
    const inserted = app.db.run(`INSERT OR IGNORE INTO credit_lots (id, workspace_id, kind, source_key, recharge_order_id, units_granted, units_available, status, created_at)
      VALUES (?, ?, 'purchase', ?, ?, ?, ?, 'active', ?)`, id, workspaceId, 'recharge:' + orderId, orderId, units, units, app.now());
    if (!inserted.changes) return app.db.get('SELECT id FROM credit_lots WHERE source_key = ?', 'recharge:' + orderId).id;
    ledger(app, { workspaceId, lotId: id, type: 'grant', units, key: 'grant:recharge:' + orderId, referenceType: 'recharge_order', referenceId: orderId, note });
    refreshAccount(app, workspaceId);
    return id;
  });
}

// Removes up to `units` still available on a lot (refunds, chargebacks, negative adjustments).
// Consumed or currently reserved credits cannot be taken back; the shortfall is returned so the
// caller can record it as uncollectable.
export function reverseLot(app, { lotId, units, key, type = 'reversal', referenceType, referenceId, note, actor }) {
  return app.db.transaction(() => {
    const lot = app.db.get('SELECT * FROM credit_lots WHERE id = ?', lotId);
    if (!lot) return { reversed: 0, uncollectable: units };
    if (app.db.get('SELECT 1 FROM credit_ledger WHERE idempotency_key = ?', key)) return { reversed: 0, uncollectable: 0, duplicate: true };
    const take = Math.min(units, lot.units_available);
    if (take) {
      app.db.run(`UPDATE credit_lots SET units_available = units_available - ?, units_revoked = units_revoked + ?, status = CASE WHEN units_available - ? = 0 AND units_held = 0 THEN 'revoked' ELSE status END WHERE id = ?`, take, take, take, lotId);
      ledger(app, { workspaceId: lot.workspace_id, lotId, type, units: -take, key, referenceType, referenceId, note, actor });
      refreshAccount(app, lot.workspace_id);
    }
    return { reversed: take, uncollectable: units - take };
  });
}

export function adjustCredits(app, workspaceId, { credits, note, actor, key }) {
  if (!Number.isInteger(credits) || credits === 0 || !note || !actor || !key) fail(400, 'validation_failed', 'Adjustments need whole credits, a note, an actor and a key.');
  return app.db.transaction(() => {
    if (credits > 0) {
      const id = randomUUID();
      const inserted = app.db.run(`INSERT OR IGNORE INTO credit_lots (id, workspace_id, kind, source_key, units_granted, units_available, status, created_at) VALUES (?, ?, 'adjustment', ?, ?, ?, 'active', ?)`,
        id, workspaceId, 'adjustment:' + key, credits * UNITS_PER_CREDIT, credits * UNITS_PER_CREDIT, app.now());
      if (!inserted.changes) return { duplicate: true };
      ledger(app, { workspaceId, lotId: id, type: 'adjustment', units: credits * UNITS_PER_CREDIT, key: 'adjustment:' + key, note, actor, referenceType: 'adjustment' });
      refreshAccount(app, workspaceId);
      return { lot_id: id };
    }
    let remaining = -credits * UNITS_PER_CREDIT;
    for (const lot of app.db.all("SELECT id FROM credit_lots WHERE workspace_id = ? AND status = 'active' AND kind IN ('adjustment', 'purchase') AND units_available > 0 ORDER BY CASE kind WHEN 'adjustment' THEN 0 ELSE 1 END, created_at DESC", workspaceId)) {
      if (!remaining) break;
      remaining -= reverseLot(app, { lotId: lot.id, units: remaining, key: `adjustment:${key}:${lot.id}`, type: 'adjustment', referenceType: 'adjustment', note, actor }).reversed;
    }
    return { unapplied_units: remaining };
  });
}

// ---- Reporting and reconciliation ----------------------------------------------------------

export function walletSummary(app, workspaceId) {
  const now = app.now();
  const lots = app.db.all("SELECT id, kind, plan, units_granted, units_available, units_held, units_consumed, units_expired, units_revoked, period_start, expires_at, status, created_at FROM credit_lots WHERE workspace_id = ? AND (status = 'active' OR units_held > 0) ORDER BY created_at", workspaceId);
  const sum = (filter, field) => lots.filter(filter).reduce((total, lot) => total + lot[field], 0);
  const allowance = lot => ['subscription', 'evaluation'].includes(lot.kind) && lot.status === 'active' && lot.expires_at > now;
  const carry = lot => ['purchase', 'adjustment'].includes(lot.kind) && lot.status === 'active';
  const resetAt = lots.filter(allowance).reduce((earliest, lot) => earliest == null || lot.expires_at < earliest ? lot.expires_at : earliest, null);
  const toCredits = units => Math.floor(units / UNITS_PER_CREDIT * 10) / 10;
  const account = app.db.get('SELECT * FROM credit_accounts WHERE workspace_id = ?', workspaceId);
  const spendable = spendableUnits(app, workspaceId);
  return {
    units_per_credit: UNITS_PER_CREDIT,
    subscription: { units: sum(allowance, 'units_available'), credits: toCredits(sum(allowance, 'units_available')), resets_at: resetAt, granted_units: sum(allowance, 'units_granted') },
    purchased: { units: sum(carry, 'units_available'), credits: toCredits(sum(carry, 'units_available')) },
    reserved: { units: account?.reserved_units || 0, credits: toCredits(account?.reserved_units || 0) },
    spendable: { units: spendable, credits: toCredits(spendable) },
    low_balance: spendable < app.config.video.lowBalanceCredits * UNITS_PER_CREDIT,
    restricted_reason: account?.restricted_reason || null,
    lots: lots.map(lot => ({ ...lot, carries_forward: ['purchase', 'adjustment'].includes(lot.kind) }))
  };
}

// Verifies cached balances, lots, reservations and ledger totals agree. Returns mismatches.
export function reconcileWallet(app, workspaceId) {
  const problems = [];
  const lots = app.db.get('SELECT CAST(COALESCE(SUM(units_available + units_held), 0) AS BIGINT) AS balance, CAST(COALESCE(SUM(units_held), 0) AS BIGINT) AS held FROM credit_lots WHERE workspace_id = ?', workspaceId);
  const ledgerTotals = app.db.get('SELECT CAST(COALESCE(SUM(units), 0) AS BIGINT) AS balance, CAST(COALESCE(SUM(held_delta), 0) AS BIGINT) AS held FROM credit_ledger WHERE workspace_id = ?', workspaceId);
  const reservations = app.db.get("SELECT CAST(COALESCE(SUM(a.units_held), 0) AS BIGINT) AS held FROM credit_allocations a JOIN credit_reservations r ON r.id = a.reservation_id WHERE r.workspace_id = ? AND r.status = 'held'", workspaceId);
  const account = app.db.get('SELECT * FROM credit_accounts WHERE workspace_id = ?', workspaceId) || { available_units: 0, reserved_units: 0 };
  const active = app.db.get("SELECT CAST(COALESCE(SUM(units_available), 0) AS BIGINT) AS available FROM credit_lots WHERE workspace_id = ? AND status = 'active'", workspaceId);
  if (lots.balance !== ledgerTotals.balance) problems.push(`ledger balance ${ledgerTotals.balance} != lots ${lots.balance}`);
  if (lots.held !== ledgerTotals.held) problems.push(`ledger reserved ${ledgerTotals.held} != lots ${lots.held}`);
  if (lots.held !== reservations.held) problems.push(`open reservations ${reservations.held} != lots ${lots.held}`);
  if (account.available_units !== active.available) problems.push(`cached available ${account.available_units} != lots ${active.available}`);
  if (account.reserved_units !== lots.held) problems.push(`cached reserved ${account.reserved_units} != lots ${lots.held}`);
  return problems;
}
