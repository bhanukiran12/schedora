import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, signUp } from './helpers.mjs';
import { adjustForStructure, createEvaluator, displayValue, renameSheetReferences, sheetValue, shiftFormula } from '../../frontend/js/sheet-formulas.mjs';
import { mergeWorkbook } from '../../frontend/js/workbook-merge.mjs';
import { createWorkbookSync } from '../../frontend/js/workbook-sync.mjs';
import { applyOp, blankSheet, coalesceOps, diffWorkbooks, normalizeSheet } from '../src/shared/workbook-ops.mjs';

const ID_A = 'a'.repeat(32);
const ID_B = 'b'.repeat(32);

// The page's api() throws errors carrying the HTTP status; tests drive the same sync code over HTTP.
const apiFor = (http, { offline = () => false } = {}) => async (method, path, body) => {
  if (offline()) throw Object.assign(new TypeError('Failed to fetch'), { status: 0 });
  const response = await http.raw(method, path, body);
  if (response.status >= 400) throw Object.assign(new Error(response.body?.error?.message || 'failed'), { status: response.status });
  return response.body;
};
const memoryStorage = (store = new Map()) => ({ store, get: key => store.get(key) ?? null, set: (key, value) => store.set(key, value) });
const noTimers = { schedule: () => 0, cancel: () => {} };

async function workbookFixture(env) {
  const owner = env.client();
  const { ws } = await signUp(owner, 'Workbook Owner');
  const created = await owner.post(`/api/workspaces/${ws.id}/forms`, { title: 'Workbook test' });
  return { owner, ws, form: created.body, route: `/api/workspaces/${ws.id}/forms/${created.body.id}/workbook` };
}

test('history records edits, scopes revisions, and restores as a new revision', async () => {
  const env = await setup();
  try {
    const { owner, route } = await workbookFixture(env);
    const sheet = { ...blankSheet(ID_A, 'Test'), cells: { A1: 'before' } };
    assert.equal((await owner.post(route + '/changes', { ops: [{ op: 'sheet-add', sheet }] })).status, 200);
    await owner.post(route + '/changes', { ops: [{ op: 'cell', sheet: ID_A, cell: 'A1', from: 'before', to: 'after' }] });
    const history = await owner.get(route + '/history');
    assert.deepEqual(history.body.versions.map(item => [item.revision, item.author]), [[2, 'Workbook Owner'], [1, 'Workbook Owner']]);
    assert.equal((await owner.raw('POST', route + '/restore', { revision: 1, restore: 1 })).status, 409);
    const restored = await owner.post(route + '/restore', { revision: 2, restore: 1 });
    assert.equal(restored.body.revision, 3);
    assert.equal(restored.body.sheets[0].cells.A1, 'before');
    assert.deepEqual((await owner.get(route + '/history')).body.versions.map(item => item.revision), [3, 2, 1]);
  } finally { await env.close(); }
});

test('form response links stay scoped to the workspace, snapshot on unlink, and backfill on relink', async () => {
  const env = await setup();
  try {
    const { owner, ws, route, form } = await workbookFixture(env);
    const targetForm = (await owner.post(`/api/workspaces/${ws.id}/forms`, { title: 'Destination' })).body;
    const destination = `/api/workspaces/${ws.id}/forms/${targetForm.id}/workbook`;
    const other = env.client();
    const otherWorkspace = (await signUp(other, 'Other workspace')).ws;
    const otherForm = (await other.post(`/api/workspaces/${otherWorkspace.id}/forms`, { title: 'Private' })).body;
    assert.equal((await owner.raw('POST', route + '/links', { target: otherForm.id, live: true })).status, 404);
    assert.equal((await owner.post(route + '/links', { target: targetForm.id, live: true })).body.live, true);
    assert.equal((await owner.get(destination)).body.links[0].source_id, form.id);
    await owner.patch(route.replace(/\/workbook$/, ''), { definition: { title: 'Workbook test', description: '', presentation: 'classic', submit_label: 'Submit', fields: [{ id: 'answer', type: 'short_text', label: 'Answer' }] } });
    assert.equal((await owner.post(route.replace(/\/workbook$/, '/publish'), {})).status, 200);
    const submit = value => env.client().post(`/api/public/forms/${form.slug}/responses`, { answers: { answer: value } });
    assert.equal((await submit('First')).status, 201);
    assert.equal((await owner.get(`${destination}/links/${form.id}`)).body.total, 1);
    await owner.post(route + '/links', { target: targetForm.id, live: false });
    assert.equal((await submit('Second')).status, 201);
    const snapshot = await owner.get(`${destination}/links/${form.id}`);
    assert.deepEqual([snapshot.body.live, snapshot.body.total], [false, 1]);
    await owner.post(route + '/links', { target: targetForm.id, live: true });
    const relinked = await owner.get(`${destination}/links/${form.id}`);
    assert.deepEqual([relinked.body.live, relinked.body.total], [true, 2]);
  } finally { await env.close(); }
});

