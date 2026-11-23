import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup, signUp } from './helpers.mjs';

const draft = { title: 'Course enquiry', presentation: 'classic', fields: [{ id: 'need', type: 'long_text', label: 'What would you like to learn?', required: true }] };
function fake(app, result) {
  const calls = [];
  app.anthropic = { beta: { messages: { create: async request => {
    calls.push(request);
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(typeof result === 'function' ? result() : result) }], usage: { input_tokens: 120, output_tokens: 80 } };
  } } } };
  return calls;
}

test('AI creates validated unpublished drafts, measures tokens, retries safely and enforces a workspace budget', async () => {
  const env = await setup();
  try {
    const owner = env.client(); const { ws } = await signUp(owner, 'AI author');
    const base = `/api/workspaces/${ws.id}/forms`;
    assert.equal((await owner.post(base + '/ai-draft', { description: 'Create a course enquiry form' })).status, 503);
    const calls = fake(env.app, draft);
    const input = { description: 'Create a course enquiry form', request_id: randomUUID() };
    const first = await owner.post(base + '/ai-draft', input);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.form.published_version, null);
    assert.equal(first.body.usage.input_tokens, 120);
    assert.equal((await owner.post(base + '/ai-draft', input)).body.form.id, first.body.form.id);
    assert.equal(calls.length, 1);
    for (let index = 1; index < 10; index++) assert.equal((await owner.post(base + '/ai-draft', { ...input, request_id: randomUUID() })).status, 201);
    assert.equal((await owner.post(base + '/ai-draft', { ...input, request_id: randomUUID() })).status, 429);
    assert.equal((await owner.get(base + '/ai-usage')).body.remaining, 0);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM forms WHERE published_version IS NOT NULL').n, 0);
  } finally { await env.close(); }
});

test('bad PDF input and malformed AI definitions create no form; valid PDFs reach only the configured provider', async () => {
  const env = await setup();
  try {
    const owner = env.client(); const { ws } = await signUp(owner, 'AI PDF author');
    const path = `/api/workspaces/${ws.id}/forms/ai-draft`;
    const calls = fake(env.app, { title: 'Invalid', fields: [{ id: 'x', type: 'unknown' }] });
    const input = { description: 'Create a form from our brochure', request_id: randomUUID() };
    assert.equal((await owner.post(path, { ...input, pdf: Buffer.from('not a PDF').toString('base64') })).status, 400);
    assert.equal(calls.length, 0);
    assert.equal((await owner.post(path, input)).status, 502);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM forms').n, 0);
    const valid = fake(env.app, draft);
    assert.equal((await owner.post(path, { ...input, request_id: randomUUID(), pdf: Buffer.from('%PDF-1.4\nfixture').toString('base64') })).status, 201);
    assert.equal(valid[0].messages[0].content[0].type, 'document');
    assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM form_ai_requests WHERE status = ?', 'failed').n, 1);
  } finally { await env.close(); }
});

test('response summaries cite actual source responses and reject invented references', async () => {
  const env = await setup();
  try {
    const owner = env.client(); const { ws } = await signUp(owner, 'AI summary author');
    const base = `/api/workspaces/${ws.id}/forms`;
    const created = (await owner.post(base, { definition: draft })).body;
    await owner.post(`${base}/${created.id}/publish`);
    const response = await env.client().post(`/api/public/forms/${created.slug}/responses`, { answers: { need: 'I need help with weekend coding classes' }, submission_id: 'summary-source-one' });
    const path = `${base}/${created.id}/ai-summary`;
    const calls = fake(env.app, { themes: [{ label: 'Weekend classes', response_ids: [response.body.id] }] });
    const request_id = randomUUID();
    const result = await owner.post(path, { request_id });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.sampled, 1);
    assert.deepEqual(result.body.themes[0].response_ids, [response.body.id]);
    assert.equal((await owner.post(path, { request_id })).status, 200);
    assert.equal(calls.length, 1);
    fake(env.app, { themes: [{ label: 'Invented', response_ids: [randomUUID()] }] });
    assert.equal((await owner.post(path, { request_id: randomUUID() })).status, 502);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM responses').n, 1);
    assert.equal((await env.client().post(path, { request_id: randomUUID() })).status, 401);
  } finally { await env.close(); }
});
