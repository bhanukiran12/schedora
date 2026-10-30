// "Ready to share?" for a saved Meet event type. Pure: the editor passes in what the server returned
// (the saved event type, the host view of open times, the viewer's own calendars and integrations,
// and server feature flags), so every status traces to saved data or a server check, never to
// unsaved form values. Anything the viewer's API access cannot confirm is "Not verified".

import { summarize } from './readiness.mjs';
import { CALENDAR_STALE_MS } from '../shared/meet-readiness-policy.mjs';
export { CALENDAR_STALE_MS } from '../shared/meet-readiness-policy.mjs';

export { KIND_LABELS, STATUS_LABELS } from './readiness.mjs';

const KINDS = { one_on_one: 'One-on-one', group: 'Group', collective: 'Collective', round_robin: 'Round robin' };
const LOCATIONS = {
  video: 'Video link', in_person: 'In person', phone_host_calls: 'Phone (you call the invitee)', phone_invitee_calls: 'Phone (the invitee calls you)',
  custom: 'Custom location', google_meet: 'Google Meet', zoom: 'Zoom', teams: 'Microsoft Teams', schedora_meet: 'Schedora Meet built-in video'
};
// Auto-link locations and the integration each host needs for the link to be created.
const AUTO_LINK = { google_meet: ['google', 'Google'], zoom: ['zoom', 'Zoom'], teams: ['microsoft', 'Microsoft 365'] };
const CALENDAR_NAMES = { ics: 'Calendar address (ICS)', google: 'Google Calendar', microsoft: 'Outlook calendar' };
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOUR = 3600000;
const DAY = 24 * HOUR;
// Calendars sync every 15 minutes; a successful check older than this is treated as stale.

