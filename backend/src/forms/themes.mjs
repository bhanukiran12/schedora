// Reusable workspace themes (docs/FORMS.md, "Design and themes"). A theme here is only a starting
// point: applying one copies its values into a form's draft, so nothing in this file can change how
// a saved or published form looks.
import { randomUUID } from 'node:crypto';
import { fail } from '../http.mjs';
import { THEME_TOKENS, themeProblems } from '../shared/forms-logic.mjs';

export const MAX_THEMES = 50;

const view = row => ({ id: row.id, name: row.name, ...JSON.parse(row.tokens), revision: row.revision, updated_at: row.updated_at });

// Only the known values are kept, in a fixed order, and every value is checked against its allow-list.
function themeFrom(body) {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const tokens = Object.fromEntries(THEME_TOKENS.map(key => [key, typeof body?.[key] === 'string' ? body[key].toLowerCase() : body?.[key]]));
  const problems = themeProblems({ name, ...tokens });
  if (problems.length) fail(400, 'validation_failed', problems[0], { field: 'theme', problems });
  return { name, tokens };
}

export const listThemes = (app, workspaceId) => app.db.all('SELECT * FROM form_themes WHERE workspace_id = ? ORDER BY updated_at DESC, id DESC', workspaceId).map(view);

export function createTheme(app, workspaceId, userId, body) {
  const { name, tokens } = themeFrom(body);
  return app.db.transaction(() => {
    if (app.db.get('SELECT COUNT(*) AS count FROM form_themes WHERE workspace_id = ?', workspaceId).count >= MAX_THEMES) fail(409, 'theme_limit', `A workspace can keep up to ${MAX_THEMES} themes. Delete one to add another.`);
    const id = randomUUID();
    const now = app.now();
    app.db.run('INSERT INTO form_themes (id, workspace_id, name, tokens, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, workspaceId, name, JSON.stringify(tokens), userId, now, now);
    return view(app.db.get('SELECT * FROM form_themes WHERE id = ?', id));
  });
}

const stored = (app, workspaceId, id) => app.db.get('SELECT * FROM form_themes WHERE id = ? AND workspace_id = ?', id, workspaceId) || fail(404, 'not_found', 'Theme not found.');

// Saving over someone else's edit is refused, as drafts do; the reply carries the current theme.
export function updateTheme(app, workspaceId, id, body) {
  const { name, tokens } = themeFrom(body);
  return app.db.transaction(() => {
    const current = stored(app, workspaceId, id);
    if (body.base_revision != null && body.base_revision !== current.revision) fail(409, 'theme_conflict', 'Someone changed this theme after you opened it.', { current: view(current) });
    app.db.run('UPDATE form_themes SET name = ?, tokens = ?, revision = revision + 1, updated_at = ? WHERE id = ?', name, JSON.stringify(tokens), app.now(), id);
    return view(stored(app, workspaceId, id));
  });
}

export function deleteTheme(app, workspaceId, id) {
  stored(app, workspaceId, id);
  app.db.run('DELETE FROM form_themes WHERE id = ?', id);
}