test('prototype whole-workbook saves still work and stay inside the workspace', async () => {
  const env = await setup();
  try {
    const { owner, ws, route } = await workbookFixture(env);
    const other = env.client();
    const otherWorkspace = (await signUp(other, 'Other Owner')).ws;
    const sheets = [{ id: ID_A, name: 'Totals', cells: { A1: '=1+2' } }];
    const save = (revision, value = sheets) => owner.raw('PUT', route, { revision, sheets: value });
    const initial = (await owner.get(route)).body;
    assert.deepEqual([initial.revision, initial.sheets, initial.can_edit], [0, [], true]);
    assert.equal((await save(0)).status, 200);
    assert.equal((await save(0)).status, 409);
    assert.equal((await save(1, [{ ...sheets[0], cells: { BA1: 'bad address' } }])).status, 400);
    const stored = (await owner.get(route)).body;
    assert.equal(stored.revision, 1);
    assert.deepEqual(stored.sheets[0], normalizeSheet(sheets[0]), 'prototype sheets are read with default size and formats');
    assert.equal((await other.get(route.replace(ws.id, otherWorkspace.id))).status, 404);
    assert.equal((await env.client().get(route)).status, 401);
    assert.equal((await env.client().post(route + '/changes', { ops: [] })).status, 401);
  } finally { await env.close(); }
});

test('standalone sheets are private, have workspace member roles, and accept form links', async () => {
  const env = await setup();
  try {
    const { owner, ws, route: formRoute, form } = await workbookFixture(env);
    const base = `/api/workspaces/${ws.id}`;
    const guest = env.client();
    const member = await signUp(guest, 'Workbook Collaborator');
    assert.equal((await owner.post(base + '/members', { email: member.email, role: 'member' })).status, 201);
    const created = await owner.post(base + '/workbooks', { title: 'Shared analysis' });
    assert.equal(created.status, 201);
    const route = `${base}/workbooks/${created.body.id}`;
    assert.equal((await guest.get(route)).status, 404);
    assert.deepEqual((await guest.get(base + '/workbooks')).body.workbooks, []);
    const editor = await owner.get(route);
    assert.equal(editor.body.workbook.title, 'Shared analysis');
    assert.equal(editor.body.form, undefined);
    const sheet = editor.body.sheets[0].id;
    const edit = { ops: [{ op: 'cell', sheet, cell: 'A1', from: null, to: 'First edit' }] };
    const access = role => owner.raw('PUT', route + '/access', { user: member.user.id, role });
    assert.equal((await access('viewer')).status, 200);
    assert.equal((await guest.get(route)).body.can_edit, false);
    assert.equal((await guest.post(route + '/changes', edit)).status, 403);
    assert.equal((await guest.get(route + '/access')).status, 403);
    assert.equal((await guest.post(formRoute + '/links', { target: created.body.id, live: true, standalone: true })).status, 403);
    assert.equal((await access('editor')).status, 200);
    assert.equal((await guest.post(route + '/sync', { since: 1 })).body.can_edit, true);
    assert.equal((await guest.post(route + '/changes', edit)).body.revision, 2);
    assert.equal((await guest.post(route + '/comments', { sheet, cell: 'A1', body: 'Verified' })).status, 201);
    assert.equal((await owner.get(route + '/history')).body.versions[0].author, 'Workbook Collaborator');
    assert.equal((await owner.post(formRoute + '/links', { target: created.body.id, live: true, standalone: true })).status, 200);
    assert.equal((await guest.get(route)).body.links[0].source_id, form.id);
    assert.equal((await guest.get(`${route}/links/${form.id}`)).status, 200);
    const otherTarget = (await owner.post(base + '/forms', { title: 'Other destination' })).body;
    assert.equal((await owner.post(formRoute + '/links', { target: otherTarget.id, live: true })).status, 409);
    assert.equal((await access(null)).status, 200);
    assert.equal((await guest.get(route)).status, 404);
    assert.equal((await guest.get(`${route}/links/${form.id}`)).status, 404);
    assert.equal((await guest.post(route + '/sync', {})).status, 404);
  } finally { await env.close(); }
});

