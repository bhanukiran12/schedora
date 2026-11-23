import { leadScore } from '../shared/forms-logic.mjs';
import { emitEvent, workbookWatched } from '../flow/events.mjs';
import { PAYMENT_STATUS_TEXT } from './service.mjs';
// Schedora Sheets workbooks linked to a form (docs/SHEETS.md).
//
// A workbook holds editable sheets as one JSON document with a revision. Browsers send change
// batches (shared/workbook-ops.mjs); each operation is checked against the stored value, so two
// people editing different cells both succeed, a retried batch changes nothing twice, and an edit to
// a cell someone else changed first is reported back as a conflict instead of overwriting it.
//
// The "Form Responses" sheet is not stored: it is generated from the responses table on every read,
// oldest response first, with a fixed column per question. Answers are returned as literal text and
// are never evaluated as formulas.
import { fail } from '../http.mjs';
import { assertWorkbookProtections } from './workbook-protection.mjs';
import { attributionColumns, formScore, responseColumns, responseColumnText } from '../shared/forms-logic.mjs';
import { LIMITS, applyOp, coalesceOps, columnIndex, currentFor, normalizeSheet, validOp } from '../shared/workbook-ops.mjs';

function assertForm(app, workspaceId, formId) {
  const form = app.db.get('SELECT id FROM forms WHERE workspace_id = ? AND id = ?', workspaceId, formId);
  if (!form) fail(404, 'not_found', 'Form not found.');
  return form;
}

const stores = {
  form: { workbooks: 'form_workbooks', versions: 'form_workbook_versions', comments: 'form_workbook_comments', key: 'form_id', workbookKey: 'form_id' },
  standalone: { workbooks: 'workbooks', versions: 'workbook_versions', comments: 'workbook_comments', key: 'workbook_id', workbookKey: 'id' }
};

function readSheets(app, formId, store = stores.form) {
  const row = app.db.get(`SELECT revision, sheets FROM ${store.workbooks} WHERE ${store.workbookKey} = ?`, formId);
  if (!row) return { revision: 0, sheets: [] };
  // Prototype workbooks (cells only, 12 × 50) are upgraded on read; nothing is rewritten until an edit.
  const sheets = JSON.parse(row.sheets).flatMap(sheet => { try { return [normalizeSheet(sheet)]; } catch { return []; } });
  return { revision: Number(row.revision), sheets };
}

function assertCommentCell(app, workspaceId, formId, sheetId, address, store) {
  if (store === stores.form) assertForm(app, workspaceId, formId);
  const sheet = readSheets(app, formId, store).sheets.find(item => item.id === sheetId);
  const point = /^([A-Z]{1,2})([1-9][0-9]{0,3})$/.exec(address ?? '');
  if (!sheet || !point || columnIndex(point[1]) >= sheet.columns || Number(point[2]) > sheet.rows) fail(404, 'not_found', 'Workbook cell not found.');
}

export function cellComments(app, workspaceId, formId, sheet, cell, standalone = false) {
  const store = standalone ? stores.standalone : stores.form;
  assertCommentCell(app, workspaceId, formId, sheet, cell, store);
  return { comments: app.db.all(`SELECT c.id, c.body, c.created_at, u.name AS author
    FROM ${store.comments} c LEFT JOIN users u ON u.id = c.author_id
    WHERE c.${store.key} = ? AND c.sheet_id = ? AND c.cell = ?
    ORDER BY c.created_at, c.id LIMIT 100`, formId, sheet, cell) };
}

export function workbookComments(app,workspaceId,id,standalone=false){
  const store=standalone?stores.standalone:stores.form;if(!standalone)assertForm(app,workspaceId,id);
  const sheets=new Map(readSheets(app,id,store).sheets.map(sheet=>[sheet.id,sheet.name]));
  const rows=app.db.all(`SELECT c.id,c.body,c.created_at,c.sheet_id,c.cell,u.name AS author FROM ${store.comments} c LEFT JOIN users u ON u.id=c.author_id WHERE c.${store.key} = ? ORDER BY c.created_at DESC,c.id DESC LIMIT 200`,id);
  return {comments:rows.filter(row=>sheets.has(row.sheet_id)).map(row=>({...row,sheet_name:sheets.get(row.sheet_id)})),limit:200};
}

