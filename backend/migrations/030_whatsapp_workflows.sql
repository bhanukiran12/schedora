-- migrate: foreign_keys_off
CREATE TABLE meet_workflows_v2 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type_id TEXT REFERENCES event_types(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('booked', 'before_start', 'after_end', 'canceled', 'rescheduled')),
  offset_min INTEGER NOT NULL DEFAULT 0 CHECK (offset_min BETWEEN 0 AND 43200),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp')),
  recipient TEXT NOT NULL CHECK (recipient IN ('invitee', 'host')),
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  condition TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

INSERT INTO meet_workflows_v2 SELECT * FROM meet_workflows;
DROP TABLE meet_workflows;
ALTER TABLE meet_workflows_v2 RENAME TO meet_workflows;
CREATE INDEX meet_workflows_event ON meet_workflows(workspace_id,event_type_id);
