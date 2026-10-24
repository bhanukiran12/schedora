import { randomBytes, randomUUID } from 'node:crypto';
import { fail } from '../http.mjs';
import { isValidDate, isValidTimeZone } from '../time.mjs';
import { bool, integer, invalid, oneOf, slug as validSlug, slugify, text } from '../validate.mjs';
import { can } from '../platform/workspaces.mjs';
import { definitionProblems } from '../shared/forms-logic.mjs';

export const KINDS = ['one_on_one', 'group', 'collective', 'round_robin'];
export const LOCATION_TYPES = {
  video: 'Video link', in_person: 'In person', phone_host_calls: 'Host calls the invitee', phone_invitee_calls: 'Invitee calls the host',
  custom: 'Custom', google_meet: 'Google Meet', zoom: 'Zoom', teams: 'Microsoft Teams'
};
const AUTO_VIDEO = ['google_meet', 'zoom', 'teams'];
const NEEDS_VALUE = ['video', 'in_person', 'phone_invitee_calls', 'custom'];
const JSON_COLUMNS = ['locations', 'questions', 'offered_slots', 'locked_fields'];
const COLUMNS = ['title', 'slug', 'description', 'location', 'duration_min', 'slot_interval_min', 'timezone', 'min_notice_min', 'horizon_days', 'buffer_before_min', 'buffer_after_min',
  'reminder_min', 'published', 'host_id', 'kind', 'seats', 'max_per_day', 'max_per_week', 'max_per_month', 'start_date', 'end_date', 'locations', 'questions', 'price_cents', 'currency',
  'secret', 'one_off', 'single_use', 'expires_at', 'offered_slots', 'rr_strategy', 'managed_parent_id', 'managed_template', 'locked_fields', 'use_host_schedules', 'confirmation_message', 'redirect_url'];
// Fields a managed template can lock for the members it is assigned to.
export const LOCKABLE = ['title', 'description', 'locations', 'duration_min', 'questions', 'buffer_before_min', 'buffer_after_min', 'min_notice_min', 'horizon_days', 'price_cents', 'confirmation_message', 'max_per_day', 'max_per_week', 'max_per_month'];

export function locationDisplay(location) {
  if (!location) return '';
  if (AUTO_VIDEO.includes(location.type)) return `${LOCATION_TYPES[location.type]} (link sent with confirmation)`;
  if (location.type === 'phone_host_calls') return 'Phone call: the host will call you';
  if (location.type === 'phone_invitee_calls') return `Phone call: ${location.value}`;
  return location.value || LOCATION_TYPES[location.type];
}

const optionalInt = (value, field, min, max) => value === null || value === '' ? null : integer(value, field, min, max);
const optionalDate = (value, field) => {
  if (value === null || value === '') return null;
  if (!isValidDate(value)) invalid(field, 'Use a YYYY-MM-DD date.');
  return value;
};
function httpsUrl(value, field) {
  const raw = text(value, field, { min: 1, max: 500 });
  let url;
  try { url = new URL(raw); } catch { invalid(field, 'Enter a full https:// link.'); }
  if (url.protocol !== 'https:') invalid(field, 'Links must start with https://.');
  return url.href;
}

function normalizeLocations(locations) {
  if (!Array.isArray(locations) || locations.length > 6) invalid('locations', 'Offer up to 6 locations.');
  return locations.map((location, index) => {
    const type = oneOf(location?.type, `locations.${index}.type`, Object.keys(LOCATION_TYPES));
    if (!NEEDS_VALUE.includes(type)) return { type };
    const value = type === 'video' ? httpsUrl(location.value, `locations.${index}.value`) : text(location.value, `locations.${index}.value`, { min: 1, max: 500, multiline: true });
    return { type, value };
  });
}