export function addCellComment(app, workspaceId, formId, { sheet, cell, body } = {}, authorId, standalone = false) {
  const store = standalone ? stores.standalone : stores.form;
  const content = typeof body === 'string' ? body.trim() : '';
  if (!content || content.length > 2000) fail(400, 'invalid_comment', 'Enter a comment of 1–2,000 characters.');
  return app.db.transaction(() => {
    const { comments } = cellComments(app, workspaceId, formId, sheet, cell, standalone);
    if (comments.length >= 100) fail(409, 'comment_limit', 'This cell already has 100 comments.');
    const id = crypto.randomUUID();
    app.db.run(`INSERT INTO ${store.comments} (id, ${store.key}, sheet_id, cell, author_id, created_at, body) VALUES (?, ?, ?, ?, ?, ?, ?)`, id, formId, sheet, cell, authorId, Date.now(), content);
    return { id };
  });
}

/** Changes on insertion, deletion, publication and edits to existing rows. */
function responsesSignature(app, workspaceId, formId) {
  const stats = app.db.get(`SELECT COUNT(*) AS count, MAX(r.created_at) AS latest, SUM(e.revision) AS edits
    FROM responses r LEFT JOIN form_response_edits e ON e.response_id = r.id WHERE r.form_id = ? AND r.workspace_id = ?`, formId, workspaceId);
  const form = app.db.get('SELECT published_version FROM forms WHERE id = ?', formId);
  // Payment changes (confirmed, expired, refunded) refresh the linked sheet like a new response does.
  const paid = app.db.get('SELECT MAX(updated_at) AS at FROM form_payments WHERE form_id = ? AND workspace_id = ?', formId, workspaceId).at;
  return `${Number(stats.count)}.${Number(stats.latest ?? 0)}.${form?.published_version ?? 0}.${Number(stats.edits ?? 0)}${paid ? '.p' + Number(paid) : ''}`;
}

export function getWorkbook(app, workspaceId, formId, { canEdit = true } = {}) {
  assertForm(app, workspaceId, formId);
  const form = app.db.get('SELECT id, slug, draft, published_version FROM forms WHERE id = ?', formId);
  return {
    ...readSheets(app, formId), can_edit: canEdit, responses: responsesSignature(app, workspaceId, formId), links: incomingLinks(app, workspaceId, formId), limits: LIMITS,
    form: { id: form.id, slug: form.slug, title: JSON.parse(form.draft).title || 'Untitled form', published_version: form.published_version ?? null }
  };
}

// The standalone routes resolve membership and per-workbook access before using these stores.
export function getStandaloneWorkbook(app, workspaceId, workbook) {
  return { ...readSheets(app, workbook.id, stores.standalone), can_edit: workbook.role !== 'viewer',
    workbook, links: incomingLinks(app, workspaceId, workbook.id, true), limits: LIMITS };
}

function bookingLinkNames(app,target,standalone) {
  return standalone ? app.db.all('SELECT name FROM workbook_booking_links WHERE workbook_id=?',target).map(row=>row.name) : [];
}

function incomingLinks(app, workspaceId, target, standalone = false) {
  return (standalone
    ? app.db.all('SELECT source_id, name, snapshot IS NULL AS live FROM workbook_form_links WHERE workbook_id = ? ORDER BY name, source_id', target)
    : app.db.all('SELECT source_id, name, snapshot IS NULL AS live FROM form_workbook_links WHERE target_id = ? ORDER BY name, source_id', target))
    .map(link => ({ source_id: link.source_id, name: link.name, live: Boolean(link.live), signature: link.live ? responsesSignature(app, workspaceId, link.source_id) : 'snapshot' }));
}

