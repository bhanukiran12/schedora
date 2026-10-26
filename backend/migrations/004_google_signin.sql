CREATE TABLE auth_identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject),
  UNIQUE (provider, user_id)
);
CREATE TABLE auth_login_flows (
  state_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
