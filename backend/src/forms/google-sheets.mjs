import { createHash, randomUUID } from 'node:crypto';
import { fail } from '../http.mjs';
import { can } from '../platform/workspaces.mjs';
import { accessToken, startOAuth } from '../platform/oauth.mjs';
import { responseGrid } from './workbooks.mjs';
import { nextStepSummary } from './service.mjs';

// One-way Google Sheets sync for Forms (docs/FORMS.md, "Google Sheets sync").
//
// - Connection: a separate Google OAuth connection (provider google_sheets, drive.file scope only) owned by
//   the member who sets up the sync. It never reuses or widens the calendar connection.
// - Destination: a new spreadsheet, or one this connection can already open (drive.file only lists files
//   Schedora created or the person opened with it). Schedora always writes to a new tab it creates, so an
//   existing tab is never overwritten.
// - Rows: column A holds the Schedora response ID. Each pass reads column A, updates rows whose content
//   changed, appends responses that are not there yet and blanks responses deleted in Schedora. Because
//   rows are found by ID, an interrupted append is updated (not duplicated) on the next pass, and sorting
//   the tab in Google does not break the mapping.
// - Values: written with valueInputOption=RAW, so answers such as "=IMPORTXML(...)" stay text and are never
//   evaluated as formulas in Google Sheets.
// - Failures: rate limits and server errors back off (honouring Retry-After); revoked or expired access
//   asks the owner to reconnect; a missing or inaccessible spreadsheet stops the sync with an explanation.
// - Two-way sync is not offered: edits made in Google are overwritten when that response next changes.

const MINUTE = 60000;
const POLL_MS = MINUTE;
const MAX_WRITES = 500;
const MAX_ATTEMPTS = 8;
const ID_HEADER = 'Schedora response ID';
const DELETED = 'Deleted in Schedora';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const backoff = attempts => Math.min(60 * MINUTE, 30000 * 2 ** Math.max(0, attempts - 1));

export const sheetsSyncAvailable = app => Boolean(app.config.googleSheets?.enabled && app.config.googleSheets.clientId && app.config.googleSheets.clientSecret);

/** Only a form's own Responses page may be the OAuth return address. */
export const sheetsReturn = value => typeof value === 'string' && /^\/forms\/[0-9a-f-]{36}\/responses$/.test(value) ? value : null;

class GoogleError extends Error {
  constructor(message, { status = 0, retryAfter = null, kind = 'transient' } = {}) { super(message); Object.assign(this, { status, retryAfter, kind }); }
}

async function google(app, integrationId, url, init = {}) {
  let token;
  try { token = await accessToken(app, integrationId); }
  catch (error) { throw new GoogleError(error.revoked ? 'Google access was revoked or expired. Reconnect Google Sheets.' : 'Google could not refresh access right now.', { kind: error.revoked ? 'reconnect' : 'transient' }); }
  let response;
  try { response = await app.fetchProvider(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers }, signal: AbortSignal.timeout(20000) }); }
  catch { throw new GoogleError('Google Sheets could not be reached.'); }
  const data = await response.json().catch(() => ({}));
  if (response.ok) return data;
  const retryAfter = Number(response.headers?.get?.('retry-after')) || null;
  if (response.status === 401) throw new GoogleError('Google access was revoked or expired. Reconnect Google Sheets.', { status: 401, kind: 'reconnect' });
  if (response.status === 403 && /rate|quota/i.test(JSON.stringify(data.error || ''))) throw new GoogleError('Google Sheets rate limit reached; retrying later.', { status: 403, retryAfter });
  if (response.status === 403) throw new GoogleError('This Google account can no longer edit the spreadsheet.', { status: 403, kind: 'destination' });
  if (response.status === 404) throw new GoogleError('The spreadsheet or tab was deleted, or this connection can no longer open it.', { status: 404, kind: 'destination' });
  if (response.status === 429) throw new GoogleError('Google Sheets rate limit reached; retrying later.', { status: 429, retryAfter });
  if (response.status === 400) throw new GoogleError('Google Sheets refused the update (' + String(data.error?.message || 'bad request').slice(0, 120) + ').', { status: 400, kind: 'destination' });
  throw new GoogleError(`Google Sheets returned HTTP ${response.status}; retrying later.`, { status: response.status, retryAfter });
}