export function workbookLinks(app, workspaceId, formId, standaloneDestinations = []) {
  assertForm(app, workspaceId, formId);
  const destinations = app.db.all('SELECT id, draft FROM forms WHERE workspace_id = ? AND id <> ? ORDER BY id LIMIT 200', workspaceId, formId)
    .map(row => ({ id: row.id, title: JSON.parse(row.draft).title || 'Untitled form' })).sort((a, b) => a.title.localeCompare(b.title));
  const allowed = new Set(standaloneDestinations.map(item => item.id));
  const links = [
    ...app.db.all('SELECT target_id, name, snapshot IS NULL AS live FROM form_workbook_links WHERE source_id = ?', formId),
    ...app.db.all('SELECT workbook_id AS target_id, name, snapshot IS NULL AS live FROM workbook_form_links WHERE source_id = ?', formId)
      .flatMap(link => allowed.has(link.target_id) ? [{ ...link, standalone: true }] : [])
  ].map(link => ({ ...link, live: Boolean(link.live) }));
  return { links, destinations: [...destinations, ...standaloneDestinations.map(item => ({ id: item.id, title: item.title, standalone: true }))] };
}

export function setWorkbookLink(app, workspaceId, formId, { target, live, standalone = false } = {}, options) {
  assertForm(app, workspaceId, formId);
  if (typeof target !== 'string' || target === formId || typeof live !== 'boolean') fail(400, 'validation_failed', 'Choose a separate workbook in this workspace.');
  if (!standalone) assertForm(app, workspaceId, target);
  const table = standalone ? 'workbook_form_links' : 'form_workbook_links';
  const key = standalone ? 'workbook_id' : 'target_id';
  const reply = name => ({ target, name, live, ...(standalone ? { standalone } : {}) });
  return app.db.transaction(() => {
    // Serialise choosing a live destination across both tables.
    if (app.db.dialect === 'postgres') app.db.get('SELECT id FROM forms WHERE id = ? FOR UPDATE', formId);
    const existing = app.db.get(`SELECT name, snapshot FROM ${table} WHERE source_id = ? AND ${key} = ?`, formId, target);
    if (!live) {
      if (!existing) fail(404, 'not_found', 'Workbook link not found.');
      if (existing.snapshot === null) {
        const payload = JSON.stringify(responseGrid(app, workspaceId, formId, options));
        if (Buffer.byteLength(payload) > LIMITS.bytes) fail(413, 'snapshot_too_large', 'The linked responses exceed the snapshot size limit.');
        app.db.run(`UPDATE ${table} SET snapshot = ? WHERE source_id = ? AND ${key} = ?`, payload, formId, target);
      }
      return reply(existing.name);
    }
    const active = app.db.get('SELECT target_id FROM form_workbook_links WHERE source_id = ? AND snapshot IS NULL', formId);
    const activeStandalone = app.db.get('SELECT workbook_id FROM workbook_form_links WHERE source_id = ? AND snapshot IS NULL', formId);
    if ((active && (standalone || active.target_id !== target)) || (activeStandalone && (!standalone || activeStandalone.workbook_id !== target))) {
      fail(409, 'workbook_link_conflict', 'Unlink the current destination before linking another workbook.');
    }
    if (existing) {
      app.db.run(`UPDATE ${table} SET snapshot = NULL WHERE source_id = ? AND ${key} = ?`, formId, target);
      return reply(existing.name);
    }
    const title = JSON.parse(app.db.get('SELECT draft FROM forms WHERE id = ?', formId).draft).title || 'Form';
    const taken = new Set([...readSheets(app, target, standalone ? stores.standalone : stores.form).sheets.map(sheet => sheet.name),
      ...incomingLinks(app, workspaceId, target, standalone).map(link => link.name), ...bookingLinkNames(app,target,standalone)].map(name => name.toLowerCase()));
    const base = `Responses · ${title.replace(/[\u0000-\u001f\[\]:*?/\\]/g, ' ').trim().slice(0, 43)}`;
    let name = base;
    for (let count = 2; taken.has(name.toLowerCase()); count++) name = `${base} (${count})`;
    app.db.run(`INSERT INTO ${table} (source_id, ${key}, name) VALUES (?, ?, ?)`, formId, target, name);
    return reply(name);
  });
}

