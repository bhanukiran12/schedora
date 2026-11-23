CREATE TABLE form_workbook_versions (
  form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  sheets TEXT NOT NULL,
  PRIMARY KEY (form_id, revision)
);
