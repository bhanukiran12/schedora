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

// ---- Media (docs/FORMS.md, "Media") ----
// A question may show one image (an uploaded workspace asset) or one video from an allow-listed
// provider; choice options may show an image. Logic, routing and answers always use option ids.
const ASSET_ID = /^[a-f0-9]{32}$/;
const VIDEO_IDS = { youtube: /^[A-Za-z0-9_-]{11}$/, vimeo: /^[0-9]{1,12}$/ };
export const VIDEO_PROVIDERS = { youtube: 'YouTube', vimeo: 'Vimeo' };
export const MEDIA_LIMITS = { alt: 250, videoTitle: 150 };

/** A supported YouTube or Vimeo address as { provider, video }, or null. Never fetched. */
export function parseVideoUrl(text) {
  let url;
  try { url = new URL(String(text).trim()); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '');
  const path = url.pathname.split('/').filter(Boolean);
  let provider = null, video = null;
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    provider = 'youtube';
    video = path[0] === 'watch' && path.length === 1 ? url.searchParams.get('v') : ['embed', 'shorts', 'live'].includes(path[0]) && path.length === 2 ? path[1] : null;
  } else if (host === 'youtu.be' && path.length === 1) { provider = 'youtube'; video = path[0]; }
  else if (host === 'vimeo.com' && path.length === 1) { provider = 'vimeo'; video = path[0]; }
  else if (host === 'player.vimeo.com' && path[0] === 'video' && path.length === 2) { provider = 'vimeo'; video = path[1]; }
  return provider && VIDEO_IDS[provider].test(video || '') ? { provider, video } : null;
}
// Controlled player and fallback addresses built from the stored id; no autoplay, privacy modes on.
export const videoEmbedUrl = media => media.provider === 'youtube' ? `https://www.youtube-nocookie.com/embed/${media.video}?rel=0` : `https://player.vimeo.com/video/${media.video}?dnt=1`;
export const videoWatchUrl = media => media.provider === 'youtube' ? `https://www.youtube.com/watch?v=${media.video}` : `https://vimeo.com/${media.video}`;

/** Every uploaded asset a definition shows, in order, without repeats. */
export function definitionAssets(definition) {
  const ids = new Set();
  for (const field of definition?.fields || []) {
    if (field?.media?.type === 'image') ids.add(field.media.asset);
    for (const option of field?.options || []) if (option?.image) ids.add(option.image.asset);
  }
  return [...ids].filter(id => typeof id === 'string');
}

function mediaProblems(field, name) {
  const problems = [];
  const media = field.media;
  if (media != null) {
    if (field.type === 'page_break') problems.push(`${name} is a page break and cannot show media.`);
    else if (typeof media !== 'object' || Array.isArray(media)) problems.push(`${name} has invalid media.`);
    else if (media.type === 'image') {
      if (!ASSET_ID.test(media.asset ?? '')) problems.push(`${name} has an invalid image.`);
      if (media.decorative != null && typeof media.decorative !== 'boolean') problems.push(`${name} image decorative setting must be true or false.`);
      if (media.alt != null && (typeof media.alt !== 'string' || media.alt.length > MEDIA_LIMITS.alt)) problems.push(`${name} image description must be under ${MEDIA_LIMITS.alt} characters.`);
      if (!media.decorative && !(typeof media.alt === 'string' && media.alt.trim())) problems.push(`${name} image needs a description, or mark it decorative.`);
    } else if (media.type === 'video') {
      if (!VIDEO_PROVIDERS[media.provider] || !VIDEO_IDS[media.provider].test(media.video ?? '')) problems.push(`${name} has an unsupported video. Use a YouTube or Vimeo link.`);
      if (media.title != null && (typeof media.title !== 'string' || media.title.length > MEDIA_LIMITS.videoTitle)) problems.push(`${name} video title must be under ${MEDIA_LIMITS.videoTitle} characters.`);
    } else problems.push(`${name} has an unsupported media type.`);
  }
  for (const option of Array.isArray(field.options) ? field.options : []) {
    if (option?.image != null && (typeof option.image !== 'object' || !ASSET_ID.test(option.image.asset ?? ''))) problems.push(`${name} has an option with an invalid image.`);
  }
  return problems;
}

