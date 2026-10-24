import { randomBytes, randomUUID } from 'node:crypto';
import { fail } from '../http.mjs';
import { isValidTimeZone } from '../time.mjs';
import { email as validEmail, integer, invalid, slugify, text } from '../validate.mjs';
import { can } from '../platform/workspaces.mjs';
import { queueEmail } from '../platform/email.mjs';
import { createBooking, formatInstant, loadEventType } from './bookings.mjs';

// Meeting polls: the host proposes times, participants vote without an account, and the host
// confirms one option. Confirming books the host's time and sends every voter a confirmation.

export function createPoll(app, workspaceId, actor, body) {
  const title = text(body.title, 'title', { min: 1, max: 120 });
  const duration = integer(body.duration_min ?? 30, 'duration_min', 5, 720);
  if (!isValidTimeZone(body.timezone)) invalid('timezone', 'Choose a valid time zone.');
  if (!Array.isArray(body.options) || body.options.length < 2 || body.options.length > 30) invalid('options', 'Propose between 2 and 30 times.');
  const options = [...new Set(body.options.map((value, index) => {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms) || ms < app.now()) invalid(`options.${index}`, 'Propose future times.');
    return ms;
  }))].sort((a, b) => a - b);
  const id = randomUUID();
  const slug = `${slugify(title).slice(0, 30)}-${randomBytes(4).toString('hex')}`;
  app.db.transaction(() => {
    app.db.run("INSERT INTO polls (id, workspace_id, host_id, slug, title, description, duration_min, location, timezone, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)",
      id, workspaceId, actor.userId, slug, title, text(body.description, 'description', { max: 2000, multiline: true }), duration, text(body.location, 'location', { max: 300 }), body.timezone, app.now());
    for (const start of options) app.db.run('INSERT INTO poll_options (id, poll_id, starts_at) VALUES (?, ?, ?)', randomUUID(), id, start);
  });
  return getPoll(app, workspaceId, actor, id);
}

function tally(app, pollId) {
  const options = app.db.all('SELECT id, starts_at FROM poll_options WHERE poll_id = ? ORDER BY starts_at', pollId);
  const votes = app.db.all('SELECT name, email, option_ids, created_at FROM poll_votes WHERE poll_id = ? ORDER BY created_at', pollId).map(vote => ({ ...vote, option_ids: JSON.parse(vote.option_ids) }));
  return { options: options.map(option => ({ ...option, starts_at: new Date(option.starts_at).toISOString(), votes: votes.filter(vote => vote.option_ids.includes(option.id)).length })), votes };
}

export function listPolls(app, workspaceId, actor) {
  const all = can(actor.role, 'meet.manage_all');
  return app.db.all(`SELECT p.id, p.slug, p.title, p.status, p.created_at, (SELECT COUNT(*) FROM poll_votes v WHERE v.poll_id = p.id) AS vote_count, u.name AS host_name
    FROM polls p JOIN users u ON u.id = p.host_id WHERE p.workspace_id = ? AND (? = 1 OR p.host_id = ?) ORDER BY p.created_at DESC`, workspaceId, all ? 1 : 0, actor.userId);
}

export function getPoll(app, workspaceId, actor, id) {
  const poll = app.db.get('SELECT * FROM polls WHERE id = ? AND workspace_id = ?', id, workspaceId);
  if (!poll || (poll.host_id !== actor.userId && !can(actor.role, 'meet.manage_all'))) fail(404, 'not_found', 'Poll not found.');
  return { ...poll, ...tally(app, id) };
}

export function publicPoll(app, slug) {
  const poll = app.db.get(`SELECT p.id, p.slug, p.title, p.description, p.duration_min, p.location, p.timezone, p.status, p.booked_option_id, u.name AS host_name, w.name AS workspace_name
    FROM polls p JOIN users u ON u.id = p.host_id JOIN workspaces w ON w.id = p.workspace_id WHERE p.slug = ?`, String(slug));
  if (!poll) fail(404, 'not_found', 'This poll is not available.');
  const { options, votes } = tally(app, poll.id);
  // Voters see counts and first names only, not other voters' email addresses.
  return { ...poll, id: undefined, options, voters: votes.map(vote => vote.name.split(' ')[0]) };
}

