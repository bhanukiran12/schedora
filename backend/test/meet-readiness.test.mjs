// "Ready to share?" (frontend/js/meet-readiness.mjs): statuses come only from saved data and server
// checks; unknowns stay "Not verified", optional calendars never block, and roles see only their own data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessReadiness, hoursSummary, noticeText } from '../../frontend/js/meet-readiness.mjs';
import { setup, signUp, publishedEventType, START } from './helpers.mjs';

const HOST = 'user-host';
const now = START; // Saturday 24 October 2026, 06:00 UTC
const ok = value => ({ ok: true, value });
const failed = message => ({ ok: false, error: new Error(message) });
const weekdays = [1, 2, 3, 4, 5].map(weekday => ({ weekday, start_min: 540, end_min: 1020 }));
const savedType = (overrides = {}) => ({
  id: 'et-1', title: 'Intro call', slug: 'intro-call', kind: 'one_on_one', duration_min: 30, timezone: 'Asia/Kolkata', published: true, secret: false,
  locations: [{ type: 'video', value: 'https://video.example.com/room' }], rules: weekdays, overrides: [], offered_slots: null,
  min_notice_min: 240, horizon_days: 60, buffer_before_min: 0, buffer_after_min: 0, max_per_day: null, max_per_week: null, max_per_month: null,
  start_date: null, end_date: null, expires_at: null, price_cents: null, currency: 'inr', managed_template: false, managed_parent_id: null, locked_fields: [],
  hosts: [{ user_id: HOST, name: 'Asha' }], use_host_schedules: false, ...overrides
});
const freshCalendar = ok({ connections: [{ id: 'c1', provider: 'ics', label: 'Work', status: 'active', last_synced_at: now - 5 * 60000, last_success_at: now - 5 * 60000, busy_count: 3 }] });
const verified = (overrides = {}) => ({
  type: savedType(), viewer: { id: HOST, admin: true }, now,
  flags: { videoEnabled: true, emailProvider: 'http', testPayments: true, meetActive: true },
  slots: ok({ slots: ['2026-10-26T03:30:00.000Z', '2026-10-26T04:00:00.000Z'], accepting: true, today: '2026-10-24' }),
  calendar: freshCalendar, integrations: ok([]), ...overrides
});
const area = (result, key) => result.areas.find(item => item.key === key);
const issues = (result, kind) => result.areas.flatMap(item => item.items).filter(item => item.kind === kind).map(item => item.text);

test('1. a valid published event with verified configuration has no blockers, but email is still not verified', () => {
  const result = assessReadiness(verified());
  assert.deepEqual(result.areas.map(item => [item.key, item.status]), [['details', 'ready'], ['availability', 'ready'], ['calendar', 'ready'], ['sharing', 'unverified']]);
  assert.deepEqual(result.counts, { blocker: 0, recommendation: 0, unknown: 1 });
  assert.equal(result.headline, 'No required issues in the saved settings. 1 item not verified.');
  assert.match(area(result, 'availability').items.at(-1).text, /^Checked .+: 2 open start times, the first on .+ An open time can still be taken/);
  assert.match(area(result, 'calendar').items[0].text, /Work: connected; busy times last checked successfully/);
  assert.match(area(result, 'calendar').items.at(-1).text, /Calendars you have not connected are not checked/);
});

test('2. a draft is a required blocker that points to Visibility and is never published for the host', () => {
  const result = assessReadiness(verified({ type: savedType({ published: false }) }));
  const draft = area(result, 'sharing').items.find(item => item.kind === 'blocker');
  assert.match(draft.text, /^Not published\. The link opens a preview that cannot be booked\./);
  assert.deepEqual(draft.action, { label: 'Go to Visibility', section: 'visibility' });
  assert.equal(result.shareable, false);
  assert.match(result.headline, /^1 required item needs attention before invitees can book\./);
});

test('3. statuses come from the saved event type passed in, not from form values', () => {
  // The editor passes only the server's copy; a title typed but not saved cannot appear here.
  const result = assessReadiness(verified({ type: savedType({ title: 'Saved title' }) }));
  assert.match(area(result, 'details').items[0].text, /“Saved title”/);
});

