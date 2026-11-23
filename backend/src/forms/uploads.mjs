import { createHash, randomBytes } from 'node:crypto';
import { fail } from '../http.mjs';
import { publishedForm, responseEditContext, editSubmissionId, VERSION_GRACE_MS } from './service.mjs';
import { requireEntitlement } from '../billing/entitlements.mjs';
import { assertFormAccess } from './respondents.mjs';
import { attachmentFilename } from './upload-storage.mjs';
import { FILE_LIMITS } from '../shared/forms-logic.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const identity = respondent => digest(JSON.stringify(respondent ? [respondent.issuer, respondent.subject, respondent.email] : null));
const fileRef = row => ({ id: row.id, name: row.filename });
const unavailable = () => fail(404, 'upload_not_found', 'This upload is unavailable. Choose the file again.');

function requireUploads(app) {
  if (!app.formUploads) fail(503, 'uploads_unavailable', 'File uploads are not connected on this server. Your other answers are still here.');
}

function grantRow(app, slug, id, token, request) {
  requireUploads(app);
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !/^[a-f0-9]{32}$/.test(id)) unavailable();
  const row = app.db.get('SELECT * FROM form_uploads WHERE id = ? AND token_hash = ?', id, digest(token));
  const form = app.db.get('SELECT * FROM forms WHERE slug = ?', slug);
  if (!form || !row || row.form_id !== form.id || form.published_version == null) unavailable();
  const respondent = assertFormAccess(app, request, form);
  if (row.respondent_hash !== identity(respondent)) unavailable();
  return row;
}

export const uploadToken = request => /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization || '')?.[1];

export function createUploadGrant(app, slug, body, request) {
  requireUploads(app);
  const edit = body.edit_key ? responseEditContext(app, slug, body.edit_key, request) : null;
  const form = edit ? { ...edit.form, respondent: null } : publishedForm(app, slug, request);
  if (edit && (body.version !== Number(edit.row.form_version) || body.submission_id !== editSubmissionId(edit.row.id))) fail(400, 'invalid_upload', 'Reload the response before uploading.');
  requireEntitlement(app, form.workspace_id, 'forms');
  if (typeof body.submission_id !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(body.submission_id) ||
    !Number.isInteger(body.version) || !Number.isSafeInteger(body.bytes) || body.bytes < 1 || body.bytes > FILE_LIMITS.bytes ||
    typeof body.filename !== 'string' || body.filename.length > 254) fail(400, 'invalid_upload', 'Choose a file up to 2 MB.');
  const version = app.db.get('SELECT definition FROM form_versions WHERE form_id = ? AND version = ?', form.id, body.version);
  const replaced = app.db.get('SELECT MIN(published_at) AS at FROM form_versions WHERE form_id = ? AND version > ?', form.id, body.version).at;
  if (!version || (!edit && body.version !== form.published_version && (replaced == null || app.now() - replaced > VERSION_GRACE_MS))) {
    fail(409, 'form_version_changed', 'This form changed. Reload it before uploading.');
  }
  const field = JSON.parse(version.definition).fields.find(field => field.id === body.field_id && field.type === 'file_upload');
  if (!field) fail(400, 'invalid_upload', 'Choose a file for an upload question in this form.');
  return app.db.transaction(() => {
    const perQuestion = app.db.get("SELECT COUNT(*) AS count FROM form_uploads WHERE form_id = ? AND field_id = ? AND submission_id = ? AND status IN ('issued', 'receiving', 'ready')",
      form.id, field.id, body.submission_id).count;
    if (Number(perQuestion) >= FILE_LIMITS.count) fail(409, 'upload_limit', 'Remove an existing file before adding another.');
    const used = app.db.get('SELECT COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS count FROM form_uploads WHERE workspace_id = ?', form.workspace_id);
    const total = app.db.get('SELECT COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS count FROM form_uploads');
    if (Number(used.bytes) + body.bytes > app.config.formUploadWorkspaceBytes || Number(used.count) >= 200 ||
      Number(total.bytes) + body.bytes > app.config.formUploadStorageBytes || Number(total.count) >= 2000) {
      fail(507, 'upload_storage_full', 'Attachment storage is full. Contact the form owner.');
    }
    const id = randomBytes(16).toString('hex');
    const token = randomBytes(32).toString('hex');
    const expires = app.now() + 300000;
    app.db.run(`INSERT INTO form_uploads
      (id, workspace_id, form_id, form_version, field_id, submission_id, respondent_hash, token_hash, filename, bytes, status, created_at, expires_at, updated_at, edit_response_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?, ?, ?)`,
      id, form.workspace_id, form.id, body.version, field.id, body.submission_id, identity(form.respondent), digest(token),
      attachmentFilename(body.filename), body.bytes, app.now(), expires, app.now(), edit?.row.id ?? null);
    return { id, token, expires_at: expires };
  });
}

