import {cellAddress,columnLabel,columnIndex,parseAddress,LIMITS} from '../shared/workbook-ops.mjs';
import {rewriteReferences,shiftFormula} from './sheet-formulas.mjs';
import {moveWorkbookRange} from './sheet-commands.mjs';
export function shiftSelectedCells(sheets,id,selection,axis,remove=false) {
  const sheet=sheets.find(item=>item.id===id);if(!sheet)return false;
  if(sheet.merges.length)throw new Error('Unmerge cells before shifting part of a sheet.');
  const vertical=axis==='row', count=vertical?selection.r2-selection.r1+1:selection.c2-selection.c1+1;
  const from={r1:selection.r1,c1:selection.c1,r2:vertical?sheet.rows-1:selection.r2,c2:vertical?selection.c2:sheet.columns-1};
  if(remove){if(vertical)from.r1+=count;else from.c1+=count}
  else if((vertical?sheet.rows+count:sheet.columns+count)>(vertical?LIMITS.rows:LIMITS.columns))throw new Error('The shifted cells would exceed this sheet’s size limit.');
  if(from.r1>from.r2||from.c1>from.c2){for(let r=selection.r1;r<=selection.r2;r++)for(let c=selection.c1;c<=selection.c2;c++){delete sheet.cells[cellAddress(r,c)];delete sheet.formats[cellAddress(r,c)]}return true}
  return moveWorkbookRange(sheets,id,id,from,selection.r1+(vertical&&!remove?count:0),selection.c1+(!vertical&&!remove?count:0));
}
export function trimRange(sheet,range) {
  let count=0;
  for(let r=range.r1;r<=range.r2;r++)for(let c=range.c1;c<=range.c2;c++){const key=cellAddress(r,c),value=sheet.cells[key];if(value&&!value.startsWith('=')){const next=value.trim().replace(/[ \t]+/g,' ');if(next!==value){count++;if(next)sheet.cells[key]=next;else delete sheet.cells[key]}}}
  return count;
}
export function deduplicateRange(sheet,range,{header=false,columns,read}={}) {
  if(sheet.merges.length)throw new Error('Unmerge cells before removing duplicate rows.');
  const rows=[],seen=new Set();let removed=0;
  const keys=columns??Array.from({length:range.c2-range.c1+1},(_,index)=>range.c1+index);
  for(let row=range.r1;row<=range.r2;row++){
    const values=Array.from({length:range.c2-range.c1+1},(_,index)=>({row,value:sheet.cells[cellAddress(row,range.c1+index)],format:sheet.formats[cellAddress(row,range.c1+index)]}));
    const key=JSON.stringify(keys.map(column=>String(read?read(row,column):sheet.cells[cellAddress(row,column)]??'').toLowerCase()));
    if(!(header&&row===range.r1)&&seen.has(key)){removed++;continue}if(!(header&&row===range.r1))seen.add(key);rows.push({row,values});
  }
  for(let r=range.r1;r<=range.r2;r++)for(let c=range.c1;c<=range.c2;c++){
    const address=cellAddress(r,c),source=rows[r-range.r1],cell=source?.values[c-range.c1];
    if(cell?.value)sheet.cells[address]=shiftFormula(cell.value,r-cell.row,0);else delete sheet.cells[address];
    if(cell?.format)sheet.formats[address]=cell.format;else delete sheet.formats[address];
  }
  return removed;
}
export function splitRangeText(sheet,range,delimiter) {
  if(range.c1!==range.c2)throw new Error('Select one column to split.');
  if(!delimiter||delimiter.length>20)throw new Error('Enter a separator of 1–20 characters.');
  const plan=[];
  for(let r=range.r1;r<=range.r2;r++){
    const value=sheet.cells[cellAddress(r,range.c1)]??'';
    if(value.startsWith('='))throw new Error('Paste formulas as values before splitting them.');
    const values=value.split(delimiter);if(range.c1+values.length>LIMITS.columns)throw new Error('The split text would exceed the column limit.');
    values.forEach((part,index)=>{if(index&&sheet.cells[cellAddress(r,range.c1+index)])throw new Error('The split would overwrite a neighboring cell. Clear it first.');plan.push([cellAddress(r,range.c1+index),part])});
  }
  for(const [address,value]of plan){if(value)sheet.cells[address]=value;else delete sheet.cells[address];sheet.columns=Math.max(sheet.columns,parseAddress(address).column+1)}return plan.length;
}
export function rangeStatistics(sheet,range,read) {
  const values=[];const unique=new Set();let blank=0,text=0;
  for(let r=range.r1;r<=range.r2;r++)for(let c=range.c1;c<=range.c2;c++){const value=read?read(r,c):sheet.cells[cellAddress(r,c)];if(value==null||value===''){blank++;continue}unique.add(String(value));if(typeof value==='number'||/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value)){values.push(Number(value))}else{text++}}
  const sum=values.reduce((a,b)=>a+b,0);return {count:values.length+text,blank,unique:unique.size,numbers:values.length,text,sum,average:values.length?sum/values.length:null,min:values.length?Math.min(...values):null,max:values.length?Math.max(...values):null};
}
export function randomizeRange(sheet,range,random=Math.random) {
  if(sheet.merges.length)throw new Error('Unmerge cells before randomizing rows.');
  const rows=[];for(let r=range.r1;r<=range.r2;r++)rows.push(Array.from({length:range.c2-range.c1+1},(_,offset)=>{const address=cellAddress(r,range.c1+offset);return {row:r,value:sheet.cells[address],format:sheet.formats[address]}}));
  for(let i=rows.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[rows[i],rows[j]]=[rows[j],rows[i]]}
  rows.forEach((row,dr)=>row.forEach((cell,dc)=>{const address=cellAddress(range.r1+dr,range.c1+dc);if(cell.value)sheet.cells[address]=shiftFormula(cell.value,range.r1+dr-cell.row,0);else delete sheet.cells[address];if(cell.format)sheet.formats[address]=cell.format;else delete sheet.formats[address]}));
}

