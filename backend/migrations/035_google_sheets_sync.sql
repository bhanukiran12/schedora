-- One-way Google Sheets sync for Forms (docs/FORMS.md, "Google Sheets sync"). Schedora is the source of
-- truth; each response owns one row, found by the response ID in column A.
CREATE TABLE form_google_syncs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  form_id TEXT NOT NULL UNIQUE REFERENCES forms(id) ON DELETE CASCADE,
  integration_id TEXT REFERENCES integrations(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  spreadsheet_id TEXT NOT NULL,
  spreadsheet_title TEXT NOT NULL,
  spreadsheet_url TEXT NOT NULL,
  sheet_id INTEGER NOT NULL,
  sheet_title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('backfilling', 'active', 'paused', 'error', 'reconnect_required', 'disconnected')),
  header_hash TEXT,
  source_signature TEXT,
  synced_rows INTEGER NOT NULL DEFAULT 0,
  pending_rows INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  claimed_until INTEGER,
  last_synced_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX form_google_syncs_due ON form_google_syncs(status, next_attempt_at);

-- What was last written for each response. Not tied to the response row, so a deleted response is
-- still known here until its Google row has been blanked.
CREATE TABLE form_google_sync_rows (
  sync_id TEXT NOT NULL REFERENCES form_google_syncs(id) ON DELETE CASCADE,
  response_id TEXT NOT NULL,
  synced_hash TEXT NOT NULL,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (sync_id, response_id)
);
