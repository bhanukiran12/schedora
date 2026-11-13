import { fail } from '../http.mjs';

function assertForm(app, workspaceId, formId) {
  if (!app.db.get('SELECT id FROM forms WHERE workspace_id = ? AND id = ?', workspaceId, formId)) {
    fail(404, 'not_found', 'Form not found.');
  }
}

export function getWorkbook(app, workspaceId, formId) {
  assertForm(app, workspaceId, formId);
  const row = app.db.get('SELECT revision, sheets FROM form_workbooks WHERE form_id = ?', formId);
  return row ? { revision: Number(row.revision), sheets: JSON.parse(row.sheets) } : { revision: 0, sheets: [] };
}

export function saveWorkbook(app, workspaceId, formId, input) {
  assertForm(app, workspaceId, formId);
  const { revision, sheets } = input ?? {};
  if (!Number.isSafeInteger(revision) || revision < 0 || !Array.isArray(sheets) || sheets.length > 12) {
    fail(400, 'validation_failed', 'Invalid workbook revision or sheet list.');
  }
  const ids = new Set();
  const names = new Set(['form responses']);
  const normalized = sheets.map(sheet => {
    const { id, cells } = sheet ?? {};
    const name = typeof sheet?.name === 'string' ? sheet.name.trim() : '';
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id) || ids.has(id) || !name || name.length > 60
        || names.has(name.toLowerCase()) || !cells || typeof cells !== 'object' || Array.isArray(cells)) {
      fail(400, 'validation_failed', 'Invalid or duplicate sheet.');
    }
    ids.add(id);
    names.add(name.toLowerCase());
    for (const [address, value] of Object.entries(cells)) {
      if (!/^[A-L](?:[1-9]|[1-4][0-9]|50)$/.test(address) || typeof value !== 'string' || value.length > 1000) {
        fail(400, 'validation_failed', 'Invalid cell address or value.');
      }
    }
    return { id, name, cells };
  });
  const payload = JSON.stringify(normalized);
  if (Buffer.byteLength(payload) > 1024 * 1024) fail(400, 'validation_failed', 'Workbook exceeds 1 MB.');
  const result = revision === 0
    ? app.db.run('INSERT INTO form_workbooks (form_id, revision, sheets) VALUES (?, 1, ?) ON CONFLICT (form_id) DO NOTHING', formId, payload)
    : app.db.run('UPDATE form_workbooks SET revision = revision + 1, sheets = ? WHERE form_id = ? AND revision = ?', payload, formId, revision);
  if (!result.changes) fail(409, 'workbook_conflict', 'Someone saved this workbook first. Reload before trying again.');
  return { revision: revision + 1, sheets: normalized };
}
