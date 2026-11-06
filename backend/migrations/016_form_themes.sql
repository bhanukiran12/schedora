-- Reusable form themes (docs/FORMS.md, "Design and themes"). Additive: older releases ignore this table.
-- A form never refers to a row here for its appearance. Applying a theme copies its values into the
-- form's draft, and publishing freezes that copy, so editing or deleting a theme restyles nothing.
CREATE TABLE form_themes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  tokens TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX form_themes_workspace ON form_themes (workspace_id, updated_at);
