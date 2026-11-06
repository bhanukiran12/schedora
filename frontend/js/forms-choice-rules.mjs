// The builder's hide-choice rules: which questions can have them and how a rule reads. Pure, so the
// editor and its tests agree. The shared forms logic decides what a rule does and whether it is valid.
import { conditionSentence } from './forms-readiness.mjs';
import { defaultCondition, paramCondition } from './forms-jumps.mjs';

/** Only a choice question outside a multi-question page can hide its choices. */
export const canHideChoices = field => Boolean(field?.type?.endsWith('_choice')) && field.group == null;

export const choiceRulesFor = (definition, fieldId) => definition.choice_rules?.find(entry => entry.field === fieldId)?.rules || [];

/** The questions a rule on the item at `index` can read: only earlier ones. */
export const choiceRuleSources = (definition, index) => definition.fields.slice(0, index).filter(field => field.type !== 'page_break');

/** A starting rule: the nearest earlier question, or else the first URL parameter, hiding the first choice. */
export function newChoiceRule(definition, index) {
  const source = choiceRuleSources(definition, index).at(-1);
  return { when: source ? defaultCondition(source) : paramCondition(definition.url_params[0].key), hide: definition.fields[index].options.slice(0, 1).map(option => option.id) };
}

/** Replaces a question's rules, leaving no empty entry or empty list behind. */
export function setChoiceRules(definition, fieldId, rules) {
  const others = (definition.choice_rules || []).filter(entry => entry.field !== fieldId);
  const position = (definition.choice_rules || []).findIndex(entry => entry.field === fieldId);
  if (rules.length) others.splice(position < 0 ? others.length : position, 0, { field: fieldId, rules });
  if (others.length) definition.choice_rules = others; else delete definition.choice_rules;
}

/** Follows a question key change through every hide-choice rule. */
export function renameInChoiceRules(definition, from, to) {
  for (const entry of definition.choice_rules || []) {
    if (entry.field === from) entry.field = to;
    for (const rule of entry.rules) if (rule.when?.field === from) rule.when.field = to;
  }
}

/** Rules leave with the questions that held them. Returns how many went. */
export function dropChoiceRulesFor(definition, fieldIds) {
  let removed = 0;
  for (const id of fieldIds) { removed += choiceRulesFor(definition, id).length; setChoiceRules(definition, id, []); }
  return removed;
}

/** Rules left behind for a question no longer in the form. Returns how many went. */
export function dropOrphanChoiceRules(definition) {
  const orphans = (definition.choice_rules || []).map(entry => entry.field).filter(id => !definition.fields.some(field => field.id === id && field.type !== 'page_break'));
  return dropChoiceRulesFor(definition, orphans);
}

const quoted = text => `“${text}”`;
const listed = names => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/** A rule in plain words, for example: When “Plan” is “Free”, hide “Phone support”. */
export function choiceRuleSentence(rule, field, fields) {
  const words = conditionSentence(rule.when, fields);
  const options = field?.options || [];
  const all = options.length > 0 && options.every(option => rule.hide.includes(option.id));
  const names = rule.hide.map(id => { const option = options.find(item => item.id === id); return option ? quoted(option.label) : 'a choice that was removed'; });
  const effect = all ? 'hide every choice, so this question is skipped' : names.length ? `hide ${listed(names)}` : 'hide nothing yet';
  return `${words[0].toUpperCase()}${words.slice(1)}, ${effect}.`;
}