const range = (title, cells) => `'${title.replace(/'/g, "''")}'!${cells}`;
const connectionFor = (app, workspaceId, userId) => app.db.get("SELECT id, account, status, last_error, updated_at FROM integrations WHERE workspace_id = ? AND user_id = ? AND provider = 'google_sheets'", workspaceId, userId);

function assertForm(app, workspaceId, formId) {
  const form = app.db.get('SELECT id, slug, draft FROM forms WHERE id = ? AND workspace_id = ?', formId, workspaceId);
  if (!form) fail(404, 'not_found', 'Form not found.');
  return form;
}

function present(app, sync, actor) {
  if (!sync) return null;
  const owner = app.db.get('SELECT name, email FROM users WHERE id = ?', sync.created_by);
  return {
    id: sync.id, status: sync.status, spreadsheet: { id: sync.spreadsheet_id, title: sync.spreadsheet_title, url: sync.spreadsheet_url }, tab: sync.sheet_title,
    synced_rows: sync.synced_rows, pending_rows: sync.pending_rows, last_synced_at: sync.last_synced_at, last_error: sync.last_error, next_attempt_at: sync.next_attempt_at,
    owner: { name: owner?.name || 'A former member', yours: sync.created_by === actor.userId }, can_stop: sync.created_by === actor.userId || can(actor.role, 'integrations.manage')
  };
}

export function sheetsSyncStatus(app, actor, formId) {
  assertForm(app, actor.workspace.id, formId);
  const connection = connectionFor(app, actor.workspace.id, actor.userId);
  const sync = app.db.get('SELECT * FROM form_google_syncs WHERE form_id = ? AND workspace_id = ?', formId, actor.workspace.id);
  return {
    available: sheetsSyncAvailable(app),
    connection: connection ? { account: connection.account, status: connection.status, error: connection.last_error } : null,
    sync: present(app, sync, actor)
  };
}

export function startSheetsConnection(app, actor, formId) {
  if (!sheetsSyncAvailable(app)) fail(501, 'integration_not_configured', 'Google Sheets sync is not set up on this server.');
  assertForm(app, actor.workspace.id, formId);
  return startOAuth(app, actor.workspace.id, actor.userId, 'google_sheets', { returnTo: `/forms/${formId}/responses` });
}

function activeConnection(app, actor) {
  if (!sheetsSyncAvailable(app)) fail(501, 'integration_not_configured', 'Google Sheets sync is not set up on this server.');
  const connection = connectionFor(app, actor.workspace.id, actor.userId);
  if (!connection) fail(409, 'sheets_not_connected', 'Connect Google Sheets first.');
  if (connection.status === 'revoked') fail(409, 'sheets_reconnect', 'Google access was revoked or expired. Reconnect Google Sheets.');
  return connection;
}

const asHttp = error => error instanceof GoogleError ? fail(error.kind === 'reconnect' ? 409 : 502, error.kind === 'reconnect' ? 'sheets_reconnect' : 'sheets_error', error.message) : (() => { throw error; })();

