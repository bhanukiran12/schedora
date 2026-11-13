import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, signUp } from './helpers.mjs';
import { sheetValue } from '../../frontend/js/sheet-formulas.mjs';
import { mergeWorkbook } from '../../frontend/js/workbook-merge.mjs';

test('workbook edits persist within the workspace and reject stale revisions', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const other = env.client();
    const { ws } = await signUp(owner, 'Workbook Owner');
    const otherWorkspace = (await signUp(other, 'Other Owner')).ws;
    const base = `/api/workspaces/${ws.id}/forms`;
    const created = await owner.post(base, { title: 'Workbook test' });
    assert.equal(created.status, 201);
    const route = `${base}/${created.body.id}/workbook`;
    const sheets = [{ id: 'a'.repeat(32), name: 'Totals', cells: { A1: '=1+2' } }];
    const save = (revision, value = sheets) => owner.raw('PUT', route, { revision, sheets: value });
    assert.deepEqual((await owner.get(route)).body, { revision: 0, sheets: [] });
    assert.equal((await save(0)).status, 200);
    assert.equal((await save(0)).status, 409);
    assert.equal((await save(1, [{ ...sheets[0], cells: { M1: 'bad address' } }])).status, 400);
    assert.deepEqual((await owner.get(route)).body, { revision: 1, sheets });
    assert.equal((await other.get(route.replace(ws.id, otherWorkspace.id))).status, 404);
    assert.equal((await env.client().get(route)).status, 401);
  } finally { await env.close(); }
});

test('formulas can reference editable tabs and detect cross-tab cycles', () => {
  const totals = { name: "May's totals", cells: { A1: '12', A2: '8' } };
  const report = { name: 'Report', cells: { A1: "='May''s totals'!A1+SUM('May''s totals'!A2, 2)" } };
  const sheets = [totals, report];
  assert.equal(sheetValue(report.cells, 'A1', sheets), 22);
  totals.cells.A1 = "='Report'!A1";
  assert.throws(() => sheetValue(report.cells, 'A1', sheets), /#CYCLE!/);
});

test('workbook reconciliation merges separate cells and preserves conflicting edits for review', () => {
  const sheet = cells => [{ id: 'a', name: 'Totals', cells }];
  const base = sheet({ A1: '1', A2: '2' });
  assert.deepEqual(mergeWorkbook(base, sheet({ A1: '10', A2: '2' }), sheet({ A1: '1', A2: '20' })), sheet({ A1: '10', A2: '20' }));
  assert.deepEqual(mergeWorkbook(base, sheet({ A2: '2' }), sheet({ A1: '1', A2: '20' })), sheet({ A2: '20' }));
  assert.equal(mergeWorkbook(base, sheet({ A1: '10', A2: '2' }), sheet({ A1: '11', A2: '2' })), null);
  assert.equal(mergeWorkbook(base, [], sheet({ A1: '11', A2: '2' })), null);
});

test('response references treat submissions as literal data and fail outside the linked grid', () => {
  const source = { name: 'Form Responses', literal: true, cells: { C2: '12', C3: '=99' } };
  assert.equal(sheetValue({ A1: "='Form Responses'!C2*2" }, 'A1', [source]), 24);
  assert.throws(() => sheetValue({ A1: "='Form Responses'!C3" }, 'A1', [source]), /#VALUE!/);
  assert.throws(() => sheetValue({ A1: "='Form Responses'!C4" }, 'A1', [source]), /#REF!/);
});
