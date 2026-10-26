-- Schedora Meet native video (LiveKit) and the workspace credit wallet.
-- Additive only: existing scheduling tables keep their meaning. A booking "meeting" is a
-- scheduled appointment; a video room is the provider session attached to one meeting
-- occurrence (or an instant meeting with no booking).
-- PostgreSQL: these tables are created by the 'postgres_v4_meet_video' upgrade step
-- (src/postgres.mjs), so keep foreign keys in the "col TEXT REFERENCES t(c)" form.

CREATE TABLE video_rooms (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
  public_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('scheduled', 'instant')),
  title TEXT NOT NULL,
  created_by TEXT,
  -- Provider deployment and room identity are fixed at creation: a configuration change never
  -- redirects an existing room to another provider.
  provider TEXT NOT NULL,
  deployment TEXT NOT NULL,
  room_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'open', 'ending', 'ended', 'canceled')),
  guest_policy TEXT NOT NULL CHECK (guest_policy IN ('host_first', 'open')),
  max_participants INTEGER NOT NULL CHECK (max_participants BETWEEN 1 AND 100),
  join_opens_at INTEGER NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  max_ends_at INTEGER NOT NULL,
  provisioned_at INTEGER,
  host_joined_at INTEGER,
  started_at INTEGER,
  ended_at INTEGER,
  end_reason TEXT,
  low_balance_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (ends_at >= starts_at AND max_ends_at >= ends_at),
  UNIQUE (deployment, room_name)
);
CREATE UNIQUE INDEX video_rooms_meeting ON video_rooms(meeting_id) WHERE meeting_id IS NOT NULL;
CREATE INDEX video_rooms_workspace ON video_rooms(workspace_id, status, starts_at);
CREATE INDEX video_rooms_status ON video_rooms(status, max_ends_at);

