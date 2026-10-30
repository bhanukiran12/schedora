import { can, requireMember } from '../platform/workspaces.mjs';
import { getEventType, hostSchedule } from './event-types.mjs';
import { calendarEvidence, hostEvidenceSignature } from '../shared/meet-readiness-policy.mjs';

const PROVIDERS = { google_meet: 'google', zoom: 'zoom', teams: 'microsoft' };
const connectionState = status => ({ active: 'connected', revoked: 'revoked', error: 'failed' })[status] || (status ? 'not_verified' : 'not_connected');

// Stored setup evidence only. Explicit projection prevents private calendar/provider data export.
export function hostReadiness(app, workspaceId, eventTypeId, user) {
  return app.db.transaction(() => {
    const actor = { ...requireMember(app, user, workspaceId, 'meet.manage_own'), userId: user.id };
    const type = getEventType(app, workspaceId, eventTypeId, actor);
    const all = can(actor.role, 'meet.manage_all');
    const now = app.now();
    const members = new Set(app.db.all('SELECT user_id FROM memberships WHERE workspace_id = ?', workspaceId).map(row => row.user_id));
    const providers = [...new Set(type.locations.map(location => PROVIDERS[location.type]).filter(Boolean))];
    const hosts = type.hosts.map(host => {
      const identity = { user_id: host.user_id, name: host.name };
      if (!members.has(host.user_id)) return { ...identity, visibility: 'unavailable', calendar: null, meeting_links: null, schedule_source: null };
      if (!all && host.user_id !== user.id) return { ...identity, visibility: 'restricted', calendar: null, meeting_links: null, schedule_source: null };
      const calendars = app.db.all('SELECT status, last_success_at FROM calendar_connections WHERE workspace_id = ? AND user_id = ?', workspaceId, host.user_id);
      const integrations = app.db.all('SELECT provider, status FROM integrations WHERE workspace_id = ? AND user_id = ?', workspaceId, host.user_id);
      return {
        ...identity, visibility: 'summary', calendar: calendarEvidence(calendars, now),
        meeting_links: providers.map(provider => ({ provider, connection: connectionState(integrations.find(row => row.provider === provider)?.status), creation: 'not_verified' })),
        schedule_source: hostSchedule(app, type, host.user_id).source
      };
    });
    return { event_type_id: type.id, event_updated_at: type.updated_at, event_signature: hostEvidenceSignature(type), checked_at: now, scope: all ? 'all_hosts' : 'self_only', hosts };
  });
}
