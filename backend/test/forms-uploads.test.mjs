import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, signUp } from './helpers.mjs';
import { pruneUploads } from '../src/forms/uploads.mjs';

const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
const submission = 'upload-test-submission-123';
const definition = {
  title: 'Project brief', presentation: 'classic', responses: { allow_edit: true },
  fields: [{ id: 'note', type: 'short_text', label: 'Notes' }, { id: 'files', type: 'file_upload', label: 'Brief', required: true }]
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'schedora-private-upload-'));
  let scanMode = 'ok';
  const env = await setup({
    config: { formUploadDirectory: root, formUploadScanner: process.execPath },
    formUploadScan: async path => {
      assert.ok((await readFile(path)).length > 0, 'the test scanner reads actual bytes from quarantine');
      if (scanMode !== 'ok') throw Object.assign(new Error('test scanner result'), { code: scanMode === 'infected' ? 1 : 2 });
    }
  });
  const owner = env.client();
  const { ws } = await signUp(owner, 'Attachments Owner');
  const forms = '/api/workspaces/' + ws.id + '/forms';
  const created = await owner.post(forms, { definition });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const form = forms + '/' + created.body.id;
  assert.equal((await owner.post(form + '/publish')).status, 200);
  const publicPath = '/api/public/forms/' + created.body.slug;
  const visitor = env.client();
  const grant = (extra = {}) => visitor.post(publicPath + '/uploads', {
    submission_id: submission, version: 1, field_id: 'files', filename: 'brief.pdf', bytes: pdf.length, ...extra
  });
  const upload = async (grant, bytes = pdf) => {
    const response = await fetch(env.base + publicPath + '/uploads/' + grant.id, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ' + grant.token }, body: bytes
    });
    return { status: response.status, body: await response.json() };
  };
  return { ...env, root, owner, visitor, ws, forms, form, publicPath, grant, upload,
    scanMode: value => { scanMode = value; },
    close: async () => { await env.close(); await rm(root, { recursive: true, force: true }); }
  };
}

test('attachments use private files, attach once, and require response permission for downloads (test scanner)', async () => {
  const env = await fixture();
  try {
    const grant = await env.grant({ filename: '../../my brief.html' });
    assert.equal(grant.status, 201);
    const pending = await env.visitor.post(env.publicPath + '/uploads/' + grant.body.id + '/status', {}, { Authorization: 'Bearer ' + grant.body.token });
    assert.equal(pending.status, 200);
    assert.equal(pending.body.status, 'issued');
    const accepted = await env.upload(grant.body);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));

    assert.equal(accepted.body.file.name, '_.._my brief.pdf');
    assert.equal((await env.upload(grant.body)).status, 409, 'the grant cannot overwrite accepted bytes');
    const status = await env.visitor.post(env.publicPath + '/uploads/' + grant.body.id + '/status', {}, { Authorization: 'Bearer ' + grant.body.token });
    assert.deepEqual(status.body.file, accepted.body.file, 'an interrupted reply recovers the already uploaded file');
    const wrong = await env.visitor.post(env.publicPath + '/responses', { version: 1, submission_id: 'another-submission-123', answers: { files: [accepted.body.file] } });
    assert.equal(wrong.status, 400, 'a file belongs to one submission');
    const sent = { version: 1, submission_id: submission, answers: { note: 'Keep this note', files: [accepted.body.file] } };
    const received = await env.visitor.post(env.publicPath + '/responses', sent);
    assert.equal(received.status, 201, JSON.stringify(received.body));
    assert.equal((await env.visitor.post(env.publicPath + '/responses', sent)).status, 200);
    const download = env.form + '/responses/' + received.body.id + '/files/' + accepted.body.file.id;
    assert.equal((await env.visitor.get(download)).status, 401);
    const own = await env.owner.get(download);
    assert.equal(own.status, 200);
    assert.equal(own.body, pdf.toString());
    assert.equal(own.headers.get('cache-control'), 'private, no-store');
    assert.match(own.headers.get('content-disposition'), /^attachment;/);
    const outsider = env.client();
    const { ws: other } = await signUp(outsider, 'Other Attachments Owner');
    assert.equal((await outsider.get(download)).status, 404);
    const foreign = '/api/workspaces/' + other.id + '/forms/' + env.form.split('/').at(-1) + '/responses/' + received.body.id + '/files/' + accepted.body.file.id;
    assert.equal((await outsider.get(foreign)).status, 404);
    const secondForm = await env.owner.post(env.forms, { title: 'Other form' });
    const wrongForm = env.forms + '/' + secondForm.body.id + '/responses/' + received.body.id + '/files/' + accepted.body.file.id;
    assert.equal((await env.owner.get(wrongForm)).status, 404);
    assert.deepEqual((await readdir(env.root)), [accepted.body.file.id + '.file']);
    const workbook = (await env.owner.get(env.form + '/workbook/responses')).body;
    assert.equal(workbook.rows[0].at(-1), accepted.body.file.name);
    assert.ok(!(await env.owner.get(env.form + '/responses.csv')).body.includes(grant.body.token), 'CSV contains filenames, never upload secrets');
    assert.equal((await env.owner.del(env.form + '/responses/' + received.body.id)).status, 204);
    assert.equal((await env.owner.get(download)).status, 404, 'access ends immediately after response deletion');
    await pruneUploads(env.app);
    assert.deepEqual(await readdir(env.root), []);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM form_uploads').n, 0);
  } finally { await env.close(); }
});

