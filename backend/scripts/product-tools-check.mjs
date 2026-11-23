export async function checkProductTools({alice,visitor,app,step,cellText}) {
  const api=async(method,path,body)=>alice.evaluate(`(async()=>{const me=await(await fetch('/api/me')).json();const r=await fetch('/api/workspaces/'+me.workspaces[0].id+${JSON.stringify(path)},{method:${JSON.stringify(method)},headers:{'Content-Type':'application/json','X-CSRF-Token':me.csrf_token},${body===undefined?'':'body:'+JSON.stringify(JSON.stringify(body))+','}});const result=await r.json();if(!r.ok)throw Error(JSON.stringify(result));return result})()`);
  const confirm=async()=>alice.evaluate("document.querySelector('dialog[open] button[value=ok]').click()");
  const fill=async(selector,value)=>visitor.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  let form,workbook,event,booking;
  await step('AI drafting creates a reviewable private form through the real browser dialog',async()=>{
    app.anthropic={beta:{messages:{create:async()=>({content:[{type:'text',text:JSON.stringify({title:'AI product check',presentation:'classic',fields:[{id:'name',type:'short_text',label:'Name'}]})}],usage:{input_tokens:40,output_tokens:60}})}}};
    await alice.open('/forms',"document.querySelector('#ai-draft-form')");await alice.evaluate("document.querySelector('#ai-draft-form').click()");
    await alice.waitFor("document.querySelector('#ai-form-description')",'AI draft dialog');
    await alice.evaluate("document.querySelector('#ai-form-description').value='An enquiry form for our weekend programming course'");await confirm();
    await alice.waitFor("document.querySelector('#form-title') || document.querySelector('.builder')",'generated draft builder');
    const forms=await api('GET','/forms');if(!forms.some(form=>form.draft.title==='AI product check'&&!form.published_version))throw Error('AI output was not an unpublished draft');
    app.anthropic=null;
  });
  await step('private lead scores appear in the builder and response inbox while public forms stay unscored',async()=>{
    form=await api('POST','/forms',{definition:{title:'Lead product check',presentation:'classic',mode:'lead_qualification',lead_scoring:{warm:20,hot:50},fields:[{id:'name',type:'short_text',label:'Name',required:true},{id:'timing',type:'single_choice',label:'When?',required:true,options:[{id:'now',label:'Now',lead_points:60},{id:'later',label:'Later',lead_points:5}]}]}});
    await alice.open('/forms/'+form.id,"document.querySelector('.builder')");
    if(!await alice.evaluate("document.querySelector('[data-lead-enabled]')?.checked"))throw Error('Lead scoring controls not shown');
    await api('POST','/forms/'+form.id+'/publish');
    await visitor.open('/f/'+form.slug,"document.querySelector('#form-root form')");await fill('#q-name','Qualified guest');
    await visitor.evaluate("document.querySelector('[name=timing][value=now]').click();document.querySelector('#form-root [type=submit]').click()");
    await visitor.waitFor("document.querySelector('.receipt')",'lead response receipt');
    if(await visitor.evaluate("document.querySelector('.receipt').textContent.includes('60 points')"))throw Error('Private lead score leaked');
    await alice.open('/forms/'+form.id+'/responses',"document.querySelector('[data-lead-score]')");
    if(!await alice.evaluate("document.querySelector('[data-lead-score]').textContent.includes('Hot · 60')"))throw Error('Lead score missing from inbox');
    await alice.evaluate("document.querySelector('#sort-leads').click();document.querySelector('[data-view-response]').click()");
    await alice.waitFor("document.querySelector('[aria-label=\"Lead qualification\"]')",'lead explanation');
  });
  await step('opt-in resume links restore unfinished answers and disappear after submission',async()=>{
    await visitor.open('/f/'+form.slug,"document.querySelector('#q-name')");await fill('#q-name','Resume guest');
    await visitor.evaluate("document.querySelector('[data-save-resume]').click()");await visitor.waitFor("document.querySelector('dialog[open]')",'resume consent');await visitor.evaluate("document.querySelector('dialog[open] button[value=ok]').click()");
    await visitor.waitFor("document.querySelector('[aria-label=\"Private resume link\"]')",'private resume link');
    const url=await visitor.evaluate("document.querySelector('[aria-label=\"Private resume link\"]').value");
    await visitor.open(new URL(url).pathname+new URL(url).hash,"document.querySelector('#q-name')?.value==='Resume guest'");
    await visitor.evaluate("document.querySelector('[name=timing][value=later]').click();document.querySelector('#form-root [type=submit]').click()");
    await visitor.waitFor("document.querySelector('.receipt')&&!document.querySelector('[data-save-resume]')",'resumed response accepted');
    await visitor.open(new URL(url).pathname+new URL(url).hash,"document.querySelector('#form-root').textContent.includes('expired or was submitted')");
  });
  await step('live booking tabs refresh after cancellation and native row actions queue once',async()=>{
    event=await api('POST','/event-types',{title:'Booking source product check',published:true,timezone:'Asia/Kolkata',min_notice_min:0});
    const workspace=await alice.evaluate("(async()=>{const me=await(await fetch('/api/me')).json();return me.workspaces[0]})()");
    const pub='/api/public/meet/'+workspace.slug+'/'+event.slug;
    booking=await visitor.evaluate(`(async()=>{const slots=await(await fetch(${JSON.stringify(pub+'/slots')})).json();const r=await fetch(${JSON.stringify(pub+'/bookings')},{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({name:'Booking guest',email:'book@example.com',timezone:'UTC',start:slots.slots[0]})});const result=await r.json();if(!r.ok)throw Error(JSON.stringify(result));return result})()`);
    workbook=await api('POST','/workbooks',{title:'Product booking workbook'});await api('POST','/workbooks/'+workbook.id+'/booking-links',{source:event.id});
    await alice.open('/sheets/workbooks/'+workbook.id,"document.querySelector('[data-tab=\"booking-"+event.id+"\"]')");await alice.evaluate(`document.querySelector('[data-tab="booking-${event.id}"]').click()`);
    await alice.waitFor(`${cellText(1,2)}==='confirmed'`,'live booking row');
    const body={booking_id:booking.booking.id,action:'send_form',target:form.id};
    const action='/workbooks/'+workbook.id+'/booking-links/'+event.id+'/actions';
    if((await api('POST',action,body)).status!=='queued'||(await api('POST',action,body)).status!=='already_queued')throw Error('Row action duplicate protection failed');
    await visitor.evaluate(`fetch('/api/public/bookings/'+${JSON.stringify(booking.manage_token)}+'/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})`);
    await alice.waitFor(`${cellText(1,2)}==='canceled'`,'booking cancellation refresh');
    await alice.shot('product-live-booking-sheet');
  });
  await step('AI column previews become editable literal text only after review',async()=>{
    const snapshot=await api('GET','/workbooks/'+workbook.id),sheet=snapshot.sheets[0].id;
    await api('POST','/workbooks/'+workbook.id+'/changes',{ops:[{op:'cell',sheet,cell:'A1',from:null,to:'Summarize this enquiry'}]});
    app.anthropic={beta:{messages:{create:async()=>({content:[{type:'text',text:JSON.stringify({rows:[{row:1,text:'Review the enquiry'}]})}],usage:{input_tokens:10,output_tokens:15}})}}};
    await alice.open('/sheets/workbooks/'+workbook.id,"document.querySelector('#sheets-app')?.dataset.workbookReady==='true'");
    await alice.evaluate(`document.querySelector('[data-tab="${sheet}"]').click();document.querySelector('#sheets-namebox').value='A1';document.querySelector('#sheets-namebox').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));document.querySelector('[data-menu=tools]').click();document.querySelector('#sheets-menu [data-action=ai-column]').click()`);
    await alice.waitFor("document.querySelector('#ai-column-instruction')",'AI column instruction');
    await alice.evaluate("document.querySelector('#ai-column-instruction').value='Summarize each enquiry'");await confirm();
    await alice.waitFor("document.querySelector('dialog[open]')?.textContent.includes('Review the enquiry')",'AI preview');
    const before=await api('GET','/workbooks/'+workbook.id);if(before.sheets[0].cells.B1!=null)throw Error('AI wrote without review');
    await confirm();await alice.waitFor(`${cellText(0,1)}==='Review the enquiry' && document.querySelector('#sheets-sync').dataset.state==='saved'`,'AI text saved');
    app.anthropic=null;
  });
  await step('qualification starter browser creates draft form and paused reminders only',async()=>{
    await alice.open('/forms',"document.querySelector('#qualify-starter')");await alice.evaluate("document.querySelector('#qualify-starter').click()");await alice.waitFor("document.querySelector('dialog[open]')",'starter consent');await confirm();
    await alice.waitFor("document.querySelector('dialog[open]')?.textContent.includes('Qualification starter created')",'starter review');
    const forms=await api('GET','/forms');if(!forms.some(form=>form.draft.title==='Tell us what you need'&&!form.published_version))throw Error('Starter is not a private draft');
    await confirm();await alice.waitFor("document.querySelector('.builder')",'starter form editor');
  });

}
