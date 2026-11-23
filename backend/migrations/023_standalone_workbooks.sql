CREATE TABLE workbooks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  revision INTEGER NOT NULL,
  sheets TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX workbooks_by_workspace ON workbooks(workspace_id, created_at);

CREATE TABLE workbook_access (
  workbook_id TEXT NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  PRIMARY KEY (workbook_id, user_id)
);
CREATE INDEX workbook_access_by_user ON workbook_access(user_id, workbook_id);

CREATE TABLE workbook_versions (
  workbook_id TEXT NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  sheets TEXT NOT NULL,
  PRIMARY KEY (workbook_id, revision)
);

CREATE TABLE workbook_comments (
  id TEXT PRIMARY KEY,
  workbook_id TEXT NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
  sheet_id TEXT NOT NULL,
  cell TEXT NOT NULL,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX workbook_comments_by_cell ON workbook_comments(workbook_id, sheet_id, cell, created_at, id);

CREATE TABLE workbook_form_links (
  workbook_id TEXT NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  snapshot TEXT,
  PRIMARY KEY (workbook_id, source_id)
);
CREATE UNIQUE INDEX workbook_form_one_live_link ON workbook_form_links(source_id) WHERE snapshot IS NULL;