/** Spreadsheets this connection can open: with drive.file, only ones Schedora created or the person chose. */
export async function sheetsDestinations(app, actor) {
  const connection = activeConnection(app, actor);
  const query = new URLSearchParams({ q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false", fields: 'files(id,name,modifiedTime)', orderBy: 'modifiedTime desc', pageSize: '50' });
  try {
    const data = await google(app, connection.id, 'https://www.googleapis.com/drive/v3/files?' + query);
    return { spreadsheets: (data.files || []).filter(file => /^[A-Za-z0-9_-]{20,100}$/.test(file.id || '')).map(file => ({ id: file.id, title: String(file.name || 'Untitled spreadsheet').slice(0, 200), modified_at: Date.parse(file.modifiedTime) || null })) };
  } catch (error) { asHttp(error); }
}

export async function createSheetsSync(app, actor, formId, body) {
  const form = assertForm(app, actor.workspace.id, formId);
  const connection = activeConnection(app, actor);
  const existing = app.db.get('SELECT * FROM form_google_syncs WHERE form_id = ?', formId);
  if (existing && existing.status !== 'disconnected') fail(409, 'sheets_sync_exists', 'This form already syncs to Google Sheets. Stop that sync before choosing another destination.');
  const title = String(JSON.parse(form.draft).title || 'Form').slice(0, 80);
  const tabTitle = `${title.replace(/[\[\]*?:\/\\']/g, ' ').trim() || 'Form'} responses`.slice(0, 90);
  let spreadsheet;
  let tab;
  try {
    if (body.destination === 'new') {
      spreadsheet = await google(app, connection.id, SHEETS, { method: 'POST', body: JSON.stringify({ properties: { title: `${title} — responses (Schedora)` }, sheets: [{ properties: { title: tabTitle } }] }) });
      tab = spreadsheet.sheets?.[0]?.properties;
    } else {
      if (typeof body.spreadsheet_id !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(body.spreadsheet_id)) fail(400, 'validation_failed', 'Choose a spreadsheet or create a new one.', { field: 'spreadsheet_id' });
      spreadsheet = await google(app, connection.id, `${SHEETS}/${encodeURIComponent(body.spreadsheet_id)}?fields=spreadsheetId,spreadsheetUrl,properties.title,sheets.properties`);
      const taken = new Set((spreadsheet.sheets || []).map(sheet => sheet.properties?.title));
      let name = tabTitle;
      for (let index = 2; taken.has(name); index++) name = `${tabTitle} ${index}`.slice(0, 100);
      const added = await google(app, connection.id, `${SHEETS}/${encodeURIComponent(spreadsheet.spreadsheetId)}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests: [{ addSheet: { properties: { title: name } } }] }) });
      tab = added.replies?.[0]?.addSheet?.properties;
    }
  } catch (error) { asHttp(error); }
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(spreadsheet?.spreadsheetId || '') || !Number.isInteger(tab?.sheetId) || !tab.title) fail(502, 'sheets_error', 'Google Sheets did not return the new tab.');
  let url;
  try { url = new URL(spreadsheet.spreadsheetUrl); } catch { url = null; }
  const safeUrl = url && url.protocol === 'https:' && url.hostname === 'docs.google.com' ? url.href : `https://docs.google.com/spreadsheets/d/${spreadsheet.spreadsheetId}/edit`;
  const now = app.now();
  const id = randomUUID();
  app.db.transaction(() => {
    if (existing) app.db.run('DELETE FROM form_google_syncs WHERE id = ?', existing.id);
    app.db.run(`INSERT INTO form_google_syncs (id, workspace_id, form_id, integration_id, created_by, spreadsheet_id, spreadsheet_title, spreadsheet_url, sheet_id, sheet_title, status, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'backfilling', ?, ?, ?)`, id, actor.workspace.id, formId, connection.id, actor.userId, spreadsheet.spreadsheetId,
      String(spreadsheet.properties?.title || 'Spreadsheet').slice(0, 200), safeUrl, tab.sheetId, String(tab.title).slice(0, 100), now, now, now);
  });
  app.nudge?.();
  return present(app, app.db.get('SELECT * FROM form_google_syncs WHERE id = ?', id), actor);
}

function syncFor(app, actor, formId) {
  assertForm(app, actor.workspace.id, formId);
  const sync = app.db.get('SELECT * FROM form_google_syncs WHERE form_id = ? AND workspace_id = ?', formId, actor.workspace.id);
  if (!sync) fail(404, 'not_found', 'This form does not sync to Google Sheets.');
  return sync;
}

export function controlSheetsSync(app, actor, formId, action) {
  const sync = syncFor(app, actor, formId);
  const now = app.now();
  if (action === 'pause') app.db.run("UPDATE form_google_syncs SET status = 'paused', claimed_until = NULL, updated_at = ? WHERE id = ?", now, sync.id);
  else if (action === 'resume' || action === 'retry') {
    if (['reconnect_required', 'disconnected'].includes(sync.status)) fail(409, 'sheets_reconnect', 'Reconnect Google Sheets to resume this sync.');
    app.db.run("UPDATE form_google_syncs SET status = CASE WHEN last_synced_at IS NULL THEN 'backfilling' ELSE 'active' END, attempts = 0, next_attempt_at = ?, source_signature = CASE WHEN ? = 'retry' THEN NULL ELSE source_signature END, updated_at = ? WHERE id = ?", now, action, now, sync.id);
    app.nudge?.();
  } else fail(400, 'validation_failed', 'Choose pause, resume or retry.');
  return present(app, app.db.get('SELECT * FROM form_google_syncs WHERE id = ?', sync.id), actor);
}

/** Stops syncing. Rows already in Google stay there; Schedora no longer writes to the tab. */
export function stopSheetsSync(app, actor, formId) {
  const sync = syncFor(app, actor, formId);
  if (sync.created_by !== actor.userId && !can(actor.role, 'integrations.manage')) fail(403, 'forbidden', 'Only the person who set up this sync or a workspace admin can stop it.');
  app.db.run('DELETE FROM form_google_syncs WHERE id = ?', sync.id);
}

/** Removes the person's Google Sheets connection: their syncs stop and Google is asked to revoke the token. */
export async function disconnectSheets(app, actor) {
  const connection = connectionFor(app, actor.workspace.id, actor.userId);
  if (!connection) fail(404, 'not_found', 'Google Sheets is not connected.');
  let token = null;
  try { token = await accessToken(app, connection.id); } catch { token = null; }
  app.db.transaction(() => {
    app.db.run("UPDATE form_google_syncs SET status = 'disconnected', integration_id = NULL, last_error = 'Google Sheets was disconnected. Rows already in Google are unchanged.', updated_at = ? WHERE integration_id = ?", app.now(), connection.id);
    app.db.run('DELETE FROM integrations WHERE id = ?', connection.id);
  });
  if (token) await app.fetchProvider('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }), signal: AbortSignal.timeout(10000) }).catch(() => null);
}

// ---- Sync engine --------------------------------------------------------------------------------

// The values for each response, in the linked-sheet layout (forms/workbooks.mjs), keyed by response ID.
function sourceRows(app, sync) {
  const grid = responseGrid(app, sync.workspace_id, sync.form_id, { nextStepSummary });
  const ids = app.db.all('SELECT id FROM responses WHERE form_id = ? AND workspace_id = ? ORDER BY created_at ASC, id ASC LIMIT ?', sync.form_id, sync.workspace_id, grid.rows.length).map(row => row.id);
  return { header: [ID_HEADER, ...grid.header], rows: grid.rows.map((values, index) => ({ id: ids[index], values: [ids[index], ...values] })), signature: grid.signature };
}

function fail_(app, sync, error) {
  const now = app.now();
  const attempts = sync.attempts + 1;
  if (error.kind === 'reconnect') {
    app.db.run("UPDATE form_google_syncs SET status = 'reconnect_required', last_error = ?, claimed_until = NULL, updated_at = ? WHERE id = ?", error.message, now, sync.id);
  } else if (error.kind === 'destination' || attempts >= MAX_ATTEMPTS) {
    app.db.run("UPDATE form_google_syncs SET status = 'error', attempts = ?, last_error = ?, claimed_until = NULL, updated_at = ? WHERE id = ?", attempts, error.message.slice(0, 300), now, sync.id);
  } else {
    const wait = Math.max(backoff(attempts), (error.retryAfter || 0) * 1000);
    app.db.run('UPDATE form_google_syncs SET attempts = ?, next_attempt_at = ?, last_error = ?, claimed_until = NULL, updated_at = ? WHERE id = ?', attempts, now + wait, error.message.slice(0, 300), now, sync.id);
  }
  app.log?.('warn', 'google_sheets_sync_failed', { sync_id: sync.id, status: error.status || null, kind: error.kind || 'error' });
}

/** One bounded pass for one sync. Safe to repeat: rows are located by response ID before writing. */
export async function runSheetsSync(app, syncId) {
  const now = app.now();
  const claim = app.db.run("UPDATE form_google_syncs SET claimed_until = ? WHERE id = ? AND status IN ('backfilling', 'active') AND next_attempt_at <= ? AND (claimed_until IS NULL OR claimed_until < ?)", now + 5 * MINUTE, syncId, now, now);
  if (!claim.changes) return 'skipped';
  const sync = app.db.get('SELECT * FROM form_google_syncs WHERE id = ?', syncId);
  // The owner must still belong to the workspace and still hold the connection the sync was set up with.
  const integration = sync.integration_id && app.db.get("SELECT id, workspace_id, user_id, status FROM integrations WHERE id = ? AND provider = 'google_sheets'", sync.integration_id);
  const member = app.db.get('SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ?', sync.workspace_id, sync.created_by);
  if (!member || !integration || integration.workspace_id !== sync.workspace_id || integration.user_id !== sync.created_by || integration.status === 'revoked') {
    const message = !member ? 'The person who set up this sync left the workspace. Stop it and set it up again from your own Google account.' : 'Google Sheets was disconnected or its access expired. Reconnect Google Sheets.';
    app.db.run("UPDATE form_google_syncs SET status = ?, last_error = ?, claimed_until = NULL, updated_at = ? WHERE id = ?", integration ? 'reconnect_required' : 'disconnected', message, now, sync.id);
    return 'reconnect_required';
  }
  try {
    const source = sourceRows(app, sync);
    const mapped = new Map(app.db.all('SELECT response_id, synced_hash FROM form_google_sync_rows WHERE sync_id = ?', sync.id).map(row => [row.response_id, row.synced_hash]));
    const headerHash = sha256(JSON.stringify(source.header));
    const liveIds = new Set(source.rows.map(row => row.id));
    const removed = [...mapped.keys()].filter(id => !liveIds.has(id));
    if (sync.source_signature === source.signature && sync.header_hash === headerHash && !removed.length && sync.status === 'active') {
      app.db.run('UPDATE form_google_syncs SET next_attempt_at = ?, claimed_until = NULL, attempts = 0, last_error = NULL, updated_at = ? WHERE id = ?', now + POLL_MS, now, sync.id);
      return 'unchanged';
    }
    // Where every response currently is in the tab (row 1 is the header).
    const base = `${SHEETS}/${encodeURIComponent(sync.spreadsheet_id)}`;
    const column = await google(app, sync.integration_id, `${base}/values/${encodeURIComponent(range(sync.sheet_title, 'A:A'))}?majorDimension=COLUMNS`);
    const positions = new Map();
    (column.values?.[0] || []).forEach((value, index) => { if (index > 0 && typeof value === 'string' && value && !positions.has(value)) positions.set(value, index + 1); });
    const headerChanged = sync.header_hash !== headerHash;
    const updates = [];
    const appends = [];
    if (headerChanged || column.values?.[0]?.[0] !== ID_HEADER) updates.push({ range: range(sync.sheet_title, 'A1'), values: [source.header] });
    const written = [];
    for (const row of source.rows) {
      if (updates.length + appends.length >= MAX_WRITES) break;
      const hash = sha256(JSON.stringify(row.values));
      const at = positions.get(row.id);
      if (at) {
        if (headerChanged || mapped.get(row.id) !== hash) { updates.push({ range: range(sync.sheet_title, `A${at}`), values: [row.values] }); written.push([row.id, hash]); }
      } else if (!mapped.has(row.id) || mapped.get(row.id) !== hash) {
        // Not in the tab: new, or removed by someone in Google and since changed in Schedora.
        appends.push(row.values); written.push([row.id, hash]);
      }
    }
    const blanked = [];
    for (const id of removed) {
      if (updates.length + appends.length >= MAX_WRITES) break;
      const at = positions.get(id);
      if (at) updates.push({ range: range(sync.sheet_title, `A${at}`), values: [[id, DELETED, ...Array(Math.max(0, source.header.length - 2)).fill('')]] });
      blanked.push(id);
    }
    // RAW: values are stored exactly as given and never parsed as formulas, numbers or dates.
    if (updates.length) await google(app, sync.integration_id, `${base}/values:batchUpdate`, { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data: updates }) });
    if (appends.length) await google(app, sync.integration_id, `${base}/values/${encodeURIComponent(range(sync.sheet_title, 'A1'))}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: 'POST', body: JSON.stringify({ majorDimension: 'ROWS', values: appends }) });
    const done = app.now();
    const pending = source.rows.filter(row => !written.some(([id]) => id === row.id) && mapped.get(row.id) !== sha256(JSON.stringify(row.values))).length + removed.length - blanked.length;
    app.db.transaction(() => {
      for (const [id, hash] of written) app.db.run('INSERT INTO form_google_sync_rows (sync_id, response_id, synced_hash, synced_at) VALUES (?, ?, ?, ?) ON CONFLICT (sync_id, response_id) DO UPDATE SET synced_hash = excluded.synced_hash, synced_at = excluded.synced_at', sync.id, id, hash, done);
      for (const id of blanked) app.db.run('DELETE FROM form_google_sync_rows WHERE sync_id = ? AND response_id = ?', sync.id, id);
      const count = Number(app.db.get('SELECT COUNT(*) AS n FROM form_google_sync_rows WHERE sync_id = ?', sync.id).n);
      app.db.run(`UPDATE form_google_syncs SET status = ?, header_hash = ?, source_signature = ?, synced_rows = ?, pending_rows = ?, attempts = 0, last_error = NULL, last_synced_at = ?, next_attempt_at = ?, claimed_until = NULL, updated_at = ? WHERE id = ? AND status IN ('backfilling', 'active')`,
        pending > 0 ? sync.status : 'active', headerHash, pending > 0 ? null : source.signature, count, Math.max(0, pending), done, pending > 0 ? done + 5000 : done + POLL_MS, done, sync.id);
    });
    return pending > 0 ? 'partial' : 'synced';
  } catch (error) {
    if (!(error instanceof GoogleError)) { fail_(app, sync, new GoogleError('Sync failed: ' + String(error.message).slice(0, 200))); throw error; }
    fail_(app, sync, error);
    return 'failed';
  }
}

/** Worker: a few due syncs per pass, so one busy form cannot exhaust the shared Google quota. */
export async function syncDueSheets(app, { limit = 3 } = {}) {
  if (!sheetsSyncAvailable(app)) return 0;
  const due = app.db.all("SELECT id FROM form_google_syncs WHERE status IN ('backfilling', 'active') AND next_attempt_at <= ? AND (claimed_until IS NULL OR claimed_until < ?) ORDER BY next_attempt_at LIMIT ?", app.now(), app.now(), limit);
  let ran = 0;
  for (const row of due) {
    try { await runSheetsSync(app, row.id); ran++; }
    catch (error) { app.log?.('error', 'google_sheets_sync_crashed', { sync_id: row.id, error: String(error.message).slice(0, 200) }); }
  }
  return ran;
}

