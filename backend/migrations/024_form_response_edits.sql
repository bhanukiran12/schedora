CREATE TABLE form_response_edits (
  response_id TEXT PRIMARY KEY REFERENCES responses(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  original_answers TEXT,
  revision INTEGER NOT NULL DEFAULT 0
);
