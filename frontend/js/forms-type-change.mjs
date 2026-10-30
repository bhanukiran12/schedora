// Changing a question's type in the builder (docs/FORMS.md, "Changing a question's type"). Pure: the
// builder passes in the draft questions, the saved routing and the keys published versions used,
// and gets back what would happen, so nothing changes until the creator confirms.
import { FIELD_TYPES, publishedTypeChangeAllowed } from '../shared/forms-logic.mjs';
import { conditionSentence } from './forms-readiness.mjs';

const TEXT_TYPES = ['short_text', 'long_text', 'email', 'phone', 'date'];
const CHOICE_TYPES = ['single_choice', 'multiple_choice'];
const family = type => CHOICE_TYPES.includes(type) ? 'choice' : 'text';
const typeName = type => FIELD_TYPES[type].toLowerCase();
const VALUE_OPS = ['equals', 'not_equals', 'contains'];

// Every question type a question can be switched to; page breaks are not questions.
export const typeChoices = field => field.type === 'page_break' ? [] : [...TEXT_TYPES, ...CHOICE_TYPES];

/** Display rules and saved routing rules that read this question's answer. */
export function dependentRules(fieldId, fields, routing) {
  const rules = [];
  fields.forEach((field, index) => {
    if (field.show_if?.field === fieldId) rules.push({ where: 'display', index, name: field.type === 'page_break' ? `The page break at position ${index + 1}` : `The question “${field.label || 'Untitled'}”`, condition: field.show_if });
  });
  (routing?.rules || []).forEach((rule, index) => {
    if (rule.condition?.field === fieldId) rules.push({ where: 'routing', index, name: `Saved routing rule ${index + 1}`, condition: rule.condition });
  });
  return rules;
}

const describe = (rule, fields) => `${rule.name}: ${rule.where === 'display' ? 'shown ' : 'applies '}${conditionSentence(rule.condition, fields)}.`;

/**
 * What changing `field` to type `to` would do. kinds:
 *   none     same type;
 *   apply    safe and self-explanatory: apply at once and announce `effects`;
 *   confirm  safe, but settings or rule meanings change: list `effects`, apply only on confirmation;
 *   blocked  rules compare this answer in a way the new type cannot keep: `rules` lists them;
 *   replace  a published version used this key and the new type would change what its answers mean:
 *            offer a new question instead (`canReplace` is false while rules still depend on it).
 * `next` is the converted question (for apply/confirm); the input is never modified. newKey(prefix)
 * makes a fresh key for placeholder options.
 */
export function planTypeChange({ field, to, fields, routing = null, locked = new Set(), newKey }) {
  const from = field.type;
  if (to === from) return { kind: 'none' };
  const rules = dependentRules(field.id, fields, routing);
  const valueRules = rules.filter(rule => VALUE_OPS.includes(rule.condition.op));
  if (locked.has(field.id) && !publishedTypeChangeAllowed(from, to)) {
    return {
      kind: 'replace', canReplace: rules.length === 0, rules: rules.map(rule => describe(rule, fields)),
      reason: `A published version collected ${typeName(from)} answers under this question. As ${typeName(to)}, those answers would mean something different, so it cannot change type in place. You can replace it with a new ${typeName(to)} question: earlier answers stay with the old question in responses and exports.`
    };
  }
  const next = structuredClone(field);
  next.type = to;
  const after = fields.map(item => item === field ? next : item);
  const effects = [];
  let confirm = false;
  if (family(from) !== family(to)) {
    confirm = true;
    // Option keys and typed text cannot stand in for each other, so such rules are never rewritten.
    if (valueRules.length) return {
      kind: 'blocked', rules: valueRules.map(rule => describe(rule, fields)),
      reason: from.endsWith('_choice') ? `These rules compare this answer with its options, which a ${typeName(to)} question does not have. Change or remove them first, then change the type.` : `These rules compare this answer with typed text, which a choice question cannot match. Change or remove them first, then change the type.`
    };
    if (from.endsWith('_choice')) {
      delete next.options;
      effects.push(`Its options are removed from the draft: ${field.options.map(option => `“${option.label}”`).join(', ')}. Change the type back before saving to restore them.`);
    } else {
      next.options = [{ id: newKey('opt'), label: 'Option 1' }, { id: newKey('opt'), label: 'Option 2' }];
      effects.push('Two placeholder options are added for you to rename.');
    }
  } else if (family(from) === 'choice') {
    const changed = rules.filter(rule => VALUE_OPS.includes(rule.condition.op));
    for (const rule of changed) {
      const before = describe(rule, fields);
      const now = describe(rule, after);
      if (before !== now) { confirm = true; effects.push(`${before.replace(/\.$/, '')} — after the change: ${now.slice(rule.name.length + 2)}`); }
    }
    if (to === 'single_choice') { confirm = true; effects.push('Respondents will be able to pick only one option.'); }
  } else if (valueRules.length && ['email', 'phone', 'date'].includes(to)) {
    confirm = true;
    effects.push(`Rules that compare this answer with typed text stay as they are; check in Preview that they can still match a valid ${typeName(to)}.`);
  }
  if (locked.has(field.id)) effects.push('Answers already received keep their original type in responses and exports.');
  return { kind: confirm ? 'confirm' : 'apply', next, effects, rules: rules.map(rule => describe(rule, fields)) };
}

/**
 * A new question replacing a published one: same wording and settings, a new key and the new type.
 * Choice options keep their labels with new keys; text-to-choice starts with two placeholders.
 */
export function replacementQuestion(field, to, newKey) {
  const next = { id: newKey('q'), type: to, label: field.label, required: Boolean(field.required) };
  if (field.help) next.help = field.help;
  if (field.show_if) next.show_if = structuredClone(field.show_if);
  if (to.endsWith('_choice')) next.options = field.options?.length ? field.options.map(option => ({ id: newKey('opt'), label: option.label })) : [{ id: newKey('opt'), label: 'Option 1' }, { id: newKey('opt'), label: 'Option 2' }];
  return next;
}
