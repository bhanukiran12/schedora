CREATE TABLE billing_checkouts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  plan TEXT NOT NULL CHECK (plan IN ('meet', 'forms', 'flow', 'suite')),
  provider_plan_id TEXT NOT NULL,
  provider_subscription_id TEXT UNIQUE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  billing_cycles INTEGER NOT NULL CHECK (billing_cycles > 0),
  status TEXT NOT NULL,
  checkout_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, request_key)
);
CREATE INDEX billing_checkouts_workspace ON billing_checkouts(workspace_id);
