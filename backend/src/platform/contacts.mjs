import { randomUUID } from 'node:crypto';
import { fail } from '../http.mjs';
import { email as validEmail, invalid, text } from '../validate.mjs';
import { can } from './workspaces.mjs';

// Contacts are created and refreshed automatically from bookings and form responses.
export function upsertContact(app, workspaceId, { email, name, phone, ownerId }) {
  if (!email) return null;
  const now = app.now();
  const existing = app.db.get('SELECT id, name, phone, owner_id FROM contacts WHERE workspace_id = ? AND email = ?', workspaceId, email);
  if (existing) {
    app.db.run('UPDATE contacts SET name = ?, phone = ?, owner_id = ?, updated_at = ?, last_activity_at = ? WHERE id = ?',
      existing.name || name || '', existing.phone || phone || null, existing.owner_id || ownerId || null, now, now, existing.id);
    return existing.id;
  }
  const id = randomUUID();
  app.db.run('INSERT INTO contacts (id, workspace_id, email, name, phone, owner_id, created_at, updated_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, workspaceId, email, name || '', phone || null, ownerId || null, now, now, now);
  return id;
}

const present = row => row && { ...row, tags: JSON.parse(row.tags), custom: JSON.parse(row.custom) };

export function listContacts(app, workspaceId, { search, tag, limit = 100, offset = 0 } = {}) {
  const like = search ? `%${String(search).toLowerCase().slice(0, 100)}%` : null;
  return app.db.all(`SELECT c.*, u.name AS owner_name,
      (SELECT COUNT(*) FROM bookings b WHERE b.contact_id = c.id) AS meeting_count
    FROM contacts c LEFT JOIN users u ON u.id = c.owner_id
    WHERE c.workspace_id = ? AND (? IS NULL OR lower(c.email) LIKE ? OR lower(c.name) LIKE ? OR lower(c.company) LIKE ?)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(c.tags) WHERE json_each.value = ?))
    ORDER BY coalesce(c.last_activity_at, c.created_at) DESC LIMIT ? OFFSET ?`,
  workspaceId, like, like, like, like, tag ?? null, tag ?? null, Math.min(200, Number(limit) || 100), Number(offset) || 0).map(present);
}

export function getContact(app, workspaceId, id) {
  const contact = present(app.db.get('SELECT c.*, u.name AS owner_name FROM contacts c LEFT JOIN users u ON u.id = c.owner_id WHERE c.id = ? AND c.workspace_id = ?', id, workspaceId));
  if (!contact) fail(404, 'not_found', 'Contact not found.');
  return {
    ...contact,
    meetings: app.db.all(`SELECT b.id, b.reference, b.status, b.starts_at, b.ends_at, b.answers, e.title AS event_title, u.name AS host_name
      FROM bookings b JOIN event_types e ON e.id = b.event_type_id JOIN users u ON u.id = b.host_id
      WHERE b.workspace_id = ? AND b.contact_id = ? ORDER BY b.starts_at DESC LIMIT 100`, workspaceId, id).map(row => ({ ...row, answers: JSON.parse(row.answers) })),
    responses: app.db.all(`SELECT r.id, r.form_id, r.created_at, f.draft FROM responses r JOIN forms f ON f.id = r.form_id
      WHERE r.workspace_id = ? AND r.contact_id = ? ORDER BY r.created_at DESC LIMIT 50`, workspaceId, id).map(row => ({ id: row.id, form_id: row.form_id, created_at: row.created_at, form_title: JSON.parse(row.draft).title })),
    notes: app.db.all(`SELECT n.id, n.body, n.created_at, u.name AS author_name FROM contact_notes n LEFT JOIN users u ON u.id = n.author_id
      WHERE n.contact_id = ? ORDER BY n.created_at DESC`, id),
    tasks: app.db.all('SELECT id, title, details, status, due_at, created_at FROM tasks WHERE workspace_id = ? AND contact_id = ? ORDER BY created_at DESC', workspaceId, id)
  };
}

export function createContact(app, workspaceId, body) {
  const address = validEmail(body.email);
  if (app.db.get('SELECT 1 FROM contacts WHERE workspace_id = ? AND email = ?', workspaceId, address)) invalid('email', 'A contact with this email already exists.');
  const id = upsertContact(app, workspaceId, { email: address, name: text(body.name, 'name', { max: 100 }) });
  return updateContact(app, workspaceId, id, body);
}

export function updateContact(app, workspaceId, id, body) {
  const contact = getContact(app, workspaceId, id);
  const value = {
    name: body.name !== undefined ? text(body.name, 'name', { max: 100 }) : contact.name,
    company: body.company !== undefined ? text(body.company, 'company', { max: 150 }) : contact.company,
    phone: body.phone !== undefined ? text(body.phone, 'phone', { max: 30 }) || null : contact.phone,
    owner_id: body.owner_id !== undefined ? body.owner_id || null : contact.owner_id,
    tags: body.tags !== undefined ? normalizeTags(body.tags) : contact.tags,
    custom: body.custom !== undefined ? normalizeCustom(body.custom) : contact.custom
  };
  if (value.owner_id && !app.db.get('SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ?', workspaceId, value.owner_id)) invalid('owner_id', 'Owner must be a workspace member.');
  app.db.run('UPDATE contacts SET name = ?, company = ?, phone = ?, owner_id = ?, tags = ?, custom = ?, updated_at = ? WHERE id = ?',
    value.name, value.company, value.phone, value.owner_id, JSON.stringify(value.tags), JSON.stringify(value.custom), app.now(), id);
  return getContact(app, workspaceId, id);
}

function normalizeTags(tags) {
  if (!Array.isArray(tags) || tags.length > 20) invalid('tags', 'Use up to 20 tags.');
  return [...new Set(tags.map((tag, index) => text(tag, `tags.${index}`, { min: 1, max: 40 }).toLowerCase()))];
}
function normalizeCustom(custom) {
  if (!custom || typeof custom !== 'object' || Array.isArray(custom) || Object.keys(custom).length > 30) invalid('custom', 'Use up to 30 custom fields.');
  return Object.fromEntries(Object.entries(custom).map(([key, value]) => [text(key, 'custom', { min: 1, max: 50 }), text(String(value ?? ''), 'custom', { max: 500 })]));
}

export function deleteContact(app, workspaceId, id) {
  getContact(app, workspaceId, id);
  app.db.run('UPDATE bookings SET contact_id = NULL WHERE contact_id = ?', id);
  app.db.run('UPDATE responses SET contact_id = NULL WHERE contact_id = ?', id);
  app.db.run('DELETE FROM contacts WHERE id = ?', id);
}

export function addNote(app, workspaceId, actor, id, body) {
  getContact(app, workspaceId, id);
  app.db.run('INSERT INTO contact_notes (id, contact_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)', randomUUID(), id, actor.userId, text(body.body, 'body', { min: 1, max: 5000, multiline: true }), app.now());
  return getContact(app, workspaceId, id);
}

export function deleteNote(app, workspaceId, actor, contactId, noteId) {
  getContact(app, workspaceId, contactId);
  const note = app.db.get('SELECT author_id FROM contact_notes WHERE id = ? AND contact_id = ?', noteId, contactId);
  if (!note) fail(404, 'not_found', 'Note not found.');
  if (note.author_id !== actor.userId && !can(actor.role, 'meet.manage_all')) fail(403, 'forbidden', 'Only the author or an administrator can delete this note.');
  app.db.run('DELETE FROM contact_notes WHERE id = ?', noteId);
}

// Follow-up reminder: a task linked to the contact, optionally due at a time and assigned.
export function addFollowUp(app, workspaceId, actor, id, body) {
  getContact(app, workspaceId, id);
  const dueAt = body.due_at ? Date.parse(body.due_at) : null;
  if (body.due_at && !Number.isFinite(dueAt)) invalid('due_at', 'Choose a valid date and time.');
  app.db.run("INSERT INTO tasks (id, workspace_id, title, details, status, created_at, contact_id, due_at, assignee_id) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)",
    randomUUID(), workspaceId, text(body.title, 'title', { min: 1, max: 200 }), text(body.details, 'details', { max: 2000, multiline: true }), app.now(), id, dueAt, actor.userId);
  return getContact(app, workspaceId, id);
}

