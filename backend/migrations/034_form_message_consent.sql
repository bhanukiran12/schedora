-- WhatsApp form receipts (docs/FORMS.md, "WhatsApp receipts"). A receipt is only sent to a respondent
-- who ticked the unchecked opt-in, to a valid number, once per response.
CREATE TABLE form_message_consents (
  response_id TEXT PRIMARY KEY REFERENCES responses(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp')),
  phone TEXT,
  consent_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('consented', 'queued', 'invalid_number', 'opted_out', 'duplicate', 'unavailable', 'withdrawn')),
  token_hash TEXT NOT NULL UNIQUE,
  message_id TEXT,
  consented_at INTEGER NOT NULL,
  withdrawn_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX form_message_consents_phone ON form_message_consents(workspace_id, phone, consented_at);

-- Numbers that withdrew from WhatsApp messages. workspace_id NULL means a STOP reply to the shared
-- sender, which applies to every workspace. Checked before every WhatsApp delivery.
CREATE TABLE messaging_opt_outs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp')),
  phone TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('link', 'reply')),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX messaging_opt_outs_unique ON messaging_opt_outs(COALESCE(workspace_id, ''), channel, phone);