// ---- Form themes (docs/FORMS.md, "Design and themes") ----
// A form holds its own copy of a theme. Only a named font stack and plain hex colours are accepted,
// so a theme can never carry CSS, a URL or anything that loads from elsewhere.
export const THEME_FONTS = {
  system: { label: 'Clean sans', stack: 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  serif: { label: 'Classic serif', stack: 'Georgia, "Times New Roman", Times, serif' },
  rounded: { label: 'Friendly rounded', stack: 'ui-rounded, "Trebuchet MS", "Segoe UI", system-ui, sans-serif' },
  mono: { label: 'Typewriter', stack: 'ui-monospace, Consolas, "Courier New", monospace' }
};
export const THEME_COLORS = ['background', 'question', 'answer', 'button', 'button_text'];
// Text sizes are named steps, never lengths, and each layout turns a step into its own size. They are
// optional: a theme without them uses the standard sizes, so every theme saved before them is unchanged.
export const THEME_SIZES = { small: 'Small', medium: 'Standard', large: 'Large' };
export const THEME_SIZE_TOKENS = ['question_size', 'description_size', 'answer_size'];
export const THEME_TOKENS = ['font', ...THEME_COLORS, ...THEME_SIZE_TOKENS];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const THEME_SOURCE = /^(preset|workspace):[A-Za-z0-9_-]{1,64}$/;

// A form's own theme may hold typography only, with no colours at all: the default style with another
// font or text sizes. It is never a workspace theme, which always needs every colour.
export const isTypographyOnly = theme => Boolean(theme) && THEME_COLORS.every(key => theme[key] == null) && theme.source == null;

export function themeProblems(theme, { typographyOnly = false } = {}) {
  const problems = [];
  if (typeof theme?.name !== 'string' || !theme.name.trim() || theme.name.length > 60) problems.push('Give the theme a name of up to 60 characters.');
  if (!Object.hasOwn(THEME_FONTS, theme?.font ?? '')) problems.push('Choose one of the listed theme fonts.');
  const coloursOptional = typographyOnly && isTypographyOnly(theme);
  if (!coloursOptional) for (const key of THEME_COLORS) if (typeof theme?.[key] !== 'string' || !HEX_COLOR.test(theme[key])) problems.push(`The theme's ${key.replace('_', ' ')} must be a colour like #1a2b3c.`);
  for (const key of THEME_SIZE_TOKENS) if (theme?.[key] != null && !Object.hasOwn(THEME_SIZES, theme[key])) problems.push(`The theme's ${key.replace('_', ' ')} must be small, medium or large.`);
  if (theme?.source != null && (typeof theme.source !== 'string' || !THEME_SOURCE.test(theme.source))) problems.push('The theme source is not valid.');
  return problems;
}

const channel = value => { const part = value / 255; return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4; };
const luminance = hex => { const number = parseInt(hex.slice(1), 16); return 0.2126 * channel(number >> 16 & 255) + 0.7152 * channel(number >> 8 & 255) + 0.0722 * channel(number & 255); };
/** WCAG contrast ratio of two #rrggbb colours, from 1 to 21. */
export function contrastRatio(first, second) {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}
/** Colour pairs too weak to read comfortably (under 4.5:1). Advice for the author; never blocks saving. */
export function themeWarnings(theme) {
  const pairs = [['question', 'Question text', theme.question, theme.background, 'the background'], ['answer', 'Answer text', theme.answer, theme.background, 'the background'], ['button', 'Button text', theme.button_text, theme.button, 'the button']];
  return pairs.filter(([, , a, b]) => contrastRatio(a, b) < 4.5).map(([pair, label, a, b, on]) => ({ pair, text: `${label} is hard to read on ${on} (contrast ${contrastRatio(a, b).toFixed(1)}:1; aim for at least 4.5:1).` }));
}

export const CONDITION_OPS = { equals: 'is', not_equals: 'is not', contains: 'includes', answered: 'is answered', not_answered: 'is not answered' };
const LIMITS = { short_text: 300, long_text: 5000, email: 254, phone: 30 };
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const isAnswered = value => Array.isArray(value) ? value.length > 0 : value != null && String(value).trim() !== '';

// ---- URL parameters (docs/FORMS.md, "URL parameters") ----
// definition.url_params: [{ key, record? }]. A rule reads one as { param, op, value? }, so a parameter is
// never an answer and cannot collide with a question key. Values come from whoever holds the link: they
// can steer jumps and hidden choices, and are never identity, authorization or a secret.
export const URL_PARAM_LIMITS = { count: 20, value: 200 };
const URL_PARAM_KEY = /^[a-z][a-z0-9_]{0,39}$/;
// Options the app itself reads from a form link.
const RESERVED_URL_PARAMS = ['mode', 'embed', 'product'];
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/** Why a key cannot be declared, or null. */
export function urlParamKeyProblem(key, taken = []) {
  if (typeof key !== 'string' || !URL_PARAM_KEY.test(key)) return 'Use lowercase letters, numbers and underscores, starting with a letter, up to 40 characters.';
  if (RESERVED_URL_PARAMS.includes(key)) return `“${key}” is used by form links themselves. Choose another name.`;
  if (taken.includes(key)) return `“${key}” is already declared.`;
  return null;
}

// One value as rules read it and attribution stores it, or null for "missing". Empty, oversized,
// non-text and control-character values all count as missing. A long value is never cut down, since a
// shortened value could match a rule the full one does not.
function urlParamValue(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.replace(/\s+/g, ' ').trim();
  return value && value.length <= URL_PARAM_LIMITS.value && !CONTROL_CHARS.test(value) ? value : null;
}

/**
 * The declared parameters present in a URLSearchParams or a plain object, and nothing else. From a link
 * with a repeated key, the first occurrence is the value, even if it is empty.
 */
export function urlParamValues(definition, source) {
  const values = Object.create(null);
  const declared = Array.isArray(definition?.url_params) ? definition.url_params : [];
  if (!declared.length || !source || typeof source !== 'object') return values;
  const read = typeof source.get === 'function' ? key => source.get(key) : key => Object.hasOwn(source, key) ? source[key] : null;
  for (const { key } of declared) {
    const value = urlParamValue(read(key));
    if (value !== null) values[key] = value;
  }
  return values;
}

/** What a response stores: only parameters the author opted to record. Null when there are none. */
export function attributionValues(definition, source) {
  const values = urlParamValues(definition, source);
  const recorded = (definition.url_params || []).filter(param => param.record === true && param.key in values).map(param => [param.key, values[param.key]]);
  return recorded.length ? Object.fromEntries(recorded) : null;
}

/** Attribution columns for the inbox and CSV: recorded by a published version, or present on a response. */
export function attributionColumns(definitions, responses) {
  const keys = definitions.flatMap(definition => (definition.url_params || []).filter(param => param.record === true).map(param => param.key));
  for (const response of responses) keys.push(...Object.keys(response.attribution || {}));
  return [...new Set(keys)];
}

export function conditionHolds(condition, answers, params = null) {
  if (!condition) return true;
  const value = condition.param != null ? params?.[condition.param] : answers[condition.field];
  switch (condition.op) {
    case 'answered': return isAnswered(value);
    case 'not_answered': return !isAnswered(value);
    case 'equals': return Array.isArray(value) ? value.length === 1 && value[0] === condition.value : value === condition.value;
    case 'not_equals': return Array.isArray(value) ? !(value.length === 1 && value[0] === condition.value) : value !== condition.value;
    case 'contains': return Array.isArray(value) ? value.includes(condition.value) : typeof value === 'string' && value.toLowerCase().includes(String(condition.value).toLowerCase());
    default: return false;
  }
}

// ---- Evaluation policy (docs/FORMS.md, "Evaluation policy") ----
// A published version records how its rules read typed answers, and that never changes for that version.
// With the policy, answers and rule values both go through the type's own clean-up before any comparison.
// A version without it keeps the behaviour it was published with. Drafts do not hold it: publishing stamps
// it, and a preview stamps it to show what the next publish will do. URL parameters have their own rules.
export const EVALUATION_POLICY = 'normalized_v1';
export const withEvaluationPolicy = definition => ({ ...definition, evaluation_policy: EVALUATION_POLICY });
const usesEvaluationPolicy = definition => definition?.evaluation_policy === EVALUATION_POLICY;
const isTypedSource = (definition, condition) => {
  if (!condition || condition.param != null || !VALUE_OPS.includes(condition.op) || typeof condition.value !== 'string') return null;
  const source = definition.fields?.find(field => field?.id === condition.field);
  return source && source.type !== 'page_break' && !source.type?.endsWith('_choice') ? source : null;
};
function comparedCondition(definition, condition) {
  if (!usesEvaluationPolicy(definition)) return condition;
  const source = isTypedSource(definition, condition);
  if (!source) return condition;
  // A rule value that is not a valid answer of this type, such as part of an email, is only tidied.
  const tidied = checkAnswer({ ...source, required: false }, condition.value);
  return { ...condition, value: tidied.error ? condition.value.replace(/\s+/g, ' ').trim() : tidied.value };
}

/** A condition as this version reads it. Display rules, jumps, hide rules, endings and routing all use this. */
export const answerConditionHolds = (definition, condition, answers, params = null) => conditionHolds(comparedCondition(definition, condition), answers, params);

// ---- Older browsers during a rollout (docs/FORMS.md, "Rollout and rollback") ----
// A browser sends CLIENT_EVALUATOR when it evaluates forms with this logic. A tab opened before that can stay
// open through a rollout and still load new versions, and it cannot be updated. It walks a form with only
// display rules and plain page breaks, comparing answers as typed. If the server then wants a question that
// browser never showed, the person cannot answer it and gets no message. So for a request without the marker,
// an error on a question that browser did not show is waived. Nothing else is relaxed: hidden choices still
// leave the answer, and every question it did show is still checked. Remove once old tabs are gone.
export const CLIENT_EVALUATOR = 2;
/** The question ids a browser from before CLIENT_EVALUATOR displays for these answers. */
export function olderClientFieldIds(definition, answers = {}) {
  const fields = definition.fields.map(({ group, grouped, ...field }) => field);
  return new Set(walkForm({ fields }, answers).pages.flat().map(field => field.id));
}

/** Whether any rule compares a typed answer, the only place the policy can change a result. */
export function comparesTypedText(definition, routing = null) {
  const conditions = [
    ...(definition.fields || []).map(field => field.show_if),
    ...[...(definition.logic || []), ...(definition.choice_rules || [])].flatMap(entry => entry.rules.flatMap(rule => rule.when?.all || rule.when?.any || [rule.when])),
    ...(routing?.rules || []).map(rule => rule.condition)
  ];
  return conditions.some(condition => isTypedSource(definition, condition));
}

// ---- In-form branching (docs/FORMS.md, "Jumps and endings") ----
// definition.logic: [{ field, rules: [{ when?, to: { type: 'field' | 'group' | 'ending', id } }] }]
// definition.endings: [{ id, title, message? }]. Rules on a question are checked in order once it is
// shown and the first match decides; a rule with no condition always matches. Jumps only go forward,
// so every path ends. Conditions use the same operators as display rules, or { all } / { any } of them.
const ruleHolds = (definition, when, answers, params) => when?.all ? when.all.every(item => answerConditionHolds(definition, item, answers, params))
  : when?.any ? when.any.some(item => answerConditionHolds(definition, item, answers, params)) : answerConditionHolds(definition, when, answers, params);

// ---- Hiding answer choices (docs/FORMS.md, "Hiding answer choices") ----
// definition.choice_rules: [{ field, rules: [{ when: { field, op, value? }, hide: [option ids] }] }]
// A rule hides choices of a choice question outside a multi-question page, from an answer to an earlier
// question. Every rule that holds adds to what is hidden. A draft may hold a rule a later edit broke, so
// the author can see and repair it: such a rule does nothing, and publishing is refused until it is fixed.
function choiceRuleProblem(definition, index, rule, name) {
  const field = definition.fields[index];
  if (!field.type?.endsWith('_choice')) return `${name}: only a single or multiple choice question can hide choices. Remove this rule or change the question back.`;
  if (field.group != null) return `${name}: this question is inside the page “${definition.fields.find(item => item.id === field.group)?.label || 'Untitled page'}”, and hiding choices is not supported on a multi-question page. Move the question off the page or remove this rule.`;
  const when = rule?.when;
  if (when?.param != null) {
    const problem = paramConditionProblem(definition, when, name);
    if (problem) return problem;
    if (VALUE_OPS.includes(when.op) && !when.value.trim()) return `${name} needs a value to compare.`;
  } else {
    const asked = definition.fields.slice(0, index).find(item => item?.type !== 'page_break' && item?.id === when?.field);
    if (!asked) return `${name} must use the answer to an earlier question, and the question it uses is no longer before this one.`;
    if (!CONDITION_OPS[when.op]) return `${name} has an unsupported condition.`;
    if (VALUE_OPS.includes(when.op)) {
      if (typeof when.value !== 'string' || !when.value.trim() || when.value.length > 300) return `${name} needs a value to compare.`;
      if (asked.type.endsWith('_choice') && !asked.options?.some(option => option.id === when.value)) return `${name} depends on an option that is no longer in “${asked.label}”.`;
    }
  }
  if (!Array.isArray(rule.hide) || !rule.hide.length) return `${name} needs at least one choice to hide.`;
  if (rule.hide.some(id => !field.options?.some(option => option.id === id))) return `${name} hides a choice that is no longer in this question.`;
  return null;
}

/** Hide-choice rules that an edit made invalid. A draft may keep them; publishing is refused. */
export function choiceRuleConflicts(definition) {
  const conflicts = [];
  for (const entry of Array.isArray(definition?.choice_rules) ? definition.choice_rules : []) {
    const index = definition.fields.findIndex(field => field.id === entry.field && field.type !== 'page_break');
    if (index < 0) { conflicts.push({ field: entry.field, rule: null, message: 'A hide-choice rule belongs to a question that is no longer in the form. Remove the rule.' }); continue; }
    const label = definition.fields[index].label || 'Untitled question';
    entry.rules.forEach((rule, position) => {
      const message = choiceRuleProblem(definition, index, rule, `Hide-choice rule ${position + 1} on “${label}”`);
      if (message) conflicts.push({ field: entry.field, rule: position, message });
    });
  }
  return conflicts;
}

function activeChoiceRules(definition) {
  if (!Array.isArray(definition.choice_rules) || !definition.choice_rules.length) return null;
  const active = new Map();
  for (const entry of definition.choice_rules) {
    const index = definition.fields.findIndex(field => field.id === entry?.field && field.type !== 'page_break');
    if (index >= 0 && Array.isArray(entry.rules)) active.set(entry.field, entry.rules.filter(rule => !choiceRuleProblem(definition, index, rule, 'Rule')));
  }
  return active;
}

// The one walk through a form: which questions this person reaches, page by page, and where it ends.
// A hidden page hides every question on it; a question whose condition refers to a question they did
// not reach treats that answer as empty. On a form with hide-choice rules, what a later rule reads is
// the answer as it would be stored: tidied, and without hidden choices. So a crafted value can neither
// slip past a rule nor trigger one.
function walkForm(definition, answers, rawParams) {
  const params = urlParamValues(definition, rawParams);
  const jumps = new Map(Array.isArray(definition.logic) ? definition.logic.map(entry => [entry.field, entry.rules]) : []);
  const choiceRules = activeChoiceRules(definition);
  const current = { ...answers };
  const visible = Object.create(null);
  const hidden = Object.create(null);
  const pages = [[]];
  const reached = () => { const effective = { ...current }; for (const key of Object.keys(effective)) if (!visible[key]) delete effective[key]; return effective; };
  let pageVisible = true;
  let skipTo = null;
  let crossedPage = false;
  let ending = null;
  let group = null; // the multi-question page this walk is inside
  for (const field of definition.fields) {
    if (skipTo) {
      if (field.id !== skipTo) { crossedPage ||= field.type === 'page_break'; continue; }
      skipTo = null;
      // Landing inside a later page starts that page, whatever the page break it skipped would have said.
      if (crossedPage && field.type !== 'page_break') { pageVisible = true; if (pages[pages.length - 1].length) pages.push([]); }
      crossedPage = false;
    }
    if (field.type === 'page_break') {
      group = field.grouped === true ? field.id : null;
      pageVisible = answerConditionHolds(definition, field.show_if, reached());
      if (pages[pages.length - 1].length) pages.push([]);
      continue;
    }
    if ((field.group ?? null) !== group) {
      // Past the end of a multi-question page: what follows starts its own page, and a rule that hid
      // that page does not hide it.
      if (group !== null) { pageVisible = true; if (pages[pages.length - 1].length) pages.push([]); }
      group = field.group ?? null;
    }
    if (!pageVisible || !answerConditionHolds(definition, field.show_if, reached())) continue;
    let shown = field;
    if (choiceRules || usesEvaluationPolicy(definition)) {
      const hide = new Set((choiceRules?.get(field.id) || []).flatMap(rule => answerConditionHolds(definition, rule.when, reached(), params) ? rule.hide : []));
      if (hide.size) {
        hidden[field.id] = [...hide];
        shown = { ...field, options: field.options.filter(option => !hide.has(option.id)) };
        // Nothing left to choose: the question is skipped even when required, and its jumps do not run.
        if (!shown.options.length) continue;
      }
      if (Object.hasOwn(current, field.id)) {
        const kept = withoutChoices(current[field.id], hide);
        const tidied = checkAnswer({ ...shown, required: false }, kept);
        current[field.id] = tidied.error ? kept : tidied.value;
      }
    }
    visible[field.id] = true;
    pages[pages.length - 1].push(shown);
    const jump = jumps.get(field.id)?.find(rule => ruleHolds(definition, rule.when, reached(), params));
    if (jump?.to.type === 'ending') { ending = jump.to.id; break; }
    if (jump) skipTo = jump.to.id;
  }
  return { pages: pages.filter((page, index) => page.length || index === 0), ending, answers: reached(), hidden };
}

const withoutChoices = (value, hide) => Array.isArray(value) ? value.filter(id => !hide.has(id)) : hide.has(value) ? '' : value;

/** Removes, in place, every choice the form is hiding right now, so it never comes back by itself. */
export function dropHiddenChoices(definition, answers, params) {
  if (!definition.choice_rules?.length) return;
  const { hidden } = walkForm(definition, answers, params);
  for (const [id, hide] of Object.entries(hidden)) {
    if (!Object.hasOwn(answers, id)) continue;
    const kept = withoutChoices(answers[id], new Set(hide));
    if (kept === '') delete answers[id]; else answers[id] = kept;
  }
}

export const visiblePages = (definition, answers, params) => walkForm(definition, answers, params).pages;

/** The ending this person reaches: the one a rule jumped to, otherwise the first; null without endings. */
export function formEnding(definition, answers, params) {
  const endings = Array.isArray(definition.endings) ? definition.endings : [];
  if (!endings.length) return null;
  const { ending } = walkForm(definition, answers, params);
  return endings.find(item => item.id === ending) || endings[0];
}

export const visibleFields = (definition, answers, params) => visiblePages(definition, answers, params).flat();

/**
 * What one screen shows. Classic: a page. Conversational: one question, or a whole multi-question page.
 * Each screen's questions are independent; only their presentation is shared.
 */
export function formScreens(definition, answers, mode = definition.presentation, params) {
  if (mode !== 'conversational') return visiblePages(definition, answers, params);
  const screens = [];
  for (const field of visibleFields(definition, answers, params)) {
    const last = screens[screens.length - 1];
    if (field.group != null && last?.[0].group === field.group) last.push(field); else screens.push([field]);
  }
  return screens;
}

/** The titled page a screen belongs to, if any. */
export const screenPage = (definition, screen) => screen?.[0]?.group == null ? null : definition.fields.find(field => field.id === screen[0].group) || null;

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
export function validateSubmission(definition, answers = {}, params, { olderClient = false } = {}) {
  const errors = {};
  const cleaned = {};
  const walk = walkForm(definition, answers, params);
  const shownToOlderClient = olderClient ? olderClientFieldIds(definition, answers) : null;
  for (const field of walk.pages.flat()) {
    const result = checkAnswer(field, walk.answers[field.id]);
    if (result.error && shownToOlderClient && !shownToOlderClient.has(field.id)) continue;
    // Only a browser that did not apply the rule can have sent this: say why its selection was not taken.
    if (result.error) errors[field.id] = walk.hidden[field.id] && isAnswered(answers[field.id]) && !isAnswered(walk.answers[field.id]) ? 'That choice is not available. Choose another.' : result.error;
    else if (isAnswered(result.value)) cleaned[field.id] = result.value;
  }
  const ending = formEnding(definition, cleaned, params);
  return ending ? { answers: cleaned, errors, ending } : { answers: cleaned, errors };
}

const KEY = /^[a-z0-9_]{1,40}$/;
const VALUE_OPS = ['equals', 'not_equals', 'contains'];

function paramConditionProblem(definition, condition, name) {
  if (condition.field != null) return `${name} must use either a question or a URL parameter, not both.`;
  if (!definition.url_params?.some?.(param => param?.key === condition.param)) return `${name} uses the URL parameter “${condition.param}”, which is not declared.`;
  if (!CONDITION_OPS[condition.op]) return `${name} has an unsupported rule.`;
  if (VALUE_OPS.includes(condition.op) && (typeof condition.value !== 'string' || condition.value.length > URL_PARAM_LIMITS.value)) return `${name} needs a value of up to ${URL_PARAM_LIMITS.value} characters.`;
  return null;
}

function conditionProblem(condition, available, name, definition) {
  if (condition?.param != null) return paramConditionProblem(definition, condition, name);
  const asked = available.find(field => field.id === condition?.field);
  if (!asked) return `${name} must use this question or an earlier one.`;
  if (!CONDITION_OPS[condition.op]) return `${name} has an unsupported rule.`;
  if (VALUE_OPS.includes(condition.op)) {
    if (typeof condition.value !== 'string' || condition.value.length > 300) return `${name} needs a value.`;
    if (asked.type.endsWith('_choice') && !asked.options?.some(option => option.id === condition.value)) return `${name} must use one of the options of "${asked.label}".`;
  }
  return null;
}

// What is wrong with one jump rule, or null. Shared by validation and by the builder's clean-up.
function ruleProblem(definition, index, rule, name) {
  const later = definition.fields.slice(index + 1);
  const available = definition.fields.slice(0, index + 1).filter(field => field?.type !== 'page_break');
  if (!rule || typeof rule !== 'object') return `${name} is invalid.`;
  const to = rule.to;
  if (to?.type === 'field') { if (!later.some(field => field?.id === to.id && field.type !== 'page_break')) return `${name} must jump to a later question.`; }
  else if (to?.type === 'group') { if (!later.some(field => field?.id === to.id && field.type === 'page_break')) return `${name} must jump to a later page.`; }
  else if (to?.type === 'ending') { if (!Array.isArray(definition.endings) || !definition.endings.some(ending => ending?.id === to.id)) return `${name} jumps to an ending that does not exist.`; }
  else return `${name} must jump to a question, a page or an ending.`;
  if (rule.when == null) return null;
  const group = rule.when.all ?? rule.when.any;
  if (rule.when.all || rule.when.any) {
    if (!Array.isArray(group) || !group.length || group.length > 10) return `${name} needs at least one condition, and at most 10.`;
    return group.map(condition => conditionProblem(condition, available, name, definition)).find(Boolean) || null;
  }
  return conditionProblem(rule.when, available, name, definition);
}

// A multi-question page is a titled page break followed directly by the questions that name it, so
// every consumer of the flat question list keeps working.
function pageProblems(fields) {
  const problems = [];
  let open = null;
  fields.forEach((field, index) => {
    const name = `Item ${index + 1}`;
    if (!field || typeof field !== 'object') return;
    if (field.type === 'page_break') {
      if (field.group != null) problems.push(`${name} is a page and cannot sit inside another page.`);
      if (field.grouped != null && typeof field.grouped !== 'boolean') problems.push(`${name} grouped must be true or false.`);
      if (field.grouped === true && (typeof field.label !== 'string' || !field.label.trim() || field.label.length > 150)) problems.push(`${name}: this page needs a title of up to 150 characters.`);
      open = field.grouped === true ? field.id : null;
      return;
    }
    if (field.group == null) open = null;
    else if (field.group !== open) problems.push(`${name} must sit directly under its page.`);
    if (field.placeholder != null && (typeof field.placeholder !== 'string' || field.placeholder.length > 100 || field.type?.endsWith('_choice') || field.type === 'date')) problems.push(`${name} placeholder must be up to 100 characters, on a text question.`);
  });
  return problems;
}

function urlParamProblems(definition) {
  const list = definition.url_params;
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > URL_PARAM_LIMITS.count) return [`URL parameters must be a list of up to ${URL_PARAM_LIMITS.count}.`];
  const problems = [];
  const seen = [];
  list.forEach((param, index) => {
    const problem = urlParamKeyProblem(param?.key, seen);
    if (problem) problems.push(`URL parameter ${index + 1}: ${problem}`);
    if (param?.record != null && typeof param.record !== 'boolean') problems.push(`URL parameter ${index + 1}: record must be true or false.`);
    seen.push(param?.key);
  });
  return problems;
}