function normalizeQuestions(questions) {
  if (!Array.isArray(questions) || questions.length > 20) invalid('questions', 'Ask up to 20 questions.');
  const fields = questions.map(question => ({
    id: question?.id, type: question?.type, label: typeof question?.label === 'string' ? question.label.trim() : question?.label, required: Boolean(question?.required),
    ...(question?.help ? { help: String(question.help).trim() } : {}),
    ...(question?.type?.endsWith?.('_choice') ? { options: question.options } : {}),
    ...(question?.show_if ? { show_if: question.show_if } : {})
  }));
  const problems = definitionProblems({ title: 'Questions', presentation: 'classic', fields });
  if (fields.some(field => field.type === 'page_break')) problems.unshift('Booking questions cannot contain page breaks.');
  if (fields.some(field => ['name', 'email', 'phone_number', 'notes'].includes(field.id))) problems.unshift('Question keys name, email, phone_number and notes are reserved.');
  if (problems.length) fail(400, 'validation_failed', problems[0], { field: 'questions', problems });
  return fields;
}

function normalizeHosts(app, workspaceId, hosts, kind, actor) {
  if (!Array.isArray(hosts) || !hosts.length || hosts.length > 50) invalid('hosts', 'Choose between 1 and 50 hosts.');
  const result = [];
  for (const [index, host] of hosts.entries()) {
    const userId = typeof host === 'string' ? host : host?.user_id;
    if (!app.db.get('SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ?', workspaceId, userId ?? '')) invalid(`hosts.${index}`, 'Every host must be a workspace member.');
    if (result.some(item => item.user_id === userId)) continue;
    result.push({ user_id: userId, priority: host?.priority === undefined ? 2 : integer(host.priority, `hosts.${index}.priority`, 0, 4) });
  }
  if (['one_on_one', 'group'].includes(kind) && result.length !== 1) invalid('hosts', 'One-on-one and group events have exactly one host.');
  if (kind === 'collective' && result.length < 2) invalid('hosts', 'Collective events need at least two hosts.');
  const others = result.some(host => host.user_id !== actor.userId);
  if (others && !can(actor.role, 'meet.manage_all')) fail(403, 'forbidden', 'Only administrators can create event types for other hosts.');
  return result;
}

function normalize(app, workspaceId, body, current, actor) {
  const value = { ...current };
  const set = (field, fn) => { if (body[field] !== undefined || !current) value[field] = fn(body[field]); };
  set('title', v => text(v, 'title', { min: 1, max: 120 }));
  if (body.slug !== undefined || !current) value.slug = body.slug ? validSlug(body.slug) : slugify(value.title);
  set('description', v => text(v, 'description', { max: 2000, multiline: true }));
  set('kind', v => oneOf(v ?? 'one_on_one', 'kind', KINDS));
  set('duration_min', v => integer(v ?? 30, 'duration_min', 5, 720));
  set('slot_interval_min', v => integer(v ?? value.duration_min, 'slot_interval_min', 5, 720));
  if (body.timezone !== undefined || !current) {
    if (!isValidTimeZone(body.timezone)) invalid('timezone', 'Choose a valid IANA time zone, such as Asia/Kolkata.');
    value.timezone = body.timezone;
  }
  for (const [field, min, max, fallback] of [['min_notice_min', 0, 43200, 240], ['horizon_days', 1, 365, 60], ['buffer_before_min', 0, 240, 0], ['buffer_after_min', 0, 240, 0]]) {
    set(field, v => integer(v ?? fallback, field, min, max));
  }
  set('seats', v => value.kind === 'group' ? integer(v ?? 10, 'seats', 2, 500) : 1);
  if (current && body.kind !== undefined && value.kind !== 'group') value.seats = 1;
  for (const field of ['max_per_day', 'max_per_week', 'max_per_month']) set(field, v => optionalInt(v ?? null, field, 1, 1000));
  set('start_date', v => optionalDate(v ?? null, 'start_date'));
  set('end_date', v => optionalDate(v ?? null, 'end_date'));
  if (value.start_date && value.end_date && value.end_date < value.start_date) invalid('end_date', 'End date must be on or after the start date.');
  if (body.locations !== undefined) value.locations = normalizeLocations(body.locations);
  else if (!current) value.locations = body.location ? [{ type: 'custom', value: text(body.location, 'location', { max: 300 }) }] : [];
  else if (body.location !== undefined) value.locations = body.location ? [{ type: 'custom', value: text(body.location, 'location', { max: 300 }) }] : [];
  value.location = locationDisplay(value.locations[0]);
  set('questions', v => normalizeQuestions(v ?? []));
  if (body.price_cents !== undefined || !current) {
    value.price_cents = optionalInt(body.price_cents ?? null, 'price_cents', 50, 100000000);
    value.currency = value.price_cents ? text(body.currency ?? current?.currency ?? 'inr', 'currency', { min: 3, max: 3 }).toLowerCase() : null;
  }
  for (const field of ['secret', 'one_off', 'single_use', 'use_host_schedules']) {
    if (body[field] !== undefined) value[field] = bool(body[field], field) ? 1 : 0;
    else value[field] = value[field] ? 1 : 0;
  }
  if (body.published !== undefined) value.published = bool(body.published, 'published') ? 1 : 0;
  else value.published = value.published ? 1 : 0;
  set('expires_at', v => {
    if (v === null || v === undefined || v === '') return null;
    const ms = Date.parse(v);
    if (!Number.isFinite(ms)) invalid('expires_at', 'Choose a valid expiry date.');
    return ms;
  });
  set('offered_slots', v => {
    if (v === null || v === undefined) return null;
    if (!Array.isArray(v) || v.length > 50) invalid('offered_slots', 'Offer up to 50 specific times.');
    return [...new Set(v.map((slot, index) => {
      const ms = Date.parse(slot);
      if (!Number.isFinite(ms) || !/Z$/.test(slot)) invalid(`offered_slots.${index}`, 'Use UTC times like 2026-11-02T09:30:00Z.');
      return new Date(ms).toISOString();
    }))].sort();
  });
  set('rr_strategy', v => oneOf(v ?? 'availability', 'rr_strategy', ['availability', 'equal']));
  set('confirmation_message', v => text(v ?? '', 'confirmation_message', { max: 1000, multiline: true }));
  set('redirect_url', v => v ? httpsUrl(v, 'redirect_url') : null);
  if (body.reminder_min !== undefined) value.reminder_min = body.reminder_min === null ? null : integer(body.reminder_min, 'reminder_min', 10, 10080);
  else if (!current) value.reminder_min = 1440;
  set('locked_fields', v => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.some(field => !LOCKABLE.includes(field))) invalid('locked_fields', 'Choose lockable fields: ' + LOCKABLE.join(', ') + '.');
    return [...new Set(v)];
  });
  if (body.managed_template !== undefined) {
    if (!can(actor.role, 'meet.manage_all')) fail(403, 'forbidden', 'Only administrators manage templates.');
    value.managed_template = bool(body.managed_template, 'managed_template') ? 1 : 0;
  } else value.managed_template = value.managed_template ? 1 : 0;
  return value;
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

