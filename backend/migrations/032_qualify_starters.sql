CREATE TABLE qualify_starters (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  form_id TEXT REFERENCES forms(id) ON DELETE SET NULL,
  event_type_id TEXT REFERENCES event_types(id) ON DELETE SET NULL,
  workflow_id TEXT REFERENCES meet_workflows(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