export function shiftSheetMetadata(sheet,axis,at,count){
  if(!sheet.settings)return;
  const rows=axis==='row',first=rows?'r1':'c1',last=rows?'r2':'c2';
  const point=n=>n<at?n:count<0&&n<at-count?null:n+count;
  const bounds=item=>{const start=point(item[first]),end=point(item[last]);if(start===null&&end===null)return null;const next={...item,[first]:start===null?at:start,[last]:end===null?at-1:end};return next[last]>=next[first]?next:null};
  const settings=sheet.settings;
  const key=rows?'hiddenRows':'hiddenColumns';if(settings[key])settings[key]=settings[key].map(point).filter(value=>value!==null);
  for(const key of ['protections','tables'])if(settings[key])settings[key]=settings[key].map(bounds).filter(Boolean);
  if(settings.groups)settings.groups=settings.groups.flatMap(group=>{if(group.axis!==(rows?'row':'column'))return[group];const next=bounds({[first]:group.start,[last]:group.end});return next?[{...group,start:next[first],end:next[last]}]:[]});
  if(settings.images)settings.images=settings.images.flatMap(image=>{const key=rows?'row':'column',next=point(image[key]);return next===null?[]:[{...image,[key]:next}]});
  if(rows&&settings.filterViews)settings.filterViews=settings.filterViews.flatMap(view=>{const row=point(view.row);return row===null?[]:[{...view,row}]});
  if(!rows&&settings.filterViews)settings.filterViews=settings.filterViews.map(view=>({...view,rules:Object.fromEntries(Object.entries(view.rules).flatMap(([column,value])=>{const next=point(Number(column));return next===null?[]:[[next,value]]}))}));
  for(const key of ['macros','extensions'])if(settings[key])settings[key]=settings[key].map(entry=>{const steps=entry.steps.flatMap(step=>{const address=parseAddress(step.cell),next=point(rows?address.row:address.column);return next===null?[]:[{...step,cell:cellAddress(rows?next:address.row,rows?address.column:next)}]});return {...entry,steps,code:JSON.stringify(steps,null,2)}});
}