test('grants bound question and size, enforce quotas and expiry, and retain quota until files are deleted', async () => {
  const env = await fixture();
  try {
    assert.equal((await env.grant({ field_id: 'note' })).status, 400);
    assert.equal((await env.grant({ version: 99 })).status, 409);
    assert.equal((await env.grant({ bytes: 2 * 1024 * 1024 + 1 })).status, 400);
    const grants = await Promise.all([env.grant(), env.grant(), env.grant()]);
    assert.deepEqual(grants.map(result => result.status).sort(), [201, 201, 409]);
    const one = grants.find(result => result.status === 201).body;
    env.clock.now += 300001;
    assert.equal((await env.upload(one)).status, 409);
    const storage = env.app.formUploads;
    env.app.formUploads = { ...storage, remove: async () => { throw new Error('temporary object deletion failure'); } };
    await pruneUploads(env.app);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM form_uploads').n, 2, 'failed cleanup keeps reservation');
    env.app.formUploads = storage;
    await pruneUploads(env.app);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM form_uploads').n, 0);
    env.app.config.formUploadWorkspaceBytes = pdf.length;
    assert.equal((await env.grant()).status, 201);
    assert.equal((await env.grant({ submission_id: 'other-submission-456' })).status, 507);
  } finally { await env.close(); }
});

test('invalid content, changed size and failed scanner results never become accepted attachments', async () => {
  const env = await fixture();
  try {
    const invalid = Buffer.from('<svg onload="alert(1)"></svg>');
    const fakeImage = await env.grant({ bytes: invalid.length, filename: 'fake.png' });
    assert.equal((await env.upload(fakeImage.body, invalid)).status, 400);
    const failed = await env.visitor.post(env.publicPath + '/uploads/' + fakeImage.body.id + '/status', {}, { Authorization: 'Bearer ' + fakeImage.body.token });
    assert.equal(failed.status, 200);
    assert.equal(failed.body.status, 'deletion_pending');
    const short = await env.grant();
    assert.equal((await env.upload(short.body, pdf.subarray(0, 10))).status, 400);
    await pruneUploads(env.app);
    env.scanMode('infected');
    const infected = await env.grant();
    assert.equal((await env.upload(infected.body)).body.error.code, 'file_rejected');
    await pruneUploads(env.app);
    env.scanMode('offline');
    const unavailable = await env.grant();
    assert.equal((await env.upload(unavailable.body)).status, 503);
    assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM form_uploads WHERE status = 'ready'").n, 0);
    const missing = await env.visitor.post(env.publicPath + '/responses', { answers: {} });
    assert.equal(missing.status, 400);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM responses').n, 0);
    await pruneUploads(env.app);
    assert.deepEqual(await readdir(env.root), []);
  } finally { await env.close(); }
});

test('a server without private storage and scanner cannot publish an enabled upload question', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner);
    const forms = '/api/workspaces/' + ws.id + '/forms';
    const created = await owner.post(forms, { definition });
    assert.equal(created.status, 201);
    assert.equal((await owner.post(forms + '/' + created.body.id + '/publish')).status, 503);
    assert.equal((await owner.get('/api/config')).body.formUploads, false);
  } finally { await env.close(); }
});

test('upload grants are scoped, concurrent reservations stay within quota, and streamed overflow is rejected', async () => {
  const env = await fixture();
  try {
    assert.equal((await env.grant({ field_id: 'note' })).status, 400);
    assert.equal((await env.grant({ version: 99 })).status, 409);
    const issued = await env.grant();
    const forged = await env.visitor.post(env.publicPath + '/uploads/' + issued.body.id + '/status', {}, { Authorization: 'Bearer ' + 'a'.repeat(64) });
    assert.equal(forged.status, 404);
    const { Readable } = await import('node:stream');
    const overflow = await fetch(env.base + env.publicPath + '/uploads/' + issued.body.id, {
      method: 'PUT', headers: { Authorization: 'Bearer ' + issued.body.token, 'Content-Type': 'application/octet-stream' },
      body: Readable.from([pdf, pdf]), duplex: 'half'
    });
    assert.equal(overflow.status, 413);
    await pruneUploads(env.app);
    env.app.config.formUploadWorkspaceBytes = pdf.length;
    const raced = await Promise.all([env.grant(), env.grant({ submission_id: 'a-different-racing-attempt' })]);
    assert.deepEqual(raced.map(result => result.status).sort(), [201, 507]);
    assert.equal(Number(env.app.db.get('SELECT SUM(bytes) AS bytes FROM form_uploads').bytes), pdf.length);
  } finally { await env.close(); }
});

