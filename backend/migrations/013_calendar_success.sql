-- last_synced_at remains the latest attempt for existing clients and retry scheduling.
-- Historical success cannot be inferred from an attempt timestamp: leave existing rows unknown.
ALTER TABLE calendar_connections ADD COLUMN last_success_at INTEGER;
