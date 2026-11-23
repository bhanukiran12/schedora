// Range protection is enforced before every snapshot, operation batch and history restore write.
import { equal, parseAddress } from '../shared/workbook-ops.mjs';
import { fail } from '../http.mjs';
const inside=(rule,address)=>{const point=parseAddress(address);return point&&point.row>=rule.r1&&point.row<=rule.r2&&point.column>=rule.c1&&point.column<=rule.c2};
const deny=()=>fail(403,'protected_range','This change affects a protected range. Ask its owner for edit access.');
export function assertWorkbookProtections(before,after,{actor,administrator=false}={}) {
  const allowed=rule=>administrator||rule.owner===actor||rule.editors.includes(actor);
  const manage=rule=>administrator||rule.owner===actor;
  const previous=new Map(before.map(sheet=>[sheet.id,sheet]));
  for(const next of after) {
    const old=previous.get(next.id);
    const oldRules=old?.settings?.protections??[];
    const nextRules=next.settings?.protections??[];
    for(const rule of nextRules) {
      const prior=oldRules.find(item=>item.id===rule.id);
      if(!prior&&(rule.owner!==actor||oldRules.some(other=>other.mode==='restrict'&&!allowed(other)&&rule.r1<=other.r2&&rule.r2>=other.r1&&rule.c1<=other.c2&&rule.c2>=other.c1)))deny();
      if(prior&&!equal(prior,rule)&&(!manage(prior)||prior.owner!==rule.owner))deny();
    }
    for(const rule of oldRules)if(!nextRules.some(item=>item.id===rule.id)&&!manage(rule))deny();
  }
  for(const old of before) {
    const blocked=(old.settings?.protections??[]).filter(rule=>rule.mode==='restrict'&&!allowed(rule));
    if(!blocked.length)continue;
    const next=after.find(sheet=>sheet.id===old.id);
    if(!next||next.rows!==old.rows||next.columns!==old.columns||!equal(next.merges,old.merges))deny();
    for(const key of ['cells','formats'])for(const address of new Set([...Object.keys(old[key]),...Object.keys(next[key])])) {
      if(!equal(old[key][address],next[key][address])&&blocked.some(rule=>inside(rule,address)))deny();
    }
  }
}
