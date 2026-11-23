import { fail } from '../http.mjs';
import { can } from '../platform/workspaces.mjs';
import { cancelPendingEmails, queueEmail } from '../platform/email.mjs';
import { loadEventType } from './bookings.mjs';
import { emitEvent } from '../flow/events.mjs';

export function setBookingAttendance(app, actor, bookingId, input) {
  if (![null, 'attended', 'no_show'].includes(input.status) || (input.notify != null && typeof input.notify !== 'boolean')) fail(400, 'validation_failed', 'Choose attended, no-show or clear attendance.');
  const result = app.db.transaction(() => {
    const booking = app.db.get('SELECT * FROM bookings WHERE id = ? AND workspace_id = ?', bookingId, actor.workspace.id);
    const host = booking && app.db.get('SELECT 1 FROM meeting_hosts WHERE meeting_id = ? AND host_id = ?', booking.meeting_id, actor.userId);
    if (!booking || booking.anonymized_at || (!host && !can(actor.role, 'meet.manage_all'))) fail(404, 'not_found', 'Appointment not found.');
    if (booking.status !== 'confirmed' || booking.ends_at > app.now()) fail(409, 'attendance_unavailable', 'Attendance can be recorded after a confirmed meeting ends.');
    if (input.status === null) app.db.run('DELETE FROM booking_attendance WHERE booking_id = ?', bookingId);
    else app.db.run('INSERT INTO booking_attendance (booking_id, status, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (booking_id) DO UPDATE SET status = excluded.status, updated_by = excluded.updated_by, updated_at = excluded.updated_at', bookingId, input.status, actor.userId, app.now());
    if (input.status !== 'no_show') cancelPendingEmails(app, bookingId, ['no_show']);
    // One event per booking, however often the no-show is set, cleared and set again.
    if (input.status === 'no_show') emitEvent(app, { id: `no_show:${bookingId}`, workspaceId: actor.workspace.id, type: 'meet.booking.no_show', subjectId: bookingId, sourceId: booking.event_type_id });
    let recovery = null;
    if (input.status === 'no_show' && input.notify) {
      const event = loadEventType(app, booking.event_type_id);
      const origin = app.config.productDomain ? `https://meet.${app.config.productDomain}` : app.config.baseUrl;
      const url = `${origin}/meet/${event.workspace_slug}/${event.slug}`;
      recovery = queueEmail(app, { workspaceId: actor.workspace.id, key: `no-show-rebook:${bookingId}`, kind: 'no_show', relatedId: bookingId, to: booking.invitee_email, subject: `Book another time: ${event.title}`, body: `Hi ${booking.invitee_name},\n\nWe missed you at ${event.title}. Choose another available time here:\n${url}\n\nIf you already spoke with your host, no action is needed.` });
    }
    return { booking_id: bookingId, status: input.status, ...(recovery ? { recovery_email: recovery } : {}) };
  });
  app.nudge?.();
  return result;
}