test('4. missing or invalid availability, without calling a future-only schedule broken', () => {
  const none = assessReadiness(verified({ type: savedType({ rules: [] }), slots: ok({ slots: [], accepting: true, today: '2026-10-24' }) }));
  assert.ok(issues(none, 'blocker').includes('No weekly hours are set, so there are no times to book.'));
  const full = assessReadiness(verified({ slots: ok({ slots: [], accepting: true, today: '2026-10-24' }) }));
  assert.equal(issues(full, 'blocker').length, 0, 'hours exist but every time is taken: explained, not blocking');
  assert.ok(issues(full, 'recommendation').some(text => /no open times right now\. Invitees would see no times to choose until one frees up/.test(text)));
  const ended = assessReadiness(verified({ type: savedType({ end_date: '2026-10-01' }) }));
  assert.ok(issues(ended, 'blocker').some(text => /Bookable until .+, which has passed\./.test(text)));
  const later = assessReadiness(verified({ type: savedType({ start_date: '2027-03-01' }), slots: ok({ slots: [], accepting: true, today: '2026-10-24' }) }));
  assert.equal(issues(later, 'blocker').length, 0, 'a schedule that starts after the window is not broken');
  assert.ok(issues(later, 'unknown').some(text => /beyond the 60-day booking window, so there are no times to check yet/.test(text)));
  const passed = assessReadiness(verified({ type: savedType({ offered_slots: ['2026-10-01T05:00:00Z'] }) }));
  assert.ok(issues(passed, 'blocker').includes('Every specific time offered has passed.'));
  assert.equal(hoursSummary([...weekdays, { weekday: 6, start_min: 600, end_min: 780 }]), 'Mon–Fri 09:00–17:00 · Sat 10:00–13:00');
  assert.deepEqual([noticeText(0), noticeText(60), noticeText(240), noticeText(2880)], ['no minimum notice', "1 hour's notice", "4 hours' notice", "2 days' notice"]);
});

test('5. a disconnected optional calendar is a visible limitation, not a blocker', () => {
  const result = assessReadiness(verified({ calendar: ok({ connections: [] }) }));
  assert.equal(area(result, 'calendar').status, 'attention');
  assert.deepEqual(issues(result, 'blocker'), []);
  assert.deepEqual(issues(result, 'recommendation'), ['No calendar is connected. Events in your other calendars are not checked, so they could overlap new bookings.']);
  assert.equal(result.shareable, true);
});

test('6. revoked, failed, waiting and stale calendar checks are distinguished from a recent success', () => {
  const connection = (status, last) => ({ id: status, provider: 'google', label: '', status, last_synced_at: last, last_success_at: last, busy_count: 0 });
  const result = assessReadiness(verified({ calendar: ok({ connections: [connection('revoked', now - 60000), connection('error', now - 60000), connection('pending', null), connection('active', now - 3 * 3600000)] }) }));
  const texts = area(result, 'calendar').items.map(item => [item.status, item.text]);
  assert.match(texts[0][1], /^Google Calendar: access was revoked or has expired\. Its busy times are no longer checked\./);
  assert.match(texts[1][1], /the last busy-time check failed .+ last successful check .+ are still used/);
  assert.deepEqual(texts[2], ['unverified', 'Google Calendar: connected, waiting for its first busy-time check.']);
  assert.equal(texts[3][0], 'unverified', 'connected but not checked recently is not "Ready"');
  assert.equal(issues(result, 'blocker').length, 0);
});

test('7. native video selected while the server feature gate is off is a blocker; on, it is still unverified', () => {
  const type = savedType({ locations: [{ type: 'schedora_meet' }] });
  const off = assessReadiness(verified({ type, flags: { ...verified().flags, videoEnabled: false } }));
  assert.ok(issues(off, 'blocker').some(text => /built-in video is turned off on this server/.test(text)));
  const on = assessReadiness(verified({ type }));
  assert.equal(issues(on, 'blocker').length, 0);
  assert.ok(issues(on, 'unknown').some(text => /only known when a meeting starts/.test(text)));
  const zoom = assessReadiness(verified({ type: savedType({ locations: [{ type: 'zoom' }] }), integrations: ok([{ provider: 'zoom', user_id: HOST, status: 'revoked' }]) }));
  assert.ok(issues(zoom, 'blocker').some(text => /Zoom needs reconnecting: access was revoked or has expired\. Bookings would have no meeting link\./.test(text)));
});

test('8. a failed check is "Not verified" with a retry, never "Ready"', () => {
  const result = assessReadiness(verified({ slots: failed('Network error'), calendar: failed('Timed out'), integrations: failed('Offline'), type: savedType({ price_cents: 50000 }) }));
  for (const key of ['availability', 'calendar']) {
    const item = area(result, key).items.find(entry => entry.status === 'unverified');
    assert.ok(item && item.action.retry, key + ' offers a retry');
  }
  assert.match(area(result, 'availability').items.at(-1).text, /Open times could not be checked \(Network error\)/);
  assert.ok(area(result, 'details').items.some(item => item.status === 'unverified' && /payment setup could not be checked/.test(item.text)));
  assert.equal(area(result, 'availability').status, 'unverified');
});

