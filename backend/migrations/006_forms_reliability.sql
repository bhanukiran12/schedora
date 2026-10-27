-- Forms reliability: draft revisions, versioned routing, submission fingerprints and Meet handoffs.
-- PostgreSQL applies the same change through the postgres_v5_forms_reliability upgrade
-- (src/postgres.mjs), so keep foreign keys in the "col TEXT REFERENCES t(c)" form.

-- Optimistic concurrency for the builder: every saved draft (questions or routing) increments it,
-- and a save or publish based on an older revision is rejected instead of overwriting.
ALTER TABLE forms ADD COLUMN draft_revision INTEGER NOT NULL DEFAULT 1;

-- Routing is published together with the questions it refers to. forms.routing is now the draft.
ALTER TABLE form_versions ADD COLUMN routing TEXT;
UPDATE form_versions SET routing = (SELECT f.routing FROM forms f WHERE f.id = form_versions.form_id)
  WHERE version = (SELECT f.published_version FROM forms f WHERE f.id = form_versions.form_id);

-- Hash of the accepted answers, so a retry with the same submission id but different answers is
-- reported truthfully (the first accepted answers stand).
ALTER TABLE responses ADD COLUMN request_hash TEXT;

-- One booking handoff per accepted response. The respondent holds an opaque token (only its
-- SHA-256 is stored) instead of personal details in the booking page address.
CREATE TABLE form_handoffs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  response_id TEXT NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  event_type_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('offered', 'booked', 'unavailable')),
  reason TEXT,
  token_hash TEXT UNIQUE,
  expires_at INTEGER,
  booking_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX form_handoffs_response ON form_handoffs(response_id);
CREATE INDEX form_handoffs_form ON form_handoffs(form_id);
CREATE INDEX form_handoffs_booking ON form_handoffs(booking_id);
