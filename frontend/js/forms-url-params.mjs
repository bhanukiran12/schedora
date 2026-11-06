// The builder's URL parameters: declaring them, what depends on them and an example link. Pure, so the
// editor and its tests agree. The shared forms logic decides what a value means and how rules read it.
import { jumpSentence, rulesFor } from './forms-jumps.mjs';
import { choiceRuleSentence, choiceRulesFor } from './forms-choice-rules.mjs';

export const declaredParams = definition => definition.url_params || [];

/** A rule's source as a select value. Question keys cannot contain a colon, so the two never clash. */
export const paramSourceValue = key => `param:${key}`;
export const parseParamSource = value => String(value).startsWith('param:') ? String(value).slice(6) : null;

export function addUrlParam(definition, key) {
  definition.url_params = [...declaredParams(definition), { key }];
}

export function setUrlParamRecorded(definition, key, recorded) {
  const param = declaredParams(definition).find(item => item.key === key);
  if (!param) return;
  if (recorded) param.record = true; else delete param.record;
}

/** Removes a declaration, leaving no empty list behind. */
export function removeUrlParam(definition, key) {
  const left = declaredParams(definition).filter(item => item.key !== key);
  if (left.length) definition.url_params = left; else delete definition.url_params;
}

const conditionsOf = when => when?.all || when?.any || (when ? [when] : []);
const usesParam = (when, key) => conditionsOf(when).some(condition => condition?.param === key);
const questionName = field => `“${field.label || 'Untitled question'}”`;

/** Every rule that reads a parameter, in words, so removing it can say what it would break. */
export function urlParamUses(definition, key) {
  const uses = [];
  for (const field of definition.fields) {
    rulesFor(definition, field.id).forEach((rule, position) => { if (usesParam(rule.when, key)) uses.push(`${questionName(field)}: ${jumpSentence(rule, definition, position === 0)}`); });
    for (const rule of choiceRulesFor(definition, field.id)) if (usesParam(rule.when, key)) uses.push(`${questionName(field)}: ${choiceRuleSentence(rule, field, definition.fields)}`);
  }
  return uses;
}

const ruleValue = (definition, key) => {
  const rules = [...(definition.logic || []), ...(definition.choice_rules || [])].flatMap(entry => entry.rules);
  return rules.flatMap(rule => conditionsOf(rule.when)).find(condition => condition?.param === key && condition.value?.trim())?.value;
};

/** The respondent link with every declared parameter, using a value a rule looks for where there is one. */
export function exampleLink(base, definition) {
  const params = declaredParams(definition).map(({ key }) => [key, ruleValue(definition, key) || 'example']);
  return params.length ? `${base}?${new URLSearchParams(params)}` : base;
}
