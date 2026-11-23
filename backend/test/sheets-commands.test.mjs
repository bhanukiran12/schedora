import assert from 'node:assert/strict';
import test from 'node:test';
import { extendFill, fillSeries, moveWorkbookRange } from '../../frontend/js/sheet-commands.mjs';
import { columnOffsets, viewportColumns } from '../../frontend/js/sheet-grid.mjs';
import { applyOp, blankSheet, coalesceOps, diffWorkbooks, invertOp, validOp } from '../src/shared/workbook-ops.mjs';

const a = 'a'.repeat(32);
const b = 'b'.repeat(32);

test('cut follows references into their new sheet and preserves unmoved references', () => {
  const source = { ...blankSheet(a, 'Source sheet'), cells: { A1: '2', B1: '=A1+$C$1', C1: '3', D1: '=SUM($A$1:B1)', E1: '=SUM(A1:C1)' }, formats: { A1: { b: true } } };
  const target = { ...blankSheet(b, 'Target sheet'), cells: { B2: 'old', C5: "='Source sheet'!$B$1" } };
  assert.ok(moveWorkbookRange([source, target], a, b, { r1: 0, c1: 0, r2: 0, c2: 1 }, 1, 1));
  assert.deepEqual(source.cells, { C1: '3', D1: "=SUM('Target sheet'!$B$2:C2)", E1: '=SUM(A1:C1)' });
  assert.deepEqual(target.cells, { B2: '2', C2: "=B2+'Source sheet'!$C$1", C5: "='Target sheet'!$C$2" });
  assert.deepEqual(target.formats, { B2: { b: true } });
});

test('overlapping cuts preserve source order and are invertible', () => {
  const before = [{ ...blankSheet(a, 'Grid'), cells: { A1: '1', B1: '2', C1: '=A1+B1', E1: '=C1' } }];
  const after = structuredClone(before);
  moveWorkbookRange(after, a, a, { r1: 0, c1: 0, r2: 0, c2: 2 }, 0, 1);
  assert.deepEqual(after[0].cells, { B1: '1', C1: '2', D1: '=B1+C1', E1: '=D1' });
  const group = { op: 'group', ops: diffWorkbooks(before, after) };
  assert.ok(validOp(group));
  assert.equal(applyOp(after, invertOp(group, before)), 'applied');
  assert.deepEqual(after, before);
});

test('series extend in either direction and formulas shift only their relative parts', () => {
  for (const [seeds, offset, expected] of [
    [['1', '3'], -1, '-1'], [['0.1', '0.2'], 2, '0.3'], [['2024-02-28'], 1, '2024-02-29'],
    [['Fri', 'Sat'], 2, 'Sun'], [['Dec', 'Jan'], 2, 'Feb'], [['Task 008', 'Task 010'], 2, 'Task 012']
  ]) assert.equal(fillSeries(seeds)(offset), expected);
  const sheet = { ...blankSheet(a, 'Grid'), cells: { A2: '=B2+$C$2', A3: '=B3+$C$2' }, formats: { A2: { b: true } } };
  extendFill(sheet, { r1: 1, c1: 0, r2: 2, c2: 0 }, { r1: 0, c1: 0, r2: 4, c2: 0 }, 'row');
  assert.equal(sheet.cells.A1, '=B1+$C$2');
  assert.equal(sheet.cells.A5, '=B5+$C$2');
  assert.deepEqual(sheet.formats.A4, { b: true });
});

test('group rejects stale writes together and blocks coalescing across earlier edits', () => {
  const sheets = [{ ...blankSheet(a, 'Grid'), cells: { A1: '4', B1: 'remote' } }];
  const edit = (cell, from, to) => ({ op: 'cell', sheet: a, cell, from, to });
  const group = { op: 'group', ops: [edit('A1', '4', '5'), edit('B1', 'old', 'new')] };
  assert.equal(applyOp(sheets, group), 'conflict');
  assert.deepEqual(sheets[0].cells, { A1: '4', B1: 'remote' });
  const ops = [edit('A1', '3', '4'), group, edit('A1', '5', '6')];
  assert.deepEqual(coalesceOps(ops), ops);
});

test('undo returns a workbook to its original state after seeded command sequences', () => {
  const original = [{ ...blankSheet(a, 'Grid'), cells: { A1: '2', B1: '=A1*2' } }];
  const sheets = structuredClone(original);
  let seed = 871;
  const random = max => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % max);
  const undo = [];
  for (let index = 0; index < 80; index++) {
    const next = structuredClone(sheets);
    const r1 = random(8);
    const c1 = random(5);
    const range = { r1, c1, r2: r1 + 1, c2: c1 };
    if (index % 3 === 0) moveWorkbookRange(next, a, a, range, random(8), random(5));
    else if (index % 3 === 1) extendFill(next[0], range, { ...range, r2: r1 + 3 }, 'row');
    else next[0].cells[`${String.fromCharCode(65 + c1)}${r1 + 1}`] = random(2) ? '7' : '=A1+1';
    const ops = diffWorkbooks(sheets, next);
    if (!ops.length) continue;
    const command = { op: 'group', ops };
    undo.push(invertOp(command, sheets));
    assert.equal(applyOp(sheets, command), 'applied');
    assert.deepEqual(sheets, next);
  }
  for (const inverse of undo.reverse()) assert.equal(applyOp(sheets, inverse), 'applied');
  assert.deepEqual(sheets, original);
});

test('column window supports variable widths, exact edges and overscan', () => {
  const offsets = columnOffsets(4, index => [50, 80, 120, 100][index]);
  assert.deepEqual(viewportColumns(offsets, 50, 80), { first: 1, last: 2 });
  assert.deepEqual(viewportColumns(offsets, 50, 80, 1), { first: 0, last: 3 });
  assert.deepEqual(viewportColumns(offsets, 129, 2), { first: 1, last: 3 });
});