test('9. the assessment has no side effects: it is a pure function of its inputs', () => {
  const input = verified({ type: savedType({ published: false }) });
  const before = JSON.stringify(input);
  assessReadiness(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(input.type.published, false);
});

test('10. members get no admin-only actions, and other hosts\' data is "Not verified"', () => {
  const member = { id: HOST, admin: false };
  const paid = assessReadiness(verified({ viewer: member, type: savedType({ price_cents: 50000, managed_parent_id: 'tpl', locked_fields: ['locations'], locations: [{ type: 'schedora_meet' }] }), flags: { ...verified().flags, videoEnabled: false, meetActive: false } }));
  const actions = paid.areas.flatMap(item => item.items).map(item => item.action).filter(Boolean);
  assert.ok(!actions.some(action => action.href === '/billing' || action.label === 'Set up payments' || action.label === 'Send a test email'));
  assert.ok(actions.some(action => action.note === 'Your administrator manages this setting.'));
  assert.ok(actions.some(action => action.note === 'Ask an owner or admin to connect a payment provider.'));
  const admin = assessReadiness(verified({ viewer: { id: 'user-admin', admin: true } }));
  assert.equal(area(admin, 'calendar').status, 'unverified', 'an admin cannot see another host\'s calendars');
  const team = assessReadiness(verified({ type: savedType({ kind: 'round_robin', hosts: [{ user_id: HOST, name: 'Asha' }, { user_id: 'u2', name: 'Ravi' }] }) }));
  assert.ok(issues(team, 'unknown').some(text => /Calendars of Ravi are not visible to you/.test(text)));
});

test('real local API data: host-view slots and ICS calendar states feed the summary; member access is unchanged', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws, user } = await signUp(owner, 'Owner');
    const type = await publishedEventType(owner, ws, { min_notice_min: 240, locations: [{ type: 'in_person', value: 'Studio 4' }] });
    const fetchAll = async () => {
      const [saved, slots, calendar, integrations] = await Promise.all([`/event-types/${type.id}`, `/event-types/${type.id}/slots`, '/calendar', '/integrations'].map(path => owner.get(`/api/workspaces/${ws.id}${path}`)));
      return assessReadiness({ type: saved.body, viewer: { id: user.id, admin: true }, now: env.clock.now, slots: ok(slots.body), calendar: ok(calendar.body), integrations: ok(integrations.body), flags: { videoEnabled: false, emailProvider: 'outbox', testPayments: true, meetActive: true } });
    };
    let result = await fetchAll();
    assert.equal(area(result, 'availability').status, 'ready');
    assert.equal(area(result, 'calendar').status, 'attention');
    assert.equal(result.counts.blocker, 0);

    env.feeds.set('https://calendar.example.com/work.ics', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
    assert.equal((await owner.post(`/api/workspaces/${ws.id}/calendar`, { feed_url: 'https://calendar.example.com/work.ics', label: 'Work' })).body.connection.status, 'active');
    result = await fetchAll();
    assert.match(area(result, 'calendar').items[0].text, /^Work: connected; busy times last checked successfully/);

    env.feeds.set('https://calendar.example.com/work.ics', new Error('feed unavailable'));
    env.clock.now += 20 * 60000;
    await owner.post(`/api/workspaces/${ws.id}/calendar/sync`);
    result = await fetchAll();
    assert.match(area(result, 'calendar').items[0].text, /^Work: the last busy-time check failed/);
    env.feeds.set('https://calendar.example.com/work.ics', Object.assign(new Error('gone'), { revoked: true }));
    await owner.post(`/api/workspaces/${ws.id}/calendar/sync`);
    result = await fetchAll();
    assert.match(area(result, 'calendar').items[0].text, /^Work: access was revoked or has expired/);

    const draft = (await owner.patch(`/api/workspaces/${ws.id}/event-types/${type.id}`, { published: false })).body;
    assert.equal(draft.published, false);
    const hostSlots = (await owner.get(`/api/workspaces/${ws.id}/event-types/${type.id}/slots`)).body;
    assert.ok(hostSlots.slots.length > 0, 'the host view still checks a draft\'s open times');
    assert.equal((await env.client().get(`/api/public/meet/${ws.slug}/${type.slug}/slots`)).status, 404, 'a draft is not public');

    const memberHttp = env.client();
    const member = await signUp(memberHttp, 'Member');
    await owner.post(`/api/workspaces/${ws.id}/members`, { email: member.email, role: 'member' });
    for (const path of [`/event-types/${type.id}`, `/event-types/${type.id}/slots`]) assert.equal((await memberHttp.get(`/api/workspaces/${ws.id}${path}`)).status, 404, path);
    assert.deepEqual((await memberHttp.get(`/api/workspaces/${ws.id}/calendar`)).body.connections, [], 'a member sees only their own calendars');
    assert.equal((await memberHttp.post(`/api/workspaces/${ws.id}/emails/test`, { target: 'account' })).status, 403);
  } finally { await env.close(); }
});


