// The Forms workspace list (frontend/js/forms-list.mjs): status, search, filters and copy titles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyTitle, filterForms, formStatus, statusCounts } from '../../frontend/js/forms-list.mjs';
import { setup, signUp } from './helpers.mjs';

const form = (id, title, extra = {}) => ({ id, draft: { title, description: extra.description || '' }, published_version: null, latest_version: null, updated_at: extra.updated_at || 0, ...extra });
const forms = [
  form('a', 'Technical Profile Details', { published_version: 2, latest_version: 2, updated_at: 30, description: 'Placement team' }),
  form('b', 'Café feedback', { updated_at: 50 }),
  form('c', 'Old survey', { latest_version: 1, updated_at: 10 }),
  form('d', 'Workshop registration', { published_version: 1, latest_version: 1, updated_at: 40 })
];

test('status tells live, closed and never-published drafts apart', () => {
  assert.deepEqual(forms.map(formStatus), ['live', 'draft', 'closed', 'live']);
  assert.deepEqual(statusCounts(forms), { all: 4, live: 2, draft: 1, closed: 1 });
});

test('search matches every word in title or description, ignoring case and accents; newest change first', () => {
  assert.deepEqual(filterForms(forms).map(item => item.id), ['b', 'd', 'a', 'c']);
  assert.deepEqual(filterForms(forms, { query: 'cafe' }).map(item => item.id), ['b']);
  assert.deepEqual(filterForms(forms, { query: '  PLACEMENT   profile ' }).map(item => item.id), ['a']);
  assert.deepEqual(filterForms(forms, { query: 'profile survey' }), []);
  assert.deepEqual(filterForms(forms, { status: 'live' }).map(item => item.id), ['d', 'a']);
  assert.deepEqual(filterForms(forms, { status: 'closed', query: 'survey' }).map(item => item.id), ['c']);
  assert.deepEqual(filterForms(forms, { status: 'draft', query: 'workshop' }), []);
});

test('a duplicate title stays within the title limit', () => {
  assert.equal(copyTitle('Survey'), 'Copy of Survey');
  assert.equal(copyTitle(''), 'Copy of Untitled form');
  assert.equal(copyTitle('x'.repeat(150)).length, 150);
});

test('the list API reports whether a form was ever published', async () => {
  const env = await setup();
  try {
    const http = env.client();
    const { ws } = await signUp(http, 'Lister');
    const path = `/api/workspaces/${ws.id}/forms`;
    const created = (await http.post(path, { title: 'Closed later' })).body;
    assert.equal(created.latest_version, null);
    await http.post(`${path}/${created.id}/publish`, {});
    await http.post(`${path}/${created.id}/unpublish`, {});
    const listed = (await http.get(path)).body.find(item => item.id === created.id);
    assert.equal(listed.published_version, null);
    assert.equal(listed.latest_version, 1);
    assert.equal(formStatus(listed), 'closed');
  } finally { await env.close(); }
});
