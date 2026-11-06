// Multi-question pages in the builder. A page stays flat in the definition: a titled page break
// (`grouped: true`) followed directly by questions carrying `group: <its id>`. So every question keeps
// its own key, answers, CSV column and logic, exactly like one outside a page. Pure, so tests and the
// editor agree. Moves here keep that shape: a page's questions stay together, directly under it.

const laterQuestionRules = fields => fields.filter((item, position) => item.show_if && !fields.slice(0, position).some(candidate => candidate.id === item.show_if.field));
// Logic may only refer to earlier questions; rules that no longer do are removed and reported.
const dropStaleRules = fields => { const dropped = laterQuestionRules(fields); dropped.forEach(item => delete item.show_if); return dropped; };

export const isHead = field => field?.type === 'page_break' && field.grouped === true;

/** The index just past a page's last question; for anything else, just past the item itself. */
export function blockEnd(fields, index) {
  if (!isHead(fields[index])) return index + 1;
  let end = index + 1;
  while (fields[end]?.group === fields[index].id) end++;
  return end;
}

const headIndex = (fields, field) => fields.findIndex(candidate => candidate.id === field.group);

/** A key based on `base` that nothing in this draft or any published version already uses. */
export function uniqueKey(base, taken) {
  if (!taken.includes(base)) return base;
  let number = 2;
  while (taken.includes(`${base}_${number}`)) number++;
  return `${base}_${number}`;
}

const CONTACT_FIELDS = [
  ['first_name', 'short_text', 'First name', 'Asha', true],
  ['last_name', 'short_text', 'Last name', 'Rao', false],
  ['phone', 'phone', 'Phone number', '+91 98765 43210', false],
  ['email', 'email', 'Email', 'name@example.com', true],
  ['company', 'short_text', 'Company', 'Your company', false]
];

/** The Contact Info page: one titled page and five independent questions with readable keys. */
export function contactInfoBlock(takenKeys) {
  const taken = [...takenKeys];
  const key = base => { const made = uniqueKey(base, taken); taken.push(made); return made; };
  const head = { id: key('contact_info'), type: 'page_break', label: 'Contact Info', grouped: true };
  return [head, ...CONTACT_FIELDS.map(([id, type, label, placeholder, required]) => ({ id: key(id), type, label, required, placeholder, group: head.id }))];
}

/** What the outline shows beside each item: a number for a question or page, a letter inside a page. */
export function outlineMarks(fields) {
  let number = 0;
  let letter = 0;
  return fields.map(field => {
    if (field.group != null) return String.fromCharCode(65 + letter++ % 26);
    letter = 0;
    if (field.type === 'page_break' && !field.grouped) return '';
    return String(++number);
  });
}

/** The ↑/↓ target for the item at `index`, or null when it cannot go that way. */
function moveTarget(fields, index, step) {
  const field = fields[index];
  if (isHead(field)) return step < 0 ? (index === 0 ? null : index - 1) : blockEnd(fields, index) < fields.length ? blockEnd(fields, index) : null;
  if (field.group != null) return index + step;
  const next = index + step;
  return next < 0 || next >= fields.length ? null : next;
}
export const canMove = (fields, index, step) => moveTarget(fields, index, step) !== null && (fields[index].group != null || (step < 0 ? index > 0 : blockEnd(fields, index) < fields.length));

/**
 * Moves one step with the ↑/↓ controls. A page moves as a whole, past the neighbouring item or page.
 * A question inside a page moves within it, then out of the page at either end. A question outside a
 * page moves past a neighbouring page rather than into it. Returns { to, dropped, left }.
 */
export function moveItem(fields, index, step) {
  const field = fields[index];
  if (field.group != null) {
    const neighbour = fields[index + step];
    if (neighbour?.group === field.group) { fields.splice(index, 1); fields.splice(index + step, 0, field); return { to: index + step, dropped: dropStaleRules(fields), left: false }; }
    delete field.group;
    if (step < 0) { const head = index - 1; fields.splice(index, 1); fields.splice(head, 0, field); return { to: head, dropped: dropStaleRules(fields), left: true }; }
    return { to: index, dropped: dropStaleRules(fields), left: true };
  }
  const size = blockEnd(fields, index) - index;
  const block = fields.splice(index, size);
  let to;
  if (step < 0) { const previous = fields[index - 1]; to = previous?.group != null ? headIndex(fields, previous) : index - 1; }
  else to = blockEnd(fields, index);
  fields.splice(to, 0, ...block);
  return { to, dropped: dropStaleRules(fields), left: false };
}

/** Whether dropping the item at `from` into gap `gap` (counted before it is lifted) would change nothing. */
export const dropIsNoop = (fields, from, gap) => gap >= from && gap <= blockEnd(fields, from);

/**
 * Drag and drop. `gap` is counted before the item is lifted. A page travels with its questions and
 * lands beside other pages, never inside. A question dropped between a page's questions joins that
 * page, and one dragged clear of its page leaves it. Returns { to, dropped, left }, or null for no change.
 */
export function dropItem(fields, from, gap) {
  if (dropIsNoop(fields, from, gap)) return null;
  const size = blockEnd(fields, from) - from;
  const block = fields.splice(from, size);
  let at = gap > from ? gap - size : gap;
  const moved = block[0];
  const had = moved.group;
  if (moved.type === 'page_break') {
    // Pages and page breaks never split another page.
    if (fields[at]?.group != null) { const head = headIndex(fields, fields[at]); at = blockEnd(fields, head); }
  } else {
    const previous = fields[at - 1];
    const next = fields[at];
    const inside = next?.group != null && (previous?.id === next.group || previous?.group === next.group);
    const stays = had != null && (previous?.id === had || previous?.group === had);
    if (inside) moved.group = next.group;
    else if (stays) moved.group = had;
    else if (isHead(previous)) moved.group = previous.id;
    else delete moved.group;
  }
  fields.splice(at, 0, ...block);
  return { to: at, dropped: dropStaleRules(fields), left: had != null && moved.group !== had };
}

/** A copy of a page with new keys throughout, so its answers never mix with the original's. */
export function duplicateBlock(fields, index, newKey) {
  const end = blockEnd(fields, index);
  const headId = newKey('page');
  const copies = fields.slice(index, end).map((field, position) => {
    const copy = structuredClone(field);
    if (position === 0) { copy.id = headId; copy.label = `${field.label} (copy)`; return copy; }
    copy.id = newKey('q');
    copy.group = headId;
    if (copy.options) copy.options = copy.options.map(option => ({ ...option, id: newKey('opt') }));
    return copy;
  });
  fields.splice(end, 0, ...copies);
  return end;
}
