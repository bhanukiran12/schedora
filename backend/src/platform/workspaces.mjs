import { fail } from '../http.mjs';
import { email as validEmail, integer, invalid, oneOf, slug as validSlug, text } from '../validate.mjs';
import { createWorkspaceRecord } from './auth.mjs';
import { entitlementsFor } from '../billing/entitlements.mjs';

const ALL = ['owner', 'admin', 'member'];
const ADMINS = ['owner', 'admin'];

// Authorization matrix. Documented in docs/AUTHORIZATION.md; keep both in sync.
export const PERMISSIONS = {
  'workspace.read': ALL,
  'workspace.update': ADMINS,
  'workspace.delete': ['owner'],
  'members.manage': ADMINS,
  'billing.read': ADMINS,
  'billing.manage': ['owner'],
  'meet.manage_own': ALL,
  'meet.manage_all': ADMINS,
  'forms.manage': ALL,
  'responses.read': ALL,
  'responses.delete': ADMINS,
  'flows.read': ALL,
  'flows.manage': ADMINS,
  'tasks.manage': ALL,
  'emails.read': ALL,
  'contacts.read': ALL,
  'contacts.manage': ALL,
  'contacts.delete': ADMINS,
  'integrations.manage': ADMINS,
  'developer.manage': ADMINS,
  'audit.read': ADMINS
};

export const can = (role, permission) => PERMISSIONS[permission].includes(role);

// Resolves the caller's membership for a workspace. Non-members get 404 so workspace
// identifiers cannot be probed; members without the permission get 403.
export function requireMember(app, user, workspaceId, permission) {
  if (!user) fail(401, 'unauthenticated', 'Sign in to continue.');
  const row = typeof workspaceId === 'string' && app.db.get(`SELECT w.id, w.name, w.slug, w.retention_days, w.brand_color, w.logo, w.welcome_message, m.role
    FROM workspaces w JOIN memberships m ON m.workspace_id = w.id WHERE w.id = ? AND m.user_id = ?`, workspaceId, user.id);
  if (!row) fail(404, 'not_found', 'Workspace not found.');
  if (permission && !can(row.role, permission)) fail(403, 'forbidden', 'Your role does not allow this action.');
  return { workspace: { id: row.id, name: row.name, slug: row.slug, retention_days: row.retention_days, brand_color: row.brand_color, logo: row.logo, welcome_message: row.welcome_message }, role: row.role };
}

export function listWorkspaces(app, userId) {
  return app.db.all(`SELECT w.id, w.name, w.slug, w.retention_days, m.role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id
    WHERE m.user_id = ? ORDER BY w.created_at`, userId).map(row => ({ ...row, entitlements: entitlementsFor(app, row.id) }));
}

export function createWorkspace(app, user, body) {
  const name = text(body.name, 'name', { min: 1, max: 100 });
  const count = app.db.get('SELECT COUNT(*) AS count FROM memberships WHERE user_id = ?', user.id).count;
  if (count >= 20) fail(409, 'limit_reached', 'You can belong to at most 20 workspaces.');
  return app.db.transaction(() => createWorkspaceRecord(app, user.id, name));
}

const RESERVED_SLUGS = ['event-types', 'manage', 'new', 'bookings', 'pay', 'poll', 'polls', 'route', 'u', 'api', 'contacts', 'embed', 'room', 'join'];
const LOGO_MAX_BYTES = 200 * 1024;

