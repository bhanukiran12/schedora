import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fail } from '../http.mjs';
import { decryptJson, encryptJson } from './crypto.mjs';
import { locationDisplay } from '../meet/event-types.mjs';

// OAuth integrations: Google (Calendar + Meet), Microsoft 365 (Outlook calendar + Teams) and Zoom.
// Calendars supply busy times and receive each booking as an event; video providers create the
// meeting link. Tokens are encrypted at rest and refreshed automatically.

export const PROVIDERS = {
  google: {
    label: 'Google Calendar and Meet', calendar: true,
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy',
    extra: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' }
  },
  microsoft: {
    label: 'Microsoft 365 (Outlook, Teams)', calendar: true,
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'offline_access openid email User.Read Calendars.ReadWrite', extra: { prompt: 'select_account' }
  },
  zoom: {
    label: 'Zoom', calendar: false,
    authorize: 'https://zoom.us/oauth/authorize', token: 'https://zoom.us/oauth/token', scope: '', extra: {}, basicAuth: true
  }
};

const stateKey = config => createHmac('sha256', config.encryptionKey || 'schedora-development-only-key').update('oauth-state').digest();
const callbackUrl = (app, provider) => `${app.config.apiBaseUrl || app.config.baseUrl}/api/oauth/${provider}/callback`;

function signState(app, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', stateKey(app.config)).update(body).digest('base64url')}`;
}
function readState(app, state) {
  const [body, mac] = String(state || '').split('.');
  const expected = createHmac('sha256', stateKey(app.config)).update(body || '').digest('base64url');
  if (!body || !mac || mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) fail(400, 'invalid_state', 'This connection link is invalid. Start again.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (payload.exp < app.now()) fail(400, 'invalid_state', 'This connection link expired. Start again.');
  return payload;
}

function credentialsFor(app, provider) {
  const settings = app.config[provider];
  if (!settings?.clientId) fail(501, 'integration_not_configured', `${PROVIDERS[provider].label} is not set up on this server yet.`);
  return settings;
}

export function startOAuth(app, workspaceId, userId, provider) {
  if (!PROVIDERS[provider]) fail(404, 'not_found', 'Unknown integration.');
  const { clientId } = credentialsFor(app, provider);
  const info = PROVIDERS[provider];
  const state = signState(app, { ws: workspaceId, user: userId, provider, nonce: randomBytes(8).toString('hex'), exp: app.now() + 10 * 60000 });
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: callbackUrl(app, provider), response_type: 'code', state, ...info.extra });
  if (info.scope) params.set('scope', info.scope);
  return { url: `${info.authorize}?${params}` };
}

async function tokenRequest(app, provider, form) {
  const { clientId, clientSecret } = credentialsFor(app, provider);
  const info = PROVIDERS[provider];
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (info.basicAuth) headers.Authorization = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  else Object.assign(form, { client_id: clientId, client_secret: clientSecret });
  const response = await app.fetchProvider(info.token, { method: 'POST', headers, body: new URLSearchParams(form), signal: AbortSignal.timeout(15000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error_description || data.error || `Token request failed (${response.status})`), { revoked: data.error === 'invalid_grant' });
  return data;
}

async function accountEmail(app, provider, accessToken) {
  const url = { google: 'https://openidconnect.googleapis.com/v1/userinfo', microsoft: 'https://graph.microsoft.com/v1.0/me', zoom: 'https://api.zoom.us/v2/users/me' }[provider];
  const response = await app.fetchProvider(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10000) });
  const data = await response.json().catch(() => ({}));
  return data.email || data.mail || data.userPrincipalName || '';
}