-- Guest attendance credentials. The secret is derived server-side from the id and nonce
-- (HMAC with the application key); only its SHA-256 is stored. Separate from booking
-- management tokens: an attendance link cannot cancel or reschedule anything.
CREATE TABLE video_invites (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES video_rooms(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  booking_id TEXT REFERENCES bookings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('booking', 'link')),
  nonce TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  seats INTEGER NOT NULL CHECK (seats BETWEEN 1 AND 20),
  created_by TEXT,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoke_reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX video_invites_booking ON video_invites(booking_id) WHERE booking_id IS NOT NULL;
CREATE INDEX video_invites_room ON video_invites(room_id);

-- One row per admitted principal (member or guest seat). Member identities are stable per room,
-- so a duplicate tab replaces the earlier connection instead of being billed twice.
CREATE TABLE video_participants (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES video_rooms(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  principal TEXT NOT NULL CHECK (principal IN ('member', 'guest')),
  user_id TEXT,
  invite_id TEXT REFERENCES video_invites(id) ON DELETE SET NULL,
  role TEXT NOT NULL CHECK (role IN ('host', 'participant')),
  identity TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('admitted', 'joined', 'left', 'expired', 'removed')),
  admitted_at INTEGER NOT NULL,
  token_expires_at INTEGER NOT NULL,
  joined_at INTEGER,
  left_at INTEGER,
  funded_until INTEGER NOT NULL,
  funding_state TEXT NOT NULL DEFAULT 'funded' CHECK (funding_state IN ('funded', 'exhausted')),
  removed_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (room_id, identity)
);
CREATE INDEX video_participants_status ON video_participants(status, funded_until);
CREATE INDEX video_participants_workspace ON video_participants(workspace_id, status);
CREATE INDEX video_participants_invite ON video_participants(invite_id);

-- Connected time per provider participant session (one row per provider SID). Billing uses
-- only provider timestamps; browser counters are never trusted.
CREATE TABLE video_usage_intervals (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES video_rooms(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  participant_id TEXT REFERENCES video_participants(id) ON DELETE SET NULL,
  identity TEXT NOT NULL,
  provider_sid TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  left_at INTEGER,
  last_seen_at INTEGER NOT NULL,
  close_source TEXT,
  created_at INTEGER NOT NULL,
  CHECK (left_at IS NULL OR left_at >= joined_at),
  UNIQUE (room_id, provider_sid)
);
CREATE INDEX video_usage_open ON video_usage_intervals(room_id, identity, left_at);

-- Verified provider webhooks, persisted before acknowledgement and processed idempotently.
CREATE TABLE video_provider_events (
  id TEXT PRIMARY KEY,
  deployment TEXT NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  room_name TEXT,
  created_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  result TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  UNIQUE (deployment, event_id)
);
CREATE INDEX video_provider_events_pending ON video_provider_events(processed_at, created_at);

-- Durable provider operations (room creation, participant removal, room deletion) with retries.
CREATE TABLE video_provider_ops (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES video_rooms(id) ON DELETE CASCADE,
  op TEXT NOT NULL CHECK (op IN ('create_room', 'remove_participant', 'delete_room')),
  identity TEXT,
  op_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX video_provider_ops_due ON video_provider_ops(status, next_attempt_at);

-- ---- Credit wallet ----------------------------------------------------------------------------
-- Internal unit: 1 unit = 1 participant-second. Customer-visible credit = 1 participant-minute = 60 units.

CREATE TABLE credit_accounts (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  available_units INTEGER NOT NULL DEFAULT 0 CHECK (available_units >= 0),
  reserved_units INTEGER NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  restricted_reason TEXT,
  updated_at INTEGER NOT NULL
);

-- Subscription/evaluation lots expire at the end of their monthly period; purchased lots never
-- expire automatically and survive renewals, plan changes and cancellation.
CREATE TABLE credit_lots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('subscription', 'evaluation', 'purchase', 'adjustment')),
  source_key TEXT NOT NULL UNIQUE,
  plan TEXT,
  subscription_id TEXT,
  recharge_order_id TEXT,
  units_granted INTEGER NOT NULL CHECK (units_granted > 0),
  units_available INTEGER NOT NULL CHECK (units_available >= 0),
  units_held INTEGER NOT NULL DEFAULT 0 CHECK (units_held >= 0),
  units_consumed INTEGER NOT NULL DEFAULT 0 CHECK (units_consumed >= 0),
  units_expired INTEGER NOT NULL DEFAULT 0 CHECK (units_expired >= 0),
  units_revoked INTEGER NOT NULL DEFAULT 0 CHECK (units_revoked >= 0),
  period_start INTEGER,
  expires_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'revoked')),
  created_at INTEGER NOT NULL,
  CHECK (units_granted = units_available + units_held + units_consumed + units_expired + units_revoked),
  CHECK ((kind IN ('subscription', 'evaluation')) = (expires_at IS NOT NULL))
);
CREATE INDEX credit_lots_spend ON credit_lots(workspace_id, status, expires_at);

CREATE TABLE credit_reservations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  room_id TEXT REFERENCES video_rooms(id) ON DELETE SET NULL,
  participant_id TEXT REFERENCES video_participants(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  covers_from INTEGER NOT NULL,
  covers_until INTEGER NOT NULL,
  units_reserved INTEGER NOT NULL CHECK (units_reserved > 0),
  units_consumed INTEGER NOT NULL DEFAULT 0 CHECK (units_consumed >= 0),
  units_released INTEGER NOT NULL DEFAULT 0 CHECK (units_released >= 0),
  units_expired INTEGER NOT NULL DEFAULT 0 CHECK (units_expired >= 0),
  status TEXT NOT NULL CHECK (status IN ('held', 'settled')),
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  CHECK (covers_until > covers_from),
  CHECK (status = 'held' OR units_reserved = units_consumed + units_released + units_expired)
);
CREATE INDEX credit_reservations_held ON credit_reservations(status, covers_until);
CREATE INDEX credit_reservations_participant ON credit_reservations(participant_id, covers_from);

