// The Workflow surface's map of a form: what each item leads to, using the same jump rules the shared
// logic walks. Pure, so the picture and its tests agree. A display rule can still hide something on a
// path, so "reached" means some rule or next-question step leads there, not that everyone sees it.
import { isHead, outlineMarks } from './forms-groups.mjs';
import { jumpSentence, rulesFor } from './forms-jumps.mjs';
import { choiceRuleSentence } from './forms-choice-rules.mjs';
import { choiceRuleConflicts } from '../shared/forms-logic.mjs';

const END = 'end';
const endingKey = id => `ending:${id}`;
const targetKey = to => to.type === 'ending' ? endingKey(to.id) : to.id;

export function logicMapModel(definition) {
  const { fields } = definition;
  const endings = definition.endings || [];
  const marks = outlineMarks(fields);
  const nodes = fields.map((field, index) => ({
    key: field.id, index, mark: marks[index], type: field.type, member: field.group != null,
    kind: isHead(field) ? 'page' : field.type === 'page_break' ? 'break' : 'question',
    label: isHead(field) ? field.label || 'Untitled page' : field.type === 'page_break' ? 'Page break' : field.label || 'Untitled question'
  }));
  nodes.push(...endings.map((ending, position) => ({ key: endingKey(ending.id), kind: 'ending', label: ending.title || 'Untitled ending', defaultEnding: position === 0, member: false })));
  if (!endings.length) nodes.push({ key: END, kind: 'end', label: 'Submit and receipt', member: false });
  const finish = endings.length ? endingKey(endings[0].id) : END;

  const jumps = [];
  const steps = [];
  fields.forEach((field, index) => {
    const rules = field.type === 'page_break' ? [] : rulesFor(definition, field.id);
    rules.forEach((rule, position) => jumps.push({ from: field.id, to: targetKey(rule.to), conditional: rule.when != null, sentence: jumpSentence(rule, definition, position === 0) }));
    // A rule with no condition is always taken, so nothing falls through to the next item.
    if (rules.at(-1) && rules.at(-1).when == null) return;
    steps.push({ from: field.id, to: fields[index + 1]?.id ?? finish });
  });

  const reached = new Set();
  const queue = fields.length ? [fields[0].id] : [finish];
  const next = key => [...jumps, ...steps].filter(edge => edge.from === key).map(edge => edge.to);
  while (queue.length) {
    const key = queue.pop();
    if (reached.has(key)) continue;
    reached.add(key);
    queue.push(...next(key));
  }
  for (const node of nodes) node.reached = reached.has(node.key);
  // Hide-choice rules change what a question offers, not where it leads, so they are words, not arcs.
  const choices = (definition.choice_rules || []).flatMap(entry => entry.rules.map(rule => ({ field: entry.field, sentence: choiceRuleSentence(rule, fields.find(field => field.id === entry.field), fields) })));
  return { nodes, jumps, steps, choices, conflicts: choiceRuleConflicts(definition), unreached: nodes.filter(node => !node.reached) };
}
