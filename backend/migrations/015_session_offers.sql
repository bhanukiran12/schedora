-- Session offers and pinned notes in Schedora meeting rooms (docs/MEET_SESSION_OFFERS.md). Additive:
-- older releases ignore these tables. Receipts hold status and a response id only, never answers.
CREATE TABLE video_session_offers (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES video_rooms(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('auto', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('active', 'replaced', 'removed')),
  launched_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  ended_by TEXT
);
-- At most one offer is active in a room; replaced and removed offers keep their receipts.
CREATE UNIQUE INDEX video_session_offers_active ON video_session_offers(room_id) WHERE status = 'active';
CREATE INDEX video_session_offers_form ON video_session_offers(form_id);

-- One row per attendee seat and offer: prompted, opened (viewing) and submitted are separate facts.
CREATE TABLE video_session_receipts (
  offer_id TEXT NOT NULL REFERENCES video_session_offers(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES video_participants(id) ON DELETE CASCADE,
  prompted_at INTEGER,
  opened_at INTEGER,
  submitted_at INTEGER,
  response_id TEXT REFERENCES responses(id) ON DELETE SET NULL,
  PRIMARY KEY (offer_id, participant_id)
);
CREATE INDEX video_session_receipts_participant ON video_session_receipts(participant_id);

-- One pinned instruction per room: plain text and an optional https link.
CREATE TABLE video_session_notes (
  room_id TEXT PRIMARY KEY REFERENCES video_rooms(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  link_url TEXT,
  link_label TEXT,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