const clock = minutes => minutes >= 1440 ? '24:00' : `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const plural = (count, one, many = one + 's') => `${count.toLocaleString('en-IN')} ${count === 1 ? one : many}`;
const names = hosts => hosts.map(host => host.name).join(', ');
const localDate = (ms, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const addDays = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * DAY).toISOString().slice(0, 10);

const defaultFormat = {
  dateTime: (ms, timeZone) => new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms)),
  date: date => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(date + 'T00:00:00Z')),
  zone: timeZone => timeZone.replace(/_/g, ' '),
  money: (cents, currency) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100)
};

// "Mon–Fri 09:00–17:00 · Sat 10:00–13:00": days with identical hours, Monday first.
export function hoursSummary(rules) {
  const byDay = new Map();
  for (const day of [1, 2, 3, 4, 5, 6, 0]) {
    const ranges = rules.filter(rule => rule.weekday === day).sort((a, b) => a.start_min - b.start_min);
    if (ranges.length) byDay.set(day, ranges.map(rule => `${clock(rule.start_min)}–${clock(rule.end_min)}`).join(', '));
  }
  const groups = [];
  let previous = null;
  for (const [position, day] of [1, 2, 3, 4, 5, 6, 0].entries()) {
    const hours = byDay.get(day);
    const last = groups.at(-1);
    if (hours && last && last.hours === hours && previous === position - 1) last.days.push(day);
    else if (hours) groups.push({ hours, days: [day] });
    if (hours) previous = position;
  }
  return groups.map(group => `${SHORT_DAYS[group.days[0]]}${group.days.length > 1 ? '–' + SHORT_DAYS[group.days.at(-1)] : ''} ${group.hours}`).join(' · ');
}

export function noticeText(minutes) {
  if (!minutes) return 'no minimum notice';
  const [count, unit] = minutes < 60 ? [minutes, 'minute'] : minutes % 1440 === 0 ? [minutes / 1440, 'day'] : [minutes / 60, 'hour'];
  return `${count.toLocaleString('en-IN')} ${unit}${count === 1 ? "'s" : "s'"} notice`;
}

function bufferText(before, after) {
  if (!before && !after) return 'no buffers between meetings';
  return [before ? `${before} min buffer before` : '', after ? `${after} min after` : ''].filter(Boolean).join(', ');
}

const settled = source => source && source.ok;
const errorText = source => source?.error?.message ? ` (${source.error.message})` : '';

/**
 * @param input {
 *   type: saved event type from GET /event-types/:id,
 *   viewer: { id, admin },
 *   flags: { videoEnabled, emailProvider, testPayments, meetActive },
 *   slots, calendar, integrations: { ok: true, value } | { ok: false, error }  (host-view slots, own calendars, integrations),
 *   now, format?
 * }
 */
export function assessReadiness({ type, viewer, flags, slots, calendar, integrations, hostSummaryAvailable = false, now = Date.now(), format = {} }) {
  const f = { ...defaultFormat, ...format };
  const hostIds = type.hosts.map(host => host.user_id);
  const isHost = hostIds.includes(viewer.id);
  const others = type.hosts.filter(host => host.user_id !== viewer.id);
  const team = ['collective', 'round_robin'].includes(type.kind);
  const locked = field => Boolean(type.managed_parent_id && !viewer.admin && type.locked_fields?.includes(field));
  const fix = (label, section, field) => locked(field) ? { note: 'Your administrator manages this setting.' } : { label, section };
  const today = settled(slots) && slots.value.today ? slots.value.today : localDate(now, type.timezone);
  const providerRow = provider => integrations.value.find(row => row.provider === provider && row.user_id === viewer.id);

  // ---- Event details ----
  const details = [{ status: 'ready', text: `“${type.title}” · ${type.duration_min} min · ${KINDS[type.kind] || type.kind}${team || others.length ? ` · hosts: ${names(type.hosts)}` : ''}.` }];
  if (!type.locations.length) {
    details.push({ status: 'attention', kind: 'recommendation', text: 'No location is set, so invitees will not know where or how you will meet.', action: fix('Add a location', 'details', 'locations') });
  }
  for (const location of type.locations) {
    const label = LOCATIONS[location.type] || location.type;
    if (location.type === 'schedora_meet') {
      details.push(flags.videoEnabled
        ? { status: 'unverified', kind: 'unknown', text: `${label} is selected and switched on for this server. Whether a room connects well is only known when a meeting starts.` }
        : { status: 'attention', kind: 'blocker', text: `${label} is selected, but built-in video is turned off on this server. Invitees would not get a working video room.`, action: fix('Change the location', 'details', 'locations') });
    } else if (AUTO_LINK[location.type]) {
      const [provider, providerName] = AUTO_LINK[location.type];
      const row = isHost && settled(integrations) ? providerRow(provider) : null;
      if (!settled(integrations)) details.push({ status: 'unverified', kind: 'unknown', text: `${label}: your app connections could not be checked${errorText(integrations)}.`, action: { retry: true, label: 'Check again' } });
      else if (!isHost || others.length) {
        details.push({ status: 'unverified', kind: 'unknown', text: hostSummaryAvailable
          ? `${label}: each host needs ${providerName} connected. See Host setup below for saved connection status; meeting-link creation remains unverified.`
          : `${label}: each host needs ${providerName} connected for a link to be created. You can see only your own connection${isHost ? ` (${row?.status === 'active' ? 'connected' : 'not connected'})` : ''}.` });
      } else if (row?.status === 'active') {
        details.push({ status: 'unverified', kind: 'unknown', text: `${label}: ${providerName} is connected. Meeting-link creation is not verified here; a link is requested when an invitee books.` });
      } else {
        const why = row?.status === 'revoked' ? 'access was revoked or has expired' : row?.status === 'error' ? 'the connection last failed' : 'it is not connected';
        details.push({ status: 'attention', kind: 'blocker', text: `${label} is selected, but ${providerName} ${row ? 'needs reconnecting: ' + why : 'is not connected'}. Bookings would have no meeting link.`, action: { label: `${row ? 'Reconnect' : 'Connect'} ${providerName}`, href: '/meet?tab=integrations' } });
      }
    } else {
      details.push({ status: 'ready', text: `${label}${location.value ? `: ${location.value.length > 80 ? location.value.slice(0, 79) + '…' : location.value}` : ''}.` });
    }
  }
  if (type.price_cents) {
    const amount = f.money(type.price_cents, type.currency || 'inr');
    const provider = settled(integrations) && integrations.value.find(row => ['stripe', 'razorpay'].includes(row.provider) && !row.user_id);
    const ask = viewer.admin ? { label: 'Set up payments', href: '/meet?tab=integrations' } : { note: 'Ask an owner or admin to connect a payment provider.' };
    if (!settled(integrations)) details.push({ status: 'unverified', kind: 'unknown', text: `Paid (${amount}): payment setup could not be checked${errorText(integrations)}.`, action: { retry: true, label: 'Check again' } });
    else if (provider?.status === 'active') details.push({ status: 'ready', text: `Paid (${amount}) through ${provider.provider === 'razorpay' ? 'Razorpay' : 'Stripe'}. A real payment is only confirmed when an invitee pays.` });
    else if (provider) details.push({ status: 'attention', kind: 'blocker', text: `Paid (${amount}), but the ${provider.provider === 'razorpay' ? 'Razorpay' : 'Stripe'} connection needs attention.`, action: ask });
    else details.push({ status: 'attention', kind: 'blocker', text: `Paid (${amount}), but no payment provider is connected. ${flags.testPayments ? 'Invitees would get a test checkout and no money moves.' : 'Invitees could not pay to complete a booking.'}`, action: ask });
  }

  // ---- Availability ----
  const availability = [];
  const sharedHours = team && type.use_host_schedules;
  availability.push(sharedHours
    ? { status: 'unverified', kind: 'unknown', text: `Each host's own working hours and time zone are used. You can see only yours.`, action: { label: 'Your working hours', href: '/meet?tab=integrations' } }
    : { status: 'ready', text: `Time zone: ${f.zone(type.timezone, now)}. Invitees see times in their own zone.` });
  const upcomingExceptions = type.overrides.filter(override => override.date >= today);
  const exceptionNote = upcomingExceptions.length ? ` Plus ${plural(upcomingExceptions.length, 'date exception')} from today.` : '';
  if (type.offered_slots?.length) {
    const future = type.offered_slots.filter(slot => Date.parse(slot) > now);
    availability.push(future.length
      ? { status: 'ready', text: `${plural(future.length, 'specific time')} offered; weekly hours are not used.` }
      : { status: 'attention', kind: 'blocker', text: 'Every specific time offered has passed.', action: fix('Add new times', 'availability') });
  } else if (!sharedHours) {
    const customDates = upcomingExceptions.filter(override => !override.unavailable);
    if (type.rules.length) availability.push({ status: 'ready', text: `Weekly hours: ${hoursSummary(type.rules)}.${exceptionNote}` });
    else if (customDates.length) availability.push({ status: 'ready', text: `No weekly hours; only ${plural(customDates.length, 'date')} with custom hours.` });
    else availability.push({ status: 'attention', kind: 'blocker', text: 'No weekly hours are set, so there are no times to book.', action: fix('Set weekly hours', 'availability') });
  }
  const limits = [type.max_per_day && `${type.max_per_day} a day`, type.max_per_week && `${type.max_per_week} a week`, type.max_per_month && `${type.max_per_month} a month`].filter(Boolean);
  if (type.expires_at && type.expires_at < now) {
    availability.push({ status: 'attention', kind: 'blocker', text: `This link expired on ${f.dateTime(type.expires_at, type.timezone)}.`, action: fix('Change the expiry', 'visibility') });
  } else if (type.end_date && type.end_date < today) {
    availability.push({ status: 'attention', kind: 'blocker', text: `Bookable until ${f.date(type.end_date)}, which has passed.`, action: fix('Change the dates', 'availability') });
  } else {
    availability.push({ status: 'ready', text: `Rules: ${noticeText(type.min_notice_min)}, up to ${plural(type.horizon_days, 'day')} ahead, ${bufferText(type.buffer_before_min, type.buffer_after_min)}${limits.length ? `, at most ${limits.join(' and ')}` : ''}${type.start_date && type.start_date > today ? `, bookable from ${f.date(type.start_date)}` : ''}.` });
  }
  // The authoritative check: the server's own slot calculation over the saved booking window.
  const windowStart = type.start_date && type.start_date > today ? type.start_date : today;
  let windowEnd = addDays(today, type.horizon_days);
  if (type.end_date && type.end_date < windowEnd) windowEnd = type.end_date;
  const checked = `${f.date(windowStart)} to ${f.date(windowEnd)}`;
  const closed = (type.expires_at && type.expires_at < now) || (type.end_date && type.end_date < today);
  if (closed) {
    // The window has ended (reported above), so there is nothing left to check.
  } else if (!settled(slots)) {
    availability.push({ status: 'unverified', kind: 'unknown', text: `Open times could not be checked${errorText(slots)}.`, action: { retry: true, label: 'Check again' } });
  } else if (windowStart > windowEnd) {
    availability.push({ status: 'unverified', kind: 'unknown', text: `Bookable from ${f.date(type.start_date)}, beyond the ${type.horizon_days}-day booking window, so there are no times to check yet.` });
  } else if (slots.value.slots.length) {
    const first = Date.parse(slots.value.slots[0]);
    availability.push({ status: 'ready', text: `Checked ${checked}: ${plural(slots.value.slots.length, 'open start time')}, the first on ${f.dateTime(first, type.timezone)}. An open time can still be taken before someone books it.` });
  } else {
    // The link still works and times reappear as they free up, so this explains the current state
    // rather than blocking sharing. Structural causes (no hours, ended window) are Required above.
    availability.push({ status: 'attention', kind: 'recommendation', text: `Checked ${checked}: no open times right now. Invitees would see no times to choose until one frees up. Existing meetings, calendar busy times, notice or limits may be filling the window.`, action: fix('Review hours', 'availability') });
  }

  // ---- Calendar and conflict checking ----
  const calendars = [];
  if (!isHost) {
    calendars.push({ status: 'unverified', kind: 'unknown', text: hostSummaryAvailable
      ? 'See Host setup below for saved calendar evidence for each host. Calendar contents are private; future conflicts are not guaranteed.'
      : `Calendars belong to each host and you can see only your own, so ${names(type.hosts)}'s calendar status is not shown here.` });
  } else if (!settled(calendar)) {
    calendars.push({ status: 'unverified', kind: 'unknown', text: `Your calendar connections could not be checked${errorText(calendar)}.`, action: { retry: true, label: 'Check again' } });
  } else {
    const connections = calendar.value.connections || [];
    const connect = { label: connections.length ? 'Manage calendars' : 'Connect a calendar', href: '/meet?tab=integrations' };
    if (!connections.length) calendars.push({ status: 'attention', kind: 'recommendation', text: 'No calendar is connected. Events in your other calendars are not checked, so they could overlap new bookings.', action: connect });
    for (const connection of connections) {
      const label = connection.label || CALENDAR_NAMES[connection.provider] || connection.provider;
      const at = connection.last_success_at ? f.dateTime(connection.last_success_at, type.timezone) : null;
      const attempted = connection.last_synced_at ? f.dateTime(connection.last_synced_at, type.timezone) : null;
      if (connection.status === 'active' && connection.last_success_at && now >= connection.last_success_at && now - connection.last_success_at <= CALENDAR_STALE_MS) {
        calendars.push({ status: 'ready', text: `${label}: connected; busy times last checked successfully ${at} (${plural(connection.busy_count || 0, 'busy period')}).` });
      } else if (connection.status === 'active') {
        calendars.push({ status: 'unverified', kind: 'unknown', text: `${label}: connected, but the last successful busy-time check was ${at || 'not recorded'}. Changes since then are not known.`, action: connect });
      } else if (connection.status === 'pending') {
        calendars.push({ status: 'unverified', kind: 'unknown', text: `${label}: connected, waiting for its first busy-time check.`, action: connect });
      } else if (connection.status === 'revoked') {
        calendars.push({ status: 'attention', kind: 'recommendation', text: `${label}: access was revoked or has expired. Its busy times are no longer checked.`, action: { label: 'Reconnect', href: '/meet?tab=integrations' } });
      } else {
        calendars.push({ status: 'attention', kind: 'recommendation', text: `${label}: the last busy-time check failed${attempted ? ` (${attempted})` : ''}. ${at ? `Busy times from the last successful check (${at}) are still used.` : 'No successful check is recorded; conflict coverage is not verified.'}`, action: connect });
      }
    }
    calendars.push({ text: `Conflicts are checked against your Schedora meetings across all event types${connections.length ? ` and ${plural(connections.length, 'connected calendar')}` : ''}. Calendars you have not connected are not checked.` });
  }
  if (isHost && others.length) calendars.push({ status: 'unverified', kind: 'unknown', text: hostSummaryAvailable
    ? 'See Host setup below for saved calendar evidence for the other hosts. Calendar contents are private; future conflicts are not guaranteed.'
    : `Calendars of ${names(others)} are not visible to you. Their busy times are applied only if they connected them.` });

  // ---- Sharing ----
  const sharing = [];
  if (type.managed_template) {
    sharing.push({ status: 'not_required', text: 'Templates are not booked directly. Each assigned member shares their own copy.' });
  } else {
    const accepting = flags.meetActive && (!settled(slots) || slots.value.accepting !== false);
    if (!accepting) sharing.push({ status: 'attention', kind: 'blocker', text: 'This workspace has no active Meet or Suite plan, so booking links are not accepting appointments.', action: viewer.admin ? { label: 'Review plans', href: '/billing' } : { note: 'Ask a workspace owner about the plan.' } });
    sharing.push(type.published
      ? { status: 'ready', text: `Published: the link accepts bookings whenever open times exist.${type.secret ? ' It is hidden from your booking page, so only people with the link can book.' : ''}${type.one_off && type.single_use ? ' It closes after one booking.' : ''}` }
      : { status: 'attention', kind: 'blocker', text: 'Not published. The link opens a preview that cannot be booked. Publishing happens only when you choose it under Visibility and save.', action: { label: 'Go to Visibility', section: 'visibility' } });
    sharing.push(flags.emailProvider === 'outbox'
      ? { status: 'attention', kind: 'recommendation', text: 'Confirmation emails go to this server\'s local outbox and are not delivered to invitees.' }
      : { status: 'unverified', kind: 'unknown', text: 'Confirmation email delivery is not checked here.', action: viewer.admin ? { label: 'Send a test email', href: '/meet?tab=emails' } : undefined });
  }

  const result = summarize([
    { key: 'details', title: 'Event details', items: details },
    { key: 'availability', title: 'Availability', items: availability },
    { key: 'calendar', title: 'Calendar and conflicts', items: calendars },
    { key: 'sharing', title: 'Sharing', items: sharing }
  ], 'before invitees can book');
  if (type.managed_template) result.headline = 'This is a managed template, so it is not shared directly.';
  return { ...result, shareable: !type.managed_template && result.counts.blocker === 0 };
}