/** Jumps on a URL parameter still waiting for a value. A draft may hold one while it is typed; publishing is refused. */
export function urlParamRuleConflicts(definition) {
  const conflicts = [];
  for (const entry of Array.isArray(definition?.logic) ? definition.logic : []) {
    for (const [position, rule] of entry.rules.entries()) {
      for (const condition of rule.when?.all || rule.when?.any || [rule.when]) {
        if (condition?.param != null && VALUE_OPS.includes(condition.op) && !condition.value?.trim()) conflicts.push(`Jump ${position + 1} on “${definition.fields.find(field => field.id === entry.field)?.label || 'Untitled question'}” compares the URL parameter “${condition.param}” with an empty value. Enter a value or change the rule.`);
      }
    }
  }
  return conflicts;
}

// The stored shape of hide-choice rules. Whether a rule still fits the form is choiceRuleConflicts.
function choiceRuleShapeProblems(definition) {
  const list = definition.choice_rules;
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > 100) return ['Hide-choice rules must be a list of up to 100 questions.'];
  const problems = [];
  const seen = new Set();
  list.forEach((entry, position) => {
    const name = `Hide-choice entry ${position + 1}`;
    if (typeof entry?.field !== 'string') return problems.push(`${name} must name a question.`);
    if (seen.has(entry.field)) problems.push(`${name}: a question can have only one set of hide-choice rules.`);
    seen.add(entry.field);
    if (!Array.isArray(entry.rules) || !entry.rules.length || entry.rules.length > 20) return problems.push(`${name} needs 1–20 rules.`);
    entry.rules.forEach((rule, index) => {
      if (!rule || typeof rule !== 'object' || !rule.when || typeof rule.when !== 'object' || Array.isArray(rule.when)) problems.push(`${name}, rule ${index + 1} needs one condition.`);
      if (!Array.isArray(rule?.hide) || rule.hide.length > 100 || rule.hide.some(id => typeof id !== 'string')) problems.push(`${name}, rule ${index + 1} must list the choices to hide.`);
    });
  });
  return problems;
}