export function linkedWorkbookResponses(app, workspaceId, target, source, options, standalone = false) {
  if (!standalone) assertForm(app, workspaceId, target);
  assertForm(app, workspaceId, source);
  const link = standalone
    ? app.db.get('SELECT name, snapshot FROM workbook_form_links WHERE source_id = ? AND workbook_id = ?', source, target)
    : app.db.get('SELECT name, snapshot FROM form_workbook_links WHERE source_id = ? AND target_id = ?', source, target);
  if (!link) fail(404, 'not_found', 'Workbook link not found.');
  const data = link.snapshot === null ? responseGrid(app, workspaceId, source, options) : JSON.parse(link.snapshot);
  return { ...data, name: link.name, live: link.snapshot === null, signature: link.snapshot === null ? data.signature : 'snapshot' };
}

const HISTORY_LIMIT = 25;

function rememberVersion(app, formId, revision, sheets, authorId, store) {
  if (!revision) return;
  app.db.run(`INSERT INTO ${store.versions} (${store.key}, revision, created_at, author_id, sheets) VALUES (?, ?, ?, ?, ?) ON CONFLICT (${store.key}, revision) DO NOTHING`,
    formId, revision, Date.now(), authorId, sheets);
}

function write(app, formId, revision, sheets, authorId, store = stores.form) {
  const previousSheets = readSheets(app, formId, store).sheets;
  if ([...previousSheets, ...sheets].some(sheet => sheet.settings?.protections?.length)) {
    const standalone = store === stores.standalone;
    const parent = app.db.get(standalone ? 'SELECT workspace_id, owner_id FROM workbooks WHERE id = ?' : 'SELECT workspace_id FROM forms WHERE id = ?', formId);
    const role = authorId && parent ? app.db.get('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?', parent.workspace_id, authorId)?.role : null;
    const administrator = Boolean(authorId && parent && (standalone ? parent.owner_id === authorId : ['owner', 'admin'].includes(role)));
    assertWorkbookProtections(previousSheets, sheets, { actor: authorId, administrator });
  }
  const payload = JSON.stringify(sheets);
  if (Buffer.byteLength(payload) > LIMITS.bytes) fail(413, 'workbook_too_large', 'This workbook would exceed 2 MB. Remove some data and try again.');
  if (revision > 0) {
    const previous = app.db.get(`SELECT sheets FROM ${store.workbooks} WHERE ${store.workbookKey} = ? AND revision = ?`, formId, revision);
    if (previous) rememberVersion(app, formId, revision, previous.sheets, null, store);
  }
  const result = revision === 0
    && store === stores.form ? app.db.run('INSERT INTO form_workbooks (form_id, revision, sheets) VALUES (?, 1, ?) ON CONFLICT (form_id) DO NOTHING', formId, payload)
    : app.db.run(`UPDATE ${store.workbooks} SET revision = revision + 1, sheets = ? WHERE ${store.workbookKey} = ? AND revision = ?`, payload, formId, revision);
  if (!result.changes) fail(409, 'workbook_conflict', 'Someone saved this workbook first. Reload before trying again.');
  rememberVersion(app, formId, revision + 1, payload, authorId, store);
  app.db.run(`DELETE FROM ${store.versions} WHERE ${store.key} = ? AND revision <= ?`, formId, revision + 1 - HISTORY_LIMIT);
  return revision + 1;
}

/**
 * Replaces the whole workbook when `revision` is current. Kept for browsers that still run the
 * prototype editor during a staggered deployment; the editor now sends change batches.
 */
