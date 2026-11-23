import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createEvaluator, sheetAddress } from '../src/shared/sheets-engine/index.mts';

const rows = 2500;
const columns = 40;
const cells = { A1: '1', A2: '2' };
for (let row = 1; row <= rows; row++) {
  for (let column = 2; column < columns + 2; column++) cells[sheetAddress(row, column)] = '=$A$2+1';
}
cells.C2 = '=A1+1';
cells.D2 = '=C2*2';
cells.E2 = '=SUM(C2:D2)';

const sheet = { name: 'Benchmark', cells };
const engine = createEvaluator([sheet]);
const warming = performance.now();
const values = engine.block(sheet, 1, 2, rows, columns + 1);
const warmMs = performance.now() - warming;
assert.equal(values.length, 100000);
assert.deepEqual(values.slice(0, 4), [2, 4, 6, 3]);
assert.ok(values.slice(3).every(value => value === 3));

const times = [];
for (let value = 2; value <= 41; value++) {
  cells.A1 = String(value);
  const start = performance.now();
  const result = engine.update([sheet], [{ sheet: 'Benchmark', address: 'A1' }]);
  times.push(performance.now() - start);
  assert.deepEqual(result, { invalidated: 4, evaluated: 3 });
  assert.equal(engine.value(sheet, 'E2'), 3 * (value + 1));
  assert.equal(engine.value(sheet, 'AP2501'), 3);
}
times.sort((a, b) => a - b);
const p95 = times[Math.ceil(times.length * 0.95) - 1];
const slowest = times.at(-1);
console.log(`Cached 100,000 formulas in ${warmMs.toFixed(1)} ms.`);
console.log(`40 single-cell edits with three dependent formulas: p95 ${p95.toFixed(2)} ms, max ${slowest.toFixed(2)} ms.`);
assert.ok(slowest < 50, 'A sparse edit exceeded the 50 ms target');