export function normalizeRules(rules, field = 'rules') {
  if (!Array.isArray(rules) || rules.length > 70) invalid(field, 'Provide up to 70 weekly time ranges.');
  const result = rules.map((rule, index) => ({
    weekday: integer(rule?.weekday, `${field}.${index}.weekday`, 0, 6),
    start_min: integer(rule?.start_min, `${field}.${index}.start_min`, 0, 1439),
    end_min: integer(rule?.end_min, `${field}.${index}.end_min`, 1, 1440)
  }));
  for (const rule of result) if (rule.end_min <= rule.start_min) invalid(field, 'Each range must end after it starts.');
  assertNoOverlap(result, rule => rule.weekday, field);
  return result;
}

export function normalizeOverrides(overrides, field = 'overrides') {
  if (!Array.isArray(overrides) || overrides.length > 400) invalid(field, 'Provide up to 400 date exceptions.');
  const result = overrides.map((override, index) => {
    if (!isValidDate(override?.date)) invalid(`${field}.${index}.date`, 'Use a YYYY-MM-DD date.');
    if (override.unavailable) return { date: override.date, start_min: null, end_min: null };
    const start = integer(override.start_min, `${field}.${index}.start_min`, 0, 1439);
    const end = integer(override.end_min, `${field}.${index}.end_min`, 1, 1440);
    if (end <= start) invalid(field, 'Each range must end after it starts.');
    return { date: override.date, start_min: start, end_min: end };
  });
  const dates = new Map();
  for (const override of result) {
    const kind = override.start_min == null ? 'off' : 'hours';
    if (dates.has(override.date) && dates.get(override.date) !== kind) invalid(field, `${override.date} cannot be both unavailable and have hours.`);
    dates.set(override.date, kind);
  }
  assertNoOverlap(result.filter(override => override.start_min != null), override => override.date, field);
  return result;
}

