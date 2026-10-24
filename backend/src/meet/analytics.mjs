import { isValidDate, localDate, zonedParts } from '../time.mjs';
import { invalid } from '../validate.mjs';
import { can } from '../platform/workspaces.mjs';

// Scheduling analytics for a date range, in the requested time zone. Members see their own
// meetings; administrators see the whole workspace.
export function analytics(app, workspaceId, actor, { from, to, timezone = 'UTC' }) {
  if (!isValidDate(from) || !isValidDate(to) || from > to) invalid('from', 'Choose a valid date range.');
  const start = Date.parse(from + 'T00:00:00Z') - 14 * 3600000;
  const end = Date.parse(to + 'T23:59:59Z') + 14 * 3600000;
  const all = can(actor.role, 'meet.manage_all');
  const rows = app.db.all(`SELECT b.id, b.status, b.canceled_by, b.starts_at, b.created_at, b.rescheduled_from, b.source, b.payment_status, b.amount_cents, b.currency,
      e.id AS event_type_id, e.title AS event_title, b.host_id, u.name AS host_name
    FROM bookings b JOIN event_types e ON e.id = b.event_type_id JOIN users u ON u.id = b.host_id
    WHERE b.workspace_id = ? AND b.starts_at BETWEEN ? AND ?
      AND (? = 1 OR EXISTS (SELECT 1 FROM meeting_hosts h WHERE h.meeting_id = b.meeting_id AND h.host_id = ?))`, workspaceId, start, end, all ? 1 : 0, actor.userId)
    .filter(row => { const date = localDate(row.starts_at, timezone); return date >= from && date <= to; });

  // A reschedule cancels one record and creates another; count only the new one.
  const scheduled = rows.filter(row => row.canceled_by !== 'reschedule');
  const live = rows.filter(row => row.status === 'confirmed');
  const canceled = rows.filter(row => row.status === 'canceled' && row.canceled_by !== 'reschedule');
  const group = (list, key, label) => Object.values(list.reduce((acc, row) => {
    acc[row[key]] ??= { id: row[key], label: row[label], booked: 0, canceled: 0 };
    if (row.status === 'canceled') acc[row[key]].canceled++; else acc[row[key]].booked++;
    return acc;
  }, {})).sort((a, b) => b.booked - a.booked);

  const daily = {};
  const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const row of live) {
    const date = localDate(row.starts_at, timezone);
    daily[date] = (daily[date] || 0) + 1;
    const parts = zonedParts(row.starts_at, timezone);
    heatmap[new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()][parts.hour]++;
  }
  const leadTimes = live.map(row => (row.starts_at - row.created_at) / 3600000).filter(hours => hours >= 0).sort((a, b) => a - b);
  const revenue = {};
  for (const row of live) if (row.payment_status === 'paid') revenue[row.currency] = (revenue[row.currency] || 0) + row.amount_cents;
  return {
    range: { from, to, timezone },
    totals: {
      scheduled: scheduled.length, confirmed: live.length, canceled: canceled.length,
      rescheduled: rows.filter(row => row.rescheduled_from).length,
      cancellation_rate: scheduled.length ? Math.round((canceled.length / scheduled.length) * 1000) / 10 : 0,
      median_lead_hours: leadTimes.length ? Math.round(leadTimes[Math.floor(leadTimes.length / 2)]) : null
    },
    by_event_type: group(scheduled, 'event_type_id', 'event_title'),
    by_host: group(scheduled, 'host_id', 'host_name'),
    by_source: Object.entries(live.reduce((acc, row) => ({ ...acc, [row.source]: (acc[row.source] || 0) + 1 }), {})).map(([source, count]) => ({ source, count })),
    daily: Object.entries(daily).sort().map(([date, count]) => ({ date, count })),
    heatmap,
    revenue: Object.entries(revenue).map(([currency, cents]) => ({ currency, cents }))
  };
}