test('an earlier published file question keeps its bound upload during the version grace window', async () => {
  const env = await fixture();
  try {
    const issue = await env.grant();
    const accepted = await env.upload(issue.body);
    assert.equal(accepted.status, 200);
    const current = await env.owner.get(env.form);
    const update = await env.owner.patch(env.form, {
      revision: current.body.revision,
      definition: { title: 'Updated form', presentation: 'classic', fields: [{ id: 'note', type: 'short_text', label: 'New notes' }] }
    });
    assert.equal(update.status, 200, JSON.stringify(update.body));
    assert.equal((await env.owner.post(env.form + '/publish')).status, 200);
    const oldPage = await env.visitor.post(env.publicPath + '/responses', {
      version: 1, submission_id: submission, answers: { files: [accepted.body.file] }
    });
    assert.equal(oldPage.status, 201, JSON.stringify(oldPage.body));
    assert.equal(oldPage.body.version, 1);
    const download = await env.owner.get(env.form + '/responses/' + oldPage.body.id + '/files/' + accepted.body.file.id);
    assert.equal(download.status, 200);
  } finally { await env.close(); }
});


test('response edits retain and replace private files atomically without adding another submission', async () => {
  const env = await fixture();
  try {
    const { createHash, randomBytes } = await import('node:crypto');
    const key = randomBytes(32).toString('hex');
    const edit_key_hash = createHash('sha256').update(key).digest('hex');
    const first = (await env.grant()).body;
    const file = (await env.upload(first)).body.file;
    const accepted = await env.visitor.post(env.publicPath + '/responses', {
      version: 1, submission_id: submission, edit_key_hash, answers: { note: 'Original note', files: [file] }
    });
    assert.equal(accepted.body.can_edit, true, JSON.stringify(accepted.body));
    const endpoint = env.publicPath + '/response-edit';
    const read = await env.visitor.post(endpoint, { key });
    assert.equal(read.status, 200);
    const oldDownload = env.form + '/responses/' + accepted.body.id + '/files/' + file.id;
    const kept = await env.visitor.patch(endpoint, { key, revision: 0, answers: { note: 'Updated note', files: [file] } });
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    assert.equal((await env.owner.get(oldDownload)).status, 200);
    const replacement = await env.grant({ edit_key: key, submission_id: read.body.upload_submission_id, filename: 'replacement.pdf' });
    assert.equal(replacement.status, 201, JSON.stringify(replacement.body));
    const replacementFile = (await env.upload(replacement.body)).body.file;
    const signature = (await env.owner.get(env.form + '/workbook/responses')).body.signature;
    const saveBody = { key, revision: 1, answers: { note: 'Final note', files: [replacementFile] } };
    const replaced = await env.visitor.patch(endpoint, saveBody);
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    assert.equal(replaced.body.id, accepted.body.id);
    assert.equal(replaced.body.created_at, accepted.body.created_at);
    assert.equal((await env.visitor.patch(endpoint, saveBody)).body.revision, 2, 'retry does not attach twice');
    assert.equal((await env.visitor.patch(endpoint, { key, revision: 1, answers: { note: 'Stale edit', files: [file] } })).status, 409);
    assert.equal((await env.owner.get(oldDownload)).status, 404, 'removed file loses access as soon as the edit saves');
    assert.equal((await env.owner.get(env.form + '/responses/' + accepted.body.id + '/files/' + replacementFile.id)).status, 200);
    const grid = (await env.owner.get(env.form + '/workbook/responses')).body;
    assert.notEqual(grid.signature, signature);
    assert.equal(grid.total, 1);
    assert.equal(grid.rows[0].at(-1), 'replacement.pdf');
    assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM outbox WHERE type = 'forms.response.created'").n, 1);
    await pruneUploads(env.app);
    assert.deepEqual(await readdir(env.root), [replacementFile.id + '.file']);
    assert.equal((await env.visitor.post(env.publicPath + '/responses', {
      version: 1, submission_id: submission, edit_key_hash, answers: { note: 'Original note', files: [file] }
    })).body.replay, true, 'the initial request remains replayable after edits and file removal');
  } finally { await env.close(); }
});

