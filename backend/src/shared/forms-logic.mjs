// Forms logic shared by the browser renderer and the server validator, so conditional
// visibility, answer piping and validation always agree. The server result is authoritative.

export const FIELD_TYPES = {
  short_text: 'Short text',
  long_text: 'Long text',
  email: 'Email',
  phone: 'Phone',
  single_choice: 'Single choice',
  multiple_choice: 'Multiple choice',
  date: 'Date',
  page_break: 'Page break'
};
// A question key that a published version used keeps its meaning. Its type may change only when
// every answer already collected under that key still means the same thing in the new type:
// a narrower text becomes wider text, or one choice becomes one of several. Anything else needs a
// new question with a new key (docs/FORMS.md, "Changing a question's type").
const WIDER_TYPES = { short_text: ['long_text'], email: ['short_text', 'long_text'], phone: ['short_text', 'long_text'], date: ['short_text', 'long_text'], single_choice: ['multiple_choice'] };
export const publishedTypeChangeAllowed = (from, to) => from === to || Boolean(WIDER_TYPES[from]?.includes(to));

export const CONDITION_OPS = { equals: 'is', not_equals: 'is not', contains: 'includes', answered: 'is answered', not_answered: 'is not answered' };
const LIMITS = { short_text: 300, long_text: 5000, email: 254, phone: 30 };
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const isAnswered = value => Array.isArray(value) ? value.length > 0 : value != null && String(value).trim() !== '';

export function conditionHolds(condition, answers) {
  if (!condition) return true;
  const value = answers[condition.field];
  switch (condition.op) {
    case 'answered': return isAnswered(value);
    case 'not_answered': return !isAnswered(value);
    case 'equals': return Array.isArray(value) ? value.length === 1 && value[0] === condition.value : value === condition.value;
    case 'not_equals': return Array.isArray(value) ? !(value.length === 1 && value[0] === condition.value) : value !== condition.value;
    case 'contains': return Array.isArray(value) ? value.includes(condition.value) : typeof value === 'string' && value.toLowerCase().includes(String(condition.value).toLowerCase());
    default: return false;
  }
}

// Visible questions grouped by page. A hidden page hides every question on it; a question whose
// condition refers to a hidden question treats that answer as empty.
export function visiblePages(definition, answers) {
  const visible = {};
  const pages = [[]];
  let pageVisible = true;
  for (const field of definition.fields) {
    const effective = { ...answers };
    for (const key of Object.keys(effective)) if (!visible[key]) delete effective[key];
    if (field.type === 'page_break') {
      pageVisible = conditionHolds(field.show_if, effective);
      if (pages[pages.length - 1].length) pages.push([]);
      continue;
    }
    if (pageVisible && conditionHolds(field.show_if, effective)) {
      visible[field.id] = true;
      pages[pages.length - 1].push(field);
    }
  }
  return pages.filter((page, index) => page.length || index === 0);
}

export const visibleFields = (definition, answers) => visiblePages(definition, answers).flat();

export function answerText(field, value) {
  if (!isAnswered(value)) return '';
  if (field.type === 'single_choice') return field.options.find(option => option.id === value)?.label ?? '';
  if (field.type === 'multiple_choice') return value.map(id => field.options.find(option => option.id === id)?.label).filter(Boolean).join(', ');
  return String(value);
}

// Replaces {{field_id}} with the plain-text answer. Callers must escape the result for HTML.
export function pipe(text, definition, answers) {
  return String(text ?? '').replace(/\{\{\s*([a-z0-9_]{1,40})\s*\}\}/g, (_, id) => {
    const field = definition.fields.find(candidate => candidate.id === id);
    return field ? answerText(field, answers[id]) || '…' : '';
  });
}

// Returns an error message or null, plus the normalized value.
export function checkAnswer(field, raw) {
  let value = raw;
  if (field.type === 'multiple_choice') {
    if (value == null || value === '') value = [];
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return { error: 'Choose from the listed options.' };
    value = [...new Set(value)];
    if (value.some(item => !field.options.some(option => option.id === item))) return { error: 'Choose from the listed options.' };
  } else if (value != null && typeof value !== 'string') {
    return { error: 'Enter text.' };
  } else {
    value = (value ?? '').replace(/\r\n?/g, '\n');
    value = field.type === 'long_text' ? value.trim() : value.replace(/\s+/g, ' ').trim();
  }
  if (!isAnswered(value)) return field.required ? { error: field.type.endsWith('choice') ? 'Choose an option.' : 'This question is required.' } : { value: field.type === 'multiple_choice' ? [] : '' };
  if (LIMITS[field.type] && value.length > LIMITS[field.type]) return { error: `Use ${LIMITS[field.type]} characters or fewer.` };
  if (field.type === 'email' && !EMAIL.test(value)) return { error: 'Enter a valid email address, like name@example.com.' };
  if (field.type === 'phone' && !/^\+?[0-9][0-9 ().-]{5,25}$/.test(value)) return { error: 'Enter a phone number with country code, like +91 98765 43210.' };
  if (field.type === 'single_choice' && !field.options.some(option => option.id === value)) return { error: 'Choose from the listed options.' };
  if (field.type === 'date') {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value + 'T00:00:00Z');
    if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return { error: 'Enter a date as YYYY-MM-DD.' };
  }
  if (field.type === 'email') value = value.toLowerCase();
  return { value };
}

