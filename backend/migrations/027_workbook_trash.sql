CREATE TABLE workbook_trash (
  workbook_id TEXT PRIMARY KEY REFERENCES workbooks(id) ON DELETE CASCADE,
  trashed_at INTEGER NOT NULL
);
