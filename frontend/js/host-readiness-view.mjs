import { html } from './core.mjs';
import { hostEvidenceSignature } from '../shared/meet-readiness-policy.mjs';

const CALENDARS = {
  checked_recently: 'Optional: connected calendars were checked successfully within the last hour. Changes since then and unconnected calendars are not known.',
  not_connected: 'Optional: no calendar is connected. Other calendar events are not checked for conflicts.',
  waiting: 'Not verified: waiting for the first successful calendar check.',
  revoked: 'Optional: calendar access was revoked. Those calendars are no longer checked.',
  failed: 'Not verified: the latest calendar check failed. Recent conflict coverage is unknown.',
  partial: 'Not verified: some connected calendars need attention. Complete conflict coverage is unknown.',
  not_verified: 'Not verified: recent successful calendar checks are not recorded for every connection.'
};
const PROVIDERS = { google: 'Google Meet', zoom: 'Zoom', microsoft: 'Microsoft Teams' };
const CONNECTIONS = { connected: 'Connected; meeting-link creation has not been verified.', not_connected: 'Needs setup: not connected for this host.', revoked: 'Needs setup: connection access was revoked.', failed: 'Needs setup: the connection last failed.', not_verified: 'Not verified: connection status is unknown.' };

export function matchingHostEvidence(source, type) {
  if (!source?.ok) return false;
  const value = source.value;
  return value?.event_type_id === type.id && value.event_updated_at === type.updated_at && value.event_signature === hostEvidenceSignature(type) &&
    Array.isArray(value.hosts) && value.hosts.length === type.hosts.length &&
    type.hosts.every(host => value.hosts.some(row => row.user_id === host.user_id));
}

export function hostReadinessView(source, type, viewerId) {
  if (type.hosts.length < 2) return '';
  if (!matchingHostEvidence(source, type)) return html`<p class="hint" data-host-evidence-error>Team host setup is not verified: ${source?.ok ? 'the saved event changed during the check.' : 'the server summary could not be loaded.'} <button class="btn-link" type="button" data-recheck>Check again</button></p>`;
  const value = source.value;
  const checked = Number.isSafeInteger(value.checked_at) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value.checked_at)) : null;
  return html`<details class="readiness-area" data-host-readiness>
    <summary><span class="readiness-title">Host setup (${value.hosts.length})</span><span class="readiness-state">Stored evidence</span></summary>
    <p class="hint">${value.scope === 'all_hosts' ? 'Workspace owners and admins can see these setup summaries.' : 'You can see only your own setup.'} This does not test meeting links or reserve a time. Re-checking reads saved evidence; it does not sync calendars or change settings.</p>
    ${checked ? html`<p class="hint">Saved setup evidence read ${checked} (your time).</p>` : ''}
    <ul class="readiness-items">${value.hosts.map(host => html`<li data-state="${host.visibility === 'restricted' ? 'unverified' : 'fact'}"><div>
      <p><strong>${host.name}${host.user_id === viewerId ? ' (you)' : ''}</strong></p>
      ${host.visibility === 'unavailable' ? html`<p>Needs attention: this host is no longer a workspace member. Ask a workspace owner or admin to review the event's hosts. Their setup is not shown.</p>` : host.visibility === 'restricted' ? html`<p>Not verified: only this host and workspace admins can see their setup.</p>` : html`
        <p>${CALENDARS[host.calendar?.state] || CALENDARS.not_verified}</p>
        <p>${host.schedule_source === 'personal' ? 'Uses their saved personal schedule.' : 'Uses the event schedule as a fallback.'} Open times are checked separately in Availability.</p>
        ${(host.meeting_links || []).map(link => html`<p>${PROVIDERS[link.provider] || 'Meeting link'}: ${CONNECTIONS[link.connection] || CONNECTIONS.not_verified}</p>`)}
        ${host.user_id === viewerId ? html`<p><a href="/meet?tab=integrations">Manage your calendars and apps</a></p>` : html`<p class="hint">If setup needs attention, ask ${host.name} to check their own calendars and apps.</p>`}
      `}</div></li>`)}</ul>
  </details>`;
}