test('change batches apply per cell, report conflicts with the kept value, and are safe to retry', async () => {
  const env = await setup();
  try {
    const { owner, route } = await workbookFixture(env);
    const add = { op: 'sheet-add', sheet: blankSheet(ID_A, 'Totals'), index: 0 };
    const first = await owner.post(route + '/changes', { ops: [add, { op: 'cell', sheet: ID_A, cell: 'A1', from: null, to: '1' }] });
    assert.equal(first.status, 200);
    assert.deepEqual([first.body.revision, first.body.applied, first.body.conflicts], [1, 2, []]);
    // A retried request finds its own values and changes nothing.
    const retried = await owner.post(route + '/changes', { ops: [add, { op: 'cell', sheet: ID_A, cell: 'A1', from: null, to: '1' }] });
    assert.deepEqual([retried.body.revision, retried.body.applied, retried.body.conflicts], [1, 0, []]);
    // A stale edit to the same cell is not written; the stored value is returned.
    const stale = await owner.post(route + '/changes', { ops: [{ op: 'cell', sheet: ID_A, cell: 'A1', from: null, to: '2' }, { op: 'cell', sheet: ID_A, cell: 'B1', from: null, to: 'x' }] });
    assert.equal(stale.body.revision, 2, 'the separate cell still lands');
    assert.deepEqual(stale.body.conflicts.map(item => [item.op.cell, item.current.value]), [['A1', '1']]);
    assert.deepEqual(stale.body.sheets[0].cells, { A1: '1', B1: 'x' });
    assert.equal((await owner.post(route + '/changes', { ops: [{ op: 'cell', sheet: ID_A, cell: 'ZZ1', from: null, to: 'x' }] })).status, 400);
    assert.equal((await owner.post(route + '/changes', { ops: [{ op: 'sheet-add', sheet: blankSheet(ID_B, 'form responses') }] })).body.conflicts.length, 1, 'the linked tab name is reserved');
  } finally { await env.close(); }
});

test('grouped edits and grouped undo are atomic under collaborator conflicts', async () => {
  const env = await setup();
  try {
    const { owner, route } = await workbookFixture(env);
    const sheet = { ...blankSheet(ID_A, 'Totals'), cells: { A1: '1', B1: '2' } };
    const editor = createWorkbookSync({ api: apiFor(owner), storage: memoryStorage(), storageKey: 'groups', endpoint: route, clientId: 'groups-client', ...noTimers });
    await owner.post(route + '/changes', { ops: [{ op: 'sheet-add', sheet }] });
    await editor.load();
    const edit = (cell, from, to) => ({ op: 'cell', sheet: ID_A, cell, from, to });
    const group = { op: 'group', ops: [edit('A1', '1', '3'), edit('B1', '2', '4')] };
    assert.equal(editor.apply([group]), true);
    await editor.flush();
    const replay = await owner.post(route + '/changes', { ops: [group] });
    assert.equal(replay.body.applied, 0);
    assert.deepEqual(replay.body.conflicts, []);
    await owner.post(route + '/changes', { ops: [edit('B1', '4', 'remote')] });
    await editor.poll();
    assert.deepEqual(editor.undo(), { done: false, skipped: 1 });
    assert.deepEqual(editor.sheets[0].cells, { A1: '3', B1: 'remote' });
    const stale = await owner.post(route + '/changes', { ops: [{ op: 'group', ops: [edit('A1', '3', '1'), edit('B1', '4', '2')] }] });
    assert.equal(stale.body.applied, 0);
    assert.equal(stale.body.conflicts.length, 1);
    assert.deepEqual(stale.body.sheets[0].cells, { A1: '3', B1: 'remote' });
    editor.close();
  } finally { await env.close(); }
});