export async function receiveUpload(app, slug, id, token, request) {
  const row = grantRow(app, slug, id, token, request);
  if (row.status !== 'issued' || row.expires_at <= app.now()) fail(409, 'upload_expired', 'This upload expired or already started. Remove it and choose the file again.');
  if (request.headers['content-type'] !== 'application/octet-stream') fail(415, 'invalid_upload', 'Send the file as binary data.');
  const claimed = app.db.transaction(() => {
    if (Number(app.db.get("SELECT COUNT(*) AS n FROM form_uploads WHERE status = 'receiving'").n) >= 1) fail(429, 'upload_busy', 'Other files are being checked. Try again shortly.');
    return app.db.run("UPDATE form_uploads SET status = 'receiving', updated_at = ? WHERE id = ? AND status = 'issued'", app.now(), row.id);
  });
  if (!claimed.changes) fail(409, 'upload_in_progress', 'This file is already uploading.');
  try {
    const result = await app.formUploads.receive(row.id, request, Number(row.bytes));
    const filename = attachmentFilename(row.filename, result.mime);
    const ready = app.db.transaction(() => app.db.run("UPDATE form_uploads SET status = 'ready', filename = ?, mime = ?, bytes = ?, updated_at = ? WHERE id = ? AND status = 'receiving'",
      filename, result.mime, result.bytes, app.now(), row.id));
    if (!ready.changes) fail(409, 'upload_expired', 'This upload expired. Choose the file again.');
    return { file: fileRef({ ...row, filename }) };
  } catch (error) {
    app.db.run("UPDATE form_uploads SET status = 'deletion_pending', updated_at = ? WHERE id = ? AND status <> 'attached'", app.now(), row.id);
    if (error.code === 'UPLOAD_SIZE') fail(413, 'upload_size', 'The file exceeded its declared size.');
    throw error;
  }
}

export function uploadStatus(app, slug, id, token, request) {
  const row = grantRow(app, slug, id, token, request);
  return { status: row.status, ...(row.status === 'ready' ? { file: fileRef(row) } : {}) };
}

export function discardUpload(app, slug, id, token, request) {
  const row = grantRow(app, slug, id, token, request);
  if (row.status === 'receiving') fail(409, 'upload_in_progress', 'Wait for this upload to finish before removing it.');
  if (row.status === 'attached') fail(409, 'upload_attached', 'This file belongs to an accepted response.');
  app.db.run("UPDATE form_uploads SET status = 'deletion_pending', updated_at = ? WHERE id = ? AND status <> 'attached'", app.now(), row.id);
  app.nudge?.();
  return { removed: true };
}

// Called inside the ordinary response transaction. A client cannot attach somebody else's object.
export function attachResponseUploads(app, form, version, answers, submissionId, respondent, responseId) {
  for (const field of version.definition.fields.filter(field => field.type === 'file_upload')) {
    for (const value of answers[field.id] || []) {
      requireUploads(app);
      const row = app.db.get('SELECT * FROM form_uploads WHERE id = ?', value.id);
      if (!row || row.form_id !== form.id || Number(row.form_version) !== Number(version.number) ||
        row.workspace_id !== form.workspace_id || row.field_id !== field.id || row.submission_id !== submissionId ||
        row.edit_response_id != null || row.respondent_hash !== identity(respondent) || row.filename !== value.name || row.status !== 'ready' ||
        app.now() - row.created_at > 86400000 || !app.formUploads.present(row.id, row.bytes)) {
        fail(400, 'validation_failed', 'Upload the file again before submitting.', { errors: { [field.id]: 'This file is unavailable. Remove it and upload it again.' } });
      }
      app.db.run("UPDATE form_uploads SET status = 'attached', response_id = ?, updated_at = ? WHERE id = ? AND status = 'ready'", responseId, app.now(), row.id);
    }
  }
}

