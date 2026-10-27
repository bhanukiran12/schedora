// "Ready to share?" for a form: what respondents see now, what the saved draft would publish, what
// happens after they submit, and how the form is shared. Pure: the builder passes in the saved form
// (GET /forms/:id), the live public payload (GET /api/public/forms/:slug), the event types the viewer
// can see and the shared form logic, so the same validator and visibility rules the server uses
// decide every status. Unsaved edits on the page are never assessed.
import { summarize } from './readiness.mjs';

const count = (n, one, many = one + 's') => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;
const quote = text => `“${text.length > 60 ? text.slice(0, 59) + '…' : text}”`;
const questionsOf = definition => definition.fields.filter(field => field.type !== 'page_break');
// More answer combinations than this are not explored; the result is then "Not verified".
export const MAX_COMBINATIONS = 4096;

/**
 * Questions no combination of answers can show, found with the shared visibility evaluator. Each
 * controlling question is tried unanswered and with every value a condition can distinguish.
 * @returns { unreachable: field[], complete: boolean }
 */
export function unreachableFields(definition, visibleFields, limit = MAX_COMBINATIONS) {
  const conditions = definition.fields.map(field => field.show_if).filter(Boolean);
  const controlling = [...new Set(conditions.map(condition => condition.field))].map(id => definition.fields.find(field => field.id === id)).filter(Boolean);
  // Text can contain several rule values at once (e.g. "red blue"). Sampling each value
  // separately cannot prove a question unreachable. Keep this check explicitly unverified.
  if (conditions.some(condition => condition.op === 'contains' && controlling.some(field => field.id === condition.field && !field.type.endsWith('_choice')))) {
    return { unreachable: [], complete: false, reason: 'text_contains' };
  }
  const candidates = controlling.map(field => {
    if (field.type === 'single_choice') return [undefined, ...field.options.map(option => option.id)];
    if (field.type === 'multiple_choice') return [[], ...field.options.map(option => [option.id]), field.options.map(option => option.id)];
    const values = conditions.filter(condition => condition.field === field.id && typeof condition.value === 'string').map(condition => condition.value);
    let other = 'any answer';
    while (values.includes(other)) other += ' other';
    return [undefined, '', other, ...new Set(values)];
  });
  const total = candidates.reduce((product, options) => product * options.length, 1);
  if (total > limit) return { unreachable: [], complete: false };
  const seen = new Set();
  for (let index = 0; index < total; index++) {
    const answers = {};
    let rest = index;
    controlling.forEach((field, position) => {
      const options = candidates[position];
      const value = options[rest % options.length];
      rest = Math.floor(rest / options.length);
      if (value !== undefined) answers[field.id] = value;
    });
    for (const field of visibleFields(definition, answers)) seen.add(field.id);
  }
  return { unreachable: questionsOf(definition).filter(field => !seen.has(field.id)), complete: true };
}

// {{key}} insertions that can only show blank ("unknown") or "…" (asked later).
export function placeholderIssues(definition) {
  const issues = [];
  const positions = new Map(definition.fields.map((field, index) => [field.id, index]));
  definition.fields.forEach((field, index) => {
    for (const text of [field.label, field.help]) {
      for (const [, key] of String(text || '').matchAll(/\{\{\s*([a-z0-9_]{1,40})\s*\}\}/g)) {
        if (!positions.has(key)) issues.push({ field, key, problem: 'unknown' });
        else if (positions.get(key) === index) issues.push({ field, key, problem: 'self' });
        else if (positions.get(key) > index) issues.push({ field, key, problem: 'later' });
      }
    }
  });
  return issues;
}

