const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function mergeWorkbook(base, local, remote) {
  const index = sheets => new Map(sheets.map(sheet => [sheet.id, sheet]));
  const [before, mine, theirs] = [base, local, remote].map(index);
  const merged = [];
  const choose = (original, edited, latest) => {
    if (equal(original, edited)) return latest;
    if (equal(original, latest) || equal(edited, latest)) return edited;
    throw new Error('Conflicting workbook edits');
  };
  try {
    for (const id of new Set([...theirs.keys(), ...mine.keys(), ...before.keys()])) {
      const original = before.get(id);
      const edited = mine.get(id);
      const latest = theirs.get(id);
      if (!original || !edited || !latest) {
        const sheet = choose(original, edited, latest);
        if (sheet) merged.push(sheet);
        continue;
      }
      const cells = {};
      const addresses = new Set([...Object.keys(original.cells), ...Object.keys(edited.cells), ...Object.keys(latest.cells)]);
      for (const address of addresses) {
        const value = choose(original.cells[address], edited.cells[address], latest.cells[address]);
        if (value !== undefined) cells[address] = value;
      }
      merged.push({ id, name: choose(original.name, edited.name, latest.name), cells });
    }
  } catch { return null; }
  if (merged.length > 12 || new Set(merged.map(sheet => sheet.name.toLowerCase())).size !== merged.length) return null;
  return merged;
}
