import { test } from 'node:test';import assert from 'node:assert/strict';
import {setup,signUp} from './helpers.mjs';
test('AI columns are preview-only, use authoritative cells and keep executable text literal when applied',async()=>{
 const env=await setup();try{
 const owner=env.client(),{ws}=await signUp(owner,'AI sheet owner'),base=`/api/workspaces/${ws.id}/workbooks`,book=(await owner.post(base,{title:'AI analysis'})).body,path=base+'/'+book.id;
 const sheet=(await owner.get(path)).body.sheets[0].id;
 await owner.post(path+'/changes',{ops:[{op:'cell',sheet,cell:'A1',from:null,to:'Source text'}]});
 let calls=0;env.app.anthropic={beta:{messages:{create:async request=>{calls++;assert.match(request.messages[0].content,/Source text/);return{content:[{type:'text',text:JSON.stringify({rows:[{row:1,text:'=IMPORTDATA("https://example.com")'}]})}],usage:{input_tokens:20,output_tokens:10}};}}}};
 const body={sheet,r1:0,r2:0,c1:0,c2:0,instruction:'Summarize the row',request_id:'ai-column-request-00001'};
 const generated=await owner.post(path+'/ai-column',body);assert.equal(generated.status,200,JSON.stringify(generated.body));assert.equal((await owner.get(path)).body.sheets[0].cells.B1,undefined);
 const repeated=await owner.post(path+'/ai-column',body);assert.deepEqual(repeated.body,generated.body);assert.equal(calls,1);
 assert.equal(generated.body.ops[0].to[0],"'");
 assert.equal((await owner.post(path+'/changes',{ops:generated.body.ops})).body.applied,1);
 assert.equal((await owner.get(path)).body.sheets[0].cells.B1,"'=IMPORTDATA(\"https://example.com\")");
 assert.equal((await owner.post(path+'/ai-column',{...body,request_id:'ai-column-request-00002'})).status,409);
 }finally{await env.close();}
});
test('AI columns reject viewers, formulas, oversized selections and invalid model rows',async()=>{
 const env=await setup();try{
 const owner=env.client(),{ws}=await signUp(owner,'AI gate owner'),base=`/api/workspaces/${ws.id}`,book=(await owner.post(base+'/workbooks',{title:'AI gated'})).body,path=base+'/workbooks/'+book.id,sheet=(await owner.get(path)).body.sheets[0].id;
 const viewer=env.client(),member=await signUp(viewer,'AI viewer');await owner.post(base+'/members',{email:member.email,role:'member'});await owner.raw('PUT',path+'/access',{user:member.user.id,role:'viewer'});
 const body={sheet,r1:0,r2:0,c1:0,c2:0,instruction:'Summarize the row',request_id:'ai-column-request-00003'};
 assert.equal((await viewer.post(path+'/ai-column',body)).status,403);
 assert.equal((await owner.post(path+'/ai-column',{...body,r2:20})).status,400);
 await owner.post(path+'/changes',{ops:[{op:'cell',sheet,cell:'A1',from:null,to:'=1+1'}]});assert.equal((await owner.post(path+'/ai-column',body)).status,400);
 await owner.post(path+'/changes',{ops:[{op:'cell',sheet,cell:'A1',from:'=1+1',to:'Text'}]});
 env.app.anthropic={beta:{messages:{create:async()=>({content:[{type:'text',text:JSON.stringify({rows:[{row:7,text:'Wrong row'}]})}],usage:{input_tokens:10,output_tokens:10}})}}};
 assert.equal((await owner.post(path+'/ai-column',body)).status,502);assert.equal((await owner.get(path)).body.sheets[0].cells.B1,undefined);
 }finally{await env.close();}
});