export function saveWorkbook(app, workspaceId, formId, input, authorId = null) {
  assertForm(app, workspaceId, formId);
  const { revision, sheets } = input ?? {};
  if (!Number.isSafeInteger(revision) || revision < 0 || !Array.isArray(sheets) || sheets.length > LIMITS.sheets) {
    fail(400, 'validation_failed', 'Invalid workbook revision or sheet list.');
  }
  const ids = new Set();
  const names = new Set(['form responses', ...incomingLinks(app, workspaceId, formId).map(link => link.name.toLowerCase())]);
  const aliases = new Set();
  const normalized = sheets.map(sheet => {
    let clean;
    try { clean = normalizeSheet(sheet); } catch (error) { fail(400, 'validation_failed', error.message); }
    if (ids.has(clean.id) || names.has(clean.name.toLowerCase())) fail(400, 'validation_failed', 'Invalid or duplicate sheet.');
    for (const name of Object.keys(clean.names)) {
      if (aliases.has(name)) fail(400, 'validation_failed', 'Named ranges must be unique within a workbook.');
      aliases.add(name);
    }
    ids.add(clean.id);
    names.add(clean.name.toLowerCase());
    // The prototype sent cells only; keep its shape in the reply.
    return Object.keys(sheet).every(key => ['id', 'name', 'cells'].includes(key)) ? { id: clean.id, name: clean.name, cells: clean.cells } : clean;
  });
  return app.db.transaction(() => ({ revision: write(app, formId, revision, normalized, authorId), sheets: normalized }));
}

/**
 * Applies a batch of operations atomically. Returns the new workbook and, for each operation that
 * found something other than its `from` value, a conflict with the value that was kept.
 */
export function applyWorkbookChanges(app, workspaceId, formId, input, authorId = null, standalone = false) {
  const store = standalone ? stores.standalone : stores.form;
  if (!standalone) assertForm(app, workspaceId, formId);
  const ops = input?.ops;
  if (!Array.isArray(ops) || !ops.length || ops.length > LIMITS.batch || !ops.every(validOp)
      || ops.reduce((count, op) => count + (op.op === 'group' ? op.ops.length : 1), 0) > LIMITS.batch) {
    fail(400, 'validation_failed', 'Invalid workbook changes.');
  }
  return app.db.transaction(() => {
    const { revision, sheets } = readSheets(app, formId, store);
    const reserved = new Set([...incomingLinks(app, workspaceId, formId, standalone).map(link => link.name),...bookingLinkNames(app,formId,standalone)].map(name=>name.toLowerCase()));
    const conflicts = [];
    let applied = 0;
    // Flow sheet triggers (docs/FLOW_V1_IMPLEMENTATION.md): only editable workbooks, and only when a workflow watches it.
    const watched = standalone && workbookWatched(app, workspaceId, formId);
    const before = watched ? new Map(sheets.map(sheet => [sheet.id, { ...sheet.cells }])) : null;
    const changedCells = [];
    coalesceOps(ops).forEach((op, index) => {
      const name = op.op === 'sheet-add' ? op.sheet.name.trim() : op.op === 'sheet-name' ? op.to.trim() : null;
      const keepsSheet = !standalone || op.op !== 'sheet-delete' || sheets.length > 1;
      const outcome = !keepsSheet || (name && reserved.has(name.toLowerCase())) ? 'conflict' : applyOp(sheets, op);
      if (outcome === 'applied') { applied++; if (watched) for (const item of op.op === 'group' ? op.ops : [op]) if (item.op === 'cell') changedCells.push({ ...item, origin: op.origin || item.origin || input.origin || 'user' }); }
      else if (outcome === 'conflict') conflicts.push({ index, op, current: currentFor(sheets, op) });
    });
    const next = applied ? write(app, formId, revision, sheets, authorId, store) : revision;
    if (watched && changedCells.length) emitSheetEvents(app, workspaceId, formId, sheets, before, changedCells, next);
    return { revision: next, sheets, conflicts, applied };
  });
}

