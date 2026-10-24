import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { fail } from '../http.mjs';
import { invalid } from '../validate.mjs';
import { parseBusy } from './ics.mjs';

const MAX_BYTES = 3 * 1024 * 1024;
const SYNC_INTERVAL = 15 * 60000;

// Calendar provider: a private iCalendar (ICS) feed address. Google Calendar ("Secret address in
// iCal format"), Outlook ("Publish calendar → ICS") and Apple iCloud all provide one. The feed
// is read-only; busy periods suppress Meet slots. OAuth providers can be added as further adapters.

function isPrivateAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const lower = address.toLowerCase();
  return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80') || lower.startsWith('::ffff:');
}

export function validateFeedUrl(value) {
  let url;
  try { url = new URL(String(value).trim().replace(/^webcal:\/\//i, 'https://')); } catch { invalid('feed_url', 'Enter the full calendar address, starting with https:// or webcal://.'); }
  if (url.protocol !== 'https:') invalid('feed_url', 'Calendar addresses must use https or webcal.');
  if (url.username || url.password || url.port && url.port !== '443') invalid('feed_url', 'This calendar address is not supported.');
  if (url.href.length > 2000) invalid('feed_url', 'This calendar address is too long.');
  return url.href;
}

// Rejects URLs whose host resolves to a private, loopback or link-local address (SSRF protection).
export async function assertPublicHost(url, resolve = lookup) {
  const { hostname } = new URL(url);
  const addresses = isIP(hostname) ? [{ address: hostname }] : await resolve(hostname, { all: true });
  if (!addresses.length || addresses.some(entry => isPrivateAddress(entry.address))) throw Object.assign(new Error('That host is not reachable from Schedora.'), { permanent: true });
}

// Fetches a feed with SSRF protection: public HTTPS hosts only, no redirects to other hosts, size and time limits.
export async function fetchFeed(url, fetchImpl = fetch, resolve = lookup) {
  await assertPublicHost(url, resolve);
  const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { Accept: 'text/calendar' } });
  if ([401, 403, 404, 410].includes(response.status)) throw Object.assign(new Error(`Calendar access was revoked or the address changed (HTTP ${response.status}).`), { revoked: true });
  if (response.status >= 300 && response.status < 400) throw Object.assign(new Error('Calendar address redirects elsewhere. Copy the final address.'), { permanent: true });
  if (!response.ok) throw new Error(`Calendar provider returned HTTP ${response.status}.`);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) { reader.cancel(); throw Object.assign(new Error('Calendar feed is larger than 3 MB.'), { permanent: true }); }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.includes('BEGIN:VCALENDAR')) throw Object.assign(new Error('This address did not return an iCalendar feed.'), { permanent: true });
  return text;
}

const MAX_CALENDARS = 6;

export function listConnections(app, workspaceId, userId) {
  return app.db.all(`SELECT id, provider, label, status, last_synced_at, last_error, created_at,
      (SELECT COUNT(*) FROM busy_blocks b WHERE b.connection_id = c.id) AS busy_count
    FROM calendar_connections c WHERE workspace_id = ? AND user_id = ? ORDER BY created_at`, workspaceId, userId);
}

export function getConnection(app, workspaceId, userId) {
  return listConnections(app, workspaceId, userId)[0] || null;
}

// Adds an ICS feed; the same address again replaces the earlier connection.
export async function connectCalendar(app, workspaceId, userId, body) {
  const feedUrl = validateFeedUrl(body.feed_url);
  const label = typeof body.label === 'string' ? body.label.trim().slice(0, 60) : '';
  const id = randomUUID();
  app.db.transaction(() => {
    app.db.run("DELETE FROM calendar_connections WHERE workspace_id = ? AND user_id = ? AND provider = 'ics' AND feed_url = ?", workspaceId, userId, feedUrl);
    if (app.db.get('SELECT COUNT(*) AS count FROM calendar_connections WHERE workspace_id = ? AND user_id = ?', workspaceId, userId).count >= MAX_CALENDARS) {
      fail(409, 'limit_reached', `Connect up to ${MAX_CALENDARS} calendars.`);
    }
    app.db.run("INSERT INTO calendar_connections (id, workspace_id, user_id, provider, feed_url, label, status, created_at) VALUES (?, ?, ?, 'ics', ?, ?, 'pending', ?)",
      id, workspaceId, userId, feedUrl, label || new URL(feedUrl).hostname, app.now());
  });
  await syncConnection(app, id);
  return listConnections(app, workspaceId, userId).find(connection => connection.id === id);
}

export function disconnectCalendar(app, workspaceId, userId, connectionId) {
  const result = connectionId
    ? app.db.run('DELETE FROM calendar_connections WHERE id = ? AND workspace_id = ? AND user_id = ?', connectionId, workspaceId, userId)
    : app.db.run('DELETE FROM calendar_connections WHERE workspace_id = ? AND user_id = ?', workspaceId, userId);
  if (!result.changes) fail(404, 'not_found', 'No calendar is connected.');
}

export async function syncConnection(app, id) {
  const connection = app.db.get('SELECT * FROM calendar_connections WHERE id = ?', id);
  if (!connection) return;
  const now = app.now();
  try {
    const busy = connection.provider === 'ics'
      ? parseBusy(await app.fetchCalendar(connection.feed_url), { from: now - 86400000, to: now + 366 * 86400000 })
      : await app.oauthBusy(connection, { from: now - 86400000, to: now + 120 * 86400000 });
    app.db.transaction(() => {
      if (!app.db.get('SELECT 1 FROM calendar_connections WHERE id = ?', id)) return;
      app.db.run('DELETE FROM busy_blocks WHERE connection_id = ?', id);
      for (const period of busy.slice(0, 20000)) app.db.run('INSERT INTO busy_blocks (connection_id, host_id, starts_at, ends_at) VALUES (?, ?, ?, ?)', id, connection.user_id, period.starts_at, period.ends_at);
      app.db.run("UPDATE calendar_connections SET status = 'active', last_synced_at = ?, last_error = NULL WHERE id = ?", now, id);
    });
  } catch (error) {
    // Revoked access removes stale busy data and is surfaced to the host; transient errors keep the last good copy.
    const status = error.revoked ? 'revoked' : 'error';
    app.db.transaction(() => {
      if (error.revoked) app.db.run('DELETE FROM busy_blocks WHERE connection_id = ?', id);
      app.db.run('UPDATE calendar_connections SET status = ?, last_error = ?, last_synced_at = ? WHERE id = ?', status, String(error.message).slice(0, 300), now, id);
    });
  }
}

export async function syncDueCalendars(app) {
  const due = app.db.all("SELECT id FROM calendar_connections WHERE status IN ('active', 'error', 'pending') AND (last_synced_at IS NULL OR last_synced_at < ?) LIMIT 20", app.now() - SYNC_INTERVAL);
  for (const { id } of due) await syncConnection(app, id);
}
