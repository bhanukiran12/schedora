-- migrate: foreign_keys_off (tables are rebuilt; see src/db.mjs)
-- Meet platform: meeting kinds (group, collective, round robin, one-off), attendees, workflows,
-- contacts, polls, routing, webhooks, API keys, integrations, SSO, AI records and branding.

-- ---- Event types ---------------------------------------------------------------------------
ALTER TABLE event_types ADD COLUMN kind TEXT NOT NULL DEFAULT 'one_on_one';
ALTER TABLE event_types ADD COLUMN seats INTEGER NOT NULL DEFAULT 1;
ALTER TABLE event_types ADD COLUMN max_per_day INTEGER;
ALTER TABLE event_types ADD COLUMN max_per_week INTEGER;
ALTER TABLE event_types ADD COLUMN max_per_month INTEGER;
ALTER TABLE event_types ADD COLUMN start_date TEXT;
ALTER TABLE event_types ADD COLUMN end_date TEXT;
ALTER TABLE event_types ADD COLUMN locations TEXT NOT NULL DEFAULT '[]';
ALTER TABLE event_types ADD COLUMN questions TEXT NOT NULL DEFAULT '[]';
ALTER TABLE event_types ADD COLUMN price_cents INTEGER;
ALTER TABLE event_types ADD COLUMN currency TEXT;
ALTER TABLE event_types ADD COLUMN secret INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_types ADD COLUMN one_off INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_types ADD COLUMN single_use INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_types ADD COLUMN expires_at INTEGER;
ALTER TABLE event_types ADD COLUMN offered_slots TEXT;
ALTER TABLE event_types ADD COLUMN rr_strategy TEXT NOT NULL DEFAULT 'availability';
ALTER TABLE event_types ADD COLUMN managed_parent_id TEXT REFERENCES event_types(id) ON DELETE SET NULL;
ALTER TABLE event_types ADD COLUMN locked_fields TEXT NOT NULL DEFAULT '[]';
ALTER TABLE event_types ADD COLUMN use_host_schedules INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_types ADD COLUMN confirmation_message TEXT NOT NULL DEFAULT '';
ALTER TABLE event_types ADD COLUMN redirect_url TEXT;
ALTER TABLE event_types ADD COLUMN managed_template INTEGER NOT NULL DEFAULT 0;

UPDATE event_types SET locations = json_array(json_object('type', 'custom', 'value', location)) WHERE location <> '';

CREATE TABLE event_type_hosts (
  event_type_id TEXT NOT NULL REFERENCES event_types(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 4),
  PRIMARY KEY (event_type_id, user_id)
);
INSERT INTO event_type_hosts (event_type_id, user_id) SELECT id, host_id FROM event_types;

-- Personal working hours used by team event types (collective and round robin) when enabled.
CREATE TABLE user_schedules (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  timezone TEXT NOT NULL,
  rules TEXT NOT NULL,
  overrides TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

-- ---- Meetings, hosts and attendees ----------------------------------------------------------
CREATE TABLE meetings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type_id TEXT NOT NULL REFERENCES event_types(id) ON DELETE CASCADE,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'canceled')),
  seats INTEGER NOT NULL DEFAULT 1,
  video_url TEXT,
  created_at INTEGER NOT NULL,
  CHECK (ends_at > starts_at)
);
CREATE INDEX meetings_event_start ON meetings(event_type_id, starts_at);
CREATE INDEX meetings_workspace ON meetings(workspace_id, starts_at);

CREATE TABLE meeting_hosts (
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  block_start INTEGER NOT NULL,
  block_end INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  external_ref TEXT,
  sync_error TEXT,
  PRIMARY KEY (meeting_id, host_id)
);
CREATE INDEX meeting_hosts_host ON meeting_hosts(host_id, block_start, block_end) WHERE active = 1;

-- Durable double-booking protection per host across all event types and meeting kinds.
CREATE TRIGGER meeting_hosts_no_overlap_insert BEFORE INSERT ON meeting_hosts
WHEN NEW.active = 1 AND EXISTS (
  SELECT 1 FROM meeting_hosts h WHERE h.host_id = NEW.host_id AND h.active = 1 AND h.meeting_id <> NEW.meeting_id
    AND ((NEW.block_start < h.ends_at AND NEW.block_end > h.starts_at) OR (NEW.starts_at < h.block_end AND NEW.ends_at > h.block_start)))
BEGIN SELECT RAISE(ABORT, 'booking_overlap'); END;

CREATE TRIGGER meeting_hosts_no_overlap_update BEFORE UPDATE OF active, starts_at, ends_at, block_start, block_end ON meeting_hosts
WHEN NEW.active = 1 AND EXISTS (
  SELECT 1 FROM meeting_hosts h WHERE h.host_id = NEW.host_id AND h.active = 1 AND h.meeting_id <> NEW.meeting_id
    AND ((NEW.block_start < h.ends_at AND NEW.block_end > h.starts_at) OR (NEW.starts_at < h.block_end AND NEW.ends_at > h.block_start)))
