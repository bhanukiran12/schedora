import { fail } from '../http.mjs';
import { assertAuthoringOpen } from './freeze.mjs';
import { requireEntitlement } from '../billing/entitlements.mjs';
import { createForm, saveRouting } from './service.mjs';
import { createEventType } from '../meet/event-types.mjs';
import { can } from '../platform/workspaces.mjs';
import { createFromTemplate } from '../flow/templates.mjs';

export function createQualifyStarter(app,actor,input) {
  assertAuthoringOpen(app);
  requireEntitlement(app,actor.workspace.id,'forms');requireEntitlement(app,actor.workspace.id,'meet');
  if(typeof input.request_id!=='string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(input.request_id)) fail(400,'validation_failed','Use a valid request ID.');
  return app.db.transaction(()=>{
    const old=app.db.get('SELECT * FROM qualify_starters WHERE id=?',input.request_id);
    if(old) {
      if(old.workspace_id!==actor.workspace.id || old.user_id!==actor.userId || !old.form_id || !old.event_type_id) fail(409,'starter_conflict','Start a new qualification kit.');
      return {form_id:old.form_id,event_type_id:old.event_type_id,workflow_id:old.workflow_id,flow_id:old.flow_id ?? null,replay:true};
    }
    const suffix=input.request_id.replaceAll('-','').slice(-8).toLowerCase();
    const event=createEventType(app,actor.workspace.id,actor,{title:'Qualification call',slug:'qualification-call-'+suffix,kind:'round_robin',hosts:input.hosts ?? [{user_id:actor.userId}],timezone:actor.workspace.timezone || 'Asia/Kolkata',published:false,duration_min:30,min_notice_min:60});
    const form=createForm(app,actor.workspace.id,actor.userId,{definition:{title:'Tell us what you need',presentation:'classic',mode:'lead_qualification',lead_scoring:{warm:25,hot:50},fields:[
      {id:'name',type:'short_text',label:'Your name',required:true},
      {id:'email',type:'email',label:'Email for follow-up',required:true},
      {id:'need',type:'long_text',label:'What would you like help with?',required:true},
      {id:'timing',type:'single_choice',label:'When would you like to get started?',required:true,options:[{id:'now',label:'This month',lead_points:50},{id:'later',label:'I am exploring options',lead_points:5}]}
    ]}});
    saveRouting(app,actor.workspace.id,form.id,{routing:{rules:[{condition:{field:'timing',op:'equals',value:'now'},action:{type:'event',event_type_id:event.id}}],fallback:{type:'message',message:'Thank you. Our team will review your enquiry and follow up.'}}});
    // The follow-up is an inactive Flow draft (speed-to-lead) bound to this form and booking page. Nothing is
    // published or switched on. Members who cannot manage Flow get the form and event only.
    const flow=can(actor.role,'flows.manage') ? createFromTemplate(app,actor,{template:'speed_to_lead',name:'Qualification follow-up',bindings:{form:form.id,event_type:event.id}}) : null;
    app.db.run('INSERT INTO qualify_starters (id,workspace_id,user_id,form_id,event_type_id,workflow_id,flow_id,created_at) VALUES (?,?,?,?,?,NULL,?,?)',input.request_id,actor.workspace.id,actor.userId,form.id,event.id,flow?.id ?? null,app.now());
    return {form_id:form.id,event_type_id:event.id,workflow_id:null,flow_id:flow?.id ?? null,...(flow ? {} : {flow_note:'Ask a workspace admin to add the follow-up workflow in Flow.'}),replay:false};
  });
}
