CREATE TABLE form_uploads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  form_version INTEGER NOT NULL,
  field_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  respondent_hash TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  mime TEXT,
  bytes INTEGER NOT NULL,
  status TEXT NOT NULL,
  response_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX form_uploads_workspace ON form_uploads(workspace_id, status);
CREATE INDEX form_uploads_submission ON form_uploads(form_id, submission_id, field_id);
CREATE INDEX form_uploads_response ON form_uploads(response_id);