// OAuth redirect target. The signed state names the workspace and user who started the flow, and
// the browser's session must belong to that same user.
export async function finishOAuth(app, provider, query, sessionUser) {
  if (query.get('error')) return { ok: false, message: 'The connection was not approved.' };
  const state = readState(app, query.get('state'));
  if (state.provider !== provider) fail(400, 'invalid_state', 'This connection link is invalid. Start again.');
  if (!sessionUser || sessionUser.id !== state.user) fail(403, 'forbidden', 'Sign in as the person who started this connection.');
  if (!app.db.get('SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ?', state.ws, state.user)) fail(404, 'not_found', 'Workspace not found.');
  const tokens = await tokenRequest(app, provider, { grant_type: 'authorization_code', code: query.get('code') || '', redirect_uri: callbackUrl(app, provider) });
  const account = await accountEmail(app, provider, tokens.access_token);
  const credentials = encryptJson(app.config, { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: app.now() + (tokens.expires_in || 3600) * 1000 });
  const now = app.now();
  app.db.transaction(() => {
    const existing = app.db.get('SELECT id FROM integrations WHERE workspace_id = ? AND user_id = ? AND provider = ?', state.ws, state.user, provider);
    const id = existing?.id || randomUUID();
    if (existing) app.db.run("UPDATE integrations SET account = ?, credentials = ?, status = 'active', last_error = NULL, updated_at = ? WHERE id = ?", account, credentials, now, id);
    else app.db.run("INSERT INTO integrations (id, workspace_id, user_id, provider, account, credentials, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)", id, state.ws, state.user, provider, account, credentials, now, now);
    if (PROVIDERS[provider].calendar && !app.db.get('SELECT 1 FROM calendar_connections WHERE integration_id = ?', id)) {
      app.db.run("INSERT INTO calendar_connections (id, workspace_id, user_id, provider, integration_id, label, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
        randomUUID(), state.ws, state.user, provider, id, account || PROVIDERS[provider].label, now);
    } else if (PROVIDERS[provider].calendar) {
      app.db.run("UPDATE calendar_connections SET status = 'pending' WHERE integration_id = ?", id);
    }
  });
  app.nudge?.();
  return { ok: true, provider, account };
}

export function disconnectIntegration(app, workspaceId, userId, provider) {
  if (!app.db.run('DELETE FROM integrations WHERE workspace_id = ? AND user_id = ? AND provider = ?', workspaceId, userId, provider).changes) fail(404, 'not_found', 'Not connected.');
}

// Returns a fresh access token, refreshing it when it is about to expire. A rejected refresh
// marks the integration revoked so the host is told to reconnect.
export async function accessToken(app, integrationId) {
  const row = app.db.get('SELECT * FROM integrations WHERE id = ?', integrationId);
  if (!row || row.status === 'revoked') throw Object.assign(new Error('Integration was disconnected or revoked.'), { revoked: true });
  const credentials = decryptJson(app.config, row.credentials);
  if (credentials.expires_at - 60000 > app.now()) return credentials.access_token;
  try {
    const tokens = await tokenRequest(app, row.provider, { grant_type: 'refresh_token', refresh_token: credentials.refresh_token });
    const next = { access_token: tokens.access_token, refresh_token: tokens.refresh_token || credentials.refresh_token, expires_at: app.now() + (tokens.expires_in || 3600) * 1000 };
    app.db.run("UPDATE integrations SET credentials = ?, status = 'active', last_error = NULL, updated_at = ? WHERE id = ?", encryptJson(app.config, next), app.now(), integrationId);
    return next.access_token;
  } catch (error) {
    app.db.run('UPDATE integrations SET status = ?, last_error = ?, updated_at = ? WHERE id = ?', error.revoked ? 'revoked' : 'error', String(error.message).slice(0, 300), app.now(), integrationId);
    throw error;
  }
}

async function api(app, integrationId, url, init = {}) {
  const token = await accessToken(app, integrationId);
  const response = await app.fetchProvider(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers }, signal: AbortSignal.timeout(15000) });
  if (response.status === 401 || response.status === 403) throw Object.assign(new Error(`Access was revoked (HTTP ${response.status}). Reconnect the integration.`), { revoked: true });
  if (response.status === 404 || response.status === 410) return { gone: true };
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
  return response.status === 204 ? {} : response.json();
}

