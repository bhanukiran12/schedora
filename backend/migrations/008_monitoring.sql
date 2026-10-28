-- Operator alert state: one row per monitored condition. Holds codes and counts only, never
-- workspace names, addresses, answers or message bodies.
CREATE TABLE monitor_alerts (
  code TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('firing', 'resolved')),
  summary TEXT NOT NULL,
  value INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  resolved_at INTEGER,
  notify TEXT CHECK (notify IN ('firing', 'resolved')),
  notified_at INTEGER
);
