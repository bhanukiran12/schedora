import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvaluator } from '../src/shared/sheets-engine/index.mts';

test('an edit recalculates a shared dependency once and keeps unrelated cached results', () => {
  const sheet = { name: 'Inputs', cells: { A1: '2', B1: '=A1*2', C1: '=B1+1', D1: '=B1+2', E1: '=C1+D1', F1: '=10*10' } };
  const engine = createEvaluator([sheet]);
  assert.equal(engine.value(sheet, 'E1'), 11);
  assert.equal(engine.value(sheet, 'F1'), 100);
  sheet.cells.A1 = '4';
  assert.deepEqual(engine.update([sheet], [{ sheet: 'Inputs', address: 'A1' }]), { invalidated: 5, evaluated: 4 });
  assert.equal(engine.value(sheet, 'E1'), 19);
  assert.equal(engine.value(sheet, 'F1'), 100);
});

test('remote snapshots invalidate cross-sheet ranges, blanks and open-range extents', () => {
  const original = { name: 'Form Responses', literal: true, cells: { B2: '4' } };
  const sheet = { name: 'Analysis', cells: { A1: "=SUM('Form Responses'!B2:B9)", A2: "=ROWS('Form Responses'!B:B)", A3: "=SUM('Form Responses'!B:B)", A4: "='Form Responses'!C2", A5: '=A1+A3' } };
  const engine = createEvaluator([sheet, original]);
  assert.deepEqual(engine.block(sheet, 0, 0, 4, 0), [4, 2, 4, '', 8]);
  const appended = { ...original, cells: { B2: '4', B3: '5', C2: '=1+2', A10: 'extent' } };
  engine.update([sheet, appended]);
  assert.deepEqual(engine.block(sheet, 0, 0, 4, 0), [9, 10, 9, '=1+2', 18]);
  engine.update([sheet, original]);
  assert.deepEqual(engine.block(sheet, 0, 0, 4, 0), [4, 2, 4, '', 8]);
});

test('overlapping rectangle subscriptions deduplicate and respect both axes and the source sheet', () => {
  const sheet = { name: 'Work', cells: { A1: '=SUM(B2:D4,C3:E8)', A2: '=ROWS(A2:A8)' } };
  const other = { name: 'Other', cells: {} };
  const engine = createEvaluator([sheet, other]);
  assert.deepEqual(engine.block(sheet, 0, 0, 1, 0), [0, 7]);
  const edit = (target, address, value) => {
    target.cells[address] = String(value);
    return engine.update([sheet, other], [{ sheet: target.name, address }]).evaluated;
  };
  assert.equal(edit(other, 'C3', 4), 0);
  assert.equal(edit(sheet, 'B8', 4), 0);
  assert.equal(edit(sheet, 'F4', 4), 0);
  assert.equal(edit(sheet, 'C3', 4), 1);
  assert.equal(edit(sheet, 'E8', 3), 1);
  assert.equal(edit(sheet, 'A8', 1), 1);
  assert.deepEqual(engine.block(sheet, 0, 0, 1, 0), [11, 7]);
});

test('stack depth stays bounded when a long cached chain is edited in reverse order', () => {
  const length = 2500;
  const cells = { A1: '1', B1: '=A1+1' };
  for (let row = 2; row <= length; row++) cells[`B${row}`] = `=B${row - 1}+1`;
  const sheet = { name: 'Work', cells };
  const engine = createEvaluator([sheet]);
  assert.equal(engine.block(sheet, 0, 1, length - 1, 1).at(-1), length + 1);

  cells.B2500 = '=B2499+2';
  cells.A1 = '2';
  assert.equal(engine.update([sheet], [{ sheet: 'Work', address: 'B2500' }, { sheet: 'Work', address: 'A1' }]).evaluated, length);
  assert.equal(engine.value(sheet, 'B2500'), length + 3);
});

