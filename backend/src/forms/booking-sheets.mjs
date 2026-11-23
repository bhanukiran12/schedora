import { createHash } from 'node:crypto';
import { fail } from '../http.mjs';
import { can } from '../platform/workspaces.mjs';
import { standaloneWorkbook } from './workbook-access.mjs';
import { LIMITS } from '../shared/workbook-ops.mjs';
import { leadScore } from '../shared/forms-logic.mjs';
import { queueEmail } from '../platform/email.mjs';
import { updateContact } from '../platform/contacts.mjs';
import { audit } from '../platform/developer.mjs';

function authorize(app, actor, workbookId, edit = false) {
  standaloneWorkbook(app, actor, workbookId, edit ? 'edit' : 'read');
  // Existing Meet access limits ordinary members to their hosted meetings. A
  // shared workbook must not broaden that access to every invitee in an event.
  if (!can(actor.role, 'meet.manage_all')) fail(403, 'booking_sheet_permission', 'Live event booking sheets currently require workspace owner or admin access.');
}

function bookingSignature(app, workspaceId, eventId) {
  const rows = app.db.all(`SELECT b.id,b.status,b.starts_at,b.ends_at,b.payment_status,b.anonymized_at,a.status AS attendance,r.answers
    FROM bookings b LEFT JOIN booking_attendance a ON a.booking_id=b.id
    LEFT JOIN form_handoffs h ON h.booking_id=b.id LEFT JOIN responses r ON r.id=h.response_id
    WHERE b.workspace_id=? AND b.event_type_id=? ORDER BY b.created_at,b.id LIMIT ?`,workspaceId,eventId,LIMITS.rows-1);
  const total=Number(app.db.get('SELECT COUNT(*) AS count FROM bookings WHERE workspace_id=? AND event_type_id=?',workspaceId,eventId).count);
  return createHash('sha256').update(JSON.stringify({rows,total})).digest('hex');
}

export function bookingSheetLinks(app, actor, workbookId) {
  authorize(app, actor, workbookId);
  return {
    links: app.db.all('SELECT l.event_type_id AS source_id, l.name FROM workbook_booking_links l JOIN event_types e ON e.id=l.event_type_id WHERE l.workbook_id=? AND e.workspace_id=? ORDER BY l.created_at,l.event_type_id', workbookId, actor.workspace.id).map(link=>({...link,signature:bookingSignature(app,actor.workspace.id,link.source_id)})),
    event_types: app.db.all('SELECT id,title FROM event_types WHERE workspace_id=? ORDER BY title,id LIMIT 200', actor.workspace.id)
  };
}

export function setBookingSheetLink(app, actor, workbookId, eventTypeId, remove = false) {
  authorize(app, actor, workbookId, true);
  const event = app.db.get('SELECT title FROM event_types WHERE id=? AND workspace_id=?', eventTypeId, actor.workspace.id);
  if (!event) fail(404, 'not_found', 'Event type not found.');
  if (remove) { app.db.run('DELETE FROM workbook_booking_links WHERE workbook_id=? AND event_type_id=?', workbookId, eventTypeId); return { removed: true }; }
  const existing = app.db.get('SELECT name FROM workbook_booking_links WHERE workbook_id=? AND event_type_id=?', workbookId, eventTypeId);
  if (existing) return { source_id: eventTypeId, name: existing.name };
  const links = bookingSheetLinks(app, actor, workbookId).links;
  if (links.length >= 10) fail(409, 'booking_link_limit', 'Keep up to 10 live booking sources in a workbook.');
  const taken = new Set([...links.map(item => item.name), ...app.db.all('SELECT name FROM workbook_form_links WHERE workbook_id=?',workbookId).map(row=>row.name), ...JSON.parse(app.db.get('SELECT sheets FROM workbooks WHERE id=?', workbookId).sheets).map(item => item.name)].map(name => name.toLowerCase()));
  const base = 'Bookings · ' + event.title.replace(/[\u0000-\u001f[\]:*?/\\]/g, ' ').slice(0, 39);
  let name = base;
  for (let number = 2; taken.has(name.toLowerCase()); number++) name = `${base} (${number})`;
  app.db.run('INSERT INTO workbook_booking_links (workbook_id,event_type_id,name,created_at) VALUES (?,?,?,?)', workbookId, eventTypeId, name, app.now());
  return { source_id: eventTypeId, name };
}

