CREATE TABLE form_workbook_comments (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  sheet_id TEXT NOT NULL,
  cell TEXT NOT NULL,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX form_workbook_comment_thread ON form_workbook_comments (form_id, sheet_id, cell, created_at, id);