// Reorder entire rows/columns as a permutation; incoming references follow moved cells.
export function moveSheetAxis(sheets,id,selection,axis,direction){
  const sheet=sheets.find(item=>item.id===id);if(!sheet)return false;
  const rows=axis==='row',start=rows?selection.r1:selection.c1,end=rows?selection.r2:selection.c2,max=rows?sheet.rows:sheet.columns;
  if(direction<0&&start===0||direction>0&&end===max-1)throw Error('The selection is already at the sheet edge.');
  if(sheet.merges.length)throw Error('Unmerge cells before moving rows or columns.');
  if(sheets.some(item=>item.reports?.some(report=>report.source===id)))throw Error('Remove saved reports that use this sheet before moving its rows or columns.');
  const count=end-start+1,neighbor=direction<0?start-1:end+1;
  const index=n=>n>=start&&n<=end?n+direction:n===neighbor?n-direction*count:n;
  const point=p=>({...p,...(rows&&p.r!==null?{r:index(p.r)}:!rows?{c:index(p.c)}:{})});
  const part=p=>(p.absC?'$':'')+columnLabel(p.c)+(p.r==null?'':(p.absR?'$':'')+(p.r+1));
  const formula=(value,home)=>rewriteReferences(value,ref=>{if((ref.sheet??home).toLowerCase()!==sheet.name.toLowerCase())return null;let a=point(ref.from),b=ref.to&&point(ref.to);if(b){const key=rows?'r':'c';if(a[key]!==null&&b[key]!==null&&a[key]>b[key])[a,b]=[{...a,[key]:b[key]},{...b,[key]:a[key]}]}return part(a)+(b?':'+part(b):'')});
  for(const key of ['cells','formats'])sheet[key]=Object.fromEntries(Object.entries(sheet[key]).map(([address,value])=>{const p=parseAddress(address);return[cellAddress(rows?index(p.row):p.row,rows?p.column:index(p.column)),value]}));
  const dim=rows?'heights':'widths';sheet[dim]=Object.fromEntries(Object.entries(sheet[dim]??{}).map(([key,value])=>[rows?index(Number(key)-1)+1:columnLabel(index(columnIndex(key))),value]));
  for(const item of sheets){for(const [address,value]of Object.entries(item.cells))if(value.startsWith('='))item.cells[address]=formula(value,item.name);if(item.settings?.namedFunctions)item.settings.namedFunctions=item.settings.namedFunctions.map(fn=>({...fn,formula:formula(fn.formula,item.name)}))}
  for(const [name,value]of Object.entries(sheet.names??{}))sheet.names[name]=formula('='+value,sheet.name).slice(1);
  const settings=sheet.settings??{};const hidden=rows?'hiddenRows':'hiddenColumns';if(settings[hidden])settings[hidden]=settings[hidden].map(index);
  for(const key of ['protections','tables'])if(settings[key])settings[key]=settings[key].map(region=>{const first=rows?'r1':'c1',last=rows?'r2':'c2';return{...region,[first]:Math.min(index(region[first]),index(region[last])),[last]:Math.max(index(region[first]),index(region[last]))}});
  if(settings.groups)settings.groups=settings.groups.map(group=>group.axis===axis?{...group,start:Math.min(index(group.start),index(group.end)),end:Math.max(index(group.start),index(group.end))}:group);
  if(settings.images)settings.images=settings.images.map(image=>({...image,[rows?'row':'column']:index(image[rows?'row':'column'])}));
  return true;
}
