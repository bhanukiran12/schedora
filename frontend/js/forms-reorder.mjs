// Moving questions in the Forms builder. The ↑/↓ buttons and drag in the question sidebar both use
// these, so a move has the same effect on display rules however it was made.

/**
 * Moves the item at `from` to position `to`, in place. Logic may only refer to earlier questions,
 * so rules that no longer do are removed. Returns the items that lost their rule.
 */
export function moveField(fields, from, to) {
  const [moved] = fields.splice(from, 1);
  fields.splice(to, 0, moved);
  const dropped = fields.filter((item, position) => item.show_if && !fields.slice(0, position).some(candidate => candidate.id === item.show_if.field));
  dropped.forEach(item => delete item.show_if);
  return dropped;
}

/** The gap a pointer at `y` is over, from 0 (before the first row) to the row count (after the last), given each row's vertical middle. */
export function dropSlot(middles, y) {
  let slot = 0;
  while (slot < middles.length && y > middles[slot]) slot++;
  return slot;
}

/** The final index of the row at `from` when dropped into gap `slot`, counted before it is lifted out. */
export const slotToIndex = (from, slot) => slot > from ? slot - 1 : slot;

export const moveMessage = (to, total, droppedCount) => `Moved to position ${to + 1} of ${total}.${droppedCount ? ` ${droppedCount} display rule${droppedCount > 1 ? 's were' : ' was'} removed because ${droppedCount > 1 ? 'they' : 'it'} referred to a later question.` : ''} Save the draft to keep this change.`;
