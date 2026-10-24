-- Schedora schema v1. Times are integer milliseconds since the Unix epoch (UTC).
-- Every tenant-owned row carries workspace_id; the API checks membership before any read or write.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  retention_days INTEGER NOT NULL DEFAULT 365 CHECK (retention_days BETWEEN 30 AND 3650),
  created_at INTEGER NOT NULL
);

CREATE TABLE memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX memberships_user ON memberships(user_id);

-- Billing: subscriptions mirror verified provider state; entitlements are derived from them.
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  plan TEXT NOT NULL CHECK (plan IN ('meet', 'forms', 'flow', 'suite')),
  status TEXT NOT NULL CHECK (status IN ('incomplete', 'trialing', 'active', 'past_due', 'canceled')),
  current_period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  grace_until INTEGER,
  last_event_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (provider, external_id)
);
CREATE INDEX subscriptions_workspace ON subscriptions(workspace_id);

CREATE TABLE billing_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  workspace_id TEXT,
  received_at INTEGER NOT NULL,
  result TEXT NOT NULL,
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE usage_counters (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  metric TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, period, metric)
);

-- Meet
CREATE TABLE event_types (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  duration_min INTEGER NOT NULL CHECK (duration_min BETWEEN 5 AND 720),
  slot_interval_min INTEGER NOT NULL CHECK (slot_interval_min BETWEEN 5 AND 720),
  timezone TEXT NOT NULL,
  min_notice_min INTEGER NOT NULL DEFAULT 240 CHECK (min_notice_min BETWEEN 0 AND 43200),
  horizon_days INTEGER NOT NULL DEFAULT 60 CHECK (horizon_days BETWEEN 1 AND 365),
  buffer_before_min INTEGER NOT NULL DEFAULT 0 CHECK (buffer_before_min BETWEEN 0 AND 240),
  buffer_after_min INTEGER NOT NULL DEFAULT 0 CHECK (buffer_after_min BETWEEN 0 AND 240),
  reminder_min INTEGER CHECK (reminder_min IS NULL OR reminder_min BETWEEN 10 AND 10080),
  published INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, slug)
);

CREATE TABLE availability_rules (
  event_type_id TEXT NOT NULL REFERENCES event_types(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_min INTEGER NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min INTEGER NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
  CHECK (end_min > start_min)
);
CREATE INDEX availability_rules_event ON availability_rules(event_type_id);

-- A date exception with NULL minutes marks the whole local date unavailable.
CREATE TABLE date_overrides (
  event_type_id TEXT NOT NULL REFERENCES event_types(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  start_min INTEGER CHECK (start_min BETWEEN 0 AND 1439),
  end_min INTEGER CHECK (end_min BETWEEN 1 AND 1440),
  CHECK ((start_min IS NULL AND end_min IS NULL) OR end_min > start_min)
);
CREATE INDEX date_overrides_event ON date_overrides(event_type_id, date);

CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type_id TEXT NOT NULL REFERENCES event_types(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  block_start INTEGER NOT NULL,
  block_end INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'canceled')),
  invitee_name TEXT NOT NULL,
  invitee_email TEXT NOT NULL,
  invitee_timezone TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  manage_token_hash TEXT NOT NULL UNIQUE,
  manage_expires_at INTEGER NOT NULL,
  rescheduled_from TEXT REFERENCES bookings(id) ON DELETE SET NULL,
  rescheduled_to TEXT,
  canceled_at INTEGER,
  canceled_by TEXT CHECK (canceled_by IS NULL OR canceled_by IN ('invitee', 'host', 'reschedule')),
  cancel_reason TEXT,
  anonymized_at INTEGER,
  created_at INTEGER NOT NULL,
  CHECK (ends_at > starts_at),
  CHECK (block_start <= starts_at AND block_end >= ends_at),
  UNIQUE (event_type_id, idempotency_key)
);
CREATE INDEX bookings_host_time ON bookings(host_id, block_start, block_end) WHERE status = 'confirmed';
CREATE INDEX bookings_workspace ON bookings(workspace_id, starts_at);

-- Durable double-booking protection, independent of application code: a confirmed
-- booking's buffered block may not overlap another confirmed booking of the same host.
CREATE TRIGGER bookings_no_overlap_insert BEFORE INSERT ON bookings
WHEN NEW.status = 'confirmed' AND EXISTS (
  SELECT 1 FROM bookings b WHERE b.host_id = NEW.host_id AND b.status = 'confirmed'
    AND ((NEW.block_start < b.ends_at AND NEW.block_end > b.starts_at)
      OR (NEW.starts_at < b.block_end AND NEW.ends_at > b.block_start)))
BEGIN SELECT RAISE(ABORT, 'booking_overlap'); END;

CREATE TRIGGER bookings_no_overlap_update BEFORE UPDATE OF status, starts_at, ends_at, block_start, block_end ON bookings
WHEN NEW.status = 'confirmed' AND EXISTS (
  SELECT 1 FROM bookings b WHERE b.id <> NEW.id AND b.host_id = NEW.host_id AND b.status = 'confirmed'
    AND ((NEW.block_start < b.ends_at AND NEW.block_end > b.starts_at)
      OR (NEW.starts_at < b.block_end AND NEW.ends_at > b.block_start)))
BEGIN SELECT RAISE(ABORT, 'booking_overlap'); END;

CREATE TABLE calendar_connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('ics')),
  feed_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked', 'error')),
  last_synced_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, user_id)
);

CREATE TABLE busy_blocks (
  connection_id TEXT NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL
);
CREATE INDEX busy_blocks_host ON busy_blocks(host_id, starts_at);

-- Email delivery queue. Each message has an idempotency key so retries never resend a delivered message.
CREATE TABLE emails (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  related_id TEXT,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  ics TEXT,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'queued', 'sending', 'sent', 'failed', 'canceled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  claimed_until INTEGER,
  last_error TEXT,
  provider_message_id TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX emails_due ON emails(status, next_attempt_at);
CREATE INDEX emails_related ON emails(related_id);

-- Forms
CREATE TABLE forms (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  draft TEXT NOT NULL,
  published_version INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX forms_workspace ON forms(workspace_id);

CREATE TABLE form_versions (
  form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  definition TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  published_by TEXT NOT NULL,
  PRIMARY KEY (form_id, version)
);

CREATE TABLE responses (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  form_version INTEGER NOT NULL,
  answers TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (form_id, idempotency_key)
);
CREATE INDEX responses_form ON responses(form_id, created_at);

-- Flow: transactional outbox written in the same transaction as the source record.
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('meet.booking.created', 'forms.response.created')),
  subject_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  dispatched_at INTEGER
);
CREATE INDEX outbox_pending ON outbox(dispatched_at, created_at);

CREATE TABLE flows (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('meet.booking.created', 'forms.response.created')),
  trigger_source TEXT,
  action_type TEXT NOT NULL CHECK (action_type IN ('email', 'task')),
  action_config TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'enabled', 'paused')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX flows_trigger ON flows(workspace_id, trigger_type, status);

CREATE TABLE flow_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'retrying', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (flow_id, event_id)
);
CREATE INDEX flow_runs_due ON flow_runs(status, next_attempt_at);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_run_id TEXT UNIQUE,
  title TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('open', 'done')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX tasks_workspace ON tasks(workspace_id, status);

CREATE TABLE worker_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
