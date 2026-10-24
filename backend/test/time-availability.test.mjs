// Sprint 3: availability generation honors weekly hours, exceptions, notice, horizon, buffers and DST.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidTimeZone, localDate, zonedToUtc } from '../src/time.mjs';
import { generateSlots } from '../src/meet/availability.mjs';

const iso = ms => new Date(ms).toISOString();
const eventType = overrides => ({ timezone: 'America/New_York', duration_min: 60, slot_interval_min: 60, min_notice_min: 0, horizon_days: 30, buffer_before_min: 0, buffer_after_min: 0, ...overrides });

test('local time to UTC across daylight-saving transitions', () => {
  // New York: DST ends 1 Nov 2026 at 02:00, starts 14 Mar 2027 at 02:00.
  assert.equal(iso(zonedToUtc('2026-10-31', 540, 'America/New_York')), '2026-10-31T13:00:00.000Z');
  assert.equal(iso(zonedToUtc('2026-11-02', 540, 'America/New_York')), '2026-11-02T14:00:00.000Z');
  assert.equal(iso(zonedToUtc('2026-11-01', 90, 'America/New_York')), '2026-11-01T05:30:00.000Z', 'ambiguous time resolves to the earlier instant');
  assert.equal(zonedToUtc('2027-03-14', 150, 'America/New_York'), null, 'skipped local time does not exist');
  // London: BST ends 25 Oct 2026 at 02:00.
  assert.equal(iso(zonedToUtc('2026-10-25', 90, 'Europe/London')), '2026-10-25T00:30:00.000Z');
  assert.equal(iso(zonedToUtc('2026-10-26', 540, 'Europe/London')), '2026-10-26T09:00:00.000Z');
  // Kolkata: fixed +05:30, half-hour offset. Lord Howe: 30-minute DST shift.
  assert.equal(iso(zonedToUtc('2026-10-26', 540, 'Asia/Kolkata')), '2026-10-26T03:30:00.000Z');
  assert.equal(iso(zonedToUtc('2027-01-15', 600, 'Australia/Lord_Howe')), '2027-01-14T23:00:00.000Z');
  assert.equal(zonedToUtc('2026-12-31', 1440, 'UTC'), Date.UTC(2027, 0, 1));
  assert.equal(localDate(Date.UTC(2026, 9, 24, 20), 'Asia/Kolkata'), '2026-10-25');
  assert.ok(isValidTimeZone('Asia/Kolkata'));
  assert.ok(!isValidTimeZone('Mars/Base'));
});

test('weekly hours keep the same local time across a DST change', () => {
  const now = Date.UTC(2026, 9, 24, 0, 0);
  const slots = generateSlots({ eventType: eventType({ horizon_days: 10 }), rules: [{ weekday: 0, start_min: 540, end_min: 600 }], overrides: [], now });
  assert.deepEqual(slots.map(iso), ['2026-10-25T13:00:00.000Z', '2026-11-01T14:00:00.000Z']);
});

test('slots skip local times removed by a DST gap', () => {
  const now = Date.UTC(2027, 2, 13, 0, 0);
  const slots = generateSlots({ eventType: eventType({ duration_min: 30, slot_interval_min: 30, horizon_days: 2 }), rules: [{ weekday: 0, start_min: 60, end_min: 240 }], overrides: [], now });
  // 01:00, 01:30 EST; 02:00 and 02:30 do not exist; 03:00, 03:30 EDT.
  assert.deepEqual(slots.map(iso), ['2027-03-14T06:00:00.000Z', '2027-03-14T06:30:00.000Z', '2027-03-14T07:00:00.000Z', '2027-03-14T07:30:00.000Z']);
});

test('exceptions, notice, horizon and buffers', () => {
  const now = Date.UTC(2026, 9, 26, 12, 0); // Monday 08:00 in New York
  const rules = [1, 2, 3].map(weekday => ({ weekday, start_min: 540, end_min: 720 }));
  const base = eventType({ horizon_days: 3 });
  const all = generateSlots({ eventType: base, rules, overrides: [], now }).map(iso);
  assert.deepEqual(all.slice(0, 3), ['2026-10-26T13:00:00.000Z', '2026-10-26T14:00:00.000Z', '2026-10-26T15:00:00.000Z']);
  assert.ok(all.every(slot => Date.parse(slot) <= now + 3 * 86400000), 'horizon respected');

  const noticed = generateSlots({ eventType: { ...base, min_notice_min: 120 }, rules, overrides: [], now }).map(iso);
  assert.equal(noticed[0], '2026-10-26T14:00:00.000Z', '2 hours notice removes 09:00');

  const exceptions = generateSlots({ eventType: base, rules, overrides: [{ date: '2026-10-26', start_min: null, end_min: null }, { date: '2026-10-27', start_min: 600, end_min: 660 }], now }).map(iso);
  assert.ok(!exceptions.some(slot => slot.startsWith('2026-10-26')), 'unavailable date removed');
  assert.deepEqual(exceptions.filter(slot => slot.startsWith('2026-10-27')), ['2026-10-27T14:00:00.000Z'], 'custom hours replace weekly hours');

  const booking = { starts_at: Date.UTC(2026, 9, 26, 14), ends_at: Date.UTC(2026, 9, 26, 15), block_start: Date.UTC(2026, 9, 26, 14), block_end: Date.UTC(2026, 9, 26, 15) };
  const buffered = generateSlots({ eventType: { ...base, buffer_after_min: 15 }, rules, overrides: [], bookings: [booking], now }).map(iso).filter(slot => slot.startsWith('2026-10-26'));
  assert.deepEqual(buffered, ['2026-10-26T15:00:00.000Z'], '13:00 slot buffer reaches 14:00 booking; 14:00 taken; 15:00 free');

  const busy = generateSlots({ eventType: base, rules, overrides: [], busy: [{ starts_at: Date.UTC(2026, 9, 26, 13, 30), ends_at: Date.UTC(2026, 9, 26, 13, 45) }], now }).map(iso);
  assert.ok(!busy.includes('2026-10-26T13:00:00.000Z'), 'calendar busy time suppresses slot');
});
