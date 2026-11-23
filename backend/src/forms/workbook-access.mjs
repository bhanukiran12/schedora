import { fail } from '../http.mjs';
import { blankSheet } from '../shared/workbook-ops.mjs';

export function standaloneWorkbook(app, actor, id, permission = 'read') {
  const row = app.db.get(`SELECT w.owner_id, w.title, a.role AS shared_role FROM workbooks w
    LEFT JOIN workbook_access a ON a.workbook_id = w.id AND a.user_id = ?
    WHERE w.workspace_id = ? AND w.id = ? AND NOT EXISTS (SELECT 1 FROM workbook_trash t WHERE t.workbook_id=w.id)`, actor.userId, actor.workspace.id, id);
  if (!row) fail(404, 'not_found', 'Workbook not found.');
  const role = row.owner_id === actor.userId ? 'owner' : row.shared_role;
  if (!role) fail(404, 'not_found', 'Workbook not found.');
  if ((permission === 'edit' && role === 'viewer') || (permission === 'share' && role !== 'owner')) fail(403, 'permission_denied', 'Your workbook role does not allow that action.');
  return { id, title: row.title, role };
}

export function listStandaloneWorkbooks(app, actor) {
  return { workbooks: app.db.all(`SELECT w.id, w.title, CASE WHEN w.owner_id = ? THEN 'owner' ELSE a.role END AS role
    FROM workbooks w LEFT JOIN workbook_access a ON a.workbook_id = w.id AND a.user_id = ?
    WHERE w.workspace_id = ? AND (w.owner_id = ? OR a.user_id IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM workbook_trash t WHERE t.workbook_id=w.id)
    ORDER BY w.created_at DESC, w.id LIMIT 200`, actor.userId, actor.userId, actor.workspace.id, actor.userId) };
}

export function createStandaloneWorkbook(app, actor, input) {
  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > 100) fail(400, 'validation_failed', 'Enter a workbook name of 1–100 characters.');
  const id = crypto.randomUUID();
  const sheet = blankSheet(crypto.randomUUID().replaceAll('-', ''), 'Sheet1');
  app.db.run('INSERT INTO workbooks (id, workspace_id, owner_id, title, revision, sheets, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
    id, actor.workspace.id, actor.userId, title, JSON.stringify([sheet]), app.now());
  return { id, title, role: 'owner' };
}

export function renameStandaloneWorkbook(app,actor,id,input){
  standaloneWorkbook(app,actor,id,'edit');
  const title=typeof input?.title==='string'?input.title.trim():'';
  if(!title||title.length>100)fail(400,'validation_failed','Enter a workbook name of 1–100 characters.');
  app.db.run('UPDATE workbooks SET title = ? WHERE id = ? AND workspace_id = ?',title,id,actor.workspace.id);
  return {id,title};
}

export function workbookAccessList(app, actor, id) {
  standaloneWorkbook(app, actor, id, 'share');
  return { members: app.db.all(`SELECT u.id, u.name, u.email, a.role FROM memberships m
    JOIN users u ON u.id = m.user_id LEFT JOIN workbook_access a ON a.user_id = m.user_id AND a.workbook_id = ?
    WHERE m.workspace_id = ? AND m.user_id <> ? ORDER BY u.name, u.id LIMIT 200`, id, actor.workspace.id, actor.userId) };
}

export function setWorkbookAccess(app, actor, id, input) {
  const { user, role } = input ?? {};
  if (typeof user !== 'string' || user === actor.userId || !['viewer', 'editor', null].includes(role)) fail(400, 'validation_failed', 'Choose another member and a workbook role.');
  return app.db.transaction(() => {
    standaloneWorkbook(app, actor, id, 'share');
    if (!app.db.get('SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ?', actor.workspace.id, user)) fail(404, 'not_found', 'Workspace member not found.');
    if (role === null) app.db.run('DELETE FROM workbook_access WHERE workbook_id = ? AND user_id = ?', id, user);
    else app.db.run('INSERT INTO workbook_access (workbook_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT (workbook_id, user_id) DO UPDATE SET role = excluded.role', id, user, role);
    return { user, role };
  });
}

export function listWorkbookTrash(app,actor){return {workbooks:app.db.all('SELECT w.id,w.title,t.trashed_at FROM workbook_trash t JOIN workbooks w ON w.id=t.workbook_id WHERE w.workspace_id = ? AND w.owner_id = ? ORDER BY t.trashed_at DESC LIMIT 200',actor.workspace.id,actor.userId)}};
export function setWorkbookTrash(app,actor,id,{trashed}={}){
  if(typeof trashed!=='boolean')fail(400,'validation_failed','Choose whether to move to trash or restore.');
  return app.db.transaction(()=>{
    const row=app.db.get('SELECT owner_id FROM workbooks WHERE id = ? AND workspace_id = ?',id,actor.workspace.id);
    if(!row||row.owner_id!==actor.userId)fail(404,'not_found','Workbook not found.');
    if(trashed)app.db.run('INSERT INTO workbook_trash (workbook_id,trashed_at) VALUES (?,?) ON CONFLICT (workbook_id) DO NOTHING',id,app.now());
    else app.db.run('DELETE FROM workbook_trash WHERE workbook_id = ?',id);
    return {id,trashed};
  });
}