function logicProblems(definition) {
  const problems = [];
  if (definition.endings != null) {
    if (!Array.isArray(definition.endings)) problems.push('Endings must be a list.');
    else {
      if (definition.endings.length > 20) problems.push('A form can have up to 20 endings.');
      const ids = new Set();
      definition.endings.forEach((ending, index) => {
        const name = `Ending ${index + 1}`;
        if (typeof ending?.id !== 'string' || !KEY.test(ending.id)) problems.push(`${name} needs an id of lowercase letters, numbers or underscores.`);
        else if (ids.has(ending.id)) problems.push(`${name} reuses the id "${ending.id}".`);
        ids.add(ending?.id);
        if (typeof ending?.title !== 'string' || !ending.title.trim() || ending.title.length > 150) problems.push(`${name} needs a title of up to 150 characters.`);
        if (ending?.message != null && (typeof ending.message !== 'string' || ending.message.length > 2000)) problems.push(`${name} message must be under 2000 characters.`);
      });
    }
  }
  if (definition.logic == null) return problems;
  if (!Array.isArray(definition.logic)) return [...problems, 'Logic must be a list.'];
  const seen = new Set();
  definition.logic.forEach((entry, position) => {
    const index = definition.fields.findIndex(field => field?.id === entry?.field && field.type !== 'page_break');
    if (index < 0) return problems.push(`Logic ${position + 1} is for a question that is not in the form.`);
    const label = `Logic on "${definition.fields[index].label}"`;
    if (seen.has(entry.field)) problems.push(`${label}: a question can have only one set of rules.`);
    seen.add(entry.field);
    if (!Array.isArray(entry.rules) || !entry.rules.length || entry.rules.length > 20) return problems.push(`${label} needs 1–20 rules.`);
    entry.rules.forEach((rule, ruleIndex) => {
      const name = `${label}, rule ${ruleIndex + 1}`;
      const problem = ruleProblem(definition, index, rule, name);
      if (problem) problems.push(problem);
      if (ruleIndex > 0 && entry.rules[ruleIndex - 1]?.when == null) problems.push(`${name} can never be reached, because the rule before it always matches.`);
    });
  });
  return problems;
}