export function replaceResponseUploads(app, form, response, definition, answers) {
  const wanted = new Set();
  for (const field of definition.fields.filter(field => field.type === 'file_upload')) {
    for (const value of answers[field.id] || []) {
      requireUploads(app);
      const row = app.db.get('SELECT * FROM form_uploads WHERE id = ?', value.id);
      const existing = row?.status === 'attached' && row.response_id === response.id;
      const added = row?.status === 'ready' && row.edit_response_id === response.id &&
        row.submission_id === editSubmissionId(response.id) && app.now() - row.created_at <= 86400000;
      if (!row || row.form_id !== form.id || row.workspace_id !== form.workspace_id ||
          Number(row.form_version) !== Number(response.form_version) || row.field_id !== field.id ||
          row.filename !== value.name || (!existing && !added) || !app.formUploads.present(row.id, row.bytes)) {
        fail(400, 'validation_failed', 'Check your attachments before saving.', { errors: { [field.id]: 'This file is unavailable. Remove it and upload it again.' } });
      }
      wanted.add(row.id);
      if (added) app.db.run("UPDATE form_uploads SET status = 'attached', response_id = ?, updated_at = ? WHERE id = ? AND status = 'ready'", response.id, app.now(), row.id);
    }
  }
  for (const row of app.db.all("SELECT id FROM form_uploads WHERE response_id = ? AND status = 'attached'", response.id)) {
    if (!wanted.has(row.id)) app.db.run("UPDATE form_uploads SET status = 'deletion_pending', updated_at = ? WHERE id = ? AND status = 'attached'", app.now(), row.id);
  }
}

export async function downloadUpload(app, workspaceId, formId, responseId, id) {
  requireUploads(app);
  const row = app.db.get(`SELECT u.* FROM form_uploads u JOIN responses r ON r.id = u.response_id
    WHERE u.id = ? AND u.response_id = ? AND u.workspace_id = ? AND r.workspace_id = ? AND r.form_id = ? AND u.status = 'attached'`,
    id, responseId, workspaceId, workspaceId, formId);
  if (!row) unavailable();
  let data;
  try { data = await app.formUploads.read(row.id); }
  catch { fail(503, 'attachment_unavailable', 'The attachment could not be read. Try again later.'); }
  return { raw: data, type: row.mime, headers: {
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(row.filename).replace(/['()*]/g, value => '%' + value.charCodeAt(0).toString(16))}`,
    'Content-Security-Policy': "default-src 'none'; sandbox"
  } };
}

// The ledger outlives deleted responses, forms and workspaces until physical deletion succeeds.
export async function pruneUploads(app) {
  if (!app.formUploads) return;
  app.db.transaction(() => {
    app.db.run(`UPDATE form_uploads SET status = 'deletion_pending' WHERE
      (status <> 'receiving' AND (
      (status = 'issued' AND expires_at <= ?) OR
      (status = 'ready' AND created_at < ?) OR
      NOT EXISTS (SELECT 1 FROM forms f WHERE f.id = form_uploads.form_id) OR
      (edit_response_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM responses r WHERE r.id = form_uploads.edit_response_id)) OR
      (response_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM responses r WHERE r.id = form_uploads.response_id))))
      OR (status = 'receiving' AND updated_at < ?)`,
      app.now(), app.now() - 86400000, app.now() - 1800000);
  });
  for (const row of app.db.all("SELECT id FROM form_uploads WHERE status = 'deletion_pending' ORDER BY created_at LIMIT 100")) {
    try {
      await app.formUploads.remove(row.id);
      app.db.run("DELETE FROM form_uploads WHERE id = ? AND status = 'deletion_pending'", row.id);
    } catch { app.log('warn', 'attachment_cleanup_retry'); }
  }
}
