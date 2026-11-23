import { LIMITS } from '../workbook-ops.mjs';

const cellsPerSheet = (LIMITS.rows + 1) * LIMITS.columns;
const rowLeaves = 2 ** Math.ceil(Math.log2(LIMITS.rows));
const columnLeaves = 2 ** Math.ceil(Math.log2(LIMITS.columns));
const columnNodes = 2 * columnLeaves;
const rangeStride = 2 * rowLeaves * columnNodes;

export const cellKey = (sheet: number, row: number, column: number) => sheet * cellsPerSheet + row * LIMITS.columns + column;
export const extentKey = (sheet: number) => cellKey(sheet, LIMITS.rows, 0);
export function cellPosition(key: number) {
  const cell = key % cellsPerSheet;
  return { sheet: Math.floor(key / cellsPerSheet), row: Math.floor(cell / LIMITS.columns), column: cell % LIMITS.columns };
}

/** Split a closed interval into disjoint segment-tree nodes. */
function segmentNodes(start: number, end: number, leaves: number): number[] {
  const nodes: number[] = [];
  for (let first = start + leaves, last = end + leaves; first <= last; first >>= 1, last >>= 1) {
    if (first & 1) nodes.push(first++);
    if (!(last & 1)) nodes.push(last--);
  }
  return nodes;
}

/** Reverse dependencies for formulas evaluated so far, with rectangular ranges indexed as 2D segments. */
export function createDependencyGraph() {
  type Buckets = Map<number, Set<number>>;
  const points: Buckets = new Map();
  const ranges: Buckets = new Map();
  const outgoing = new Map<number, { points: Set<number>; ranges: Set<number> }>();

  function add(owner: number, kind: 'points' | 'ranges', key: number) {
    let edges = outgoing.get(owner);
    if (!edges) outgoing.set(owner, edges = { points: new Set(), ranges: new Set() });
    if (edges[kind].has(key)) return;
    edges[kind].add(key);
    const buckets = kind === 'points' ? points : ranges;
    let readers = buckets.get(key);
    if (!readers) buckets.set(key, readers = new Set());
    readers.add(owner);
  }

  function remove(owner: number, buckets: Buckets, keys: Set<number>) {
    for (const key of keys) {
      const readers = buckets.get(key);
      readers?.delete(owner);
      if (readers?.size === 0) buckets.delete(key);
    }
  }

  return {
    point(owner: number, key: number) { add(owner, 'points', key); },
    range(owner: number, sheet: number, r1: number, c1: number, r2: number, c2: number) {
      const rows = segmentNodes(Math.max(0, r1), Math.min(LIMITS.rows - 1, r2), rowLeaves);
      const columns = segmentNodes(Math.max(0, c1), Math.min(LIMITS.columns - 1, c2), columnLeaves);
      for (const row of rows) for (const column of columns) add(owner, 'ranges', sheet * rangeStride + row * columnNodes + column);
    },
    forget(owner: number) {
      const edges = outgoing.get(owner);
      if (!edges) return;
      remove(owner, points, edges.points);
      remove(owner, ranges, edges.ranges);
      outgoing.delete(owner);
    },
    plan(roots: Iterable<number>) {
      const dirty = new Set(roots);
      const downstream = new Map<number, Set<number>>();
      const incoming = new Map<number, number>();
      // Set iteration also visits entries appended by this loop, so each cell is visited once.
      for (const key of dirty) {
        const readers = new Set(points.get(key));
        const { sheet, row, column } = cellPosition(key);
        if (ranges.size && row < LIMITS.rows) {
          for (let r = row + rowLeaves; r > 0; r >>= 1) {
            for (let c = column + columnLeaves; c > 0; c >>= 1) {
              const bucket = ranges.get(sheet * rangeStride + r * columnNodes + c);
              if (bucket) for (const reader of bucket) readers.add(reader);
            }
          }
        }
        if (readers.size) downstream.set(key, readers);
        for (const reader of readers) {
          dirty.add(reader);
          incoming.set(reader, (incoming.get(reader) ?? 0) + 1);
        }
      }

      const order = [...dirty].filter(key => !incoming.has(key));
      for (let index = 0; index < order.length; index++) {
        for (const reader of downstream.get(order[index]) ?? []) {
          const remaining = (incoming.get(reader) ?? 1) - 1;
          if (remaining) incoming.set(reader, remaining);
          else { incoming.delete(reader); order.push(reader); }
        }
      }
      // Range subscriptions can be conservative. The evaluator inspects actual reads to tell
      // a real cycle from a formula that only uses range metadata or an untaken branch.
      for (const key of incoming.keys()) order.push(key);
      return { dirty, order };
    }
  };
}
