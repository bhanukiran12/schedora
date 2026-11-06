// The builder's jump rules: where a question can jump to and how a rule reads. Pure, so the editor
// and its tests agree. The shared forms logic decides what a rule does and whether it is valid.
import { conditionSentence } from './forms-readiness.mjs';
import { outlineMarks } from './forms-groups.mjs';

export const targetValue = to => `${to.type}:${to.id}`;
export const parseTarget = value => { const at = value.indexOf(':'); return { type: value.slice(0, at), id: value.slice(at + 1) }; };

/** Everything after the question at `index`, grouped for a select: later questions, pages, endings. */
export function jumpTargets(definition, index) {
  const marks = outlineMarks(definition.fields);
  let page = 1;
  const questions = [];
  const pages = [];
  definition.fields.forEach((field, position) => {
    if (field.type === 'page_break') page++;
    if (position <= index) return;
    if (field.type === 'page_break') pages.push({ value: targetValue({ type: 'group', id: field.id }), label: field.grouped ? field.label || 'Untitled page' : `Page ${page}` });
    else questions.push({ value: targetValue({ type: 'field', id: field.id }), label: `${marks[position]}. ${field.label || 'Untitled question'}` });
  });
  const endings = (definition.endings || []).map(ending => ({ value: targetValue({ type: 'ending', id: ending.id }), label: ending.title || 'Untitled ending' }));
  return [{ label: 'Questions', items: questions }, { label: 'Pages', items: pages }, { label: 'Endings', items: endings }].filter(group => group.items.length);
}

/** A starting condition for a question: its first option, or simply that it was answered. */
export const defaultCondition = field => field.type.endsWith('_choice') ? { field: field.id, op: 'equals', value: field.options[0]?.id } : { field: field.id, op: 'answered' };

/** A starting condition on a URL parameter: its value, still to be typed. */
export const paramCondition = key => ({ param: key, op: 'equals', value: '' });

export const rulesFor = (definition, fieldId) => definition.logic?.find(entry => entry.field === fieldId)?.rules || [];

/** Replaces a question's rules, leaving no empty entry or empty list behind. */
export function setRules(definition, fieldId, rules) {
  const others = (definition.logic || []).filter(entry => entry.field !== fieldId);
  const position = (definition.logic || []).findIndex(entry => entry.field === fieldId);
  if (rules.length) others.splice(position < 0 ? others.length : position, 0, { field: fieldId, rules });
  if (others.length) definition.logic = others; else delete definition.logic;
}

/** Follows a question key change through every jump rule, as display rules already do. */
export function renameInLogic(definition, from, to) {
  const follow = condition => { if (condition?.field === from) condition.field = to; };
  for (const entry of definition.logic || []) {
    if (entry.field === from) entry.field = to;
    for (const rule of entry.rules) {
      if (rule.to.type !== 'ending' && rule.to.id === from) rule.to.id = to;
      if (rule.when?.all || rule.when?.any) (rule.when.all || rule.when.any).forEach(follow); else follow(rule.when);
    }
  }
}

const targetName = (definition, to) => {
  if (to.type === 'ending') return `the ending “${definition.endings?.find(ending => ending.id === to.id)?.title || 'Untitled ending'}”`;
  const position = definition.fields.findIndex(field => field.id === to.id);
  if (to.type === 'group' && definition.fields[position]?.grouped) return `the page “${definition.fields[position].label}”`;
  if (to.type === 'group') return `page ${definition.fields.slice(0, position + 1).filter(field => field.type === 'page_break').length + 1}`;
  return `“${definition.fields[position]?.label || 'Untitled question'}”`;
};

/** A rule in plain words, for example: When “Topic” is “Other”, go to “Email”. */
export function jumpSentence(rule, definition, first = true) {
  const target = targetName(definition, rule.to);
  if (rule.when == null) return `${first ? 'Always' : 'Otherwise'} go to ${target}.`;
  const group = rule.when.all || rule.when.any;
  const words = (group || [rule.when]).map(condition => conditionSentence(condition, definition.fields)).join(rule.when.all ? ', and ' : ', or ');
  return `${words[0].toUpperCase()}${words.slice(1)}, go to ${target}.`;
}
