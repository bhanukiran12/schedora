-- Respondent sign-in (docs/FORMS.md, "Respondent sign-in"). Additive: older releases ignore all of it.
-- forms.access: 'public' (default, so every existing link keeps working) or 'signin'. It belongs to the form,
-- not to its definition, so it is not in exported files and takes effect without republishing.
ALTER TABLE forms ADD COLUMN access TEXT NOT NULL DEFAULT 'public';
-- The verified identity a response was submitted with, apart from its answers. NULL for public forms.
ALTER TABLE responses ADD COLUMN respondent TEXT;
-- A respondent's sign-in to one workspace's forms. Never a user, membership or member session.
CREATE TABLE respondent_sessions (
  token_hash TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX respondent_sessions_expiry ON respondent_sessions (expires_at);
