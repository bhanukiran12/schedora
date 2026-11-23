import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSheetSettings,safeSheetLink,validRasterData} from '../src/shared/workbook-settings.mjs';
import {blankSheet,normalizeFormat,applyOp,diffWorkbooks} from '../src/shared/workbook-ops.mjs';
import {createEvaluator,displayValue} from '../../frontend/js/sheet-formulas.mjs';
import {moveSheetAxis,deduplicateRange,randomizeRange,splitRangeText,shiftSheetMetadata,shiftSelectedCells,trimRange} from '../../frontend/js/sheet-extra-commands.mjs';
import {spreadsheetMenus,flattenMenuCommands} from '../../frontend/js/sheet-menu-model.mjs';
const id='a'.repeat(32);
const selected={r1:0,c1:0,r2:2,c2:1};

test('settings accept bounded safe values and reject unknown properties, executable links and duplicate arguments',()=>{
  assert.equal(safeSheetLink('javascript:alert(1)'),false);assert.equal(safeSheetLink('https://user:password@example.com'),false);assert.equal(safeSheetLink('https://example.com'),true);
  assert.equal(normalizeSheetSettings({unexpected:true}),undefined);
  assert.equal(normalizeSheetSettings({namedFunctions:[{name:'TWICE',args:['X','X'],formula:'=X*2'}]}),undefined);
  assert.equal(normalizeFormat({link:'javascript:alert(1)'}),undefined);
  assert.equal(validRasterData('data:image/svg+xml;base64,PHN2Zz4='),false);
  const safe=normalizeSheetSettings({hiddenRows:[3,1,3],groups:[{id,axis:'row',start:2,end:8,collapsed:false}]});assert.deepEqual(safe.hiddenRows,[1,3]);
  const format=normalizeFormat({size:36,rotation:-45,valign:'bottom',font:'Arial',currency:'USD',pattern:'#,##0.00'});assert.equal(format.size,36);assert.equal(format.rotation,-45);
  assert.equal(normalizeFormat({size:97}),undefined);
});

test('named functions evaluate caller arguments, survive metadata-only changes and reject recursion',()=>{
  const sheet=blankSheet(id,'Data');sheet.cells={A1:'7',B1:'=TWICE(A1)',C1:'=TWICE(B1)'};sheet.settings={namedFunctions:[{name:'TWICE',args:['VALUE'],formula:'=VALUE*2'}]};
  const engine=createEvaluator([sheet]);assert.equal(engine.value(sheet,'B1'),14);assert.equal(engine.value(sheet,'C1'),28);
  const changed=structuredClone(sheet);changed.settings.namedFunctions[0].formula='=VALUE*3';engine.update([changed],[]);assert.equal(engine.value(changed,'C1'),63);
  changed.settings.namedFunctions[0].formula='=TWICE(VALUE)';engine.update([changed],[]);assert.equal(displayValue(engine.value(changed,'B1')),'#CYCLE!');
});

test('custom formats distinguish month from minutes in a combined date and time',()=>{
  assert.equal(displayValue('2026-11-18T16:07:23Z',{pattern:'yyyy-mm-dd HH:mm:ss'}),'2026-11-18 16:07:23');
  assert.equal(displayValue(1250.5,{num:'currency',currency:'USD'}),'$1,250.50');
  assert.equal(displayValue(1250.5,{num:'number',locale:'de-DE'}),'1.250,50');
  assert.equal(displayValue('2026-11-18T16:07:23Z',{pattern:'yyyy-mm-dd HH:mm:ss',timeZone:'Asia/Kolkata'}),'2026-11-18 21:37:23');
  assert.equal(displayValue(-1250.5,{pattern:'#,##0.00;(#,##0.00)'}),'(1,250.50)');
});

test('cleanup keeps formulas relative when rows move and split refuses overwriting data',()=>{
  const sheet=blankSheet(id,'Data');sheet.cells={A1:' item ',B1:'1',A2:'same',B2:'=A2',A3:'same',B3:'=A3',A4:'last',B4:'=A4'};
  assert.equal(trimRange(sheet,{r1:0,c1:0,r2:0,c2:0}),1);
  assert.equal(deduplicateRange(sheet,{...selected,r2:3},{columns:[0]}),1);assert.equal(sheet.cells.A3,'last');assert.equal(sheet.cells.B3,'=A3');
  const randomized=blankSheet(id,'Random');randomized.cells={A1:'x',B1:'=A1',A2:'y',B2:'=A2'};randomizeRange(randomized,{...selected,r2:1},()=>0);assert.equal(randomized.cells.A1,'y');assert.equal(randomized.cells.B1,'=A1');
  const split=blankSheet(id,'Split');split.cells={A1:'one,two',B1:'keep'};assert.throws(()=>splitRangeText(split,{r1:0,c1:0,r2:0,c2:0},','),/overwrite/);assert.equal(split.cells.A1,'one,two');delete split.cells.B1;splitRangeText(split,{r1:0,c1:0,r2:0,c2:0},',');assert.equal(split.cells.B1,'two');
});

test('insert cells preserves incoming references and metadata follows structural edits',()=>{
  const sheet=blankSheet(id,'Data');sheet.cells={A1:'4',B1:'=A1'};shiftSelectedCells([sheet],id,{r1:0,c1:0,r2:0,c2:0},'row');assert.equal(sheet.cells.A2,'4');assert.equal(sheet.cells.B1,'=A2');
  sheet.settings={hiddenRows:[1,3],groups:[{id,axis:'row',start:1,end:4,collapsed:true}],protections:[{r1:1,c1:0,r2:3,c2:1}],images:[{row:2,column:1}],filterViews:[{row:1,rules:{0:{contains:'x',exclude:[]}}}]};shiftSheetMetadata(sheet,'row',2,1);assert.deepEqual(sheet.settings.hiddenRows,[1,4]);assert.equal(sheet.settings.groups[0].end,5);assert.equal(sheet.settings.protections[0].r2,4);assert.equal(sheet.settings.images[0].row,3);
});

test('settings edits use the same invertible operations as cell edits; menus cover the supplied vocabulary',()=>{
  const before=[blankSheet(id,'Data')],after=structuredClone(before);after[0].settings={hiddenRows:[1]};const ops=diffWorkbooks(before,after);assert.equal(ops[0].key,'settings');const replay=structuredClone(before);assert.equal(applyOp(replay,ops[0]),'applied');assert.deepEqual(replay,after);
  const menus=spreadsheetMenus();assert.deepEqual(Object.keys(menus),['file','edit','view','insert','format','data','tools','extensions','help']);const commands=flattenMenuCommands(menus);for(const action of ['paste-values','protected-ranges','named-functions','image-cell','image-over','drawing','split-text','record-video','script-editor','search-menus'])assert.ok(commands.some(command=>command.action===action),action);
});


test('moving rows preserves row contents, formats and references from other sheets',()=>{
  const sheet=blankSheet(id,'Data');sheet.cells={A1:'first',B1:'=A1',A2:'second',B2:'=A2',A3:'third'};sheet.formats={A2:{b:true}};
  const other=blankSheet('b'.repeat(32),'Summary');other.cells={A1:'=Data!$A$2'};
  moveSheetAxis([sheet,other],id,{r1:1,c1:0,r2:1,c2:1},'row',-1);
  assert.equal(sheet.cells.A1,'second');assert.equal(sheet.cells.A2,'first');assert.equal(sheet.cells.B1,'=A1');assert.equal(sheet.cells.B2,'=A2');assert.equal(other.cells.A1,'=Data!$A$1');assert.deepEqual(sheet.formats.A1,{b:true});
});
