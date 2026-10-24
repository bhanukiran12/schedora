import { addDays, isValidTimeZone, localDate, localMinutes, weekday, zonedToUtc } from '../time.mjs';

const escapeText = value => String(value).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stamp = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function fold(line) {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ' ' + rest.slice(cut);
  }
  out.push(rest);
  return out.join('\r\n');
}

export function bookingIcs({ booking, eventType, hostName, method = 'REQUEST', now }) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Schedora//Meet//EN', 'CALSCALE:GREGORIAN', 'METHOD:' + method,
    'BEGIN:VEVENT',
    `UID:${booking.id}@meet.schedora.in`,
    'DTSTAMP:' + stamp(now),
    'DTSTART:' + stamp(booking.starts_at),
    'DTEND:' + stamp(booking.ends_at),
    'SUMMARY:' + escapeText(`${eventType.title} with ${hostName}`),
    'DESCRIPTION:' + escapeText(`${eventType.description}\nReference: ${booking.reference}`.trim()),
    'LOCATION:' + escapeText(eventType.location || 'To be confirmed'),
    'STATUS:' + (method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'),
    'SEQUENCE:' + (method === 'CANCEL' ? 1 : 0),
    'END:VEVENT', 'END:VCALENDAR'
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------------------------
// Busy-time parsing for subscribed calendar feeds (Google, Microsoft and Apple all publish
// private iCalendar addresses). Supports UTC, TZID and all-day values, cancelled/transparent
// events, and DAILY/WEEKLY/MONTHLY RRULEs with INTERVAL, COUNT, UNTIL, BYDAY and EXDATE.

function unfold(text) {
  return text.replace(/\r\n[ \t]|\n[ \t]/g, '').split(/\r?\n/);
}

function parseProperty(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const [name, ...paramParts] = line.slice(0, colon).split(';');
  const params = {};
  for (const part of paramParts) {
    const [key, value] = part.split('=');
    if (key && value) params[key.toUpperCase()] = value.replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

// Returns { ms, allDay, date } or null.
function parseDateValue(value, params, fallbackZone) {
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (dateOnly || params.VALUE === 'DATE') {
    const match = dateOnly || /^(\d{4})(\d{2})(\d{2})/.exec(value);
    if (!match) return null;
    return { allDay: true, date: `${match[1]}-${match[2]}-${match[3]}` };
  }
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, z] = match;
  if (z) return { ms: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) };
  const zone = params.TZID && isValidTimeZone(params.TZID) ? params.TZID : fallbackZone;
  const date = `${y}-${mo}-${d}`;
  const ms = zonedToUtc(date, +h * 60 + +mi, zone) ?? zonedToUtc(date, +h * 60 + +mi + 60, zone);
  return ms == null ? null : { ms: ms + +s * 1000 };
}

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export function parseBusy(text, { from, to, defaultZone = 'UTC', maxOccurrences = 5000 }) {
  const busy = [];
  let event = null;
  let calendarZone = defaultZone;
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') { event = { exdates: new Set() }; continue; }
    if (line === 'END:VEVENT') {
      if (event) expandEvent(event, { from, to, busy, maxOccurrences, zone: calendarZone });
      event = null;
      continue;
    }
    const property = parseProperty(line);
    if (!property) continue;
    if (!event) {
      if (property.name === 'X-WR-TIMEZONE' && isValidTimeZone(property.value)) calendarZone = property.value;
      continue;
    }
    switch (property.name) {
      case 'DTSTART': event.start = parseDateValue(property.value, property.params, calendarZone); event.startZone = property.params.TZID; event.rawStart = property.value; break;
      case 'DTEND': event.end = parseDateValue(property.value, property.params, calendarZone); break;
      case 'DURATION': event.duration = parseDuration(property.value); break;
      case 'STATUS': event.status = property.value.toUpperCase(); break;
      case 'TRANSP': event.transparent = property.value.toUpperCase() === 'TRANSPARENT'; break;
      case 'RRULE': event.rrule = Object.fromEntries(property.value.split(';').map(part => part.split('='))); break;
      case 'RECURRENCE-ID': event.isOverride = true; break;
      case 'EXDATE':
        for (const value of property.value.split(',')) {
          const parsed = parseDateValue(value, property.params, calendarZone);
          if (parsed) event.exdates.add(parsed.allDay ? parsed.date : parsed.ms);
        }
        break;
    }
  }
  return mergeIntervals(busy);
}

