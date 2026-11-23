import { test } from 'node:test';
import assert from 'node:assert/strict';
import twilio from 'twilio';
import { createWhatsappProvider } from '../src/platform/twilio.mjs';
import { deliverEmail, queueEmail } from '../src/platform/email.mjs';
import { setup, signUp, publishedEventType, idem } from './helpers.mjs';
const config={whatsappProvider:'twilio',twilioAccountSid:'AC'+'a'.repeat(32),twilioAuthToken:'test-token',twilioWhatsappFrom:'whatsapp:+14155552671',twilioWhatsappContentSid:'HX'+'b'.repeat(32),twilioStatusCallback:'https://meet.example.com/api/messaging/twilio/status'};
test('Twilio WhatsApp sends only approved template variables with signed-status URL',async()=>{
 let captured;const provider=createWhatsappProvider(config,async(url,input)=>{captured={url,...input};return{ok:true,json:async()=>({sid:'SM'+'c'.repeat(32)})};});
 const variables={'1':'Guest','2':'Intro','3':'Monday 9 AM','4':'https://meet.example.com/change'};
 await provider.send({to:'+916309499278',body:JSON.stringify(variables)});
 const params=new URLSearchParams(captured.body);assert.equal(params.get('To'),'whatsapp:+916309499278');assert.equal(params.get('ContentSid'),config.twilioWhatsappContentSid);assert.equal(params.has('Body'),false);assert.equal(params.get('StatusCallback'),config.twilioStatusCallback);assert.deepEqual(JSON.parse(params.get('ContentVariables')),variables);
 await assert.rejects(()=>provider.send({to:'6309499278',body:JSON.stringify(variables)}),/recipient/);
 await assert.rejects(()=>provider.send({to:'+916309499278',body:JSON.stringify({...variables,'1':'Two\nlines'})}),/variables/);
});
test('WhatsApp workflows require invitee consent, survive rescheduling and cancel scheduled reminders',async()=>{
 const env=await setup({config});try{
 const owner=env.client(),{ws}=await signUp(owner,'WhatsApp host'),event=await publishedEventType(owner,ws),base=`/api/workspaces/${ws.id}`,pub=`/api/public/meet/${ws.slug}/${event.slug}`;
 const wf=await owner.post(base+'/workflows',{name:'WhatsApp reminder',event_type_id:event.id,trigger_type:'before_start',offset_min:60,channel:'whatsapp',recipient:'invitee',body:'Provider template'});assert.equal(wf.status,201,JSON.stringify(wf.body));
 const slots=(await env.client().get(pub+'/slots')).body.slots;
 const book=(start,consent)=>env.client().post(pub+'/bookings',{name:'Guest',email:'guest@example.com',phone:'+916309499278',timezone:'UTC',start,whatsapp_consent:consent},idem());
 const first=await book(slots[0],false);assert.equal(first.status,201);assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM emails WHERE channel='whatsapp'").n,0);
 const second=await book(slots[2],true);assert.equal(second.status,201,JSON.stringify(second.body));assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM emails WHERE channel='whatsapp'").n,1);
 const moved=await env.client().post('/api/public/bookings/'+second.body.manage_token+'/reschedule',{start:slots[4],timezone:'UTC'});assert.equal(moved.status,200,JSON.stringify(moved.body));
 assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM emails WHERE channel='whatsapp' AND status='scheduled'").n,1);
 assert.equal(env.app.db.get('SELECT whatsapp FROM booking_message_consent WHERE booking_id=?',moved.body.booking.id).whatsapp,1);
 await env.client().post('/api/public/bookings/'+moved.body.manage_token+'/cancel',{});assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM emails WHERE channel='whatsapp' AND status='scheduled'").n,0);
 }finally{await env.close();}
});
test('signed Twilio callbacks update SMS/WhatsApp delivery without accepting spoofed or regressive reports',async()=>{
 const env=await setup({config});try{
 const owner=env.client(),{ws}=await signUp(owner,'Delivery host');env.app.whatsappProvider={name:'twilio',send:async()=>({id:'SM'+'d'.repeat(32)})};
 const id=queueEmail(env.app,{workspaceId:ws.id,key:'wa-test-only',kind:'test',channel:'whatsapp',to:'+916309499278',subject:'',body:'{}'});assert.equal(await deliverEmail(env.app,id),'sent');
 const params={AccountSid:config.twilioAccountSid,MessageSid:'SM'+'d'.repeat(32),MessageStatus:'delivered',FutureField:'also signed'};
 const post=(body,sig)=>env.client().raw('POST','/api/messaging/twilio/status',new URLSearchParams(body).toString(),{'Content-Type':'application/x-www-form-urlencoded','X-Twilio-Signature':sig});
 assert.equal((await post(params,'bad')).status,401);
 const signed=body=>twilio.getExpectedTwilioSignature(config.twilioAuthToken,config.twilioStatusCallback,body);
 assert.equal((await post(params,signed(params))).body.result,'recorded');assert.equal((await post(params,signed(params))).body.result,'duplicate');
 const late={...params,MessageStatus:'sent'};await post(late,signed(late));assert.equal(env.app.db.get('SELECT delivery_status FROM emails WHERE id=?',id).delivery_status,'delivered');
 const forged={...params,MessageSid:'SM'+'e'.repeat(32)};assert.equal((await post(forged,signed(forged))).body.result,'unknown_message');
 }finally{await env.close();}
});
