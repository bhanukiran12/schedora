// IANA timezone arithmetic using only Intl. All instants are UTC milliseconds;
// local wall-clock values are a 'YYYY-MM-DD' date plus minutes after local midnight.

const formatters = new Map();
const DAY = 86400000;

function formatter(timeZone) {
  let cached = formatters.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

// Older IANA names that browsers and systems still report. Stored values are kept as given; these
// only make labels and comparisons treat both spellings as the same place.
export const ZONE_ALIASES = { 'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Saigon': 'Asia/Ho_Chi_Minh', 'Asia/Katmandu': 'Asia/Kathmandu', 'Asia/Rangoon': 'Asia/Yangon',
  'Europe/Kiev': 'Europe/Kyiv', 'America/Buenos_Aires': 'America/Argentina/Buenos_Aires', 'Etc/UTC': 'UTC', 'Etc/GMT': 'UTC', GMT: 'UTC' };
export const canonicalZone = timeZone => ZONE_ALIASES[timeZone] || timeZone;

// "India Standard Time (UTC+05:30)" for the given instant, so daylight-saving offsets are those in
// effect on the appointment date. Zones without an English name fall back to the city.
export function zoneLabel(timeZone, ms = Date.now()) {
  const zone = canonicalZone(timeZone);
  const part = style => new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: style }).formatToParts(new Date(ms)).find(item => item.type === 'timeZoneName')?.value || '';
  const offset = part('longOffset').replace(/^GMT$/, 'GMT+00:00').replace('GMT', 'UTC');
  const name = part('long');
  const place = zone.split('/').pop().replace(/_/g, ' ');
  return `${/^GMT|^UTC/.test(name) ? (zone === 'UTC' ? 'Coordinated Universal Time' : place) : name} (${offset})`;
}

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 64) return false;
  try { formatter(timeZone); return true; } catch { return false; }
}

export function zonedParts(ms, timeZone) {
  const parts = {};
  for (const { type, value } of formatter(timeZone).formatToParts(new Date(ms))) parts[type] = value;
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second)
  };
}

// Offset of the zone from UTC at the given instant, in milliseconds (e.g. +19800000 for Asia/Kolkata).
export function offsetAt(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

export function localDate(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function localMinutes(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return p.hour * 60 + p.minute;
}

export function isValidDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === day;
}

export function addDays(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * DAY).toISOString().slice(0, 10);
}

export function weekday(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

// Converts a local wall-clock time to a UTC instant. Returns null when the local time does not
// exist (skipped by a daylight-saving transition). Ambiguous times resolve to the earlier instant.
export function zonedToUtc(date, minutes, timeZone) {
  if (minutes === 1440) return zonedToUtc(addDays(date, 1), 0, timeZone);
  const [year, month, day] = date.split('-').map(Number);
  const wall = Date.UTC(year, month - 1, day, 0, minutes);
  let guess = wall - offsetAt(wall, timeZone);
  guess = wall - offsetAt(guess, timeZone);
  const earlier = wall - offsetAt(guess - 3 * 3600000, timeZone);
  if (earlier < guess && localDate(earlier, timeZone) === date && localMinutes(earlier, timeZone) === minutes) guess = earlier;
  if (localDate(guess, timeZone) !== date || localMinutes(guess, timeZone) !== minutes) return null;
  return guess;
}
