-- migrate: foreign_keys_off
-- Flow v1 (docs/FLOW_V1_IMPLEMENTATION.md): versioned multi-step workflows with durable runs, steps,
-- waits and approvals. Existing one-trigger/one-action flows and their runs are kept unchanged; a flow
-- without a definition keeps running on the original single-action path.

CREATE TABLE flows_v3 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  trigger_source TEXT,
  action_type TEXT NOT NULL,
  action_config TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'enabled', 'paused')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  definition TEXT,
  draft_revision INTEGER NOT NULL DEFAULT 0,
  published_version INTEGER,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  template TEXT,
  auto_pause INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  alerted_at INTEGER,
  enabled_at INTEGER
);
INSERT INTO flows_v3 (id, workspace_id, name, trigger_type, trigger_source, action_type, action_config, status, created_at, updated_at)
  SELECT id, workspace_id, name, trigger_type, trigger_source, action_type, action_config, status, created_at, updated_at FROM flows;
DROP TABLE flows;
ALTER TABLE flows_v3 RENAME TO flows;
CREATE INDEX flows_trigger ON flows(workspace_id, trigger_type, status);

CREATE TABLE flow_runs_v3 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'retrying', 'failed', 'waiting', 'needs_approval', 'skipped', 'canceled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER,
  trigger_data TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until INTEGER,
  reason TEXT,
  finished_at INTEGER,
  UNIQUE (flow_id, event_id)
);
INSERT INTO flow_runs_v3 (id, workspace_id, flow_id, event_id, event_type, subject_id, status, attempts, next_attempt_at, last_error, result, created_at, updated_at)
  SELECT id, workspace_id, flow_id, event_id, event_type, subject_id, status, attempts, next_attempt_at, last_error, result, created_at, updated_at FROM flow_runs;
DROP TABLE flow_runs;
ALTER TABLE flow_runs_v3 RENAME TO flow_runs;
CREATE INDEX flow_runs_due ON flow_runs(status, next_attempt_at);
CREATE INDEX flow_runs_subject ON flow_runs(workspace_id, subject_id);
CREATE INDEX flow_runs_flow ON flow_runs(flow_id, created_at);

-- Immutable published definitions. Runs record the version they started on.
CREATE TABLE flow_versions (
  flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  definition TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  published_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (flow_id, version)
);

-- One record per executed step. A succeeded step is never executed again for the same run.
CREATE TABLE flow_run_steps (
  run_id TEXT NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  step_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped', 'waiting', 'uncertain', 'canceled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  input TEXT,
  output TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  PRIMARY KEY (run_id, step_id)
);

-- "Wait until something happens": resolved once, by the matching event or by the timeout.
CREATE TABLE flow_waits (
  run_id TEXT NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  match_key TEXT NOT NULL,
  source_id TEXT,
  timeout_at INTEGER NOT NULL,
  outcome TEXT CHECK (outcome IN ('matched', 'timeout', 'canceled')),
  resolved_at INTEGER,
  matched_subject TEXT,
  PRIMARY KEY (run_id, step_id)
);
CREATE INDEX flow_waits_open ON flow_waits(workspace_id, event_type, match_key, resolved_at);

CREATE TABLE flow_approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  approver TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'canceled')),
  revision INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  draft TEXT,
  decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at INTEGER,
  note TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (run_id, step_id)
);
CREATE INDEX flow_approvals_pending ON flow_approvals(workspace_id, status, created_at);

-- Fair round-robin owner assignment per step.
CREATE TABLE flow_round_robin (
  flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_count INTEGER NOT NULL DEFAULT 0,
  last_assigned_at INTEGER,
  PRIMARY KEY (flow_id, step_id, user_id)
);

-- Incoming webhook trigger: a private URL token plus an HMAC signing secret (encrypted).
CREATE TABLE flow_inbound_hooks (
  flow_id TEXT PRIMARY KEY REFERENCES flows(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  secret TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE flow_inbound_deliveries (
  flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  delivery_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (flow_id, delivery_id)
);

-- Scheduled triggers: the last slot fired, so restarts never fire a slot twice.
CREATE TABLE flow_schedules (
  flow_id TEXT PRIMARY KEY REFERENCES flows(id) ON DELETE CASCADE,
  last_slot INTEGER
);

-- "Connected and tested": a provider counts as tested for a workspace only after a confirmed test.
CREATE TABLE flow_provider_checks (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'delivered', 'failed')),
  detail TEXT,
  checked_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, provider)
);

-- Events carry an origin (user, undo, redo, source, automation, manual) and an automation depth.
ALTER TABLE outbox ADD COLUMN payload TEXT;
ALTER TABLE outbox ADD COLUMN origin TEXT;
ALTER TABLE outbox ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;

-- Qualify-then-book starters now create an inactive Flow draft instead of a paused Meet email workflow.
ALTER TABLE qualify_starters ADD COLUMN flow_id TEXT;