// Plain-language differences between the live version and the saved draft (questions and settings).
export function draftChanges(live, draft) {
  const liveFields = new Map(questionsOf(live).map(field => [field.id, field]));
  const draftFields = new Map(questionsOf(draft).map(field => [field.id, field]));
  const added = [...draftFields.keys()].filter(id => !liveFields.has(id)).length;
  const removed = [...liveFields.keys()].filter(id => !draftFields.has(id)).length;
  const changed = [...draftFields].filter(([id, field]) => liveFields.has(id) && JSON.stringify(field) !== JSON.stringify(liveFields.get(id))).length;
  const order = JSON.stringify(live.fields.map(field => field.id)) !== JSON.stringify(draft.fields.map(field => field.id));
  const settings = ['title', 'description', 'presentation', 'submit_label'].filter(key => (live[key] ?? '') !== (draft[key] ?? ''));
  return [
    added && `${count(added, 'question')} added`, removed && `${count(removed, 'question')} removed`, changed && `${count(changed, 'question')} changed`,
    order && !added && !removed && 'order or page breaks changed', settings.length && `${settings.map(key => key.replace('_', ' ')).join(', ')} changed`
  ].filter(Boolean);
}

/**
 * @param input {
 *   form: saved form from GET /forms/:id,
 *   live: { ok, value } from GET /api/public/forms/:slug, or null when there is no live version,
 *   eventTypes: { ok, value } from GET /event-types (only those the viewer can see),
 *   viewer: { admin }, flags: { formsActive, meetActive }, baseUrl,
 *   logic: { definitionProblems, visibleFields } from the shared forms logic, now
 * }
 */