// Busy periods for a connected OAuth calendar (used by calendar sync).
export async function oauthBusy(app, connection, { from, to }) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error('Invalid calendar sync interval.');
  const window = 30 * 86400000;
  if (to - from > window) {
    const periods = new Map();
    for (let start = from; start < to; start += window) {
      for (const period of await oauthBusy(app, connection, { from: start, to: Math.min(start + window, to) })) {
        periods.set(period.starts_at + ':' + period.ends_at, period);
      }
    }
    return [...periods.values()];
  }
  const timeMin = new Date(from).toISOString();
  const timeMax = new Date(to).toISOString();
  if (connection.provider === 'google') {
    const data = await api(app, connection.integration_id, 'https://www.googleapis.com/calendar/v3/freeBusy', { method: 'POST', body: JSON.stringify({ timeMin, timeMax, items: [{ id: 'primary' }] }) });
    const calendar = data.calendars?.primary;
    if (!calendar || calendar.errors?.length) throw new Error('Google could not return calendar availability. Check calendar access and reconnect if needed.');
    return (calendar.busy || []).map(period => ({ starts_at: Date.parse(period.start), ends_at: Date.parse(period.end) }));
  }
  const integration = app.db.get('SELECT account FROM integrations WHERE id = ?', connection.integration_id);
  const data = await api(app, connection.integration_id, 'https://graph.microsoft.com/v1.0/me/calendar/getSchedule', {
    method: 'POST', headers: { Prefer: 'outlook.timezone="UTC"' },
    body: JSON.stringify({ schedules: [integration.account], startTime: { dateTime: timeMin.slice(0, 19), timeZone: 'UTC' }, endTime: { dateTime: timeMax.slice(0, 19), timeZone: 'UTC' }, availabilityViewInterval: 30 })
  });
  return (data.value?.[0]?.scheduleItems || []).filter(item => item.status !== 'free' && item.status !== 'workingElsewhere')
    .map(item => ({ starts_at: Date.parse(item.start.dateTime + 'Z'), ends_at: Date.parse(item.end.dateTime + 'Z') }));
}

// ---- Calendar events and video links for booked meetings ------------------------------------

function hostIntegrations(app, workspaceId, hostId) {
  return Object.fromEntries(app.db.all("SELECT id, provider FROM integrations WHERE workspace_id = ? AND user_id = ? AND status = 'active'", workspaceId, hostId).map(row => [row.provider, row.id]));
}

