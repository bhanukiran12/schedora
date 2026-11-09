// The Forms workspace list: status, search and filters. Pure, so the page and its tests agree.

/** live: collecting now; closed: published before, not collecting; draft: never published. */
export const formStatus = form => form.published_version ? 'live' : form.latest_version ? 'closed' : 'draft';

export const STATUS_FILTERS = [['all', 'All'], ['live', 'Live'], ['draft', 'Drafts'], ['closed', 'Closed']];

const fold = text => String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Forms matching a search (every word, in the title or description) and a status, newest change first. */
export function filterForms(forms, { query = '', status = 'all' } = {}) {
  const words = fold(query).split(' ').filter(Boolean);
  return forms
    .filter(form => status === 'all' || formStatus(form) === status)
    .filter(form => { const text = fold(`${form.draft?.title} ${form.draft?.description}`); return words.every(word => text.includes(word)); })
    .sort((a, b) => b.updated_at - a.updated_at);
}

export const statusCounts = forms => Object.fromEntries(STATUS_FILTERS.map(([key]) => [key, key === 'all' ? forms.length : forms.filter(form => formStatus(form) === key).length]));

/** The title a duplicate gets, within the 150-character title limit. */
export const copyTitle = title => { const text = `Copy of ${String(title || 'Untitled form').trim()}`; return text.length > 150 ? text.slice(0, 149) + '…' : text; };
