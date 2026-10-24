import { randomUUID } from 'node:crypto';
import { fail } from '../http.mjs';
import { isValidDate, isValidTimeZone } from '../time.mjs';
import { bool, integer, invalid, slug as validSlug, slugify, text } from '../validate.mjs';
import { can } from '../platform/workspaces.mjs';

const COLUMNS = ['title', 'slug', 'description', 'location', 'duration_min', 'slot_interval_min', 'timezone', 'min_notice_min', 'horizon_days', 'buffer_before_min', 'buffer_after_min', 'reminder_min', 'published', 'host_id'];

function normalize(app, workspaceId, body, current, actor) {
  const value = { ...current };
  if (!current || body.title !== undefined) value.title = text(body.title, 'title', { min: 1, max: 120 });
  if (body.slug !== undefined || !current) value.slug = body.slug ? validSlug(body.slug) : slugify(value.title);
  if (body.description !== undefined || !current) value.description = text(body.description, 'description', { max: 2000, multiline: true });
  if (body.location !== undefined || !current) value.location = text(body.location, 'location', { max: 300 });
  if (body.duration_min !== undefined || !current) value.duration_min = integer(body.duration_min ?? 30, 'duration_min', 5, 720);
  if (body.slot_interval_min !== undefined || !current) value.slot_interval_min = integer(body.slot_interval_min ?? value.duration_min, 'slot_interval_min', 5, 720);
  if (body.timezone !== undefined || !current) {
    if (!isValidTimeZone(body.timezone)) invalid('timezone', 'Choose a valid IANA time zone, such as Asia/Kolkata.');
    value.timezone = body.timezone;
  }
  for (const [field, min, max, fallback] of [['min_notice_min', 0, 43200, 240], ['horizon_days', 1, 365, 60], ['buffer_before_min', 0, 240, 0], ['buffer_after_min', 0, 240, 0]]) {
    if (body[field] !== undefined || !current) value[field] = integer(body[field] ?? fallback, field, min, max);
  }
  if (body.reminder_min !== undefined) value.reminder_min = body.reminder_min === null ? null : integer(body.reminder_min, 'reminder_min', 10, 10080);
  else if (!current) value.reminder_min = 1440;
  if (body.published !== undefined) value.published = bool(body.published, 'published') ? 1 : 0;
  else value.published = value.published ? 1 : 0;
  if (body.host_id !== undefined && body.host_id !== value.host_id) {
    if (!can(actor.role, 'meet.manage_all')) fail(403, 'forbidden', 'Only administrators can assign another host.');
    if (!app.db.get('SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ?', workspaceId, body.host_id)) invalid('host_id', 'Host must be a workspace member.');
    value.host_id = body.host_id;
  }
  return value;
}

function normalizeRules(rules) {
  if (!Array.isArray(rules) || rules.length > 70) invalid('rules', 'Provide up to 70 weekly time ranges.');
  const result = rules.map((rule, index) => ({
    weekday: integer(rule?.weekday, `rules.${index}.weekday`, 0, 6),
    start_min: integer(rule?.start_min, `rules.${index}.start_min`, 0, 1439),
    end_min: integer(rule?.end_min, `rules.${index}.end_min`, 1, 1440)
  }));
  for (const rule of result) if (rule.end_min <= rule.start_min) invalid('rules', 'Each range must end after it starts.');
  assertNoOverlap(result, rule => rule.weekday, 'rules');
  return result;
}

function normalizeOverrides(overrides) {
  if (!Array.isArray(overrides) || overrides.length > 400) invalid('overrides', 'Provide up to 400 date exceptions.');
  const result = overrides.map((override, index) => {
    if (!isValidDate(override?.date)) invalid(`overrides.${index}.date`, 'Use a YYYY-MM-DD date.');
    if (override.unavailable) return { date: override.date, start_min: null, end_min: null };
    const start = integer(override.start_min, `overrides.${index}.start_min`, 0, 1439);
    const end = integer(override.end_min, `overrides.${index}.end_min`, 1, 1440);
    if (end <= start) invalid('overrides', 'Each range must end after it starts.');
    return { date: override.date, start_min: start, end_min: end };
  });
  const dates = new Map();
  for (const override of result) {
    const kind = override.start_min == null ? 'off' : 'hours';
    if (dates.has(override.date) && dates.get(override.date) !== kind) invalid('overrides', `${override.date} cannot be both unavailable and have hours.`);
    dates.set(override.date, kind);
  }
  assertNoOverlap(result.filter(override => override.start_min != null), override => override.date, 'overrides');
  return result;
}

function assertNoOverlap(ranges, groupKey, field) {
  const sorted = [...ranges].sort((a, b) => String(groupKey(a)).localeCompare(String(groupKey(b))) || a.start_min - b.start_min);
  for (let index = 1; index < sorted.length; index++) {
    if (groupKey(sorted[index]) === groupKey(sorted[index - 1]) && sorted[index].start_min < sorted[index - 1].end_min) invalid(field, 'Time ranges on the same day must not overlap.');
  }
}

