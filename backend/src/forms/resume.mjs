import { createHash } from 'node:crypto';
import { fail } from '../http.mjs';
import { validateSubmission } from '../shared/forms-logic.mjs';

const DAY = 86400000;
const hash = key => {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) fail(400,'invalid_resume_key','Use the private resume link you saved.');
  return createHash('sha256').update(key).digest('hex');
};
export const resumeAvailable = form => form.access === 'public' && form.definition.mode !== 'knowledge_quiz' && !form.definition.url_params?.length && !form.definition.fields.some(field=>field.type==='file_upload');

export function resumeDraft(app,form,input,action='read') {
  if (!resumeAvailable(form)) fail(409,'resume_unavailable','Private resume links are not available for sign-in forms, quizzes, uploads or forms using link parameters.');
  const key = hash(input.key);
  return app.db.transaction(()=>{
    const old=app.db.get('SELECT * FROM form_resume_drafts WHERE token_hash=? AND form_id=?',key,form.id);
    if(action==='delete') { app.db.run('DELETE FROM form_resume_drafts WHERE token_hash=? AND form_id=?',key,form.id);return {removed:true}; }
    if(old && (old.expires_at<=app.now() || old.status!=='saved')) fail(410,'resume_expired','This saved draft expired or was submitted. Start a new response.');
    if(old && old.version!==form.published_version) fail(409,'resume_version_changed','This form changed. Start a new response and review its questions.');
    if(action==='read') {
      if(!old) fail(404,'not_found','Saved draft not found.');
      return {answers:JSON.parse(old.answers),version:old.version,expires_at:old.expires_at};
    }
    if(input.consent!==true) fail(400,'resume_consent','Choose to save your unfinished answers before creating a resume link.');
    if(input.version!==form.published_version) fail(409,'resume_version_changed','Reload and review the latest form before saving a draft.');
    if(!input.answers || typeof input.answers!=='object' || Array.isArray(input.answers)) fail(400,'validation_failed','Answers are missing.');
    const {answers,errors}=validateSubmission(form.definition,input.answers);
    // Required questions may be unfinished; every supplied answer must otherwise be valid.
    if(Object.keys(errors).some(id=>input.answers[id]!=null && input.answers[id]!=='')) fail(400,'validation_failed','Check your entered answers before saving a draft.');
    const serialized=JSON.stringify(answers);
    if(Buffer.byteLength(serialized)>16384) fail(413,'resume_limit','Saved drafts can contain up to 16 KB of answers.');
    if(!old && Number(app.db.get("SELECT COUNT(*) AS n FROM form_resume_drafts WHERE form_id=? AND status='saved' AND expires_at>?",form.id,app.now()).n)>=500) fail(429,'resume_capacity','Saved drafts are full for this form. You can still submit your response now.');
    const expires=old?.expires_at ?? app.now()+7*DAY;
    if(old) app.db.run('UPDATE form_resume_drafts SET answers=?,updated_at=? WHERE token_hash=?',serialized,app.now(),key);
    else app.db.run('INSERT INTO form_resume_drafts (token_hash,form_id,version,answers,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?)',key,form.id,form.published_version,serialized,app.now(),app.now(),expires);
    return {version:form.published_version,expires_at:expires};
  });
}

export function completeResumeDraft(app,formId,version,key) {
  if(key==null) return;
  const token=hash(key),draft=app.db.get('SELECT * FROM form_resume_drafts WHERE token_hash=? AND form_id=?',token,formId);
  if(!draft || draft.status!=='saved' || draft.expires_at<=app.now() || draft.version!==version) fail(409,'resume_expired','This saved draft expired or changed. Start a new response.');
  app.db.run("UPDATE form_resume_drafts SET status='submitted',answers='{}',updated_at=? WHERE token_hash=?",app.now(),token);
}

export function resumeMetrics(app,workspaceId,formId) {
  if(!app.db.get('SELECT 1 FROM forms WHERE id=? AND workspace_id=?',formId,workspaceId)) fail(404,'not_found','Form not found.');
  const rows=app.db.all('SELECT status,updated_at FROM form_resume_drafts WHERE form_id=? AND created_at>=?',formId,app.now()-30*DAY);
  return {period_days:30,opted_in_drafts:rows.length,submitted:rows.filter(row=>row.status==='submitted').length,inactive_24h:rows.filter(row=>row.status==='saved' && row.updated_at<app.now()-DAY).length,note:'Only people who explicitly saved a resume draft are counted. Inactive does not mean abandoned; other form visits are not tracked.'};
}
