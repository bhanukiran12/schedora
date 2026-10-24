import { addDays, localDate, weekday, zonedToUtc } from '../time.mjs';

const MINUTE = 60000;
const DAY = 86400000;

// Pure slot generation. All conflict inputs are UTC millisecond intervals:
//   bookings: [{ starts_at, ends_at, block_start, block_end }] confirmed bookings of the same host
//   busy: [{ starts_at, ends_at }] calendar busy periods of the host
// A slot conflicts when its buffered block overlaps an existing booking, or when the slot
// itself overlaps another booking's buffered block or a busy period.
export function generateSlots({ eventType, rules, overrides, bookings = [], busy = [], now, fromDate, toDate }) {
  const tz = eventType.timezone;
  const duration = eventType.duration_min * MINUTE;
  const earliest = now + eventType.min_notice_min * MINUTE;
  const latest = now + eventType.horizon_days * DAY;
  let first = localDate(now, tz);
  const last = localDate(latest, tz);
  if (fromDate && fromDate > first) first = fromDate;
  const end = toDate && toDate < last ? toDate : last;

  const overridesByDate = new Map();
  for (const override of overrides) {
    if (!overridesByDate.has(override.date)) overridesByDate.set(override.date, []);
    if (override.start_min != null) overridesByDate.get(override.date).push(override);
  }

  const slots = [];
  for (let date = first; date <= end; date = addDays(date, 1)) {
    const windows = overridesByDate.has(date) ? overridesByDate.get(date) : rules.filter(rule => rule.weekday === weekday(date));
    for (const window of windows) {
      const windowStart = zonedToUtc(date, window.start_min, tz);
      const windowEnd = zonedToUtc(date, window.end_min, tz) ?? (windowStart != null ? windowStart + (window.end_min - window.start_min) * MINUTE : null);
      if (windowStart == null || windowEnd == null) continue;
      for (let minute = window.start_min; minute + eventType.duration_min <= window.end_min; minute += eventType.slot_interval_min) {
        const start = zonedToUtc(date, minute, tz);
        if (start == null) continue; // local time skipped by a DST transition
        const finish = start + duration;
        if (start < earliest || start > latest || finish > windowEnd) continue;
        if (conflicts(eventType, start, finish, bookings, busy)) continue;
        slots.push(start);
      }
    }
  }
  return [...new Set(slots)].sort((a, b) => a - b);
}

export function bufferedBlock(eventType, start, finish) {
  return [start - eventType.buffer_before_min * MINUTE, finish + eventType.buffer_after_min * MINUTE];
}

export function conflicts(eventType, start, finish, bookings, busy) {
  const [blockStart, blockEnd] = bufferedBlock(eventType, start, finish);
  for (const booking of bookings) {
    if (blockStart < booking.ends_at && blockEnd > booking.starts_at) return true;
    if (start < booking.block_end && finish > booking.block_start) return true;
  }
  for (const period of busy) if (blockStart < period.ends_at && blockEnd > period.starts_at) return true;
  return false;
}