export function vote(app, slug, body) {
  const poll = app.db.get('SELECT id, status FROM polls WHERE slug = ?', String(slug));
  if (!poll) fail(404, 'not_found', 'This poll is not available.');
  if (poll.status !== 'open') fail(409, 'poll_closed', 'Voting has closed for this poll.');
  const name = text(body.name, 'name', { min: 1, max: 100 });
  const address = validEmail(body.email);
  const valid = new Set(app.db.all('SELECT id FROM poll_options WHERE poll_id = ?', poll.id).map(option => option.id));
  if (!Array.isArray(body.option_ids) || !body.option_ids.length || body.option_ids.some(option => !valid.has(option))) invalid('option_ids', 'Choose at least one of the proposed times.');
  app.db.run(`INSERT INTO poll_votes (id, poll_id, name, email, option_ids, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (poll_id, email) DO UPDATE SET name = excluded.name, option_ids = excluded.option_ids, created_at = excluded.created_at`,
  randomUUID(), poll.id, name, address, JSON.stringify([...new Set(body.option_ids)]), app.now());
  return publicPoll(app, slug);
}

// Confirms an option: creates a hidden group event type for the poll and books every voter into it.
export function confirmPoll(app, workspaceId, actor, id, body) {
  const poll = getPoll(app, workspaceId, actor, id);
  if (poll.status !== 'open') fail(409, 'poll_closed', 'This poll is already closed.');
  const option = poll.options.find(item => item.id === body.option_id);
  if (!option) invalid('option_id', 'Choose one of the proposed times.');
  const voters = poll.votes.length ? poll.votes : [];
  const eventTypeId = randomUUID();
  const now = app.now();
  app.db.transaction(() => {
    app.db.run(`INSERT INTO event_types (id, workspace_id, host_id, slug, title, description, location, locations, duration_min, slot_interval_min, timezone, min_notice_min, horizon_days,
        reminder_min, published, kind, seats, secret, one_off, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 365, 1440, 0, 'group', ?, 1, 1, ?, ?)`,
    eventTypeId, workspaceId, poll.host_id, `poll-${poll.slug}`, poll.title, poll.description, poll.location,
    JSON.stringify(poll.location ? [{ type: 'custom', value: poll.location }] : []), poll.duration_min, poll.duration_min, poll.timezone, Math.max(2, voters.length), now, now);
    app.db.run('INSERT INTO event_type_hosts (event_type_id, user_id, priority) VALUES (?, ?, 2)', eventTypeId, poll.host_id);
    const eventType = loadEventType(app, eventTypeId);
    for (const voter of voters) {
      createBooking(app, eventType, { name: voter.name, email: voter.email, timezone: poll.timezone, start: option.starts_at },
        `poll-${poll.id}-${voter.email}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100).padEnd(16, '_'), { source: 'poll', bookedBy: actor.userId, override: true, preferredHost: poll.host_id });
    }
    app.db.run("UPDATE polls SET status = 'booked', booked_option_id = ?, event_type_id = ? WHERE id = ?", option.id, eventTypeId, id);
    // People who voted for other times only still hear the outcome.
    for (const voter of voters) {
      if (voter.option_ids.includes(option.id)) continue;
      queueEmail(app, { workspaceId, key: `poll:${id}:outcome:${voter.email}`, kind: 'poll_outcome', relatedId: id, to: voter.email,
        subject: `Time chosen: ${poll.title}`,
        body: `Hi ${voter.name},\n\nThe host picked ${formatInstant(Date.parse(option.starts_at), poll.timezone)} for "${poll.title}". You are invited; your confirmation follows separately.` });
    }
  });
  app.nudge?.();
  return getPoll(app, workspaceId, actor, id);
}

export function closePoll(app, workspaceId, actor, id) {
  getPoll(app, workspaceId, actor, id);
  app.db.run("UPDATE polls SET status = 'closed' WHERE id = ? AND status = 'open'", id);
  return getPoll(app, workspaceId, actor, id);
}

export function deletePoll(app, workspaceId, actor, id) {
  getPoll(app, workspaceId, actor, id);
  app.db.run('DELETE FROM polls WHERE id = ?', id);
}