// One "row added" event per row that was empty before this change, and one "column changed" event per
// changed cell below the header. Each carries its origin: user edits start workflows; undo, redo and
// automation writes are recorded with their origin and never start one.
function emitSheetEvents(app, workspaceId, workbookId, sheets, before, cells, revision) {
  const title = app.db.get('SELECT title FROM workbooks WHERE id = ?', workbookId)?.title || '';
  const rowValues = (sheet, row) => {
    const values = {};
    for (const [address, value] of Object.entries(sheet.cells)) {
      const match = /^([A-Z]+)(\d+)$/.exec(address);
      if (match && Number(match[2]) === row && sheet.cells[match[1] + '1']) values[String(sheet.cells[match[1] + '1']).slice(0, 100)] = String(value ?? '').slice(0, 2000);
    }
    return values;
  };
  const rowsAdded = new Set();
  for (const cell of cells.slice(0, 200)) {
    const match = /^([A-Z]+)(\d+)$/.exec(cell.cell);
    const sheet = sheets.find(item => item.id === cell.sheet);
    if (!match || !sheet || Number(match[2]) < 2) continue;
    const row = Number(match[2]);
    const origin = ['undo', 'redo', 'automation'].includes(cell.origin) ? cell.origin : 'user';
    const base = { workbook: workbookId, workbook_title: title, sheet: sheet.id, sheet_name: sheet.name, row };
    const wasEmpty = !Object.keys(before.get(sheet.id) || {}).some(address => new RegExp('^[A-Z]+' + row + '$').test(address) && before.get(sheet.id)[address] != null && before.get(sheet.id)[address] !== '');
    if (wasEmpty && !rowsAdded.has(sheet.id + ':' + row) && cell.to != null && cell.to !== '') {
      rowsAdded.add(sheet.id + ':' + row);
      emitEvent(app, { id: `row:${workbookId}:${sheet.id}:${row}:${revision}`, workspaceId, type: 'sheets.row.added', subjectId: workbookId, sourceId: workbookId, payload: { ...base, values: rowValues(sheet, row) }, origin });
    }
    const header = sheet.cells[match[1] + '1'];
    if (header) emitEvent(app, { id: `cell:${workbookId}:${sheet.id}:${cell.cell}:${revision}`, workspaceId, type: 'sheets.cell.changed', subjectId: workbookId, sourceId: workbookId,
      payload: { ...base, column: String(header).slice(0, 100), value: String(cell.to ?? '').slice(0, 200), values: rowValues(sheet, row) }, origin });
  }
}

export function workbookHistory(app, workspaceId, formId, standalone = false) {
  const store = standalone ? stores.standalone : stores.form;
  if (!standalone) assertForm(app, workspaceId, formId);
  const versions = app.db.all(`SELECT v.revision, v.created_at, u.name AS author FROM ${store.versions} v
    LEFT JOIN users u ON u.id = v.author_id WHERE v.${store.key} = ? ORDER BY v.revision DESC LIMIT ?`, formId, HISTORY_LIMIT);
  return { versions: versions.map(row => ({ revision: Number(row.revision), created_at: Number(row.created_at), author: row.author })) };
}

export function restoreWorkbook(app, workspaceId, formId, { revision, restore } = {}, authorId = null, standalone = false) {
  const store = standalone ? stores.standalone : stores.form;
  if (!standalone) assertForm(app, workspaceId, formId);
  if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(restore) || restore < 1) fail(400, 'validation_failed', 'Choose a valid workbook version.');
  return app.db.transaction(() => {
    const current = readSheets(app, formId, store);
    if (current.revision !== revision) fail(409, 'workbook_conflict', 'Someone saved this workbook first. Refresh history before restoring.');
    const snapshot = app.db.get(`SELECT sheets FROM ${store.versions} WHERE ${store.key} = ? AND revision = ?`, formId, restore);
    if (!snapshot) fail(404, 'not_found', 'Workbook version is no longer available.');
    if (revision === restore) return current;
    const sheets = JSON.parse(snapshot.sheets).map(normalizeSheet);
    const linkedNames = new Set([...incomingLinks(app, workspaceId, formId, standalone).map(link => link.name),...bookingLinkNames(app,formId,standalone)].map(name=>name.toLowerCase()));
    if (sheets.some(sheet => linkedNames.has(sheet.name.toLowerCase()))) fail(409, 'workbook_conflict', 'A tab in that version has the same name as a linked response tab.');
    return { revision: write(app, formId, revision, sheets, authorId, store), sheets };
  });
}