BEGIN SELECT RAISE(ABORT, 'booking_overlap'); END;

INSERT INTO meetings (id, workspace_id, event_type_id, starts_at, ends_at, status, seats, created_at)
  SELECT id, workspace_id, event_type_id, starts_at, ends_at, CASE status WHEN 'confirmed' THEN 'active' ELSE 'canceled' END, 1, created_at FROM bookings;
DROP TRIGGER bookings_no_overlap_insert;
DROP TRIGGER bookings_no_overlap_update;
INSERT INTO meeting_hosts (meeting_id, host_id, starts_at, ends_at, block_start, block_end, active)
  SELECT id, host_id, starts_at, ends_at, block_start, block_end, CASE status WHEN 'confirmed' THEN 1 ELSE 0 END FROM bookings;

-- Attendee records. One meeting has one attendee, or several for group events.
CREATE TABLE bookings_v2 (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type_id TEXT NOT NULL REFERENCES event_types(id) ON DELETE CASCADE,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'canceled')),
  invitee_name TEXT NOT NULL,
  invitee_email TEXT NOT NULL,
  invitee_timezone TEXT NOT NULL,
  invitee_phone TEXT,
  notes TEXT NOT NULL DEFAULT '',
  answers TEXT NOT NULL DEFAULT '{}',
  location TEXT,
  guests TEXT NOT NULL DEFAULT '[]',
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  manage_token_hash TEXT NOT NULL UNIQUE,
  manage_expires_at INTEGER NOT NULL,
  rescheduled_from TEXT,
  rescheduled_to TEXT,
  canceled_at INTEGER,
  canceled_by TEXT CHECK (canceled_by IS NULL OR canceled_by IN ('invitee', 'host', 'reschedule', 'payment_timeout', 'system')),
  cancel_reason TEXT,
  payment_status TEXT NOT NULL DEFAULT 'none' CHECK (payment_status IN ('none', 'pending', 'paid', 'refunded')),
  payment_ref TEXT,
  amount_cents INTEGER,
  currency TEXT,
  hold_expires_at INTEGER,
  booked_by TEXT,
  contact_id TEXT,
  source TEXT NOT NULL DEFAULT 'page',
  anonymized_at INTEGER,
  created_at INTEGER NOT NULL,
  CHECK (ends_at > starts_at),
  UNIQUE (event_type_id, idempotency_key)
);
INSERT INTO bookings_v2 (id, reference, workspace_id, event_type_id, meeting_id, host_id, starts_at, ends_at, status, invitee_name, invitee_email,
    invitee_timezone, notes, idempotency_key, request_hash, manage_token_hash, manage_expires_at, rescheduled_from, rescheduled_to, canceled_at,
    canceled_by, cancel_reason, anonymized_at, created_at)
  SELECT id, reference, workspace_id, event_type_id, id, host_id, starts_at, ends_at, status, invitee_name, invitee_email,
    invitee_timezone, notes, idempotency_key, request_hash, manage_token_hash, manage_expires_at, rescheduled_from, rescheduled_to, canceled_at,
    canceled_by, cancel_reason, anonymized_at, created_at FROM bookings;
DROP TABLE bookings;
ALTER TABLE bookings_v2 RENAME TO bookings;
CREATE INDEX bookings_meeting ON bookings(meeting_id);
CREATE INDEX bookings_workspace ON bookings(workspace_id, starts_at);
CREATE INDEX bookings_email ON bookings(workspace_id, invitee_email);
CREATE INDEX bookings_hold ON bookings(status, hold_expires_at);

-- ---- Messages: email and SMS share one delivery queue -----------------------------------
ALTER TABLE emails ADD COLUMN channel TEXT NOT NULL DEFAULT 'email';

-- Event workflows: confirmations, reminders and follow-ups by email or SMS.
CREATE TABLE meet_workflows (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type_id TEXT REFERENCES event_types(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('booked', 'before_start', 'after_end', 'canceled', 'rescheduled')),
  offset_min INTEGER NOT NULL DEFAULT 0 CHECK (offset_min BETWEEN 0 AND 43200),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
  recipient TEXT NOT NULL CHECK (recipient IN ('invitee', 'host')),
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  condition TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX meet_workflows_event ON meet_workflows(workspace_id, event_type_id);
-- The per-event-type reminder_min setting stays as the built-in reminder; workflows are additional.

-- ---- Outbox and flows: allow more event types (validated in application code) -------------
CREATE TABLE outbox_v2 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  dispatched_at INTEGER
);
INSERT INTO outbox_v2 SELECT id, workspace_id, type, subject_id, source_id, created_at, dispatched_at FROM outbox;
DROP TABLE outbox;
ALTER TABLE outbox_v2 RENAME TO outbox;
CREATE INDEX outbox_pending ON outbox(dispatched_at, created_at);

