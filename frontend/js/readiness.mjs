// Shared "Ready to share?" vocabulary for Meet event types and Forms. Pure, so both products'
// rules are unit-tested and use the same words: an item is Ready, Needs attention, Not verified or
// Not required, and an issue is Required (stops people using the link), Optional or Unknown.

export const STATUS_LABELS = { ready: 'Ready', attention: 'Needs attention', unverified: 'Not verified', not_required: 'Not required' };
export const KIND_LABELS = { blocker: 'Required', recommendation: 'Optional', unknown: 'Unknown' };
export const STATUS_ICONS = { ready: '✓', attention: '!', unverified: '?', not_required: '–' };

const count = (n, one, many = one + 's') => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

export function areaStatus(items) {
  const states = items.map(item => item.status).filter(Boolean);
  if (states.includes('attention')) return 'attention';
  if (states.includes('unverified')) return 'unverified';
  if (states.length && states.every(state => state === 'not_required')) return 'not_required';
  return 'ready';
}

/**
 * Adds each area's status, counts the issues and writes a headline. There is no percentage and no
 * all-clear: with no blockers it says only that no required issue was found, plus what is unverified.
 * @param areas [{ key, title, items: [{ status?, kind?, text, action? }] }]
 * @param blockedBefore what a blocker stops, e.g. 'before invitees can book'
 */
export function summarize(areas, blockedBefore) {
  const sized = areas.map(area => ({ ...area, status: areaStatus(area.items) }));
  const all = sized.flatMap(area => area.items);
  const counts = Object.fromEntries(Object.keys(KIND_LABELS).map(kind => [kind, all.filter(item => item.kind === kind).length]));
  const rest = [counts.recommendation && count(counts.recommendation, 'optional recommendation'), counts.unknown && `${count(counts.unknown, 'item')} not verified`].filter(Boolean).join(' and ');
  const headline = counts.blocker
    ? `${count(counts.blocker, 'required item')} ${counts.blocker === 1 ? 'needs' : 'need'} attention ${blockedBefore}.${rest ? ` Also ${rest}.` : ''}`
    : `No required issues in the saved settings.${rest ? ` ${rest[0].toUpperCase() + rest.slice(1)}.` : ''}`;
  return { areas: sized, counts, headline };
}