function assertNoOverlap(ranges, groupKey, field) {
  const sorted = [...ranges].sort((a, b) => String(groupKey(a)).localeCompare(String(groupKey(b))) || a.start_min - b.start_min);
  for (let index = 1; index < sorted.length; index++) {
    if (groupKey(sorted[index]) === groupKey(sorted[index - 1]) && sorted[index].start_min < sorted[index - 1].end_min) invalid(field, 'Time ranges on the same day must not overlap.');
  }
}

export function scheduleFor(app, eventTypeId) {
  return {
    rules: app.db.all('SELECT weekday, start_min, end_min FROM availability_rules WHERE event_type_id = ? ORDER BY weekday, start_min', eventTypeId),
    overrides: app.db.all('SELECT date, start_min, end_min FROM date_overrides WHERE event_type_id = ? ORDER BY date, start_min', eventTypeId)
      .map(row => row.start_min == null ? { date: row.date, unavailable: true } : row)
  };
}

export function hostsFor(app, eventTypeId) {
  return app.db.all(`SELECT h.user_id, h.priority, u.name, u.email FROM event_type_hosts h JOIN users u ON u.id = h.user_id
    WHERE h.event_type_id = ? ORDER BY h.priority DESC, u.name`, eventTypeId);
}

// Parses JSON columns; used by the booking engine and API.
export function hydrate(row) {
  if (!row) return row;
  const result = { ...row };
  for (const column of JSON_COLUMNS) if (typeof result[column] === 'string') result[column] = JSON.parse(result[column]);
  for (const flag of ['published', 'secret', 'one_off', 'single_use', 'use_host_schedules', 'managed_template']) result[flag] = Boolean(result[flag]);
  return result;
}

const present = (app, row) => row && { ...hydrate(row), ...scheduleFor(app, row.id), hosts: hostsFor(app, row.id) };
const SELECT = `SELECT e.*, u.name AS host_name, p.title AS managed_parent_title FROM event_types e JOIN users u ON u.id = e.host_id
  LEFT JOIN event_types p ON p.id = e.managed_parent_id`;

// Members see event types they host (including team types); administrators see all.
export function listEventTypes(app, workspaceId, actor) {
  const rows = can(actor.role, 'meet.manage_all')
    ? app.db.all(`${SELECT} WHERE e.workspace_id = ? ORDER BY e.managed_template DESC, e.created_at`, workspaceId)
    : app.db.all(`${SELECT} WHERE e.workspace_id = ? AND EXISTS (SELECT 1 FROM event_type_hosts h WHERE h.event_type_id = e.id AND h.user_id = ?) ORDER BY e.created_at`, workspaceId, actor.userId);
  return rows.map(row => present(app, row));
}

export function getEventType(app, workspaceId, id, actor) {
  const row = app.db.get(`${SELECT} WHERE e.id = ? AND e.workspace_id = ?`, id, workspaceId);
  const isHost = row && app.db.get('SELECT 1 FROM event_type_hosts WHERE event_type_id = ? AND user_id = ?', id, actor.userId);
  if (!row || (!isHost && !can(actor.role, 'meet.manage_all'))) fail(404, 'not_found', 'Event type not found.');
  return present(app, row);
}

