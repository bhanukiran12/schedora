import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, signUp, publishedEventType, idem } from './helpers.mjs';
async function fixture(env) {
 const owner=env.client(),{ws,user}=await signUp(owner,'Booking sheet owner'),event=await publishedEventType(owner,ws);
 const base=`/api/workspaces/${ws.id}`,pub=`/api/public/meet/${ws.slug}/${event.slug}`,slots=(await env.client().get(pub+'/slots')).body.slots;
 const booked=await env.client().post(pub+'/bookings',{name:'Invitee',email:'invitee@example.com',timezone:'UTC',start:slots[0]},idem());
 assert.equal(booked.status,201,JSON.stringify(booked.body));
 const workbook=(await owner.post(base+'/workbooks',{title:'Bookings analysis'})).body;
 return {owner,ws,user,event,base,pub,slots,booked:booked.body,route:base+'/workbooks/'+workbook.id};
}
test('booking sources stay live across reschedule/cancel without exposing capabilities',async()=>{
 const env=await setup();try{
 const f=await fixture(env),links=f.route+'/booking-links',grid=links+'/'+f.event.id;
 assert.equal((await f.owner.post(links,{source:f.event.id})).status,200);
 await f.owner.post(links,{source:f.event.id});assert.equal((await f.owner.get(links)).body.links.length,1);
 const linkedName=(await f.owner.get(links)).body.links[0].name;
 const sheet=(await f.owner.get(f.route)).body.sheets[0];
 const renamed=await f.owner.post(f.route+'/changes',{ops:[{op:'sheet-name',sheet:sheet.id,from:sheet.name,to:linkedName}]});
 assert.equal(renamed.body.conflicts.length,1,'editable tabs cannot shadow a live booking source name');

 const before=(await f.owner.get(grid)).body;assert.equal(before.rows.length,1);assert.equal(before.rows[0][2],'confirmed');
 assert.ok(!JSON.stringify(before).includes(f.booked.manage_token));
 const moved=await env.client().post('/api/public/bookings/'+f.booked.manage_token+'/reschedule',{start:f.slots[2],timezone:'UTC'});
 assert.equal(moved.status,200,JSON.stringify(moved.body));
 const after=(await f.owner.get(grid)).body;assert.equal(after.rows.length,2);assert.notEqual(after.signature,before.signature);
 assert.equal(after.rows.filter(row=>row[2]==='confirmed').length,1);assert.equal(new Set(after.rows.map(row=>row[1])).size,2);
 const canceled=await env.client().post('/api/public/bookings/'+moved.body.manage_token+'/cancel',{});assert.equal(canceled.status,200,JSON.stringify(canceled.body));
 assert.equal((await f.owner.get(grid)).body.rows.filter(row=>row[2]==='confirmed').length,0);
 }finally{await env.close();}
});
test('sharing an editable workbook does not broaden Meet booking access',async()=>{
 const env=await setup();try{
 const f=await fixture(env),member=env.client(),m=await signUp(member,'Ordinary member');
 await f.owner.post(f.base+'/members',{email:m.email,role:'member'});await f.owner.raw('PUT',f.route+'/access',{user:m.user.id,role:'editor'});
 assert.equal((await member.get(f.route)).status,200);assert.equal((await member.get(f.route+'/booking-links')).status,403);
 assert.equal((await member.post(f.route+'/booking-links',{source:f.event.id})).status,403);
 const stranger=env.client();await signUp(stranger,'Unrelated owner');assert.equal((await stranger.get(f.route+'/booking-links')).status,404);
 }finally{await env.close();}
});
test('no-show attendance is time-gated and optional recovery is idempotent and cancellable',async()=>{
 const env=await setup();try{
 const f=await fixture(env),path=f.base+'/bookings/'+f.booked.booking.id+'/attendance';
 assert.equal((await f.owner.post(path,{status:'no_show',notify:true})).status,409);env.clock.now=Date.parse(f.slots[0])+3600000;
 assert.equal((await f.owner.post(path,{status:'no_show'})).status,200);assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM emails WHERE kind='no_show'").n,0);
 assert.equal((await f.owner.post(path,{status:'no_show',notify:true})).status,200);await f.owner.post(path,{status:'no_show',notify:true});
 assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM emails WHERE kind='no_show'").n,1);
 assert.equal((await f.owner.get(f.base+'/bookings?scope=past')).body[0].attendance,'no_show');
 await f.owner.post(path,{status:'attended'});assert.equal(env.app.db.get("SELECT status FROM emails WHERE kind='no_show'").status,'canceled');
 await f.owner.post(path,{status:null});assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM booking_attendance').n,0);
 }finally{await env.close();}
});

