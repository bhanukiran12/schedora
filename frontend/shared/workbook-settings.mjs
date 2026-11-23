// Bounded spreadsheet settings shared by browser and server. Unknown keys never survive a save.
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const id=/^[a-f0-9]{32}$/;
const user=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const color=/^#[a-f0-9]{6}$/i;
export const safeSheetLink=value=>{
  if(typeof value!=='string'||value.length>2000)return false;
  try{const url=new URL(value);return ['https:','http:','mailto:'].includes(url.protocol)&&!url.username&&!url.password}catch{return false}
};
export function validRasterData(value) {
  if(typeof value!=='string'||value.length>180000)return false;
  if(!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value))return false;
  try {
    const bytes=Uint8Array.from(atob(value.slice(value.indexOf(',')+1)),character=>character.charCodeAt(0));
    if(bytes.length<45||![137,80,78,71,13,10,26,10].every((byte,index)=>bytes[index]===byte)||String.fromCharCode(...bytes.slice(12,16))!=='IHDR'||String.fromCharCode(...bytes.slice(-8,-4))!=='IEND')return false;
    const view=new DataView(bytes.buffer);const width=view.getUint32(16),height=view.getUint32(20);
    return width>0&&height>0&&width<=1000&&height<=1000;
  }catch{return false;}
}
const text=(value,max)=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u0008]/.test(value);
const bounds=item=>object(item)&&[item.r1,item.c1,item.r2,item.c2].every(Number.isInteger)&&item.r1>=0&&item.c1>=0&&item.r2>=item.r1&&item.c2>=item.c1&&item.r2<5000&&item.c2<52;
const cleanBounds=item=>({r1:item.r1,c1:item.c1,r2:item.r2,c2:item.c2});
export function normalizeSheetSettings(input={}) {
  if(!object(input)||JSON.stringify(input).length>300000)return undefined;
  const out={};
  for(const [key,value] of Object.entries(input)) {
    if(['hidden','starred','offline','suggestions','notifications'].includes(key)) {if(typeof value!=='boolean')return;out[key]=value}
    else if(key==='tabColor') {if(!color.test(value))return;out[key]=value.toLowerCase()}
    else if(['hiddenRows','hiddenColumns'].includes(key)) {
      const max=key==='hiddenRows'?5000:52;
      if(!Array.isArray(value)||value.length>=max||!value.every(n=>Number.isInteger(n)&&n>=0&&n<max))return;
      out[key]=[...new Set(value)].sort((a,b)=>a-b);
    } else if(key==='groups') {
      if(!Array.isArray(value)||value.length>100)return;
      out.groups=[];
      for(const group of value){if(!object(group)||!id.test(group.id)||!['row','column'].includes(group.axis)||![group.start,group.end].every(Number.isInteger)||group.start<0||group.end<group.start||group.end>=(group.axis==='row'?5000:52)||typeof group.collapsed!=='boolean')return;out.groups.push({id:group.id,axis:group.axis,start:group.start,end:group.end,collapsed:group.collapsed})}
    } else if(key==='protections') {
      if(!Array.isArray(value)||value.length>100)return;
      const ids=new Set();out.protections=[];
      for(const rule of value){
        if(!bounds(rule)||!id.test(rule.id)||ids.has(rule.id)||!user.test(rule.owner)||!['warn','restrict'].includes(rule.mode)||!text(rule.name,100)||!Array.isArray(rule.editors)||rule.editors.length>100||!rule.editors.every(item=>user.test(item)))return;
        ids.add(rule.id);out.protections.push({id:rule.id,...cleanBounds(rule),name:rule.name,mode:rule.mode,owner:rule.owner,editors:[...new Set(rule.editors)]});
      }
    } else if(key==='tables') {
      if(!Array.isArray(value)||value.length>30)return;out.tables=[];
      for(const table of value){if(!bounds(table)||!id.test(table.id)||!text(table.name,80)||!['green','blue','purple','gray'].includes(table.theme)||typeof table.header!=='boolean')return;out.tables.push({id:table.id,...cleanBounds(table),name:table.name,theme:table.theme,header:table.header})}
    } else if(key==='images') {
      if(!Array.isArray(value)||value.length>10)return;out.images=[];
      for(const image of value){if(!object(image)||!id.test(image.id)||!validRasterData(image.data)||!text(image.alt,300)||![image.row,image.column,image.width,image.height].every(Number.isInteger)||image.row<0||image.row>=5000||image.column<0||image.column>=52||image.width<20||image.width>1000||image.height<20||image.height>1000)return;out.images.push({id:image.id,data:image.data,alt:image.alt,row:image.row,column:image.column,width:image.width,height:image.height})}
    } else if(key==='filterViews') {
      if(!Array.isArray(value)||value.length>20)return;out.filterViews=[];
      for(const view of value){if(!object(view)||!id.test(view.id)||!text(view.name,80)||!Number.isInteger(view.row)||view.row<0||view.row>=5000||!object(view.rules)||Object.keys(view.rules).length>52)return;const rules={};for(const [column,rule] of Object.entries(view.rules)){if(!/^\d{1,2}$/.test(column)||Number(column)>=52||!object(rule)||!text(rule.contains??'',200)||!Array.isArray(rule.exclude??[])||(rule.exclude??[]).length>500||!(rule.exclude??[]).every(item=>text(item,5000)))return;rules[column]={contains:rule.contains??'',exclude:rule.exclude??[]}}out.filterViews.push({id:view.id,name:view.name,row:view.row,rules})}
    } else if(key==='namedFunctions') {
      if(!Array.isArray(value)||value.length>50)return;out.namedFunctions=[];
      for(const fn of value){if(!object(fn)||!/^[A-Z_][A-Z0-9_]{0,39}$/.test(fn.name)||!text(fn.description??'',300)||!text(fn.formula,5000)||!fn.formula.startsWith('=')||!Array.isArray(fn.args)||fn.args.length>20||new Set(fn.args).size!==fn.args.length||!fn.args.every(arg=>/^[A-Z_][A-Z0-9_]{0,39}$/.test(arg)))return;out.namedFunctions.push({name:fn.name,description:fn.description??'',formula:fn.formula,args:fn.args})}
    } else if(['macros','extensions'].includes(key)) {
      if(!Array.isArray(value)||value.length>20)return;out[key]=[];
      for(const entry of value){if(!object(entry)||!id.test(entry.id)||!text(entry.name,80)||!text(entry.code??'',20000)||!Array.isArray(entry.steps??[])||(entry.steps??[]).length>1000)return;const steps=[];for(const step of entry.steps??[]){if(!object(step)||!text(step.cell,8)||!text(step.value,5000)||!/^[A-Z]{1,2}[1-9]\d{0,3}$/.test(step.cell))return;steps.push({cell:step.cell,value:step.value})}out[key].push({id:entry.id,name:entry.name,code:entry.code??'',steps})}
    } else if(key==='versionNames') {if(!object(value)||Object.keys(value).length>25||!Object.entries(value).every(([revision,label])=>/^\d{1,12}$/.test(revision)&&text(label,80)))return;out[key]={...value}}
    else if(key==='locale') {if(!['en-IN','en-US','en-GB','de-DE','fr-FR'].includes(value))return;out[key]=value}
    else if(key==='timeZone') {if(!text(value,80))return;try{new Intl.DateTimeFormat('en',{timeZone:value}).format(0)}catch{return}out[key]=value}
    else return;
  }
  return Object.fromEntries(Object.entries(out).sort(([a],[b])=>a.localeCompare(b)));
}