test('two sessions: separate cells merge, the same cell becomes a recoverable conflict, reloads keep unsynced edits', async () => {
  const env = await setup();
  try {
    const { owner, route } = await workbookFixture(env);
    // A second, separately signed-in session (another browser) of the same account.
    const email = env.app.db.get('SELECT email FROM users ORDER BY created_at DESC LIMIT 1').email;
    const second = env.client();
    assert.equal((await second.post('/api/auth/login', { email, password: 'a sufficiently long password' })).status, 200);
    await second.get('/api/me');
    const storageA = memoryStorage();
    const storageB = memoryStorage();
    const make = (http, storage, offline) => createWorkbookSync({ api: apiFor(http, { offline }), storage, storageKey: 'k', endpoint: route, clientId: 'client-' + Math.random().toString(36).slice(2, 12), ...noTimers });
    const a = make(owner, storageA);
    const b = make(second, storageB);
    await a.load();
    await b.load();
    a.apply([{ op: 'sheet-add', sheet: blankSheet(ID_A, 'Totals'), index: 0 }]);
    await a.flush();
    await b.poll();
    assert.equal(b.sheets[0]?.name, 'Totals');

    // Different cells at the same time.
    a.apply([{ op: 'cell', sheet: ID_A, cell: 'A1', from: null, to: '10' }]);
    b.apply([{ op: 'cell', sheet: ID_A, cell: 'B1', from: null, to: '20' }]);
    await Promise.all([a.flush(), b.flush()]);
    await a.poll();
    await b.poll();
    assert.deepEqual(a.sheets[0].cells, { A1: '10', B1: '20' });
    assert.deepEqual(b.sheets[0].cells, { A1: '10', B1: '20' });

    // The same cell: the first save wins and the second edit is kept for review, not lost.
    a.apply([{ op: 'cell', sheet: ID_A, cell: 'A1', from: '10', to: 'mine-a' }]);
    await a.flush();
    b.apply([{ op: 'cell', sheet: ID_A, cell: 'A1', from: '10', to: 'mine-b' }]);
    await b.flush();
    assert.equal(b.conflicts.length, 1);
    assert.equal(b.conflicts[0].op.to, 'mine-b');
    assert.equal(b.conflicts[0].current.value, 'mine-a');
    assert.equal(b.sheets[0].cells.A1, 'mine-a', 'the workspace value is shown until the person chooses');
    assert.ok(JSON.parse(storageB.store.get('k')).conflicts.length, 'conflicts survive a reload');
    b.resolve(0, 'mine');
    await b.flush();
    await a.poll();
    assert.equal(a.sheets[0].cells.A1, 'mine-b');

    // Offline edits are queued in storage; a reloaded page sends them.
    let down = true;
    const c = make(owner, storageA, () => down);
    down = false;
    await c.load();
    down = true;
    c.apply([{ op: 'cell', sheet: ID_A, cell: 'C1', from: null, to: 'offline edit' }]);
    await c.flush();
    assert.equal(c.status.state, 'offline');
    assert.equal(JSON.parse(storageA.store.get('k')).queue.length, 1);
    c.close();
    down = false;
    const reloaded = make(owner, storageA);
    await reloaded.load();
    await reloaded.flush();
    assert.equal((await owner.get(route)).body.sheets[0].cells.C1, 'offline edit');
    assert.equal(reloaded.status.state, 'saved');

    // Undo restores the earlier value; it does not overwrite a cell someone else changed since.
    reloaded.apply([{ op: 'cell', sheet: ID_A, cell: 'D1', from: null, to: 'undo me' }]);
    await reloaded.flush();
    assert.equal(reloaded.undo().done, true);
    await reloaded.flush();
    assert.equal((await owner.get(route)).body.sheets[0].cells.D1, undefined);
  } finally { await env.close(); }
});