CREATE TABLE flows_v2 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  trigger_source TEXT,
  action_type TEXT NOT NULL CHECK (action_type IN ('email', 'task')),
  action_config TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'enabled', 'paused')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO flows_v2 SELECT id, workspace_id, name, trigger_type, trigger_source, action_type, action_config, status, created_at, updated_at FROM flows;
DROP TABLE flows;
ALTER TABLE flows_v2 RENAME TO flows;
CREATE INDEX flows_trigger ON flows(workspace_id, trigger_type, status);

-- ---- Contacts (lightweight CRM) -----------------------------------------------------------
CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  phone TEXT,
  company TEXT NOT NULL DEFAULT '',
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  custom TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_activity_at INTEGER,
  UNIQUE (workspace_id, email)
);
CREATE TABLE contact_notes (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  author_id TEXT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
ALTER TABLE responses ADD COLUMN contact_id TEXT;
ALTER TABLE tasks ADD COLUMN contact_id TEXT;
ALTER TABLE tasks ADD COLUMN due_at INTEGER;
ALTER TABLE tasks ADD COLUMN assignee_id TEXT;

-- Routing: a published form can send respondents to a booking page, a URL or a message.
ALTER TABLE forms ADD COLUMN routing TEXT;

-- ---- Meeting polls ------------------------------------------------------------------------
CREATE TABLE polls (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration_min INTEGER NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'booked', 'closed')),
  booked_option_id TEXT,
  event_type_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE poll_options (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  starts_at INTEGER NOT NULL
);
CREATE TABLE poll_votes (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  option_ids TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (poll_id, email)
);

-- ---- Developer platform -------------------------------------------------------------------
CREATE TABLE webhook_endpoints (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_status INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  UNIQUE (endpoint_id, event_id)
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

-- ---- Integrations: OAuth calendars/video, payments; secrets encrypted at rest -------------
CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  account TEXT NOT NULL DEFAULT '',
  credentials TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'error')),
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX integrations_unique ON integrations(workspace_id, ifnull(user_id, ''), provider);

-- Calendar connections may now be ICS feeds or OAuth calendars, several per host.
CREATE TABLE calendar_connections_v2 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('ics', 'google', 'microsoft')),
  feed_url TEXT,
  integration_id TEXT REFERENCES integrations(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked', 'error')),
  last_synced_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
INSERT INTO calendar_connections_v2 (id, workspace_id, user_id, provider, feed_url, status, last_synced_at, last_error, created_at)
  SELECT id, workspace_id, user_id, provider, feed_url, status, last_synced_at, last_error, created_at FROM calendar_connections;
CREATE TABLE busy_blocks_v2 (
  connection_id TEXT NOT NULL REFERENCES calendar_connections_v2(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL
);
INSERT INTO busy_blocks_v2 SELECT connection_id, host_id, starts_at, ends_at FROM busy_blocks;
DROP TABLE busy_blocks;
DROP TABLE calendar_connections;
ALTER TABLE calendar_connections_v2 RENAME TO calendar_connections;
ALTER TABLE busy_blocks_v2 RENAME TO busy_blocks;
CREATE INDEX busy_blocks_host ON busy_blocks(host_id, starts_at);
CREATE INDEX calendar_connections_user ON calendar_connections(workspace_id, user_id);

CREATE TABLE sso_configs (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  email_domain TEXT NOT NULL DEFAULT '',
  default_role TEXT NOT NULL DEFAULT 'member' CHECK (default_role IN ('member', 'admin')),
  enforced INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

-- ---- AI: transcripts, recaps and the scheduling assistant -------------------------------
CREATE TABLE transcripts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'upload',
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX transcripts_workspace ON transcripts(workspace_id, created_at);
CREATE TABLE recaps (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  decisions TEXT NOT NULL DEFAULT '[]',
  action_items TEXT NOT NULL DEFAULT '[]',
  follow_up TEXT NOT NULL DEFAULT '',
  share_token_hash TEXT UNIQUE,
  share_passcode_hash TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE assist_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  event_type_id TEXT,
  from_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  proposed TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- ---- Branding and audit -------------------------------------------------------------------
ALTER TABLE workspaces ADD COLUMN brand_color TEXT;
ALTER TABLE workspaces ADD COLUMN logo TEXT;
ALTER TABLE workspaces ADD COLUMN welcome_message TEXT NOT NULL DEFAULT '';

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_log_workspace ON audit_log(workspace_id, created_at);
