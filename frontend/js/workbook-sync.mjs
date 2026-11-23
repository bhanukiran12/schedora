// Keeps a Schedora Sheets workbook in step with the workspace (docs/SHEETS.md, "Collaboration").
//
// The workspace version is the last workbook the server confirmed. Local edits are operations
// queued on top of it; what the person sees is the workspace version with the queue applied. The
// queue is written to browser storage after every edit, so a reload, a closed tab or a lost
// connection keeps unsynced work, and it is sent again when the page is back.
//
// The server applies each operation only if the cell still holds what this browser saw. Edits to
// different cells from different people both land; an edit to a cell someone else changed first is
// returned as a conflict, kept here with both values until the person chooses one.
//
// No DOM access: the page passes `api` and `storage`, so this runs unchanged in tests.
import { applyOp, coalesceOps, currentFor, diffWorkbooks, equal, invertOp, LIMITS, normalizeSheet } from '../shared/workbook-ops.mjs';

const RETRY_MS = [1000, 3000, 8000, 20000, 30000];

export function createWorkbookSync({ api, storage, storageKey, endpoint, clientId, onChange = () => {}, onStatus = () => {}, schedule = setTimeout, cancel = clearTimeout }) {
  let server = { revision: 0, sheets: [] };
  let queue = [];
  let conflicts = [];
  let view = [];
  let inflight = null;
  let retryTimer = null;
  let failures = 0;
  let status = { state: 'loading', message: 'Loading workbook…' };
  let canEdit = true;
  let closed = false;
  const undoStack = [];
  const redoStack = [];

  const persist = () => {
    try { storage.set(storageKey, JSON.stringify({ version: 2, revision: server.revision, queue, conflicts })); }
    catch { /* Storage blocked or full: edits still sync while the page is open. */ }
  };
  const rebuild = () => {
    view = structuredClone(server.sheets);
    for (const op of queue) applyOp(view, op, { force: op.op !== 'group' });
  };
  const setStatus = (state, message) => { status = { state, message }; onStatus(status); };
  const describe = () => {
    if (!canEdit) return setStatus('readonly', 'View only: your role cannot edit these sheets.');
    if (inflight) return setStatus('saving', 'Saving…');
    if (queue.length) return setStatus(failures ? 'offline' : 'pending', failures ? `Offline. ${queue.length} unsynced ${queue.length === 1 ? 'change is' : 'changes are'} kept in this browser.` : 'Saving…');
    if (conflicts.length) return setStatus('conflict', `${conflicts.length} ${conflicts.length === 1 ? 'edit needs' : 'edits need'} review`);
    return setStatus('saved', 'All changes saved');
  };

  /** Takes a newer workspace version, keeping unsynced edits on top. Older versions are ignored. */
  function adoptServer(revision, sheets) {
    if (revision <= server.revision) return false;
    server = { revision, sheets: sheets.map(normalizeSheet) };
    rebuild();
    return true;
  }

  async function load() {
    let saved = null;
    try { saved = JSON.parse(storage.get(storageKey) || 'null'); } catch { /* Unreadable draft: start from the workspace. */ }
    const remote = await api('GET', endpoint);
    canEdit = remote.can_edit !== false;
    server = { revision: remote.revision, sheets: remote.sheets.map(normalizeSheet) };
    if (saved?.version === 2) {
      queue = Array.isArray(saved.queue) ? saved.queue : [];
      conflicts = Array.isArray(saved.conflicts) ? saved.conflicts : [];
    } else if (saved && Array.isArray(saved.sheets) && saved.pending) {
      // A draft kept by the prototype editor: replay what changed since the version it started from.
      try { queue = diffWorkbooks((saved.baseSheets ?? []).map(normalizeSheet), saved.sheets.map(normalizeSheet)); }
      catch { queue = []; }
    }
    rebuild();
    persist();
    describe();
    onChange({ remote: true });
    if (queue.length) void flush();
    return remote;
  }

  /**
   * Records local edits. `ops` are applied to the view at once and queued for the server. Returns
   * false when nothing changed.
   */
  function apply(ops, { undoable = true } = {}) {
    if (!canEdit) return false;
    const done = [];
    for (const op of ops) {
      const snapshot = op.op === 'sheet-delete' || op.op === 'sheet-move' ? structuredClone(view) : view;
      const outcome = applyOp(view, op, { force: op.op !== 'group' });
      if (outcome !== 'applied') continue;
      done.push({ op, inverse: invertOp(op, snapshot) });
    }
    if (!done.length) return false;
    queue.push(...done.map(item => item.op));
    if (undoable) {
      undoStack.push(done.map(item => item.inverse).filter(Boolean).reverse());
      if (undoStack.length > 100) undoStack.shift();
      redoStack.length = 0;
    }
    persist();
    onChange({ local: true, ops: done.map(item => item.op) });
    void flush();
    return true;
  }

  // Undo writes the earlier values as new edits. A cell someone else has changed since is left alone.
  function step(from, to) {
    const group = from.pop();
    if (!group) return { done: false };
    const ops = [];
    let skipped = 0;
    for (const op of group) {
      if (['cell', 'format', 'sheet-prop', 'sheet-name'].includes(op.op)) {
        const current = currentFor(view, op);
        if (current.missing || !equal(current.value, op.from)) { skipped++; continue; }
      }
      ops.push(op);
    }
    const applied = [];
    const inverses = [];
    for (const op of ops) {
      const snapshot = op.op === 'sheet-delete' || op.op === 'sheet-move' ? structuredClone(view) : view;
      const outcome = applyOp(view, op, { force: op.op !== 'group' });
      if (outcome !== 'applied') { if (outcome === 'conflict') skipped++; continue; }
      applied.push(op);
      const inverse = invertOp(op, snapshot);
      if (inverse) inverses.push(inverse);
    }
    if (applied.length) {
      to.push(inverses.reverse());
      // Marked so the server can tell undo and redo from new edits (Flow sheet triggers ignore them).
      const origin = from === undoStack ? 'undo' : 'redo';
      queue.push(...applied.map(op => ({ ...op, origin })));
      persist();
      onChange({ local: true, ops: applied });
      void flush();
    }
    return { done: applied.length > 0, skipped };
  }
  const undo = () => step(undoStack, redoStack);
  const redo = () => step(redoStack, undoStack);

  // One flush at a time; calling flush() while one runs returns the running one, which keeps sending
  // until the queue is empty or the connection fails.
  let running = null;
  function flush() {
    if (running) return running;
    running = (async () => { while (await sendOnce()); })().finally(() => { running = null; });
    return running;
  }

  async function sendOnce() {
    if (closed || inflight || !queue.length || !canEdit) { describe(); return false; }
    cancel(retryTimer);
    retryTimer = null;
    let count = 0;
    let weight = 0;
    for (const op of queue) {
      const size = op.op === 'group' ? op.ops.length : 1;
      if (count && weight + size > LIMITS.batch) break;
      weight += size;
      count++;
    }
    const batch = coalesceOps(queue.slice(0, count));
    if (!batch.length) {
      queue.splice(0, count);
      persist();
      describe();
      return queue.length > 0;
    }
    inflight = batch;
    describe();
    let result;
    try {
      result = await api('POST', endpoint + '/changes', { revision: server.revision, ops: batch });
    } catch (error) {
      inflight = null;
      if (closed) return false;
      if (error.status === 403 || error.status === 404) { canEdit = false; describe(); onChange({ remote: true }); return false; }
      if (error.status === 400 || error.status === 413) {
        // The server refused the batch as a whole: keep it for review instead of retrying forever.
        conflicts.push(...batch.map(op => ({ op, current: null, rejected: error.message || 'Rejected by the server.' })));
        queue.splice(0, count);
        rebuild();
        persist();
        describe();
        onChange({ remote: true });
        return queue.length > 0;
      }
      failures++;
      describe();
      retryTimer = schedule(() => { retryTimer = null; void flush(); }, RETRY_MS[Math.min(failures - 1, RETRY_MS.length - 1)]);
      return false;
    }
    inflight = null;
    failures = 0;
    queue.splice(0, count);
    for (const conflict of result.conflicts ?? []) conflicts.push({ op: conflict.op, current: conflict.current ?? null });
    // A batch reply is always at least as new as what this browser has seen, even when another
    // poll already reported the same revision.
    server = { revision: Math.max(result.revision, server.revision), sheets: result.revision >= server.revision ? result.sheets.map(normalizeSheet) : server.sheets };
    rebuild();
    persist();
    describe();
    onChange({ remote: true, conflicts: result.conflicts?.length ?? 0 });
    return queue.length > 0;
  }

  /** Polls the server. Returns the reply so the page can use presence and the response signature. */
  async function poll(presence = {}) {
    if (closed) return null;
    const reply = await api('POST', endpoint + '/sync', { since: server.revision, client: clientId, ...presence });
    if (closed) return null;
    const accessChanged = typeof reply.can_edit === 'boolean' && canEdit !== reply.can_edit;
    if (accessChanged) canEdit = reply.can_edit;
    const updated = reply.sheets && adoptServer(reply.revision, reply.sheets);
    if (accessChanged || updated) onChange({ remote: true });
    if (accessChanged) describe();
    if (failures && queue.length && !inflight) { failures = 0; void flush(); }
    return reply;
  }

  /** Settles a conflict: 'mine' writes this browser's value over the stored one, 'theirs' keeps it. */
  function resolve(index, choice) {
    const conflict = conflicts[index];
    if (!conflict) return;
    conflicts.splice(index, 1);
    if (choice === 'mine' && !conflict.rejected) {
      const { op } = conflict;
      const sheet = view.find(item => item.id === (op.op === 'sheet-add' ? op.sheet.id : op.sheet));
      if (op.op === 'cell' && sheet) apply([{ ...op, from: sheet.cells[op.cell] ?? null }]);
      else if (op.op === 'format' && sheet) apply([{ ...op, from: sheet.formats[op.cell] ?? null }]);
      else if (op.op === 'sheet-name' && sheet) apply([{ ...op, from: sheet.name }]);
      else if (op.op === 'sheet-prop' && sheet) apply([{ ...op, from: currentFor(view, op).value }]);
      else if (op.op === 'sheet-add') apply([{ ...op, sheet: { ...op.sheet, name: op.sheet.name.slice(0, 52) + ' (mine)' } }]);
      // An edit to a sheet deleted elsewhere cannot be written back; the page offers to copy it first.
    }
    persist();
    describe();
    onChange({ remote: true });
  }

  return {
    load, apply, undo, redo, flush, poll, resolve,
    acceptRestore(result) {
      if (!adoptServer(result.revision, result.sheets)) return;
      undoStack.length = 0;
      redoStack.length = 0;
      persist();
      describe();
      onChange({ remote: true });
    },
    get sheets() { return view; },
    get revision() { return server.revision; },
    get serverSheets() { return server.sheets; },
    get conflicts() { return conflicts; },
    get pending() { return queue.length + (inflight ? 1 : 0); },
    get status() { return status; },
    get canEdit() { return canEdit; },
    get canUndo() { return undoStack.length > 0; },
    get canRedo() { return redoStack.length > 0; },
    retry() { failures = 0; return flush(); },
    close() { closed = true; cancel(retryTimer); }
  };
}
