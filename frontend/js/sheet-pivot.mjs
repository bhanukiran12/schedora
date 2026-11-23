/** Groups source rows without changing the original data or the order of the source sheet. */
export function pivotTable(values, { group, split, value, aggregate }) {
  const rows = new Map();
  const columns = new Set();
  let limited = false;
  const label = input => input == null || input === '' ? '(blank)' : String(input);
  for (const record of values) {
    if (record.every(input => input == null || input === '')) continue;
    const row = label(record[group]);
    const column = split === null ? 'Total' : label(record[split]);
    if ((!rows.has(row) && rows.size >= 100) || (!columns.has(column) && columns.size >= 20)) {
      limited = true;
      continue;
    }
    if (!rows.has(row)) rows.set(row, new Map());
    columns.add(column);
    const groups = rows.get(row);
    if (!groups.has(column)) groups.set(column, { total: 0, numeric: 0, filled: 0 });
    const bucket = groups.get(column);
    const amount = record[value];
    if (amount != null && amount !== '') bucket.filled += 1;
    if (typeof amount === 'number' && Number.isFinite(amount)) {
      bucket.total += amount;
      bucket.numeric += 1;
    }
  }
  const keys = [...columns];
  return { columns: keys, limited, rows: [...rows].map(([name, groups]) => [
    name, ...keys.map(key => {
      const bucket = groups.get(key);
      if (aggregate === 'count') return bucket?.filled ?? 0;
      if (aggregate === 'average') return bucket?.numeric ? bucket.total / bucket.numeric : '';
      return bucket?.total ?? 0;
    })
  ]) };
}