/**
 * Removes jump rules a builder edit made invalid (a moved or deleted question, option or ending), so
 * a draft never carries a rule that would refuse to save. Returns how many were removed.
 */
export function pruneLogic(definition) {
  if (!Array.isArray(definition.logic)) return 0;
  let removed = 0;
  definition.logic = definition.logic.filter(entry => {
    const index = definition.fields.findIndex(field => field.id === entry.field && field.type !== 'page_break');
    const kept = index < 0 ? [] : entry.rules.filter(rule => !ruleProblem(definition, index, rule, 'Rule'));
    removed += entry.rules.length - kept.length;
    entry.rules = kept;
    return kept.length > 0;
  });
  if (!definition.logic.length) delete definition.logic;
  return removed;
}

// Description limits, in characters. Page and question descriptions share one limit; the form's own
// description is separate. Titles and answers have their own limits, which these do not change.
export const DESCRIPTION_LIMITS = { form: 2000, page: 3000, question: 3000 };
const count = number => number.toLocaleString('en-US');

// Structural validation of a form definition. Returns a list of problems (empty when valid).
export function definitionProblems(definition) {
  const problems = [];
  if (!definition || typeof definition !== 'object') return ['Form definition is missing.'];
  if (typeof definition.title !== 'string' || !definition.title.trim() || definition.title.length > 150) problems.push('Give the form a title of up to 150 characters.');
  if (typeof (definition.description ?? '') !== 'string' || (definition.description ?? '').length > DESCRIPTION_LIMITS.form) problems.push(`Keep the form description to ${count(DESCRIPTION_LIMITS.form)} characters or fewer.`);
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
    if (field.help != null) {
      const limit = field.type === 'page_break' ? DESCRIPTION_LIMITS.page : DESCRIPTION_LIMITS.question;
      if (typeof field.help !== 'string' || field.help.length > limit) problems.push(`${name} ${field.type === 'page_break' ? 'page description' : 'description'} must be ${count(limit)} characters or fewer.`);
    }
    if (field.required != null && typeof field.required !== 'boolean') problems.push(`${name} required must be true or false.`);
    problems.push(...mediaProblems(field, name));
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
  problems.push(...pageProblems(definition.fields));
  problems.push(...logicProblems(definition));
  problems.push(...choiceRuleShapeProblems(definition));
  problems.push(...urlParamProblems(definition));
  if (definition.theme != null) problems.push(...(typeof definition.theme === 'object' && !Array.isArray(definition.theme) ? themeProblems(definition.theme, { typographyOnly: true }) : ['Theme is invalid.']));
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