function saveSchedule(app, eventTypeId, rules, overrides) {
  if (rules) {
    app.db.run('DELETE FROM availability_rules WHERE event_type_id = ?', eventTypeId);
    for (const rule of rules) app.db.run('INSERT INTO availability_rules (event_type_id, weekday, start_min, end_min) VALUES (?, ?, ?, ?)', eventTypeId, rule.weekday, rule.start_min, rule.end_min);
  }
  if (overrides) {
    app.db.run('DELETE FROM date_overrides WHERE event_type_id = ?', eventTypeId);
    for (const override of overrides) app.db.run('INSERT INTO date_overrides (event_type_id, date, start_min, end_min) VALUES (?, ?, ?, ?)', eventTypeId, override.date, override.start_min, override.end_min);
  }
}

export function scheduleFor(app, eventTypeId) {
  return {
    rules: app.db.all('SELECT weekday, start_min, end_min FROM availability_rules WHERE event_type_id = ? ORDER BY weekday, start_min', eventTypeId),
    overrides: app.db.all('SELECT date, start_min, end_min FROM date_overrides WHERE event_type_id = ? ORDER BY date, start_min', eventTypeId)
      .map(row => row.start_min == null ? { date: row.date, unavailable: true } : row)
  };
}

const present = (app, row) => row && { ...row, published: Boolean(row.published), ...scheduleFor(app, row.id) };

export function listEventTypes(app, workspaceId, actor) {
  const rows = can(actor.role, 'meet.manage_all')
    ? app.db.all('SELECT e.*, u.name AS host_name FROM event_types e JOIN users u ON u.id = e.host_id WHERE e.workspace_id = ? ORDER BY e.created_at', workspaceId)
    : app.db.all('SELECT e.*, u.name AS host_name FROM event_types e JOIN users u ON u.id = e.host_id WHERE e.workspace_id = ? AND e.host_id = ? ORDER BY e.created_at', workspaceId, actor.userId);
  return rows.map(row => present(app, row));
}

export function getEventType(app, workspaceId, id, actor) {
  const row = app.db.get('SELECT e.*, u.name AS host_name FROM event_types e JOIN users u ON u.id = e.host_id WHERE e.id = ? AND e.workspace_id = ?', id, workspaceId);
  if (!row || (row.host_id !== actor.userId && !can(actor.role, 'meet.manage_all'))) fail(404, 'not_found', 'Event type not found.');
  return present(app, row);
}

export function createEventType(app, workspaceId, actor, body) {
  const value = normalize(app, workspaceId, body, null, actor);
  value.host_id = value.host_id || actor.userId;
  const rules = normalizeRules(body.rules ?? [1, 2, 3, 4, 5].map(day => ({ weekday: day, start_min: 540, end_min: 1020 })));
  const overrides = normalizeOverrides(body.overrides ?? []);
  const id = randomUUID();
  const now = app.now();
  app.db.transaction(() => {
    if (app.db.get('SELECT 1 FROM event_types WHERE workspace_id = ? AND slug = ?', workspaceId, value.slug)) invalid('slug', 'Another event type already uses this link.');
    app.db.run(`INSERT INTO event_types (id, workspace_id, ${COLUMNS.join(', ')}, created_at, updated_at) VALUES (?, ?, ${COLUMNS.map(() => '?').join(', ')}, ?, ?)`,
      id, workspaceId, ...COLUMNS.map(column => value[column] ?? null), now, now);
    saveSchedule(app, id, rules, overrides);
  });
  return getEventType(app, workspaceId, id, actor);
}

export function updateEventType(app, workspaceId, actor, id, body) {
  const current = getEventType(app, workspaceId, id, actor);
  const value = normalize(app, workspaceId, body, current, actor);
  const rules = body.rules !== undefined ? normalizeRules(body.rules) : null;
  const overrides = body.overrides !== undefined ? normalizeOverrides(body.overrides) : null;
  app.db.transaction(() => {
    if (value.slug !== current.slug && app.db.get('SELECT 1 FROM event_types WHERE workspace_id = ? AND slug = ?', workspaceId, value.slug)) invalid('slug', 'Another event type already uses this link.');
    app.db.run(`UPDATE event_types SET ${COLUMNS.map(column => column + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, ...COLUMNS.map(column => value[column] ?? null), app.now(), id);
    saveSchedule(app, id, rules, overrides);
  });
  return getEventType(app, workspaceId, id, actor);
}

export function deleteEventType(app, workspaceId, actor, id) {
  getEventType(app, workspaceId, id, actor);
  if (app.db.get("SELECT 1 FROM bookings WHERE event_type_id = ? AND status = 'confirmed' AND ends_at > ?", id, app.now())) {
    fail(409, 'has_upcoming_bookings', 'Cancel upcoming appointments first, or unpublish this event type.');
  }
  app.db.run('DELETE FROM event_types WHERE id = ?', id);
}

export function findPublishedEventType(app, workspaceSlug, eventSlug) {
  return app.db.get(`SELECT e.*, w.name AS workspace_name, w.slug AS workspace_slug, u.name AS host_name, u.email AS host_email
    FROM event_types e JOIN workspaces w ON w.id = e.workspace_id JOIN users u ON u.id = e.host_id
    WHERE w.slug = ? AND e.slug = ? AND e.published = 1`, workspaceSlug, eventSlug);
}