function parseDuration(value) {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!match) return null;
  const [, sign, w, d, h, m, s] = match;
  const ms = ((+w || 0) * 7 * 86400 + (+d || 0) * 86400 + (+h || 0) * 3600 + (+m || 0) * 60 + (+s || 0)) * 1000;
  return sign === '-' ? -ms : ms;
}

function expandEvent(event, { from, to, busy, maxOccurrences, zone }) {
  if (!event.start || event.status === 'CANCELLED' || event.transparent) return;
  const startZone = event.startZone && isValidTimeZone(event.startZone) ? event.startZone : zone;
  const occurrence = (date, minutes, msStart) => {
    let start, end;
    if (event.start.allDay) {
      start = zonedToUtc(date, 0, zone);
      const days = event.end?.allDay ? Math.max(1, Math.round((Date.parse(event.end.date) - Date.parse(event.start.date)) / 86400000)) : 1;
      end = zonedToUtc(addDays(date, days), 0, zone);
      if (event.exdates.has(date)) return;
    } else {
      start = msStart ?? zonedToUtc(date, minutes, startZone);
      if (start == null || event.exdates.has(start)) return;
      const length = event.end?.ms != null ? event.end.ms - event.start.ms : event.duration ?? 0;
      end = start + Math.max(0, length);
    }
    if (start != null && end != null && end > start && end > from && start < to) busy.push({ starts_at: start, ends_at: end });
  };

  const baseDate = event.start.allDay ? event.start.date : null;
  if (!event.rrule || event.isOverride) {
    occurrence(baseDate, null, event.start.allDay ? null : event.start.ms);
    return;
  }
  // Recurring: iterate over local dates in the start zone.
  const rule = event.rrule;
  const frequency = rule.FREQ;
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(frequency)) { occurrence(baseDate, null, event.start.ms); return; }
  const interval = Math.max(1, Number(rule.INTERVAL) || 1);
  const count = rule.COUNT ? Number(rule.COUNT) : Infinity;
  const until = rule.UNTIL ? parseDateValue(rule.UNTIL, {}, startZone) : null;
  const untilMs = until ? (until.allDay ? zonedToUtc(addDays(until.date, 1), 0, startZone) : until.ms) : Infinity;
  const firstDate = event.start.allDay ? event.start.date : localDate(event.start.ms, startZone);
  const minutes = event.start.allDay ? 0 : localMinutes(event.start.ms, startZone);
  const byDay = rule.BYDAY ? rule.BYDAY.split(',').map(code => DAY_CODES.indexOf(code.slice(-2))).filter(index => index >= 0) : null;
  const firstWeekday = weekday(firstDate);
  const weekStart = addDays(firstDate, -firstWeekday);
  let produced = 0;
  for (let date = firstDate, steps = 0; steps < 366 * 20 && produced < Math.min(count, maxOccurrences); date = addDays(date, 1), steps++) {
    const startMs = zonedToUtc(date, minutes, event.start.allDay ? zone : startZone);
    if (startMs != null && startMs > untilMs) break;
    if (startMs != null && startMs > to) break;
    const daysFromStart = Math.round((Date.parse(date) - Date.parse(firstDate)) / 86400000);
    let matches;
    if (frequency === 'DAILY') matches = daysFromStart % interval === 0;
    else if (frequency === 'WEEKLY') {
      const week = Math.floor(Math.round((Date.parse(date) - Date.parse(weekStart)) / 86400000) / 7);
      matches = week % interval === 0 && (byDay ? byDay.includes(weekday(date)) : weekday(date) === firstWeekday);
    } else {
      const months = (Number(date.slice(0, 4)) - Number(firstDate.slice(0, 4))) * 12 + Number(date.slice(5, 7)) - Number(firstDate.slice(5, 7));
      matches = months % interval === 0 && date.slice(8) === firstDate.slice(8);
    }
    if (!matches) continue;
    produced++;
    occurrence(date, minutes, null);
  }
}

export function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a.starts_at - b.starts_at);
  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.starts_at <= last.ends_at) last.ends_at = Math.max(last.ends_at, interval.ends_at);
    else merged.push({ ...interval });
  }
  return merged;
}