CREATE TABLE credit_allocations (
  reservation_id TEXT NOT NULL REFERENCES credit_reservations(id) ON DELETE CASCADE,
  lot_id TEXT NOT NULL REFERENCES credit_lots(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  units_held INTEGER NOT NULL CHECK (units_held >= 0),
  units_consumed INTEGER NOT NULL DEFAULT 0 CHECK (units_consumed >= 0),
  units_released INTEGER NOT NULL DEFAULT 0 CHECK (units_released >= 0),
  units_expired INTEGER NOT NULL DEFAULT 0 CHECK (units_expired >= 0),
  PRIMARY KEY (reservation_id, lot_id)
);
CREATE INDEX credit_allocations_lot ON credit_allocations(lot_id);

-- Immutable ledger. units = change to the workspace balance (available + reserved);
-- held_delta = change to the reserved portion. Sums reconcile with lots and the account cache.
CREATE TABLE credit_ledger (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lot_id TEXT REFERENCES credit_lots(id) ON DELETE CASCADE,
  -- CASCADE (not SET NULL): the ledger is never updated, rows only go away with their workspace.
  reservation_id TEXT REFERENCES credit_reservations(id) ON DELETE CASCADE,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('grant', 'expire', 'reserve', 'release', 'consume', 'refund', 'reversal', 'adjustment')),
  units INTEGER NOT NULL,
  held_delta INTEGER NOT NULL DEFAULT 0,
  reference_type TEXT,
  reference_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  note TEXT,
  actor TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX credit_ledger_workspace ON credit_ledger(workspace_id, created_at);
CREATE TRIGGER credit_ledger_immutable BEFORE UPDATE ON credit_ledger
BEGIN SELECT RAISE(ABORT, 'credit_ledger_immutable'); END;

-- Settled usage per reservation window, with estimated (not invoiced) provider cost.
CREATE TABLE video_usage_records (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  room_id TEXT REFERENCES video_rooms(id) ON DELETE SET NULL,
  participant_id TEXT REFERENCES video_participants(id) ON DELETE SET NULL,
  reservation_id TEXT REFERENCES credit_reservations(id) ON DELETE SET NULL,
  usage_key TEXT NOT NULL UNIQUE,
  period_from INTEGER NOT NULL,
  period_until INTEGER NOT NULL,
  connected_ms INTEGER NOT NULL CHECK (connected_ms >= 0),
  units_charged INTEGER NOT NULL CHECK (units_charged >= 0),
  units_unfunded INTEGER NOT NULL DEFAULT 0 CHECK (units_unfunded >= 0),
  estimated_cost_micros INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX video_usage_records_workspace ON video_usage_records(workspace_id, created_at);

-- Purchased credit packs (Meet credit recharge). Separate from subscriptions (billing_checkouts)
-- and from invitee booking payments (bookings.payment_*).
CREATE TABLE credit_recharge_orders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  package_id TEXT NOT NULL,
  catalog_version TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK (credits > 0),
  units INTEGER NOT NULL CHECK (units > 0),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('razorpay', 'test')),
  provider_link_id TEXT UNIQUE,
  provider_payment_id TEXT UNIQUE,
  checkout_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('creating', 'open', 'uncertain', 'paid', 'failed', 'expired', 'refunded', 'partially_refunded', 'charged_back')),
  lot_id TEXT,
  refunded_minor INTEGER NOT NULL DEFAULT 0,
  reversed_units INTEGER NOT NULL DEFAULT 0,
  uncollectable_units INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, request_key)
);
CREATE INDEX credit_recharge_orders_workspace ON credit_recharge_orders(workspace_id, status);

-- Provider payment events already applied to recharge orders (refunds, disputes, captures).
CREATE TABLE credit_payment_events (
  provider TEXT NOT NULL,
  event_key TEXT NOT NULL,
  order_id TEXT,
  type TEXT NOT NULL,
  result TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (provider, event_key)
);