// Validates a whole submission. Answers to hidden questions are discarded, never stored.
export function validateSubmission(definition, answers = {}) {
  const errors = {};
  const cleaned = {};
  for (const field of visibleFields(definition, answers)) {
    const result = checkAnswer(field, answers[field.id]);
    if (result.error) errors[field.id] = result.error;
    else if (isAnswered(result.value)) cleaned[field.id] = result.value;
  }
  return { answers: cleaned, errors };
}

// Structural validation of a form definition. Returns a list of problems (empty when valid).
export function definitionProblems(definition) {
  const problems = [];
  if (!definition || typeof definition !== 'object') return ['Form definition is missing.'];
  if (typeof definition.title !== 'string' || !definition.title.trim() || definition.title.length > 150) problems.push('Give the form a title of up to 150 characters.');
  if (typeof (definition.description ?? '') !== 'string' || (definition.description ?? '').length > 2000) problems.push('Keep the description under 2000 characters.');
  if (!['classic', 'conversational'].includes(definition.presentation)) problems.push('Choose classic or conversational presentation.');
  if (!Array.isArray(definition.fields) || definition.fields.length > 100) return [...problems, 'A form can have up to 100 items.'];
  const seen = new Map();
  definition.fields.forEach((field, index) => {
    const name = `Item ${index + 1}`;
    if (!field || typeof field !== 'object') { problems.push(`${name} is invalid.`); return; }
    if (typeof field.id !== 'string' || !/^[a-z0-9_]{1,40}$/.test(field.id)) problems.push(`${name} needs an id of lowercase letters, numbers or underscores.`);
    else if (seen.has(field.id)) problems.push(`${name} reuses the id "${field.id}".`);
    if (!FIELD_TYPES[field.type]) problems.push(`${name} has an unsupported type.`);
    if (field.type !== 'page_break' && (typeof field.label !== 'string' || !field.label.trim() || field.label.length > 300)) problems.push(`${name} needs a question of up to 300 characters.`);
    if (field.help != null && (typeof field.help !== 'string' || field.help.length > 500)) problems.push(`${name} help text must be under 500 characters.`);
    if (field.required != null && typeof field.required !== 'boolean') problems.push(`${name} required must be true or false.`);
    if (field.type?.endsWith('_choice')) {
      if (!Array.isArray(field.options) || field.options.length < 1 || field.options.length > 50) problems.push(`${name} needs 1–50 options.`);
      else {
        const ids = new Set();
        for (const option of field.options) {
          if (typeof option?.id !== 'string' || !/^[a-z0-9_]{1,40}$/.test(option.id) || ids.has(option.id)) problems.push(`${name} has an invalid or repeated option id.`);
          if (typeof option?.label !== 'string' || !option.label.trim() || option.label.length > 200) problems.push(`${name} options need labels up to 200 characters.`);
          ids.add(option?.id);
        }
      }
    }
    if (field.show_if) {
      const condition = field.show_if;
      const source = seen.get(condition.field);
      if (!source) problems.push(`${name} logic must refer to an earlier question.`);
      if (!CONDITION_OPS[condition.op]) problems.push(`${name} logic has an unsupported rule.`);
      if (['equals', 'not_equals', 'contains'].includes(condition.op) && (typeof condition.value !== 'string' || condition.value.length > 300)) problems.push(`${name} logic needs a value.`);
      if (source?.type?.endsWith('_choice') && ['equals', 'not_equals', 'contains'].includes(condition.op) && !source.options?.some(option => option.id === condition.value)) problems.push(`${name} logic must use one of the options of "${source.label}".`);
    }
    if (typeof field.id === 'string') seen.set(field.id, field);
  });
  return problems;
}

export function starterDefinition(title = 'Untitled form') {
  return {
    title, description: '', presentation: 'classic', submit_label: 'Submit',
    fields: [
      { id: 'name', type: 'short_text', label: 'What is your name?', required: true },
      { id: 'email', type: 'email', label: 'Thanks, {{name}}. What email should we reply to?', required: true },
      { id: 'topic', type: 'single_choice', label: 'What can we help with?', required: true, options: [{ id: 'new_project', label: 'A new project' }, { id: 'support', label: 'Support' }, { id: 'other', label: 'Something else' }] },
      { id: 'details', type: 'long_text', label: 'Tell us a little more', required: false, show_if: { field: 'topic', op: 'equals', value: 'other' } }
    ]
  };
}