async function createEvent(app, meeting, host, attendees, location, integrations) {
  const description = `Booked with Meet by Schedora.${location?.display ? '\nLocation: ' + location.display : ''}`;
  const result = { ref: null, videoUrl: null };
  if (location?.type === 'zoom' && integrations.zoom) {
    const zoom = await api(app, integrations.zoom, 'https://api.zoom.us/v2/users/me/meetings', {
      method: 'POST', body: JSON.stringify({ topic: meeting.title, type: 2, start_time: new Date(meeting.starts_at).toISOString(), duration: Math.round((meeting.ends_at - meeting.starts_at) / 60000), settings: { join_before_host: false, waiting_room: true } })
    });
    result.videoUrl = zoom.join_url || null;
  }
  const where = result.videoUrl || location?.display || '';
  if (integrations.google) {
    const meet = location?.type === 'google_meet' && !result.videoUrl;
    const event = await api(app, integrations.google, `https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none${meet ? '&conferenceDataVersion=1' : ''}`, {
      method: 'POST', body: JSON.stringify({
        summary: `${meeting.title}: ${attendees.map(attendee => attendee.invitee_name).join(', ')}`, description, location: where,
        start: { dateTime: new Date(meeting.starts_at).toISOString() }, end: { dateTime: new Date(meeting.ends_at).toISOString() },
        attendees: attendees.map(attendee => ({ email: attendee.invitee_email, displayName: attendee.invitee_name })),
        ...(meet ? { conferenceData: { createRequest: { requestId: meeting.id, conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : {})
      })
    });
    result.ref = `google:${event.id}`;
    if (meet) result.videoUrl = event.hangoutLink || event.conferenceData?.entryPoints?.find(point => point.entryPointType === 'video')?.uri || null;
  } else if (integrations.microsoft) {
    const teams = location?.type === 'teams' && !result.videoUrl;
    const event = await api(app, integrations.microsoft, 'https://graph.microsoft.com/v1.0/me/events', {
      method: 'POST', body: JSON.stringify({
        subject: `${meeting.title}: ${attendees.map(attendee => attendee.invitee_name).join(', ')}`, body: { contentType: 'text', content: description },
        start: { dateTime: new Date(meeting.starts_at).toISOString().slice(0, 19), timeZone: 'UTC' }, end: { dateTime: new Date(meeting.ends_at).toISOString().slice(0, 19), timeZone: 'UTC' },
        location: { displayName: where }, attendees: attendees.map(attendee => ({ emailAddress: { address: attendee.invitee_email, name: attendee.invitee_name }, type: 'required' })),
        ...(teams ? { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' } : {})
      })
    });
    result.ref = `microsoft:${event.id}`;
    if (teams) result.videoUrl = event.onlineMeeting?.joinUrl || null;
  }
  return result;
}

async function deleteEvent(app, ref, integrations) {
  const [provider, id] = ref.split(':');
  if (provider === 'google' && integrations.google) await api(app, integrations.google, `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}?sendUpdates=none`, { method: 'DELETE' });
  if (provider === 'microsoft' && integrations.microsoft) await api(app, integrations.microsoft, `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// Worker job: writes new meetings to hosts' connected calendars (creating Meet/Teams/Zoom links)
// and removes events of canceled meetings. Errors are recorded and retried on the next pass.
export async function syncMeetingCalendars(app, limit = 20) {
  const pending = app.db.all(`SELECT h.meeting_id, h.host_id, h.active, h.external_ref, m.workspace_id, m.starts_at, m.ends_at, m.status, e.title
    FROM meeting_hosts h JOIN meetings m ON m.id = h.meeting_id JOIN event_types e ON e.id = m.event_type_id
    WHERE ((h.active = 1 AND h.external_ref IS NULL AND m.ends_at > ?) OR (h.active = 0 AND h.external_ref LIKE '%:%'))
      AND EXISTS (SELECT 1 FROM integrations i WHERE i.workspace_id = m.workspace_id AND i.user_id = h.host_id AND i.status = 'active')
      AND (h.sync_error IS NULL OR m.created_at > ?)
    LIMIT ?`, app.now(), app.now() - 3600000, limit);
  for (const row of pending) {
    const integrations = hostIntegrations(app, row.workspace_id, row.host_id);
    try {
      if (row.active) {
        const attendees = app.db.all("SELECT invitee_name, invitee_email, location FROM bookings WHERE meeting_id = ? AND status <> 'canceled'", row.meeting_id);
        const stored = attendees[0]?.location ? JSON.parse(attendees[0].location) : null;
        const location = stored ? { ...stored, display: locationDisplay(stored) } : null;
        const result = await createEvent(app, { id: row.meeting_id, title: row.title, starts_at: row.starts_at, ends_at: row.ends_at }, row.host_id, attendees, location, integrations);
        app.db.run('UPDATE meeting_hosts SET external_ref = ?, sync_error = NULL WHERE meeting_id = ? AND host_id = ?', result.ref || 'none', row.meeting_id, row.host_id);
        if (result.videoUrl) app.db.run('UPDATE meetings SET video_url = coalesce(video_url, ?) WHERE id = ?', result.videoUrl, row.meeting_id);
      } else {
        await deleteEvent(app, row.external_ref, integrations);
        app.db.run("UPDATE meeting_hosts SET external_ref = 'deleted', sync_error = NULL WHERE meeting_id = ? AND host_id = ?", row.meeting_id, row.host_id);
      }
    } catch (error) {
      app.db.run('UPDATE meeting_hosts SET sync_error = ? WHERE meeting_id = ? AND host_id = ?', String(error.message).slice(0, 300), row.meeting_id, row.host_id);
    }
  }
  return pending.length;
}