test('qualification starter is private, atomic, retry-safe and honors the authoring freeze',async()=>{
 const env=await setup();try{
 const owner=env.client(),{ws}=await signUp(owner,'Starter owner'),base=`/api/workspaces/${ws.id}`,input={request_id:'qualification-kit-00000001'};
 const created=await owner.post(base+'/forms/qualify-starter',input);assert.equal(created.status,201,JSON.stringify(created.body));const kit=created.body;
 assert.equal((await owner.get(base+'/forms/'+kit.form_id)).body.published_version,null);
 assert.equal((await owner.get(base+'/event-types/'+kit.event_type_id)).body.published,false);
 // The follow-up is an inactive, unpublished Flow draft; no Meet email workflow is created.
 assert.equal(kit.workflow_id,null);
 const draft=(await owner.get(base+'/flow/workflows/'+kit.flow_id)).body;
 assert.equal(draft.state,'draft');assert.equal(draft.published_version,null);assert.equal(draft.status,'draft');
 assert.equal(draft.definition.trigger.source,kit.form_id);
 assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM meet_workflows').n,0);
 assert.equal((await owner.post(base+'/forms/qualify-starter',input)).body.form_id,kit.form_id);
 assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM qualify_starters').n,1);
 env.app.config.formsAuthoringFrozen=true;assert.equal((await owner.post(base+'/forms/qualify-starter',{request_id:'qualification-kit-00000002'})).status,423);
 assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM qualify_starters').n,1);
 }finally{await env.close();}
});

test('booking row actions restrict destinations, assign real contacts and deduplicate published link messages',async()=>{
 const env=await setup();try{
 const f=await fixture(env);await f.owner.post(f.route+'/booking-links',{source:f.event.id});
 const path=f.route+'/booking-links/'+f.event.id+'/actions';
 const form=(await f.owner.post(f.base+'/forms',{title:'Published wording'})).body;
 assert.equal((await f.owner.post(path,{booking_id:f.booked.booking.id,action:'send_form',target:form.id})).status,409);
 await f.owner.post(f.base+'/forms/'+form.id+'/publish');
 await f.owner.patch(f.base+'/forms/'+form.id,{definition:{title:'Private draft wording',presentation:'classic',fields:[{id:'q',type:'short_text',label:'Q'}]}});
 const action={booking_id:f.booked.booking.id,action:'send_form',target:form.id};
 const first=await f.owner.post(path,action);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.status,'queued');
 assert.equal((await f.owner.post(path,action)).body.status,'already_queued');
 const mail=env.app.db.get("SELECT subject FROM emails WHERE kind='sheet_row_link'");assert.equal(mail.subject,'Published wording');
 assert.equal((await f.owner.post(path,{booking_id:f.booked.booking.id,action:'assign_owner',target:f.user.id})).body.owner_id,f.user.id);
 assert.equal((await f.owner.post(path,{booking_id:f.booked.booking.id,action:'send_booking',target:'foreign-event'})).status,409);
 const member=env.client(),m=await signUp(member,'Viewer');await f.owner.post(f.base+'/members',{email:m.email,role:'admin'});await f.owner.raw('PUT',f.route+'/access',{user:m.user.id,role:'viewer'});
 assert.equal((await member.post(path,action)).status,403);
 }finally{await env.close();}
});
