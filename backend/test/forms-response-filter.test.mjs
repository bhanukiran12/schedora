// Responses search and filters (docs/FORMS.md, "Responses: search, filters and export"). The same
// filter drives the list and the CSV, across every response, and verified identity stays apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, signUp } from './helpers.mjs';

const v1 = { title: 'Placement check-in', presentation: 'classic', fields: [
  { id: 'name', type: 'short_text', label: 'Full name', required: true },
  { id: 'batch', type: 'single_choice', label: 'Batch', required: true, options: [{ id: 'jan', label: 'January' }, { id: 'jul', label: 'July' }] }
] };
const v2 = { ...v1, fields: [v1.fields[0], { ...v1.fields[1], options: [{ id: 'jan', label: 'Jan cohort' }, { id: 'jul', label: 'July' }] }] };

async function world() {
  const env = await setup();
  const http = env.client();
  const { ws } = await signUp(http, 'Responses');
  const forms = `/api/workspaces/${ws.id}/forms`;
  const form = (await http.post(forms, { definition: v1 })).body;
  await http.post(`${forms}/${form.id}/publish`, {});
  const submit = async answers => {
    env.clock.now += 60_000;
    const response = await env.client().post(`/api/public/forms/${form.slug}/responses`, { answers });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body;
  };
  // Five in version 1, then a relabelled version 2 with three more.
  const first = [await submit({ name: 'José Ramírez', batch: 'jan' }), await submit({ name: 'Asha Rao', batch: 'jul' }), await submit({ name: 'Ravi Kumar', batch: 'jan' }), await submit({ name: 'Meera Iyer', batch: 'jul' }), await submit({ name: 'Arjun Das', batch: 'jan' })];
  await http.patch(`${forms}/${form.id}`, { definition: v2, expected_revision: (await http.get(`${forms}/${form.id}`)).body.revision });
  await http.post(`${forms}/${form.id}/publish`, {});
  const second = [await submit({ name: 'Kiran Shah', batch: 'jan' }), await submit({ name: 'Lata Menon', batch: 'jul' }), await submit({ name: 'Nikhil Jain', batch: 'jan' })];
  // A verified sign-in on one response, as the sign-in flow would store it.
  env.app.db.run('UPDATE responses SET respondent = ? WHERE id = ?', JSON.stringify({ issuer: 'https://idp.example.com', subject: 'student-7', email: 'lata@nxtwave.in', name: 'Lata M', verified_at: env.clock.now }), second[1].id);
  return { env, http, ws, forms, form, first, second, list: query => http.get(`${forms}/${form.id}/responses${query ? '?' + query : ''}`) };
}

test('search matches answers by the labels each version showed, ignoring case and accents, plus receipts and verified emails', async () => {
  const { env, list, first, second } = await world();
  try {
    const names = body => body.responses.map(row => row.answers.name);
    assert.deepEqual(names((await list('q=jose')).body), ['José Ramírez']);
    // "January" was the label in version 1; version 2 calls the same choice "Jan cohort".
    assert.deepEqual(names((await list('q=january')).body).sort(), ['Arjun Das', 'José Ramírez', 'Ravi Kumar']);
    assert.deepEqual(names((await list('q=cohort')).body).sort(), ['Kiran Shah', 'Nikhil Jain']);
    assert.deepEqual(names((await list('q=  RAO   july ')).body), ['Asha Rao']);
    assert.deepEqual(names((await list(`q=${first[3].reference.toLowerCase()}`)).body), ['Meera Iyer']);
    assert.deepEqual(names((await list('q=lata%40nxtwave.in')).body), ['Lata Menon']);
    const none = (await list('q=nobody')).body;
    assert.deepEqual(none.responses, []);
    assert.equal(none.matched, 0);
    assert.equal(none.form.response_count, 8, 'the total stays the whole form');
    assert.equal(second.length, 3);
    assert.equal((await list()).body.matched, undefined, 'no filter, no match count');
    assert.equal((await list('q=nobody')).body.has_verified, true, 'the sign-in filter is offered even when no loaded row is signed in');
  } finally { await env.close(); }
});