test('calendar readiness never substitutes an attempt for successful-sync evidence', () => {
  const legacy = { provider: 'ics', label: 'Legacy', status: 'active', last_synced_at: now - 1000, last_success_at: null };
  assert.equal(area(assessReadiness(verified({ calendar: ok({ connections: [legacy] }) })), 'calendar').items[0].status, 'unverified');
  const failed = { ...legacy, status: 'error', last_success_at: now - 4 * 3600000 };
  const text = area(assessReadiness(verified({ calendar: ok({ connections: [failed] }) })), 'calendar').items[0].text;
  assert.match(text, /last busy-time check failed/); assert.match(text, /last successful check/);
  assert.equal(area(assessReadiness(verified({ calendar: ok({ connections: [{ ...legacy, last_success_at: now + 1000 }] }) })), 'calendar').items[0].status, 'unverified', 'future timestamps cannot prove freshness');
});

test('calendar API keeps the successful timestamp through failures and revocation, then advances it on recovery', async () => {
  const env = await setup();
  try {
    const owner=env.client(); const {ws}=await signUp(owner,'Calendar evidence'); const base=`/api/workspaces/${ws.id}`;
    const url='https://calendar.example.com/evidence.ics';
    env.feeds.set(url,new Error('temporarily unavailable'));
    const first=(await owner.post(`${base}/calendar`,{feed_url:url})).body.connection;
    assert.equal(first.status,'error'); assert.equal(first.last_success_at,null); assert.equal(first.last_synced_at,env.clock.now);
    env.clock.now+=1000; env.feeds.set(url,'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
    const good=(await owner.post(`${base}/calendar/sync`)).body.connection;
    assert.equal(good.last_success_at,env.clock.now); assert.equal(good.busy_count,0,'empty calendar is still a successful check');
    env.clock.now+=1000; env.feeds.set(url,new Error('provider unavailable'));
    const failed=(await owner.post(`${base}/calendar/sync`)).body.connection;
    assert.equal(failed.last_synced_at,env.clock.now); assert.equal(failed.last_success_at,good.last_success_at);
    env.clock.now+=1000; env.feeds.set(url,Object.assign(new Error('revoked'),{revoked:true}));
    const revoked=(await owner.post(`${base}/calendar/sync`)).body.connection;
    assert.equal(revoked.status,'revoked'); assert.equal(revoked.last_success_at,good.last_success_at);
    env.clock.now+=1000; env.feeds.set(url,'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
    const recovered=(await owner.post(`${base}/calendar/sync`)).body.connection;
    assert.equal(recovered.status,'active'); assert.equal(recovered.last_success_at,env.clock.now);
    const outsider=env.client(); await signUp(outsider,'OtherCalendar');
    assert.equal((await outsider.get(`${base}/calendar`)).status,404);
  } finally {await env.close();}
});


test('SQLite upgrade preserves calendar attempts and busy blocks without inventing historical success', async () => {
  const {openDatabase}=await import('../src/db.mjs'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const {unlinkSync,existsSync}=await import('node:fs'); const {randomUUID}=await import('node:crypto');
  const file=join(tmpdir(),'schedora-calendar-upgrade-'+randomUUID()+'.db'); let db=openDatabase(file);
  try {
    db.run("INSERT INTO workspaces (id,slug,name,created_at) VALUES ('cw','cw','Calendar',1)");
    db.run("INSERT INTO users (id,email,name,password_hash,created_at) VALUES ('cu','calendar@example.test','Calendar','unused',1)");
    db.run("INSERT INTO calendar_connections (id,workspace_id,user_id,provider,label,status,last_synced_at,created_at) VALUES ('cc','cw','cu','ics','Work','active',12345,1)");
    db.run("INSERT INTO busy_blocks (connection_id,host_id,starts_at,ends_at) VALUES ('cc','cu',50000,60000)");
    db.exec('ALTER TABLE calendar_connections DROP COLUMN last_success_at');
    db.run("DELETE FROM schema_migrations WHERE name = '013_calendar_success.sql'");
    db.close(); db=openDatabase(file);
    const row=db.get("SELECT last_synced_at,last_success_at FROM calendar_connections WHERE id = 'cc'");
    assert.equal(row.last_synced_at,12345); assert.equal(row.last_success_at,null);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM busy_blocks').count,1);
    db.close(); db=openDatabase(file);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE name = '013_calendar_success.sql'").count,1);
  } finally {db.close(); if(existsSync(file)) unlinkSync(file);}
});
