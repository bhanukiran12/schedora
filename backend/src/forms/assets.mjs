// Host-authored form images (docs/FORMS.md, "Media"). Uploads are validated from their bytes and
// stored in the database, so no extra storage service or credential exists. Workspace members
// with forms.manage can read their workspace's images; the public route serves only images that
// a published version of a currently collecting form shows. Respondent uploads are not handled here.
import { createHash, randomBytes } from 'node:crypto';
import { fail } from '../http.mjs';
import { definitionAssets } from '../shared/forms-logic.mjs';
import { IMAGE_LIMITS, ImageError, inspectImage, storedBytes } from './images.mjs';
import { assertAuthoringOpen } from './freeze.mjs';

const DAY = 86400000;
const ASSET_ID = /^[a-f0-9]{32}$/;
const megabytes = bytes => `${Math.round(bytes / 1024 / 1024)} MB`;

export function uploadAsset(app, workspaceId, userId, body) {
  assertAuthoringOpen(app);
  if (typeof body?.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.data)) fail(400, 'validation_failed', 'Choose a JPEG, PNG or WebP image to upload.', { field: 'data' });
  let image;
  try { image = inspectImage(Buffer.from(body.data, 'base64')); }
  catch (error) { if (error instanceof ImageError) fail(400, 'invalid_image', error.message, { field: 'data' }); throw error; }
  const sha256 = createHash('sha256').update(image.data).digest('hex');
  return app.db.transaction(() => {
    // The same image uploaded again in this workspace reuses the stored copy.
    const existing = app.db.get('SELECT id, mime, width, height, bytes FROM form_assets WHERE workspace_id = ? AND sha256 = ?', workspaceId, sha256);
    if (existing) {
      // Restart the cleanup clock, so an old unused copy is not removed before the draft saves it.
      app.db.run('UPDATE form_assets SET created_at = ? WHERE id = ?', app.now(), existing.id);
      return { ...existing, reused: true };
    }
    const used = app.db.get('SELECT CAST(COALESCE(SUM(bytes), 0) AS BIGINT) AS total FROM form_assets WHERE workspace_id = ?', workspaceId).total;
    if (Number(used) + image.data.length > IMAGE_LIMITS.workspaceBytes) fail(413, 'asset_quota', `This workspace has used its ${megabytes(IMAGE_LIMITS.workspaceBytes)} of form images. Remove images from drafts you no longer need; unused images are cleared after a day.`);
    // Quotas are read and the row written inside one transaction; on PostgreSQL every transaction
    // holds the same advisory lock, so concurrent uploads cannot both pass the check.
    const total = app.db.get('SELECT CAST(COALESCE(SUM(bytes), 0) AS BIGINT) AS total FROM form_assets').total;
    const budget = app.config.formImageStorageBytes ?? IMAGE_LIMITS.instanceStoredBytes;
    if (storedBytes(Number(total)) + storedBytes(image.data.length) > budget) fail(507, 'asset_storage_full', 'Image storage is full right now. Nothing was uploaded; try again later.');
    const id = randomBytes(16).toString('hex');
    app.db.run('INSERT INTO form_assets (id, workspace_id, mime, width, height, bytes, sha256, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, workspaceId, image.mime, image.width, image.height, image.data.length, sha256, image.data.toString('base64'), userId, app.now());
    return { id, mime: image.mime, width: image.width, height: image.height, bytes: image.data.length, reused: false };
  });
}

const asImage = row => ({ raw: Buffer.from(row.data, 'base64'), type: row.mime });
const IMAGE_HEADERS = { 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin' };

export function workspaceAsset(app, workspaceId, id) {
  const row = ASSET_ID.test(id) && app.db.get('SELECT mime, data FROM form_assets WHERE id = ? AND workspace_id = ?', id, workspaceId);
  if (!row) fail(404, 'not_found', 'Image not found.');
  return { ...asImage(row), headers: { ...IMAGE_HEADERS, 'Cache-Control': 'private, max-age=300' } };
}

// Served without sign-in only while a version that shows it belongs to a form that is collecting.
// The same 404 covers unknown, draft-only, closed and other workspaces' images.
export function publicAsset(app, id) {
  const row = ASSET_ID.test(id) && app.db.get(`SELECT a.mime, a.data FROM form_assets a WHERE a.id = ? AND EXISTS (
    SELECT 1 FROM form_version_assets v JOIN forms f ON f.id = v.form_id WHERE v.asset_id = a.id AND f.workspace_id = a.workspace_id AND f.published_version IS NOT NULL)`, id);
  if (!row) fail(404, 'not_found', 'Image not found.');
  return { ...asImage(row), headers: { ...IMAGE_HEADERS, 'Cache-Control': 'public, max-age=3600' } };
}

/** Refuses a definition that shows an image this workspace does not own. */
export function assertDefinitionAssets(app, workspaceId, definition) {
  const ids = definitionAssets(definition);
  if (!ids.length) return;
  const found = new Set(app.db.all(`SELECT id FROM form_assets WHERE workspace_id = ? AND id IN (${ids.map(() => '?').join(', ')})`, workspaceId, ...ids).map(row => row.id));
  const missing = ids.filter(id => !found.has(id));
  if (missing.length) fail(400, 'validation_failed', 'An image in this form is not available in this workspace. Upload it again.', { field: 'definition', problems: ['An image in this form is not available in this workspace. Upload it again.'] });
}

/** Records the images a newly published version shows, so they outlive later draft edits. */
export function recordVersionAssets(app, formId, version, definition) {
  for (const id of definitionAssets(definition)) app.db.run('INSERT INTO form_version_assets (form_id, version, asset_id) VALUES (?, ?, ?)', formId, version, id);
}

/**
 * Removes images no draft or published version shows, a day after upload (so an image being added
 * to an unsaved draft is not removed). Deleting a form removes its versions' references; deleting
 * a workspace removes its images.
 */
export function pruneAssets(app) {
  return app.db.run(`DELETE FROM form_assets WHERE created_at < ?
    AND NOT EXISTS (SELECT 1 FROM form_version_assets v WHERE v.asset_id = form_assets.id)
    AND NOT EXISTS (SELECT 1 FROM forms f WHERE f.workspace_id = form_assets.workspace_id AND f.draft LIKE '%' || form_assets.id || '%')`, app.now() - DAY).changes;
}
