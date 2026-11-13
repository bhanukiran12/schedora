CREATE TABLE form_workbooks (
  form_id TEXT PRIMARY KEY REFERENCES forms(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  sheets TEXT NOT NULL
);
