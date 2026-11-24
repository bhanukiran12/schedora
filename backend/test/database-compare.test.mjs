import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSnapshots } from '../scripts/database-compare.mjs';

const snapshot = (hash = 'original') => ({ schema_sha256: 'schema', tables: {
  forms: { rows: 1, sha256: hash }, responses: { rows: 3, sha256: 'responses' }
} });

test('cutover comparison refuses changed values even when row counts match', () => {
  const result = compareSnapshots(snapshot(), snapshot('changed'));
  assert.equal(result.verified, false);
  assert.deepEqual(result.differing_tables, ['forms']);
});

test('cutover comparison refuses missing tables and altered constraints or columns', () => {
  const missing = snapshot();
  delete missing.tables.responses;
  assert.equal(compareSnapshots(snapshot(), missing).verified, false);
  assert.equal(compareSnapshots(snapshot(), { ...snapshot(), schema_sha256: 'different-schema' }).verified, false);
  assert.deepEqual(compareSnapshots(snapshot(), snapshot()), {
    verified: true, schema_matches: true, table_count: 2, row_count: 4, differing_tables: []
  });
});