export function updateWorkspace(app, workspaceId, body) {
  const changes = {};
  if (body.name !== undefined) changes.name = text(body.name, 'name', { min: 1, max: 100 });
  if (body.retention_days !== undefined) changes.retention_days = integer(body.retention_days, 'retention_days', 30, 3650);
  // Custom booking URL: /meet/<slug>
  if (body.slug !== undefined) {
    const value = validSlug(body.slug);
    if (RESERVED_SLUGS.includes(value)) invalid('slug', 'This address is reserved. Choose another.');
    if (app.db.get('SELECT 1 FROM workspaces WHERE slug = ? AND id <> ?', value, workspaceId)) invalid('slug', 'This address is already taken.');
    changes.slug = value;
  }
  if (body.brand_color !== undefined) {
    if (body.brand_color !== null && !/^#[0-9a-fA-F]{6}$/.test(body.brand_color)) invalid('brand_color', 'Use a hex color like #225C43.');
    changes.brand_color = body.brand_color;
  }
  if (body.welcome_message !== undefined) changes.welcome_message = text(body.welcome_message, 'welcome_message', { max: 500, multiline: true });
  // Logos are stored as small data URLs; SVG is refused because it can carry script.
  if (body.logo !== undefined) {
    if (body.logo !== null) {
      const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.logo));
      if (!match) invalid('logo', 'Upload a PNG, JPEG or WebP image.');
      if (Buffer.from(match[2], 'base64').length > LOGO_MAX_BYTES) invalid('logo', 'Use an image under 200 KB.');
    }
    changes.logo = body.logo;
  }
  for (const [column, value] of Object.entries(changes)) app.db.run(`UPDATE workspaces SET ${column} = ? WHERE id = ?`, value, workspaceId);
}

export function listMembers(app, workspaceId) {
  return app.db.all(`SELECT u.id, u.name, u.email, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ? ORDER BY m.created_at`, workspaceId);
}

// Adds an existing Schedora user by email. Invitation emails for people without accounts are not built yet.
export function addMember(app, actor, workspaceId, body) {
  const address = validEmail(body.email);
  const role = oneOf(body.role || 'member', 'role', ['admin', 'member']);
  if (role === 'admin' && actor.role !== 'owner') fail(403, 'forbidden', 'Only owners can add administrators.');
  const user = app.db.get('SELECT id FROM users WHERE email = ?', address);
  if (!user) fail(404, 'user_not_found', 'No Schedora account uses this email. Ask them to sign up first.', { field: 'email' });
  if (app.db.get('SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ?', workspaceId, user.id)) fail(409, 'already_member', 'This person is already a member.', { field: 'email' });
  app.db.run('INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)', workspaceId, user.id, role, app.now());
}

export function changeMember(app, actor, workspaceId, userId, body) {
  const target = app.db.get('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?', workspaceId, userId);
  if (!target) fail(404, 'not_found', 'Member not found.');
  const role = oneOf(body.role, 'role', ['owner', 'admin', 'member']);
  if ((role === 'owner' || target.role === 'owner' || role === 'admin') && actor.role !== 'owner') fail(403, 'forbidden', 'Only owners can change owner or administrator roles.');
  app.db.transaction(() => {
    app.db.run('UPDATE memberships SET role = ? WHERE workspace_id = ? AND user_id = ?', role, workspaceId, userId);
    assertOwnerRemains(app, workspaceId);
  });
}

export function removeMember(app, actor, workspaceId, userId) {
  const target = app.db.get('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?', workspaceId, userId);
  if (!target) fail(404, 'not_found', 'Member not found.');
  if (target.role !== 'member' && actor.role !== 'owner' && actor.userId !== userId) fail(403, 'forbidden', 'Only owners can remove administrators or owners.');
  app.db.transaction(() => {
    app.db.run('DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?', workspaceId, userId);
    assertOwnerRemains(app, workspaceId);
  });
}

function assertOwnerRemains(app, workspaceId) {
  if (!app.db.get("SELECT 1 FROM memberships WHERE workspace_id = ? AND role = 'owner'", workspaceId)) fail(409, 'owner_required', 'A workspace must keep at least one owner.');
}

export function deleteWorkspace(app, workspaceId, body, workspace) {
  if (body.confirm !== workspace.name) fail(400, 'validation_failed', 'Type the workspace name to confirm deletion.', { field: 'confirm' });
  app.db.run('DELETE FROM workspaces WHERE id = ?', workspaceId);
}
