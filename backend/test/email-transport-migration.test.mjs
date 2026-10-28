import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, migrate } from '../src/db.mjs';

test('upgrading legacy messages preserves records with unknown transport and reruns safely', () => {
  const db = openDatabase(':memory:');
  try {
    // Recreate the pre-007 table shape and preserve a genuine old sent record. This is a disposable
    // in-memory upgrade fixture only; no production data or evidence is rewritten.
    db.exec('ALTER TABLE emails DROP COLUMN accepted_transport');
    db.run("DELETE FROM schema_migrations WHERE name = '007_email_transport.sql'");
    db.run("INSERT INTO workspaces (id, slug, name, created_at) VALUES ('old-ws', 'old-ws', 'Old workspace', 1)");
    db.run("INSERT INTO emails (id, workspace_id, idempotency_key, kind, to_address, subject, body, status, next_attempt_at, created_at, sent_at, provider_message_id) VALUES ('old-email', 'old-ws', 'old-key', 'flow', 'old@example.com', 'Old subject', 'Old body', 'sent', 1, 1, 2, 'old-id')");
    migrate(db.raw);
    const record = db.get("SELECT * FROM emails WHERE id = 'old-email'");
    assert.equal(record.accepted_transport, null);
    assert.equal(record.status, 'sent');
    assert.equal(record.provider_message_id, 'old-id');
    assert.equal(record.body, 'Old body');
    migrate(db.raw);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM emails').count, 1);
  } finally { db.close(); }
});
