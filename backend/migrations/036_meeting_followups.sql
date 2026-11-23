-- Reviewed post-meeting follow-ups (docs/MEET_VIDEO.md, "Reviewed AI follow-up"). An AI draft grounded in a
-- transcript; nothing is emailed and no task is created until a person reviews the latest revision and sends it.
CREATE TABLE meeting_followups (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('generating', 'draft', 'failed', 'sent', 'discarded')),
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  recipients TEXT NOT NULL DEFAULT '[]',
  tasks TEXT NOT NULL DEFAULT '[]',
  sources TEXT NOT NULL DEFAULT '[]',
  removed_unsupported INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  edited INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at INTEGER,
  sent_at INTEGER,
  sent_emails INTEGER NOT NULL DEFAULT 0,
  created_tasks INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX meeting_followups_budget ON meeting_followups(workspace_id, created_at);
CREATE INDEX meeting_followups_transcript ON meeting_followups(transcript_id, created_at);