test('the linked Form Responses grid is ordered oldest first, keeps literal answers and recalculates', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Grid Owner');
    const definition = {
      title: 'Scores', presentation: 'classic', mode: 'knowledge_quiz',
      fields: [
        { id: 'name', type: 'short_text', label: 'Name', required: true },
        { id: 'score', type: 'short_text', label: 'Points', required: true },
        { id: 'pick', type: 'single_choice', label: 'Capital of France', options: [{ id: 'paris', label: 'Paris', correct: true }, { id: 'rome', label: 'Rome' }] }
      ]
    };
    const forms = `/api/workspaces/${ws.id}/forms`;
    const form = (await owner.post(forms, { definition })).body;
    assert.equal((await owner.post(`${forms}/${form.id}/publish`)).status, 200);
    const submit = answers => { env.clock.now += 1000; return env.client().post(`/api/public/forms/${form.slug}/responses`, { answers }); };
    assert.equal((await submit({ name: 'Asha', score: '12', pick: 'paris' })).status, 201);
    assert.equal((await submit({ name: '=HYPERLINK("http://evil")', score: '=99', pick: 'rome' })).status, 201);
    const grid = async (query = '') => (await owner.get(`${forms}/${form.id}/workbook/responses${query}`)).body;
    let linked = await grid();
    assert.deepEqual(linked.header.slice(0, 9), ['Submitted at (UTC)', 'Receipt', 'Form version', 'Score', 'Next step', 'Verified sign-in email', 'Name', 'Points', 'Capital of France']);
    assert.deepEqual(linked.rows.map(row => row[6]), ['Asha', '=HYPERLINK("http://evil")'], 'oldest first, answers verbatim');
    assert.deepEqual(linked.rows.map(row => row[3]), ['1 / 1', '0 / 1'], 'scores are computed on the server');
    assert.ok(!JSON.stringify(linked).includes('correct'), 'answer keys stay on the server');

    const asSheet = data => ({ name: 'Form Responses', literal: true, cells: Object.fromEntries([data.header, ...data.rows].flatMap((row, r) => row.map((value, c) => [String.fromCharCode(65 + c) + (r + 1), value]))) });
    const analysis = { name: 'Analysis', cells: { A1: "=SUM('Form Responses'!H:H)", A2: "='Form Responses'!G3", A3: "=COUNTA('Form Responses'!G2:G)", A4: "='Form Responses'!H3*1" } };
    let evaluator = createEvaluator([asSheet(linked), analysis]);
    assert.equal(evaluator.value(analysis, 'A1'), 12, 'the literal "=99" is text and is skipped by SUM');
    assert.equal(evaluator.value(analysis, 'A2'), '=HYPERLINK("http://evil")');
    assert.equal(evaluator.value(analysis, 'A3'), 2);
    assert.equal(evaluator.value(analysis, 'A4').code, '#VALUE!');

    // A search on the Responses page never changes the grid; a new response is appended at the bottom.
    const signature = linked.signature;
    assert.equal((await owner.get(`${forms}/${form.id}/responses?q=Asha`)).status, 200);
    assert.equal((await submit({ name: 'Ravi', score: '30', pick: 'paris' })).status, 201);
    const sync = (await owner.post(`${forms}/${form.id}/workbook/sync`, { since: 0 })).body;
    assert.notEqual(sync.responses, signature, 'the poll tells the editor that responses changed');
    linked = await grid('?q=Asha&since=7');
    assert.deepEqual(linked.rows.map(row => row[6]), ['Asha', '=HYPERLINK("http://evil")', 'Ravi']);
    evaluator = createEvaluator([asSheet(linked), analysis]);
    assert.equal(evaluator.value(analysis, 'A1'), 42, 'dependent formulas see the new response');
    assert.equal(evaluator.value(analysis, 'A3'), 3);
  } finally { await env.close(); }
});