// Who else has the workbook open, kept in memory for a short while. With several server instances
// each one sees only its own viewers; presence is a hint, never a lock.
const PRESENCE_MS = 15000;
function presence(app, formId, viewer) {
  app.workbookPresence ??= new Map();
  const now = Date.now();
  const viewers = app.workbookPresence.get(formId) ?? new Map();
  for (const [key, value] of viewers) if (now - value.at > PRESENCE_MS) viewers.delete(key);
  if (viewer) viewers.set(viewer.client, { ...viewer, at: now });
  app.workbookPresence.set(formId, viewers);
  return [...viewers.values()].filter(item => item.client !== viewer?.client).map(({ client, name, sheet, cell, range }) => ({ client, name, sheet, cell, range }));
}

/**
 * A cheap poll: the workbook only when its revision moved past `since`, the response signature (so
 * the linked tab reloads only when responses changed) and who else is here.
 */
export function syncWorkbook(app, workspaceId, formId, user, input = {}, standalone = false) {
  const store = standalone ? stores.standalone : stores.form;
  if (!standalone) assertForm(app, workspaceId, formId);
  const since = Number.isSafeInteger(input.since) ? input.since : -1;
  const client = typeof input.client === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(input.client) ? input.client : null;
  const sheet = typeof input.sheet === 'string' && /^(?:[a-f0-9]{32}|responses|response-[a-f0-9-]{36})$/.test(input.sheet) ? input.sheet : null;
  const cell = typeof input.cell === 'string' && /^[A-Z]{1,2}[0-9]{1,5}$/.test(input.cell) ? input.cell : null;
  const range = typeof input.range === 'string' && /^[A-Z]{1,2}[0-9]{1,5}:[A-Z]{1,2}[0-9]{1,5}$/.test(input.range) ? input.range : null;
  const row = app.db.get(`SELECT revision FROM ${store.workbooks} WHERE ${store.workbookKey} = ?`, formId);
  const revision = Number(row?.revision ?? 0);
  return {
    revision,
    ...(revision !== since ? { sheets: readSheets(app, formId, store).sheets } : {}),
    ...(standalone ? {} : { responses: responsesSignature(app, workspaceId, formId) }),
    links: incomingLinks(app, workspaceId, formId, standalone),
    viewers: presence(app, standalone ? 'workbook:' + formId : formId, client ? { client, user: user.id, name: user.name || 'Someone', sheet, cell, range } : null)
  };
}

const RESPONSE_ROWS = LIMITS.rows - 1;
const FIXED_COLUMNS = ['Submitted at (UTC)', 'Receipt', 'Form version', 'Score', 'Next step', 'Verified sign-in email'];
function paymentCells(app, responseId) {
  const payment = app.db.get('SELECT status, last_failure, amount_paid, provider_payment_id FROM form_payments WHERE response_id = ?', responseId);
  if (!payment) return ['', '', ''];
  const state = payment.status === 'pending' && payment.last_failure ? 'failed' : payment.status;
  return [PAYMENT_STATUS_TEXT[state] || state, payment.amount_paid ? (payment.amount_paid / 100).toFixed(2) : '', payment.provider_payment_id || ''];
}
const NEXT_STEP_TEXT = { offered: 'Booking offered', unavailable: 'Booking unavailable', booked: 'Booking confirmed', booking_pending: 'Booking pending', booking_canceled: 'Booking canceled', booking_removed: 'Booking removed' };
const stamp = at => new Date(at).toISOString().slice(0, 19).replace('T', ' ');