function write(app, id, workspaceId, value, now, insert) {
  const values = COLUMNS.map(column => {
    const item = value[column];
    if (JSON_COLUMNS.includes(column)) return item == null ? (column === 'offered_slots' ? null : '[]') : JSON.stringify(item);
    if (typeof item === 'boolean') return item ? 1 : 0;
    return item ?? null;
  });
  if (insert) {
    app.db.run(`INSERT INTO event_types (id, workspace_id, ${COLUMNS.join(', ')}, created_at, updated_at) VALUES (?, ?, ${COLUMNS.map(() => '?').join(', ')}, ?, ?)`, id, workspaceId, ...values, now, now);
  } else {
    app.db.run(`UPDATE event_types SET ${COLUMNS.map(column => column + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, ...values, now, id);
  }
}

function saveHosts(app, id, hosts) {
  app.db.run('DELETE FROM event_type_hosts WHERE event_type_id = ?', id);
  for (const host of hosts) app.db.run('INSERT INTO event_type_hosts (event_type_id, user_id, priority) VALUES (?, ?, ?)', id, host.user_id, host.priority);
}

export function createEventType(app, workspaceId, actor, body) {
  const value = normalize(app, workspaceId, body, null, actor);
  const hosts = normalizeHosts(app, workspaceId, body.hosts ?? [{ user_id: body.host_id || actor.userId }], value.kind, actor);
  value.host_id = hosts[0].user_id;
  if (value.one_off && !body.slug) value.slug = `${slugify(value.title).slice(0, 40)}-${randomBytes(3).toString('hex')}`;
  if (value.one_off) value.secret = 1;
  const rules = normalizeRules(body.rules ?? [1, 2, 3, 4, 5].map(day => ({ weekday: day, start_min: 540, end_min: 1020 })));
  const overrides = normalizeOverrides(body.overrides ?? []);
  const id = randomUUID();
  app.db.transaction(() => {
    if (app.db.get('SELECT 1 FROM event_types WHERE workspace_id = ? AND slug = ?', workspaceId, value.slug)) invalid('slug', 'Another event type already uses this link.');
    write(app, id, workspaceId, value, app.now(), true);
    saveHosts(app, id, hosts);
    saveSchedule(app, id, rules, overrides);
  });
  return getEventType(app, workspaceId, id, actor);
}

export function updateEventType(app, workspaceId, actor, id, body) {
  // host_id is shorthand for a single host.
  if (body.host_id !== undefined && body.hosts === undefined) body = { ...body, hosts: [{ user_id: body.host_id }] };
  const current = getEventType(app, workspaceId, id, actor);
  if (current.managed_parent_id && !can(actor.role, 'meet.manage_all')) {
    const locked = Object.keys(body).filter(field => current.locked_fields.includes(field) || (field === 'locations' && current.locked_fields.includes('locations')));
    if (locked.length) fail(403, 'field_locked', `Your administrator manages these settings: ${locked.join(', ')}.`, { field: locked[0] });
  }
  const value = normalize(app, workspaceId, body, current, actor);
  const hosts = body.hosts !== undefined ? normalizeHosts(app, workspaceId, body.hosts, value.kind, actor)
    : (body.kind !== undefined ? normalizeHosts(app, workspaceId, current.hosts.map(host => ({ user_id: host.user_id, priority: host.priority })), value.kind, actor) : null);
  if (hosts) value.host_id = hosts[0].user_id;
  const rules = body.rules !== undefined ? normalizeRules(body.rules) : null;
  const overrides = body.overrides !== undefined ? normalizeOverrides(body.overrides) : null;
  app.db.transaction(() => {
    if (value.slug !== current.slug && app.db.get('SELECT 1 FROM event_types WHERE workspace_id = ? AND slug = ?', workspaceId, value.slug)) invalid('slug', 'Another event type already uses this link.');
    write(app, id, workspaceId, value, app.now(), false);
    if (hosts) saveHosts(app, id, hosts);
    saveSchedule(app, id, rules, overrides);
    if (value.managed_template) propagateTemplate(app, id, value, rules, overrides);
  });
  return getEventType(app, workspaceId, id, actor);
}

// Managed event types: copies of a template assigned to members. Locked fields follow the template.
function propagateTemplate(app, templateId, template, rules, overrides) {
  for (const child of app.db.all('SELECT * FROM event_types WHERE managed_parent_id = ?', templateId).map(hydrate)) {
    const value = { ...child, locked_fields: template.locked_fields, kind: template.kind === 'group' ? 'group' : 'one_on_one', seats: template.kind === 'group' ? template.seats : 1 };
    for (const field of template.locked_fields) value[field] = template[field];
    if (template.locked_fields.includes('price_cents')) value.currency = template.currency;
    value.location = locationDisplay(value.locations[0]);
    write(app, child.id, child.workspace_id, value, app.now(), false);
    if (rules && template.locked_fields.includes('duration_min')) saveSchedule(app, child.id, rules, overrides);
  }
}

export function assignTemplate(app, workspaceId, actor, templateId, body) {
  if (!can(actor.role, 'meet.manage_all')) fail(403, 'forbidden', 'Only administrators assign managed event types.');
  const template = getEventType(app, workspaceId, templateId, actor);
  if (!template.managed_template) invalid('managed_template', 'Mark this event type as a managed template first.');
  if (!Array.isArray(body.user_ids) || !body.user_ids.length || body.user_ids.length > 200) invalid('user_ids', 'Choose members to assign.');
  const created = [];
  app.db.transaction(() => {
    for (const userId of body.user_ids) {
      const member = app.db.get('SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.user_id = ?', workspaceId, userId);
      if (!member) invalid('user_ids', 'Every assignee must be a workspace member.');
      if (app.db.get('SELECT 1 FROM event_types WHERE managed_parent_id = ? AND host_id = ?', templateId, userId)) continue;
      let slug = `${template.slug}-${slugify(member.name).slice(0, 20)}`;
      for (let attempt = 2; app.db.get('SELECT 1 FROM event_types WHERE workspace_id = ? AND slug = ?', workspaceId, slug); attempt++) slug = `${template.slug}-${slugify(member.name).slice(0, 20)}-${attempt}`;
      const id = randomUUID();
      const value = { ...template, slug, host_id: userId, kind: template.kind === 'group' ? 'group' : 'one_on_one', seats: template.kind === 'group' ? template.seats : 1, managed_parent_id: templateId, managed_template: 0, published: template.published ? 1 : 0 };
      write(app, id, workspaceId, value, app.now(), true);
      saveHosts(app, id, [{ user_id: userId, priority: 2 }]);
      saveSchedule(app, id, template.rules, template.overrides.map(override => override.unavailable ? { date: override.date, start_min: null, end_min: null } : override));
      created.push(id);
    }
  });
  return { created: created.length };
}

export function deleteEventType(app, workspaceId, actor, id) {
  const eventType = getEventType(app, workspaceId, id, actor);
  if (eventType.managed_parent_id && !can(actor.role, 'meet.manage_all')) fail(403, 'forbidden', 'Your administrator manages this event type.');
  if (app.db.get("SELECT 1 FROM bookings WHERE event_type_id = ? AND status IN ('confirmed', 'pending') AND ends_at > ?", id, app.now())) {
    fail(409, 'has_upcoming_bookings', 'Cancel upcoming appointments first, or unpublish this event type.');
  }
  app.db.run('DELETE FROM event_types WHERE id = ?', id);
}

// Public lookups ------------------------------------------------------------------------------

export function findEventTypeBySlug(app, workspaceSlug, eventSlug) {
  return hydrate(app.db.get(`SELECT e.*, w.name AS workspace_name, w.slug AS workspace_slug, w.brand_color, w.logo, w.welcome_message,
      u.name AS host_name, u.email AS host_email
    FROM event_types e JOIN workspaces w ON w.id = e.workspace_id JOIN users u ON u.id = e.host_id
    WHERE w.slug = ? AND e.slug = ? AND e.managed_template = 0`, workspaceSlug, eventSlug));
}

export function findPublishedEventType(app, workspaceSlug, eventSlug) {
  const eventType = findEventTypeBySlug(app, workspaceSlug, eventSlug);
  if (!eventType || !eventType.published) return null;
  if (eventType.expires_at && eventType.expires_at < app.now()) return null;
  return eventType;
}

export function publicWorkspacePage(app, workspaceSlug) {
  const workspace = app.db.get('SELECT id, name, slug, brand_color, logo, welcome_message FROM workspaces WHERE slug = ?', workspaceSlug);
  if (!workspace) return null;
  const eventTypes = app.db.all(`SELECT e.slug, e.title, e.description, e.duration_min, e.kind, e.price_cents, e.currency, u.name AS host_name FROM event_types e
    JOIN users u ON u.id = e.host_id WHERE e.workspace_id = ? AND e.published = 1 AND e.secret = 0 AND e.one_off = 0 AND e.managed_template = 0
    AND (e.expires_at IS NULL OR e.expires_at > ?) ORDER BY e.title`, workspace.id, app.now());
  return { name: workspace.name, slug: workspace.slug, brand_color: workspace.brand_color, logo: workspace.logo, welcome_message: workspace.welcome_message, event_types: eventTypes };
}

export { AUTO_VIDEO };