test('formula edits replace old dependencies and lazy branches subscribe only when used', () => {
  const sheet = { name: 'Work', cells: { A1: 'TRUE', B1: '4', C1: '8', D1: '=IF(A1,B1,C1)', E1: '=D1+1' } };
  const engine = createEvaluator([sheet]);
  assert.equal(engine.value(sheet, 'E1'), 5);
  const change = (address, value) => {
    sheet.cells[address] = value;
    return engine.update([sheet], [{ sheet: 'Work', address }]);
  };
  assert.equal(change('C1', '10').evaluated, 0);
  assert.equal(change('A1', 'FALSE').evaluated, 2);
  assert.equal(engine.value(sheet, 'E1'), 11);
  assert.equal(change('B1', '6').evaluated, 0);
  assert.equal(change('D1', '=B1').evaluated, 2);
  assert.equal(change('C1', '20').evaluated, 0);
  assert.equal(engine.value(sheet, 'E1'), 7);
});

test('each member of a cycle reports the error and recovers after an edit', () => {
  const sheet = { name: 'Work', cells: { A1: '=ISNUMBER(B1)', B1: '=SUM(A1:A2)', C1: '=B1+1', D1: '=IF(FALSE,D1,2)' } };
  const engine = createEvaluator([sheet]);
  for (const address of ['A1', 'B1', 'C1']) assert.equal(engine.value(sheet, address).code, '#CYCLE!');
  assert.equal(engine.value(sheet, 'D1'), 2);
  sheet.cells.B1 = '7';
  engine.update([sheet], [{ sheet: 'Work', address: 'B1' }]);
  assert.deepEqual(engine.block(sheet, 0, 0, 0, 3), [true, 7, 8, 2]);
});

test('volatile values refresh once per recalculation, with dynamic references and a shared clock', () => {
  let clock = new Date(2026, 10, 16, 12);
  let reads = 0;
  const sheet = { name: 'Work', cells: { A1: '=RAND()', B1: '=A1*2', C1: '=TODAY()', D1: '=NOW()', E1: '=NOW()', F1: 'TRUE', G1: '10', G2: '20', H1: '=INDIRECT(IF(F1,"G1","G2"))', I1: '=SUM(OFFSET(G1,0,0,2,1))' } };
  const engine = createEvaluator([sheet], { now: () => clock, random: () => ++reads / 10 });
  assert.deepEqual(engine.block(sheet, 0, 0, 0, 2), [0.1, 0.2, '2026-11-16']);
  const previous = engine.value(sheet, 'D1');
  assert.equal(engine.value(sheet, 'E1'), previous);
  assert.equal(engine.value(sheet, 'H1'), 10);
  assert.equal(engine.value(sheet, 'I1'), 30);
  clock = new Date(2026, 10, 17, 12);
  sheet.cells.F1 = 'FALSE';
  engine.update([sheet], [{ sheet: 'Work', address: 'F1' }]);
  assert.deepEqual(engine.block(sheet, 0, 0, 0, 2), [0.2, 0.4, '2026-11-17']);
  assert.equal(engine.value(sheet, 'D1'), previous + 1);
  assert.equal(engine.value(sheet, 'H1'), 20);
  sheet.cells.G2 = '25';
  engine.update([sheet], [{ sheet: 'Work', address: 'G2' }]);
  assert.equal(engine.value(sheet, 'H1'), 25);
  assert.equal(engine.value(sheet, 'I1'), 35);
  assert.equal(reads, 3);
  engine.update([{ ...sheet, cells: { ...sheet.cells } }]);
  assert.equal(reads, 3);
  engine.recalculate();
  assert.equal(engine.value(sheet, 'B1'), 0.8);
  assert.equal(reads, 4);
});

test('changing sheet topology clears cached missing references and truncated bounds', () => {
  const sheet = { name: 'Work', cells: { A1: '=Other!A2' } };
  const engine = createEvaluator([sheet]);
  assert.equal(engine.value(sheet, 'A1').code, '#REF!');
  const target = { name: 'Other', cells: { A2: '3' }, limit: { rows: 1, columns: 1 } };
  engine.update([sheet, target]);
  assert.equal(engine.value(sheet, 'A1').code, '#REF!');
  engine.update([sheet, { ...target, limit: { rows: 2, columns: 1 } }]);
  assert.equal(engine.value(sheet, 'A1'), 3);
  engine.update([sheet]);
  assert.equal(engine.value(sheet, 'A1').code, '#REF!');
});