export function bookingSheetGrid(app, actor, workbookId, eventTypeId) {
  authorize(app, actor, workbookId);
  const link = app.db.get('SELECT l.name FROM workbook_booking_links l JOIN event_types e ON e.id=l.event_type_id WHERE l.workbook_id=? AND l.event_type_id=? AND e.workspace_id=?', workbookId, eventTypeId, actor.workspace.id);
  if (!link) fail(404, 'not_found', 'Booking sheet source not found.');
  const bookings = app.db.all(`SELECT b.*,e.title,a.status AS attendance,
    (SELECT h.response_id FROM form_handoffs h WHERE h.booking_id=b.id ORDER BY h.response_id LIMIT 1) AS response_id
    FROM bookings b JOIN event_types e ON e.id=b.event_type_id LEFT JOIN booking_attendance a ON a.booking_id=b.id
    WHERE b.workspace_id=? AND b.event_type_id=? ORDER BY b.created_at,b.id LIMIT ?`, actor.workspace.id, eventTypeId, LIMITS.rows - 1);
  const stamp = value => new Date(value).toISOString();
  const header = ['Booked at (UTC)','Reference','Booking status','Starts (UTC)','Ends (UTC)','Invitee','Email','Phone','Event','Payment','Attendance','Form response','Lead score','Lead priority'];
  const rows = bookings.map(booking => {
    let qualification = null;
    if (booking.response_id) {
      const source = app.db.get('SELECT r.answers,v.definition FROM responses r JOIN form_versions v ON v.form_id=r.form_id AND v.version=r.form_version WHERE r.id=? AND r.workspace_id=?', booking.response_id, actor.workspace.id);
      if (source) qualification = leadScore(JSON.parse(source.definition), JSON.parse(source.answers));
    }
    return [stamp(booking.created_at),booking.reference,booking.status,stamp(booking.starts_at),stamp(booking.ends_at),booking.invitee_name,booking.invitee_email,booking.invitee_phone || '',booking.title,booking.payment_status,booking.attendance || '',booking.response_id || '',qualification?.score ?? '',qualification?.band ?? ''].map(value => String(value).slice(0,LIMITS.cellLength));
  });
  const total = Number(app.db.get('SELECT COUNT(*) AS count FROM bookings WHERE workspace_id=? AND event_type_id=?', actor.workspace.id, eventTypeId).count);
  const payload = JSON.stringify({ header, rows, row_ids:bookings.map(row=>row.id) });
  if (Buffer.byteLength(payload) > LIMITS.bytes) fail(413, 'booking_source_limit', 'This booking source exceeds the current workbook data limit.');
  return { name:link.name,header,rows,row_ids:bookings.map(row=>row.id),total,truncated:total>rows.length,questions:header.length,fixed:header.length,live:true,kind:'bookings',signature:bookingSignature(app,actor.workspace.id,eventTypeId) };
}

export function bookingRowAction(app,actor,workbookId,eventTypeId,input) {
  authorize(app,actor,workbookId,true);
  return app.db.transaction(()=>{
    if(!app.db.get('SELECT 1 FROM workbook_booking_links WHERE workbook_id=? AND event_type_id=?',workbookId,eventTypeId)) fail(404,'not_found','Booking source not found.');
    const booking=app.db.get('SELECT * FROM bookings WHERE id=? AND workspace_id=? AND event_type_id=?',String(input.booking_id || ''),actor.workspace.id,eventTypeId);
    if(!booking || booking.anonymized_at) fail(404,'not_found','Booking contact is not available.');
    if(input.action==='assign_owner') {
      if(!booking.contact_id) fail(409,'contact_unavailable','This booking does not have a contact.');
      const contact=updateContact(app,actor.workspace.id,booking.contact_id,{owner_id:input.target});
      audit(app,actor.workspace.id,actor.userId,'sheets.contact.owner',booking.contact_id);
      return {status:'assigned',owner_id:contact.owner_id};
    }
    let url,title;
    if(input.action==='send_form') {
      const form=app.db.get('SELECT f.slug,v.definition FROM forms f JOIN form_versions v ON v.form_id=f.id AND v.version=f.published_version WHERE f.id=? AND f.workspace_id=? AND f.published_version IS NOT NULL',String(input.target || ''),actor.workspace.id);
      if(!form) fail(409,'form_unavailable','Choose a published form in this workspace.');
      title=JSON.parse(form.definition).title;url=(app.config.productDomain ? 'https://forms.'+app.config.productDomain : app.config.baseUrl)+'/f/'+form.slug;
    } else if(input.action==='send_booking') {
      const event=app.db.get('SELECT e.slug,e.title,w.slug AS workspace_slug FROM event_types e JOIN workspaces w ON w.id=e.workspace_id WHERE e.id=? AND e.workspace_id=? AND e.published=1 AND (e.expires_at IS NULL OR e.expires_at>?)',String(input.target || ''),actor.workspace.id,app.now());
      if(!event) fail(409,'event_unavailable','Choose a published booking page in this workspace.');
      title=event.title;url=(app.config.productDomain ? 'https://meet.'+app.config.productDomain : app.config.baseUrl)+'/meet/'+event.workspace_slug+'/'+event.slug;
    } else fail(400,'validation_failed','Choose send form, send booking page or assign owner.');
    // One identical link per booking per UTC day, across retries and editors.
    const key=`sheet-row:${booking.id}:${input.action}:${input.target}:${Math.floor(app.now()/86400000)}`;
    const old=app.db.get('SELECT id FROM emails WHERE idempotency_key=?',key);
    const id=queueEmail(app,{workspaceId:actor.workspace.id,key,kind:'sheet_row_link',relatedId:booking.id,to:booking.invitee_email,subject:title,body:`Hi ${booking.invitee_name},\n\nYour host shared ${title}:\n${url}\n\nNo action is taken until you open the link.`});
    if(!old) audit(app,actor.workspace.id,actor.userId,'sheets.'+input.action,booking.id);
    app.nudge?.();
    return {status:old?'already_queued':'queued',message_id:id,transport:app.emailProvider.name,to:booking.invitee_email};
  });
}