export function assessFormReadiness({ form, live, eventTypes, viewer, flags, baseUrl, logic, now = Date.now() }) {
  const draft = form.draft;
  const closed = form.published_version == null && form.locked_ids?.length > 0;
  const liveDefinition = live?.ok ? live.value.definition : null;
  const link = `${baseUrl}/f/${form.slug}`;

  // ---- Draft and live ----
  const versions = [];
  if (form.published_version == null) {
    versions.push(closed
      ? { status: 'attention', kind: 'blocker', text: 'Closed: the link tells people the form is not accepting responses. Responses already received are kept.', action: { label: 'Go to Publish', section: 'publish' } }
      : { status: 'attention', kind: 'blocker', text: 'Not published. Nobody can open the link yet. Publishing happens only when you select Publish.', action: { label: 'Go to Publish', section: 'publish' } });
    if (!flags.formsActive) versions.push({ status: 'attention', kind: 'blocker', text: 'This workspace has no active Forms or Suite plan, so publishing is refused.', action: viewer.admin ? { label: 'Review plans', href: '/billing' } : { note: 'Ask a workspace owner about the plan.' } });
  } else if (!live?.ok) {
    versions.push({ status: 'unverified', kind: 'unknown', text: `Version ${form.published_version} is live, but what respondents see could not be checked${live?.error?.message ? ` (${live.error.message})` : ''}.`, action: { retry: true, label: 'Check again' } });
  } else {
    const changes = draftChanges(liveDefinition, draft);
    if (!form.has_unpublished_changes) versions.push({ status: 'ready', text: `Respondents see version ${form.published_version}, which matches your saved draft.` });
    else versions.push({ status: 'attention', kind: 'recommendation', text: `Your saved draft differs from live version ${form.published_version}: ${changes.length ? changes.join('; ') : 'the questions and settings match, so the difference is in the next step after submitting, which cannot be compared with the live version here'}. Respondents keep seeing version ${form.published_version} until you publish.`, action: { label: 'Go to Publish', section: 'publish' } });
    const state = live.value.availability;
    if (state === 'capacity_reached') versions.push({ status: 'attention', kind: 'blocker', text: 'The workspace\'s monthly response allowance is used up. The form says so and refuses new responses until the allowance resets.', action: viewer.admin ? { label: 'Review plans', href: '/billing' } : { note: 'Ask a workspace owner about the allowance.' } });
    else if (state === 'not_accepting') versions.push({ status: 'attention', kind: 'blocker', text: 'This workspace has no active Forms or Suite plan, so the form is not accepting responses.', action: viewer.admin ? { label: 'Review plans', href: '/billing' } : { note: 'Ask a workspace owner about the plan.' } });
    else versions.push({ status: 'ready', text: 'The live form is accepting responses.' });
  }

  // ---- Questions and logic (the saved draft, which is what Publish would make live) ----
  const questions = [];
  const asked = questionsOf(draft);
  const problems = logic.definitionProblems(draft);
  for (const problem of problems) questions.push({ status: 'attention', kind: 'blocker', text: problem, action: { label: 'Review questions', section: 'questions' } });
  if (!asked.length) questions.push({ status: 'attention', kind: 'blocker', text: 'There are no questions yet. Add at least one before publishing.', action: { label: 'Add a question', section: 'questions' } });
  else {
    const pages = draft.fields.filter(field => field.type === 'page_break').length + 1;
    const conditional = asked.filter(field => field.show_if).length + draft.fields.filter(field => field.type === 'page_break' && field.show_if).length;
    if (!problems.length) questions.push({ status: 'ready', text: `${count(asked.length, 'question')} (${asked.filter(field => field.required).length} required)${draft.presentation === 'classic' ? ` on ${count(pages, 'page')}` : ''}; every question and rule passes the same checks the server runs.${conditional ? ` ${count(conditional, 'item')} ${conditional === 1 ? 'is' : 'are'} shown only when an earlier answer matches.` : ''}` });
    const reach = problems.length ? null : unreachableFields(draft, logic.visibleFields);
    if (reach && !reach.complete) questions.push({ status: 'unverified', kind: 'unknown', text: reach.reason === 'text_contains'
      ? 'Text-includes rules can match several phrases in one answer, so automatic checks cannot verify every question path. Try those combinations in Preview.'
      : 'The display rules allow too many answer combinations to check that every question can be reached.' });
    for (const field of reach?.unreachable || []) {
      questions.push({ status: 'attention', kind: 'recommendation', text: `${quote(field.label)} can never be shown with these display rules${field.required ? ', so it is never asked even though it is required' : ''}. Respondents can still submit.`, action: { label: 'Review its rule', section: 'questions' } });
    }
    for (const issue of placeholderIssues(draft)) {
      questions.push({ status: 'attention', kind: 'recommendation', text: issue.problem === 'unknown'
        ? `${quote(issue.field.label)} inserts {{${issue.key}}}, which is not a question in this form, so it shows nothing.`
        : `${quote(issue.field.label)} inserts {{${issue.key}}}, which is ${issue.problem === 'self' ? "this question's own answer" : 'asked later'}, so respondents see “…”.`, action: { label: 'Review questions', section: 'questions' } });
    }
  }

  // ---- Respondent preview ----
  const preview = [
    { status: 'ready', text: `Respondents get the ${draft.presentation === 'conversational' ? 'conversational presentation (one question at a time)' : 'classic presentation (questions grouped into pages)'}. A conversational link is also available.` },
    { text: 'Preview shows this page\'s questions, including unsaved edits, in either presentation. It runs only in your browser: no response, usage or follow-up is created.', action: { label: 'Preview classic', section: 'preview-classic' } },
    { text: 'Try answers that change which questions appear, then switch presentation to compare.', action: { label: 'Preview conversational', section: 'preview-conversational' } }
  ];

  // ---- After submission ----
  const after = [{ text: 'Every accepted response shows a receipt with a reference and time. The receipt means the response was received, nothing more.' }];
  const routing = form.routing;
  if (!routing || (!routing.rules?.length && !routing.fallback)) {
    after.push({ status: 'not_required', text: 'No next step is set, so respondents see the receipt only. No booking is offered.' });
  } else {
    const fields = new Map(asked.map(field => [field.id, field]));
    const known = eventTypes?.ok ? new Map(eventTypes.value.map(type => [type.id, type])) : null;
    const steps = [...(routing.rules || []).map((rule, index) => [`Rule ${index + 1}`, rule]), ...(routing.fallback ? [['If no rule matches', { action: routing.fallback }]] : [])];
    for (const [name, rule] of steps) {
      if (rule.condition) {
        const field = fields.get(rule.condition.field);
        if (!field) after.push({ status: 'attention', kind: 'blocker', text: `${name} refers to a question that is no longer in the form, so publishing is refused.`, action: { label: 'Edit routing', section: 'routing' } });
        else if (field.type.endsWith('_choice') && ['equals', 'not_equals', 'contains'].includes(rule.condition.op) && !field.options.some(option => option.id === rule.condition.value)) {
          after.push({ status: 'attention', kind: 'blocker', text: `${name} refers to an option that is no longer in ${quote(field.label)}, so publishing is refused.`, action: { label: 'Edit routing', section: 'routing' } });
        }
      }
      const action = rule.action;
      if (action?.type === 'event') {
        const type = known?.get(action.event_type_id);
        if (!known) after.push({ status: 'unverified', kind: 'unknown', text: `${name} offers a booking page that could not be checked${eventTypes?.error?.message ? ` (${eventTypes.error.message})` : ''}.`, action: { retry: true, label: 'Check again' } });
        else if (!type) after.push(viewer.admin
          ? { status: 'attention', kind: 'blocker', text: `${name} offers a booking page that was deleted, so publishing is refused.`, action: { label: 'Edit routing', section: 'routing' } }
          : { status: 'unverified', kind: 'unknown', text: `${name} offers a booking page you cannot see (another host's). Publishing checks it on the server.` });
        else if (!type.published || type.managed_template || (type.expires_at && type.expires_at <= now)) after.push({ status: 'attention', kind: 'blocker', text: `${name} offers ${quote(type.title)}, which is not published, so publishing is refused.`, action: { label: `Open ${type.title}`, href: `/meet/event-types/${type.id}` } });
        else after.push({ status: 'ready', text: `${name} offers ${quote(type.title)}. The receipt says “Response received — choose a time”. Nothing is booked until the respondent picks a time, and only Meet's confirmation means an appointment exists.`, action: { label: `Check ${quote(type.title)} is ready to share`, href: `/meet/event-types/${type.id}` } });
      } else if (action?.type === 'url') after.push({ status: 'ready', text: `${name} shows a link to ${action.url}.` });
      else if (action?.type === 'message') after.push({ status: 'ready', text: `${name} shows the message ${quote(action.message || '(empty)')}.` });
    }
    if (steps.some(([, rule]) => rule.action?.type === 'event') && !flags.meetActive) {
      after.push({ status: 'attention', kind: 'blocker', text: 'Booking pages need an active Meet or Suite plan. Without one, publishing with booking rules is refused.', action: viewer.admin ? { label: 'Review plans', href: '/billing' } : { note: 'Ask a workspace owner about the plan.' } });
    }
    if (routing.rules?.length && !routing.fallback) after.push({ text: 'If no rule matches, respondents see the receipt only.' });
    after.push({ text: `This is the saved routing${form.published_version && form.has_unpublished_changes ? '; the live version keeps the routing published with it until you publish' : ''}. These checks use the same rules as the server, which checks again when you publish.` });
  }

  // ---- Sharing ----
  const sharing = [];
  if (form.published_version == null) sharing.push({ status: 'attention', kind: 'blocker', text: `${closed ? 'Closed' : 'Not published'}: the link below does not accept responses. Copy and embed appear once the form is published.`, action: { label: 'Go to Publish', section: 'publish' } });
  else sharing.push({ status: live?.ok && live.value.accepting ? 'ready' : 'unverified', ...(live?.ok && live.value.accepting ? {} : { kind: 'unknown' }), text: live?.ok && live.value.accepting ? 'Published: anyone with the link can respond. The embed code shows the same live form.' : 'Published, but whether the link is accepting responses was not confirmed.' });
  sharing.push({ text: 'Copying a link does not show that responses are received or that follow-ups work.' });

  const result = summarize([
    { key: 'versions', title: 'Draft and live', items: versions },
    { key: 'questions', title: 'Questions and logic', items: questions },
    { key: 'preview', title: 'Respondent preview', items: preview },
    { key: 'after', title: 'After submission', items: after },
    { key: 'sharing', title: 'Sharing', items: sharing }
  ], 'before people can respond');
  return { ...result, link, shareable: result.counts.blocker === 0 };
}
