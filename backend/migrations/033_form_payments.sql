-- Forms payments (docs/FORMS.md, "Payments"). A response to a paid form is saved first and stays
-- incomplete until Schedora's server confirms the payment with the provider. Browser redirects never
-- change these rows.
ALTER TABLE responses ADD COLUMN payment_status TEXT;

CREATE TABLE form_payments (
  response_id TEXT PRIMARY KEY REFERENCES responses(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL CHECK (provider IN ('razorpay', 'test')),
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'expired', 'refunded', 'partially_refunded', 'review')),
  window_ends_at INTEGER NOT NULL,
  amount_paid INTEGER NOT NULL DEFAULT 0,
  amount_refunded INTEGER NOT NULL DEFAULT 0,
  provider_payment_id TEXT,
  last_failure TEXT,
  review_reason TEXT,
  paid_at INTEGER,
  completed_at INTEGER,
  last_checked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX form_payments_due ON form_payments(status, last_checked_at);
CREATE INDEX form_payments_form ON form_payments(form_id, status);
CREATE INDEX form_payments_provider_payment ON form_payments(provider_payment_id);

CREATE TABLE form_payment_attempts (
  id TEXT PRIMARY KEY,
  response_id TEXT NOT NULL REFERENCES form_payments(response_id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_ref TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('creating', 'created', 'paid', 'expired', 'cancelled')),
  url TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX form_payment_attempts_response ON form_payment_attempts(response_id, created_at);

-- Verified provider webhook deliveries, kept for evidence and so a redelivery is recognised.
CREATE TABLE form_payment_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  response_id TEXT,
  type TEXT NOT NULL,
  result TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX form_payment_events_received ON form_payment_events(received_at);
