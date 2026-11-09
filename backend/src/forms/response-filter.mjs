// Search and filters for a form's responses (docs/FORMS.md, "Responses: search, filters and export").
// The same filter drives the inbox list and the CSV export, so "Export matching responses" downloads
// exactly what the list shows, across every response rather than only the loaded page.
import { answerText } from '../shared/forms-logic.mjs';
import { fail } from '../http.mjs';

export const RESPONSE_SEARCH_MAX = 200;
const SIGNIN = ['verified', 'anonymous'];

const bad = (field, message) => { fail(400, 'validation_failed', message, { field }); };

// Case- and accent-insensitive words, so "jose" finds "José".
export const fold = text => String(text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const words = text => fold(text).split(/\s+/).filter(Boolean);

/**
 * Reads the filter from a query string. Every value is optional:
 * - q: words that must all appear in an answer, the receipt, attribution, or the verified email or name
 * - version: the form version answered
 * - from / to: submitted at or after / before, in epoch milliseconds
 * - signin: 'verified' (signed in through the workspace's provider) or 'anonymous'
 */
export function parseResponseFilter(query) {
  const get = key => (query.get(key) ?? '').trim();
  const filter = {};
  const q = get('q');
  if (q.length > RESPONSE_SEARCH_MAX) bad('q', `Search is limited to ${RESPONSE_SEARCH_MAX} characters.`);
  if (q) filter.q = q;
  const version = get('version');
  if (version) {
    if (!/^\d{1,6}$/.test(version) || Number(version) < 1) bad('version', 'Choose a published version number.');
    filter.version = Number(version);
  }
  for (const key of ['from', 'to']) {
    const value = get(key);
    if (!value) continue;
    if (!/^\d{1,16}$/.test(value)) bad(key, 'Dates must be epoch milliseconds.');
    filter[key] = Number(value);
  }
  if (filter.from != null && filter.to != null && filter.from >= filter.to) bad('to', 'The end of the date range must be after its start.');
  const signin = get('signin');
  if (signin) {
    if (!SIGNIN.includes(signin)) bad('signin', 'Sign-in filter must be verified or anonymous.');
    filter.signin = signin;
  }
  return filter;
}

export const filterActive = filter => Object.keys(filter || {}).length > 0;

/** SQL conditions (on alias r) for the parts of the filter the database can check. */
export function filterSql(filter) {
  const clauses = [];
  const params = [];
  if (filter.version != null) { clauses.push('r.form_version = ?'); params.push(filter.version); }
  if (filter.from != null) { clauses.push('r.created_at >= ?'); params.push(filter.from); }
  if (filter.to != null) { clauses.push('r.created_at < ?'); params.push(filter.to); }
  if (filter.signin === 'verified') clauses.push('r.respondent IS NOT NULL');
  if (filter.signin === 'anonymous') clauses.push('r.respondent IS NULL');
  return { sql: clauses.map(clause => ` AND ${clause}`).join(''), params };
}

/**
 * The text search. A row is { id, form_version, answers, attribution, respondent } with JSON already
 * parsed. Answers are read with the labels of the version they were given in, so a choice is found by
 * the label the respondent saw.
 */
export function searchMatcher(filter, versions) {
  const wanted = words(filter.q);
  if (!wanted.length) return () => true;
  return row => {
    const fields = versions[row.form_version]?.fields || [];
    const parts = [row.id.replace(/-/g, '').slice(0, 8)];
    for (const [id, value] of Object.entries(row.answers || {})) {
      const field = fields.find(item => item.id === id);
      parts.push(field ? answerText(field, value) : Array.isArray(value) ? value.join(' ') : String(value ?? ''));
    }
    for (const value of Object.values(row.attribution || {})) parts.push(value);
    if (row.respondent) parts.push(row.respondent.email, row.respondent.name);
    const haystack = fold(parts.filter(Boolean).join('\n'));
    return wanted.every(word => haystack.includes(word));
  };
}