/**
 * The linked "Form Responses" sheet. Row 1 holds headers and each response keeps its row for as
 * long as it exists: rows are ordered by submission time, oldest first, so a new response is added
 * at the bottom and never moves earlier ones. Columns A–F are fixed; each question then has its own
 * column, in the order questions were first published, so publishing a new version adds columns at
 * the end instead of shifting existing ones. Searching, filtering or sorting a view never changes
 * this grid.
 */
export function responseGrid(app, workspaceId, formId, { nextStepSummary }) {
  assertForm(app, workspaceId, formId);
  const versions = app.db.all('SELECT version, definition FROM form_versions WHERE form_id = ? ORDER BY version ASC', formId)
    .map(row => ({ version: Number(row.version), definition: JSON.parse(row.definition) }));
  const byVersion = new Map(versions.map(item => [item.version, item.definition]));
  const columns = new Map();
  for (const { definition } of versions) {
    for (const column of (definition.fields || []).flatMap(responseColumns)) if (!columns.has(column.key)) columns.set(column.key, column);
  }
  const questions = [...columns.values()];
  const total = Number(app.db.get('SELECT COUNT(*) AS count FROM responses WHERE form_id = ? AND workspace_id = ?', formId, workspaceId).count);
  const rows = app.db.all(`SELECT r.id, r.form_version, r.answers, r.attribution, r.respondent, r.created_at,
      h.status AS handoff_status, h.reason AS handoff_reason, h.booking_id, h.expires_at AS handoff_expires_at
    FROM responses r LEFT JOIN form_handoffs h ON h.response_id = r.id WHERE r.form_id = ? AND r.workspace_id = ?
    ORDER BY r.created_at ASC, r.id ASC LIMIT ?`, formId, workspaceId, RESPONSE_ROWS);
  const parse = value => value ? JSON.parse(value) : null;
  const attribution = attributionColumns(versions.map(item => item.definition).reverse(), rows.map(row => ({ attribution: parse(row.attribution) })));
  const lead = versions.some(item => item.definition.mode === 'lead_qualification' && item.definition.lead_scoring);
  // Payment columns come last and only for forms that took payments, so other sheets keep their columns.
  const paid = versions.some(item => item.definition.payment);
  const header = [...FIXED_COLUMNS, ...questions.map(column => column.label), ...attribution.map(key => `Attribution: ${key}`), ...(lead ? ['Lead priority', 'Lead score explanation'] : []), ...(paid ? ['Payment status', 'Amount paid (INR)', 'Payment ID'] : [])].slice(0, LIMITS.columns);
  const values = rows.map(row => {
    const definition = byVersion.get(Number(row.form_version)) || { fields: [] };
    const answers = JSON.parse(row.answers);
    // The score is computed here from the published definition; answer keys never leave the server.
    const score = formScore(definition, answers);
    const qualification = leadScore(definition, answers);
    const step = nextStepSummary(app, workspaceId, row);
    const recorded = parse(row.attribution) || {};
    return [stamp(row.created_at), row.id.replace(/-/g, '').slice(0, 8).toUpperCase(), String(row.form_version),
      score ? `${score.correct} / ${score.total}` : qualification ? String(qualification.score) : '', step ? [NEXT_STEP_TEXT[step.status] || step.status, step.reference].filter(Boolean).join(' ') : '',
      parse(row.respondent)?.email ?? '',
      ...questions.map(column => responseColumnText(definition.fields, column, answers)),
      ...attribution.map(key => String(recorded[key] ?? '')), ...(lead ? [qualification?.band ?? '', qualification?.reasons.map(item => `${item.question}: ${item.answer} (+${item.points})`).join('; ') ?? ''] : []), ...(paid ? paymentCells(app, row.id) : [])].slice(0, LIMITS.columns).map(value => String(value).slice(0, LIMITS.cellLength));
  });
  return {
    signature: responsesSignature(app, workspaceId, formId),
    header, rows: values, total, truncated: total > rows.length,
    questions: questions.length, fixed: FIXED_COLUMNS.length
  };
}
