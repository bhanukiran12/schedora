import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvaluator, displayValue } from '../src/shared/sheets-engine/index.mts';
import { applyOp, blankSheet, invertOp, normalizeSheet, validOp } from '../src/shared/workbook-ops.mjs';
import { readXlsx, writeXlsx } from '../../frontend/js/sheet-files.mjs';

test('spill values resolve before reads, recalculate after an edit, and report collisions', () => {
  const sheet = { name: 'Entries', cells: { A1: '3', A2: '1', A3: '3', B1: '=SORT(UNIQUE(A1:A3),1,TRUE)', C1: '=ARRAYFORMULA(B1:B3*2)', D1: '=SUM(B1:B3)' } };
  const engine = createEvaluator([sheet]);
  assert.equal(engine.value(sheet, 'D1'), 4);
  assert.equal(engine.spillValue(sheet, 'C2'), 6);
  sheet.cells.A3 = '4';
  engine.update([sheet], [{ sheet: 'Entries', address: 'A3' }]);
  assert.equal(engine.spillValue(sheet, 'B3'), 4);
  assert.equal(engine.spillValue(sheet, 'C3'), 8);
  sheet.cells.B2 = 'occupied';
  engine.update([sheet], [{ sheet: 'Entries', address: 'B2' }]);
  assert.equal(engine.value(sheet, 'B1').code, '#REF!');
  assert.equal(engine.value(sheet, 'B2'), 'occupied');
  assert.equal(engine.spillValue(sheet, 'B3'), undefined);
  delete sheet.cells.B2;
  engine.update([sheet], [{ sheet: 'Entries', address: 'B2' }]);
  assert.equal(engine.spillValue(sheet, 'C3'), 8);
});

test('filter conditions can be calculated arrays and lookup returns a matching record', () => {
  const sheet = { name: 'Entries', cells: { A1: '3', A2: '1', A3: '4', B1: 'Open', B2: 'Done', B3: 'Open', D1: '=FILTER(A1:B3,A1:A3>1,B1:B3="Open")', G1: '=XLOOKUP(1,A1:A3,A1:B3)', J1: '=SPLIT("7::8","::",FALSE)' } };
  const engine = createEvaluator([sheet]);
  assert.deepEqual(engine.block(sheet, 0, 3, 1, 4), [3, 'Open', 4, 'Open']);
  assert.deepEqual(engine.block(sheet, 0, 6, 0, 7), [1, 'Done']);
  assert.deepEqual(engine.block(sheet, 0, 9, 0, 10), [7, 8]);
});

test('calendar functions and spreadsheet number formats preserve valid dates and durations', () => {
  const sheet = { name: 'Dates', cells: { A1: '=EDATE(DATE(2024,1,31),1)', A2: '=EOMONTH("2024-02-01",1)', A3: '=YEAR(A1)', A4: '=MONTH(A1)', A5: '=DAY(A1)' } };
  const engine = createEvaluator([sheet]);
  assert.equal(displayValue(engine.value(sheet, 'A1'), { num: 'date' }), '2024-02-29');
  assert.equal(displayValue(engine.value(sheet, 'A2') + .5, { num: 'datetime' }), '2024-03-31 12:00:00');
  assert.deepEqual(engine.block(sheet, 2, 0, 4, 0), [2024, 2, 29]);
  assert.equal(displayValue(-1.5, { num: 'duration' }), '-36:00:00');
  assert.equal(displayValue(12, { num: 'scientific' }), '1.20E+1');
});

test('row height, freeze and wrap metadata are validated and round-trip', () => {
  const sheet = blankSheet('a'.repeat(32), 'Sheet');
  const height = { op: 'sheet-prop', sheet: sheet.id, key: 'height.2', from: null, to: 72 };
  assert.ok(validOp(height));
  assert.ok(!validOp({ ...height, key: 'height.5001' }));
  assert.ok(!validOp({ ...height, to: 500 }));
  assert.equal(applyOp([sheet], height), 'applied');
  assert.equal(applyOp([sheet], { ...height, key: 'frozenColumns', from: 0, to: 2 }), 'applied');
  sheet.formats.A2 = { wrap: true, num: 'date' };
  assert.deepEqual(normalizeSheet(sheet), sheet);
});

test('XLSX round-trips cell styles, styled blanks, dimensions and frozen panes', async () => {
  const workbook = writeXlsx([{
    name: 'Styled', frozen: 1, frozenColumns: 2, heights: { 1: 52 }, widths: { A: 145 },
    rows: [[{ value: 10, formula: '=5*2', format: { b: true, color: '#123456', num: 'percent', dp: 1 } },
      { value: '', format: { wrap: true, fill: '#FFFF00', align: 'right' } }]]
  }]);
  const [sheet] = await readXlsx(await workbook.arrayBuffer());
  assert.deepEqual(sheet.cells, { A1: '=5*2' });
  const { b, color, num, dp } = sheet.formats.A1;
  assert.deepEqual({ b, color, num, dp }, { b: true, color: '#123456', num: 'percent', dp: 1 });
  const { wrap, align, fill } = sheet.formats.B1;
  assert.deepEqual({ wrap, align, fill }, { wrap: true, align: 'right', fill: '#ffff00' });
  assert.deepEqual([sheet.frozen, sheet.frozenColumns, sheet.heights[1], sheet.widths.A], [1, 2, 52, 145]);
});

test('merged ranges round-trip in XLSX and protect covered cells and frozen boundaries', async () => {
  const sheet = blankSheet('a'.repeat(32), 'Merged');
  sheet.cells.A1 = 'Title';
  const region = { r1: 0, c1: 0, r2: 1, c2: 1 };
  const merge = { op: 'sheet-prop', sheet: sheet.id, key: 'merges', from: [], to: [region] };
  assert.ok(validOp(merge));
  assert.equal(applyOp([sheet], merge), 'applied');
  assert.equal(applyOp([sheet], { op: 'cell', sheet: sheet.id, cell: 'B2', from: null, to: 'Unexpected' }), 'conflict');
  assert.equal(applyOp([sheet], { op: 'sheet-prop', sheet: sheet.id, key: 'frozen', from: 0, to: 1 }), 'conflict');
  const blob = writeXlsx([{ name: sheet.name, rows: [[{ value: 'Title' }]], merges: sheet.merges }]);
  const [imported] = await readXlsx(await blob.arrayBuffer());
  assert.deepEqual(imported.merges, [region]);
  assert.equal(applyOp([sheet], invertOp(merge)), 'applied');
  assert.deepEqual(sheet.merges, []);
});
