// Shared server/browser evidence policy. Connection is not successful conflict coverage.
export const CALENDAR_STALE_MS = 3600000;
// Not an auth token: binds stored evidence to the event settings even when two saves share a millisecond.
export const hostEvidenceSignature = type => JSON.stringify([type.id, type.updated_at, type.kind, Boolean(type.use_host_schedules),
  type.hosts.map(host => host.user_id).sort(), type.locations.map(location => location.type).sort()]);
export function calendarEvidence(connections, now) {
  const result = (state, coverage = 'unknown') => ({ state, coverage });
  if (!connections.length) return result('not_connected', 'none');
  const statuses = new Set(connections.map(row => row.status));
  if ([...statuses].some(status => !['active', 'pending', 'error', 'revoked'].includes(status))) return result('not_verified');
  if (statuses.size > 1) return result('partial');
  const status = connections[0].status;
  if (status === 'revoked') return result('revoked', 'none');
  if (status === 'error') return result('failed');
  if (status === 'pending') return result('waiting');
  const fresh = connections.every(row => Number.isSafeInteger(row.last_success_at) && row.last_success_at > 0 && row.last_success_at <= now && now - row.last_success_at <= CALENDAR_STALE_MS);
  return fresh ? result('checked_recently', 'current') : result('not_verified');
}
