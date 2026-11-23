CREATE TABLE form_resume_drafts (
  token_hash TEXT PRIMARY KEY,
  form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  answers TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'saved',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX form_resume_form ON form_resume_drafts(form_id,updated_at);