test('version, date and sign-in filters combine with search; paging stays inside the matches', async () => {
  const { env, list, first } = await world();
  try {
    const v2only = (await list('version=2')).body;
    assert.equal(v2only.matched, 3);
    assert.ok(v2only.responses.every(row => row.form_version === 2));
    const verified = (await list('signin=verified')).body;
    assert.deepEqual(verified.responses.map(row => row.respondent.email), ['lata@nxtwave.in']);
    assert.equal((await list('signin=anonymous')).body.matched, 7);
    // created_at of the third response onwards.
    const from = env.app.db.get('SELECT created_at FROM responses WHERE id = ?', first[2].id).created_at;
    assert.equal((await list(`from=${from}`)).body.matched, 6);
    assert.equal((await list(`from=${from}&version=1&q=jan`)).body.matched, 2);
    // Two per page through the five version-1 responses: no gaps, no repeats, never a version-2 row.
    const seen = [];
    let next = null;
    do {
      const page = (await list(`version=1&limit=2${next ? '&before=' + encodeURIComponent(next) : ''}`)).body;
      assert.equal(page.matched, 5);
      seen.push(...page.responses.map(row => row.id));
      next = page.next;
    } while (next);
    assert.equal(seen.length, 5);
    assert.equal(new Set(seen).size, 5);
    assert.deepEqual(new Set(seen), new Set(first.map(row => row.id)));
  } finally { await env.close(); }
});

test('bad filters are refused with the field named', async () => {
  const { env, list } = await world();
  try {
    for (const [query, field] of [['version=0', 'version'], ['version=x', 'version'], ['from=yesterday', 'from'], ['from=20&to=10', 'to'], ['signin=maybe', 'signin'], [`q=${'a'.repeat(201)}`, 'q']]) {
      const response = await list(query);
      assert.equal(response.status, 400, query);
      assert.equal(response.body.error.field, field, query);
    }
  } finally { await env.close(); }
});

test('CSV exports every response unless filtered; filtered files say so and keep the same columns', async () => {
  const { env, http, forms, form, ws } = await world();
  try {
    const all = await http.get(`${forms}/${form.id}/responses.csv`);
    assert.equal(all.headers.get('x-response-count'), '8');
    assert.match(all.headers.get('content-disposition'), /placement-check-in[^"]*-responses\.csv"/);
    assert.doesNotMatch(all.headers.get('content-disposition'), /filtered/);
    const filtered = await http.get(`${forms}/${form.id}/responses.csv?q=jan&version=1`);
    assert.equal(filtered.headers.get('x-response-count'), '3');
    assert.match(filtered.headers.get('content-disposition'), /-responses-filtered\.csv"/);
    const lines = text => text.trim().split('\r\n');
    assert.equal(lines(filtered.body).length, 4);
    assert.equal(lines(filtered.body)[0], lines(all.body)[0], 'same header row');
    assert.ok(lines(filtered.body).slice(1).every(line => line.includes('"January"')));
    // The verified columns appear because a response has them, kept apart from the answers.
    assert.match(lines(all.body)[0], /"Verified sign-in email","Verified sign-in subject"$/);
    // Other workspaces and signed-out visitors get nothing.
    const stranger = env.client();
    await signUp(stranger, 'Stranger');
    assert.equal((await stranger.get(`${forms}/${form.id}/responses?q=jan`)).status, 404);
    assert.equal((await stranger.get(`${forms}/${form.id}/responses.csv?q=jan`)).status, 404);
    assert.equal((await env.client().get(`/api/workspaces/${ws.id}/forms/${form.id}/responses?q=jan`)).status, 401);
  } finally { await env.close(); }
});