test('formulas: cross-tab references, cycles, literal response data and the function library', () => {
  const totals = { name: "May's totals", cells: { A1: '12', A2: '8' } };
  const report = { name: 'Report', cells: { A1: "='May''s totals'!A1+SUM('May''s totals'!A2, 2)" } };
  const sheets = [totals, report];
  assert.equal(sheetValue(report.cells, 'A1', sheets), 22);
  totals.cells.A1 = "='Report'!A1";
  assert.throws(() => sheetValue(report.cells, 'A1', sheets), /#CYCLE!/);

  const source = { name: 'Form Responses', literal: true, cells: { C2: '12', C3: '=99' }, limit: { rows: 3, columns: 52 } };
  assert.equal(sheetValue({ A1: "='Form Responses'!C2*2" }, 'A1', [source]), 24);
  assert.throws(() => sheetValue({ A1: "='Form Responses'!C3*1" }, 'A1', [source]), /#VALUE!/);
  assert.throws(() => sheetValue({ A1: "='Form Responses'!C4" }, 'A1', [source]), /#REF!/, 'rows past a truncated grid are not guessed');
  assert.equal(sheetValue({ A1: "='Form Responses'!C3" }, 'A1', [source]), '=99');

  const data = { name: 'Data', cells: { A1: 'apple', A2: 'pear', A3: 'apple', B1: '3', B2: '5', B3: '7', C1: '10%', D1: "'42", E1: 'TRUE' } };
  const value = formula => sheetValue({ Z1: formula }, 'Z1', [data]);
  assert.equal(value('=COUNTIF(Data!A1:A3,"apple")'), 2);
  assert.equal(value('=SUMIF(Data!A1:A3,"apple",Data!B1:B3)'), 10);
  assert.equal(value('=SUMIFS(Data!B1:B3,Data!A1:A3,"apple",Data!B1:B3,">3")'), 7);
  assert.equal(value('=AVERAGEIF(Data!B1:B3,">=5")'), 6);
  assert.equal(value('=VLOOKUP("pear",Data!A1:B3,2,FALSE)'), 5);
  assert.equal(value('=INDEX(Data!B1:B3,MATCH("pear",Data!A1:A3,0))'), 5);
  assert.equal(value('=IF(Data!B2>4,"big","small")&"!"'), 'big!');
  assert.equal(value('=IFERROR(1/0,"none")'), 'none');
  assert.equal(value('=ROUND(2.345,2)+Data!C1'), 2.45);
  assert.equal(value('=Data!D1+0'), 42, 'an apostrophe makes text; arithmetic still reads numeric text');
  assert.equal(value('=COUNT(Data!D1,Data!B1:B3)'), 3, 'text reached through a reference is not counted');
  assert.equal(value('=AND(Data!E1,TRUE)'), true);
  assert.equal(value('=TEXTJOIN(", ",TRUE,Data!A1:A3)'), 'apple, pear, apple');
  assert.throws(() => value('=NOPE(1)'), /#NAME\?/);
  assert.throws(() => value('=1+'), /#ERROR!/);
  assert.equal(displayValue(1234.5, { num: 'currency' }), '₹1,234.50');
  assert.equal(displayValue(0.256, { num: 'percent', dp: 1 }), '25.6%');
  assert.equal(displayValue(0.1 + 0.2), '0.3');
});

test('reference rewriting for fill, inserted or deleted rows and renamed sheets', () => {
  assert.equal(shiftFormula('=A1+$B$1+B$2+SUM(C1:C3)', 2, 1), '=B3+$B$1+C$2+SUM(D3:D5)');
  assert.equal(shiftFormula('=A1', -1, 0), '=#REF!');
  assert.equal(shiftFormula('="A1"&A1', 1, 0), '="A1"&A2', 'text in quotes is not a reference');
  const insert = { home: 'Data', target: 'Data', axis: 'row', at: 1, count: 2 };
  assert.equal(adjustForStructure('=A1+A2+SUM(A1:A5)+Other!A2', insert), '=A1+A4+SUM(A1:A7)+Other!A2');
  const remove = { home: 'Data', target: 'Data', axis: 'row', at: 1, count: -1 };
  assert.equal(adjustForStructure('=A2+A3+SUM(A1:A5)', remove), '=#REF!+A2+SUM(A1:A4)');
  assert.equal(adjustForStructure('=B1+C1', { home: 'Data', target: 'Data', axis: 'col', at: 1, count: 1 }), '=C1+D1');
  assert.equal(renameSheetReferences("='Old name'!A1+old name", 'Old name', 'New'), '=New!A1+old name');
});

test('operation helpers: coalescing, diffing and the prototype merge', () => {
  assert.deepEqual(coalesceOps([
    { op: 'cell', sheet: ID_A, cell: 'A1', from: null, to: '1' },
    { op: 'cell', sheet: ID_A, cell: 'B1', from: null, to: 'x' },
    { op: 'cell', sheet: ID_A, cell: 'A1', from: '1', to: '2' },
    { op: 'cell', sheet: ID_A, cell: 'B1', from: 'x', to: null }
  ]), [{ op: 'cell', sheet: ID_A, cell: 'A1', from: null, to: '2' }]);
  const before = [normalizeSheet({ id: ID_A, name: 'One', cells: { A1: '1' } })];
  const after = [normalizeSheet({ id: ID_A, name: 'Uno', cells: { A2: '2' } }), blankSheet(ID_B, 'Two')];
  const replay = structuredClone(before);
  for (const op of diffWorkbooks(before, after)) assert.equal(applyOp(replay, op), 'applied');
  assert.deepEqual(replay, after);

  const sheet = cells => [{ id: 'a', name: 'Totals', cells }];
  const base = sheet({ A1: '1', A2: '2' });
  assert.deepEqual(mergeWorkbook(base, sheet({ A1: '10', A2: '2' }), sheet({ A1: '1', A2: '20' })), sheet({ A1: '10', A2: '20' }));
  assert.equal(mergeWorkbook(base, sheet({ A1: '10', A2: '2' }), sheet({ A1: '11', A2: '2' })), null);
});

test('import and export: CSV quoting and formula protection, XLSX round trip', async () => {
  const { parseDelimited, toDelimited, rowsToCells, writeXlsx, readXlsx } = await import('../../frontend/js/sheet-files.mjs');
  assert.deepEqual(parseDelimited('name,notes\r\n"Asha, R","said ""hi""\nthen left"\r\n'), [['name', 'notes'], ['Asha, R', 'said "hi"\nthen left']]);
  assert.equal(toDelimited([['=HYPERLINK("x")', -5, 'plain']]), '"\'=HYPERLINK(""x"")","-5","plain"\r\n', 'formula-like text is neutralized; numbers are not');
  assert.deepEqual(rowsToCells([['a', '', 'c']]).cells, { A1: 'a', C1: 'c' });
  const blob = writeXlsx([{ name: 'Totals / May', frozen: 1, rows: [[{ value: 'Item', bold: true }, { value: 'Cost' }], [{ value: 'Tea' }, { value: 12 }], [{ value: 'Total' }, { value: 12, formula: '=SUM(B2:B2)' }], [{ value: '007' }]] }]);
  const sheets = await readXlsx(await blob.arrayBuffer());
  assert.equal(sheets[0].name, 'Totals   May', 'characters Excel forbids in sheet names are replaced');
  assert.deepEqual(sheets[0].cells, { A1: 'Item', B1: 'Cost', A2: 'Tea', B2: '12', A3: 'Total', B3: '=SUM(B2:B2)', A4: "'007" });
});

test('protected ranges reject unauthorized batches, metadata removal and history restore, while allowing edits elsewhere', async () => {
  const env = await setup();
  try {
    const { owner, ws } = await workbookFixture(env);
    const memberHttp = env.client();
    const collaborator = await signUp(memberHttp, 'Protected sheet editor');
    const base = '/api/workspaces/' + ws.id;
    assert.equal((await owner.post(base + '/members', { email: collaborator.email, role: 'member' })).status, 201);
    const created = await owner.post(base + '/workbooks', { title: 'Protected analysis' });
    const route = base + '/workbooks/' + created.body.id;
    assert.equal((await owner.raw('PUT', route + '/access', { user: collaborator.user.id, role: 'editor' })).status, 200);
    const first = (await owner.get(route)).body;
    const sheet = first.sheets[0].id;
    const ownerId = env.app.db.get('SELECT owner_id FROM workbooks WHERE id = ?', created.body.id).owner_id;
    const rule = { id: 'e'.repeat(32), name: 'Approved total', r1: 0, c1: 0, r2: 0, c2: 0, owner: ownerId, mode: 'restrict', editors: [] };
    const protection = { op: 'sheet-prop', sheet, key: 'settings', from: {}, to: { protections: [rule] } };
    assert.equal((await owner.post(route + '/changes', { ops: [protection] })).status, 200);
    const cell = (address, value) => ({ op: 'cell', sheet, cell: address, from: null, to: value });
    assert.equal((await memberHttp.post(route + '/changes', { ops: [cell('A1', 'blocked'), cell('B1', 'must also roll back')] })).status, 403);
    assert.equal((await owner.get(route)).body.sheets[0].cells.B1, undefined);
    assert.equal((await memberHttp.post(route + '/changes', { ops: [cell('B1', 'allowed')] })).status, 200);
    assert.equal((await memberHttp.post(route + '/changes', { ops: [{ ...protection, from: { protections: [rule] }, to: {} }] })).status, 403);
    const revision = (await owner.get(route)).body.revision;
    assert.equal((await memberHttp.post(route + '/restore', { revision, restore: first.revision })).status, 403);
    const granted = { ...rule, editors: [collaborator.user.id] };
    assert.equal((await owner.post(route + '/changes', { ops: [{ ...protection, from: { protections: [rule] }, to: { protections: [granted] } }] })).status, 200);
    assert.equal((await memberHttp.post(route + '/changes', { ops: [cell('A1', 'approved')] })).status, 200);
  } finally { await env.close(); }
});


test('standalone rename, owner-only recoverable trash and restoration preserve workbook data',async()=>{
  const env=await setup();try{
    const {owner,ws}=await workbookFixture(env);const memberHttp=env.client();const member=await signUp(memberHttp,'Trash editor');const base='/api/workspaces/'+ws.id;
    await owner.post(base+'/members',{email:member.email,role:'member'});const workbook=(await owner.post(base+'/workbooks',{title:'Trash QA'})).body;const route=base+'/workbooks/'+workbook.id;
    await owner.raw('PUT',route+'/access',{user:member.user.id,role:'editor'});const snapshot=(await owner.get(route)).body;
    await owner.post(route+'/changes',{ops:[{op:'cell',sheet:snapshot.sheets[0].id,cell:'A1',from:null,to:'Keep me'}]});
    assert.equal((await memberHttp.raw('PUT',route+'/title',{title:'Renamed QA'})).status,200);assert.equal((await owner.get(route)).body.workbook.title,'Renamed QA');
    assert.equal((await memberHttp.raw('PUT',route+'/trash',{trashed:true})).status,404);
    assert.equal((await owner.raw('PUT',route+'/trash',{trashed:true})).status,200);assert.equal((await owner.get(route)).status,404);assert.equal((await memberHttp.get(route)).status,404);
    assert.ok(!(await owner.get(base+'/workbooks')).body.workbooks.some(item=>item.id===workbook.id));assert.equal((await owner.get(base+'/workbooks/trash')).body.workbooks[0].id,workbook.id);assert.equal((await memberHttp.get(base+'/workbooks/trash')).body.workbooks.length,0);
    assert.equal((await memberHttp.raw('PUT',route+'/trash',{trashed:false})).status,404);assert.equal((await owner.raw('PUT',route+'/trash',{trashed:false})).status,200);
    assert.equal((await memberHttp.get(route)).body.sheets[0].cells.A1,'Keep me');
  }finally{await env.close()}
});
