import assert from 'node:assert/strict';
import test from 'node:test';
import * as source from '../src/shared/sheets-engine/index.mts';
import * as browser from '../../frontend/js/sheet-formulas.mjs';

const { createEvaluator, shiftFormula, tokenize, typedValue } = browser;

test('spreadsheet input distinguishes numbers, percents, currency, booleans and literal text', () => {
  for (const [raw, expected] of [['2.5e2', 250], ['12.5%', 0.125], ['₹1,250.25', 1250.25], ['FALSE', false], ["'001", '001'], ['2026-11-16', '2026-11-16'], [null, '']]) {
    assert.equal(typedValue(raw), expected, String(raw));
  }
});

test('quoted identities, open ranges and string literals stay distinct', () => {
  const tokens = tokenize(`SUM('Team''s input'!$A$1:B, "A2")`);
  assert.equal(tokens[1].sheet, "Team's input");
  assert.equal(tokens[1].body, '$A$1:B');
  assert.equal(tokens[3].v, 'A2');
  assert.equal(shiftFormula(`=SUM('Team''s input'!$A$1:B, "A2")`, 1, 1), `=SUM('Team''s input'!$A$1:C, "A2")`);
  assert.equal(shiftFormula('=A1+$A1+A$1+$A$1', 2, 1), '=B3+$A3+B$1+$A$1');
});

test('formulas preserve precedence, short-circuiting, literal responses and error propagation', () => {
  const responses = { name: 'Form Responses', literal: true, cells: { A1: '=1+1', A2: '12.5%', B1: '21' } };
  const sheet = { name: 'Work', cells: { A1: '=2+3*4^2', A2: '=IF(FALSE,1/0,21)', A3: '=SUM(A1:A2)', A4: "='Form Responses'!A1", A5: "=SUM('Form Responses'!A:B)", B1: '=1/0', B2: '=SUM(B1:B1)', C1: '=C2', C2: '=C1', D1: '=1+' } };
  const calc = createEvaluator([sheet, responses]);
  assert.deepEqual(['A1', 'A2', 'A3', 'A4', 'A5'].map(address => calc.value(sheet, address)), [50, 21, 71, '=1+1', 21]);
  assert.deepEqual(['B1', 'B2', 'C1', 'C2', 'D1'].map(address => calc.value(sheet, address).code), ['#DIV/0!', '#DIV/0!', '#CYCLE!', '#CYCLE!', '#ERROR!']);
});

test('written reference errors survive formula parsing and propagate through ranges', () => {
  const sheet = { name: 'Work', cells: { A1: shiftFormula('=B7+A1', 0, -1), A2: '=SUM(A1:A1)', A3: '=IFERROR(A2,0)', A4: '="#REF!"', A5: '=1+#N/A' } };
  const calc = createEvaluator([sheet]);
  assert.equal(sheet.cells.A1, '=A7+#REF!');
  assert.equal(calc.value(sheet, 'A1').code, '#REF!');
  assert.equal(calc.value(sheet, 'A2').code, '#REF!');
  assert.equal(calc.value(sheet, 'A3'), 0);
  assert.equal(calc.value(sheet, 'A4'), '#REF!');
  assert.equal(calc.value(sheet, 'A5').code, '#N/A');
});

test('the public parser distinguishes literal input, invalid formulas and reference nodes', () => {
  for (const engine of [source, browser]) {
    assert.deepEqual(engine.parseInput("'=2+2"), { kind: 'value', value: '=2+2' });
    assert.deepEqual(engine.parseInput('=2+2', { literal: true }), { kind: 'value', value: '=2+2' });
    assert.deepEqual(engine.parseInput('='), { kind: 'value', value: '=' });
    assert.deepEqual(engine.parseInput('2024-02-29'), { kind: 'date', value: new Date('2024-02-29T00:00:00Z') });
    assert.deepEqual(engine.parseInput('2026-02-29'), { kind: 'value', value: '2026-02-29' });
    assert.deepEqual(engine.parseInput('12:00:00.500'), { kind: 'time', value: 43200.5 / 86400 });
    assert.deepEqual(engine.parseInput("'12:00"), { kind: 'value', value: '12:00' });
    assert.deepEqual(engine.parseInput('12:00', { literal: true }), { kind: 'value', value: '12:00' });
    assert.equal(engine.parseInput('=,').node.code, '#ERROR!');
    assert.deepEqual(engine.parseFormula("='Team''s input'!$A2:B"), {
      k: 'ref', sheet: "Team's input",
      from: { r: 1, c: 0, absR: false, absC: true },
      to: { r: null, c: 1, absR: false, absC: false }
    });
    const sheet = { name: 'Empty', cells: {} };
    const calc = engine.createEvaluator([sheet]);
    assert.equal(calc.value(sheet, 'a1'), '');
    assert.equal(calc.value(sheet, 'A0').code, '#REF!');
    assert.equal(calc.value(sheet, 'bad').code, '#REF!');
  }
});

// https://support.google.com/docs/table/25273?hl=en
test('core function examples agree in the TypeScript engine and browser build', () => {
  const examples = [
    ['SUM(A1:A4)', 16], ['AVERAGE(A1:A4)', 16 / 3], ['MIN(A1:A4)', 2], ['MAX(A1:A4)', 9],
    ['COUNT(A1:C4)', 6], ['COUNTA(A1:B4)', 6], ['COUNTBLANK(A1:A4)', 1], ['MEDIAN(A1:A4)', 5],
    ['PRODUCT(A1:A4)', 90], ['ROUND(1.255,2)', 1.26], ['ABS(-5)', 5], ['MOD(-3,2)', 1], ['POWER(3,2)', 9],
    ['COUNTIF(A1:A4,">4")', 2], ['SUMIF(B1:B3,"d*",A1:A3)', 11], ['AVERAGEIF(B1:B3,"done",A1:A3)', 5.5],
    ['COUNTIFS(B1:B3,"Done",A1:A3,">6")', 1], ['SUMIFS(A1:A3,B1:B3,"Done",A1:A3,">6")', 9],
    ['IFERROR(1/0,"fallback")', 'fallback'], ['IFERROR(1/0)', ''], ['IFNA(#N/A,"missing")', 'missing'],
    ['AND(TRUE,NOT(FALSE))', true], ['OR(FALSE,2>1)', true], ['CONCATENATE(LEFT(B1,2),RIGHT(B2,2))', 'Doen'],
    ['TRIM("  Team    A  ")', 'Team A'], ['SUBSTITUTE("A/B/A","A","C")', 'C/B/C'],
    ['INDEX(B1:C3,2,2)', 50], ['MATCH("Open",B1:B3,0)', 2], ['VLOOKUP("Open",B1:C3,2,FALSE)', 50]
  ];
  const sheet = { name: 'Examples', cells: { A1: '2', A2: '5', A3: '9', B1: 'Done', B2: 'Open', B3: 'Done', C1: '20', C2: '50', C3: '90',
    ...Object.fromEntries(examples.map(([formula], index) => [`E${index + 1}`, `=${formula}`])) } };
  for (const engine of [source, browser]) {
    const calc = engine.createEvaluator([sheet]);
    for (const [index, [formula, value]] of examples.entries()) {
      assert.equal(calc.value(sheet, `E${index + 1}`), value, formula);
    }
  }
});
