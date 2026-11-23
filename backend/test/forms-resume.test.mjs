import {test} from 'node:test';import assert from 'node:assert/strict';import {setup,signUp} from './helpers.mjs';
const definition={title:'Resume test',presentation:'classic',fields:[{id:'name',type:'short_text',label:'Name',required:true},{id:'email',type:'email',label:'Email',required:true}]};
async function fixture(env){const owner=env.client(),{ws}=await signUp(owner,'Resume owner'),base=`/api/workspaces/${ws.id}/forms`,form=(await owner.post(base,{definition})).body;await owner.post(base+'/'+form.id+'/publish');return{owner,ws,form,base,pub:'/api/public/forms/'+form.slug};}
test('resume drafts require opt-in, keep partial answers private, and clear answers after one accepted submission',async()=>{const env=await setup();try{
 const f=await fixture(env),key='a'.repeat(64),visitor=env.client();
 assert.equal((await visitor.post(f.pub+'/resume',{action:'save',key,version:1,answers:{name:'Partial'}})).status,400);
 const save=await visitor.post(f.pub+'/resume',{action:'save',consent:true,key,version:1,answers:{name:'Partial'}});assert.equal(save.status,200,JSON.stringify(save.body));
 assert.equal((await visitor.post(f.pub+'/resume',{action:'read',key})).body.answers.name,'Partial');
 assert.equal((await visitor.post(f.pub+'/resume',{action:'read',key:'b'.repeat(64)})).status,404);
 assert.ok(!JSON.stringify((await f.owner.get(f.base+'/'+f.form.id+'/responses')).body).includes('Partial'));
 const sent=await visitor.post(f.pub+'/responses',{resume_key:key,version:1,submission_id:'resume-test-000000001',answers:{name:'Completed',email:'guest@example.com'}});assert.equal(sent.status,201,JSON.stringify(sent.body));
 assert.equal(env.app.db.get('SELECT answers FROM form_resume_drafts').answers,'{}');
 assert.equal((await visitor.post(f.pub+'/resume',{action:'read',key})).status,410);
 const replay=await visitor.post(f.pub+'/responses',{resume_key:key,version:1,submission_id:'resume-test-000000001',answers:{name:'Completed',email:'guest@example.com'}});assert.equal(replay.status,200);
 const metrics=(await f.owner.get(f.base+'/'+f.form.id+'/resume-metrics')).body;assert.equal(metrics.opted_in_drafts,1);assert.equal(metrics.submitted,1);
 }finally{await env.close();}});
test('resume drafts enforce version/expiry, validate supplied values, delete safely, and label inactive counts honestly',async()=>{const env=await setup();try{
 const f=await fixture(env),visitor=env.client(),key='c'.repeat(64),post=body=>visitor.post(f.pub+'/resume',{key,...body});
 assert.equal((await post({action:'save',consent:true,version:1,answers:{email:'invalid'}})).status,400);
 assert.equal((await post({action:'save',consent:true,version:1,answers:{name:'Draft'}})).status,200);
 env.clock.now+=86400001;let metrics=(await f.owner.get(f.base+'/'+f.form.id+'/resume-metrics')).body;assert.equal(metrics.inactive_24h,1);assert.match(metrics.note,/does not mean abandoned/);
 await f.owner.post(f.base+'/'+f.form.id+'/publish');assert.equal((await post({action:'read'})).status,409);
 assert.equal((await post({action:'delete'})).status,200);assert.equal((await post({action:'read'})).status,404);
 assert.equal((await post({action:'save',consent:true,version:2,answers:{}})).status,200);env.clock.now+=7*86400000;
 assert.equal((await post({action:'read'})).status,410);
 }finally{await env.close();}});
