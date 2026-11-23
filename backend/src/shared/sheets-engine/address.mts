import { LIMITS, columnLabel } from '../workbook-ops.mjs';
import { parseReference, tokenize } from './parser.mts';
import type { Reference, ReferencePoint } from './types.mts';

export const quoteSheetName = (name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !/^[A-Za-z]{1,3}[0-9]+$/.test(name) ? name : "'" + name.replaceAll("'", "''") + "'";

// ---- Reference rewriting ------------------------------------------------------------------------
/**
 * Rewrites every reference in a formula. `map(ref)` receives { sheet, from, to } with zero-based
 * coordinates and returns a replacement body (without the sheet prefix), null to keep the reference,
 * or '#REF!' when it no longer points anywhere. Text inside quotes is never touched.
 */
export function rewriteReferences(formula: string, map: (reference: Reference) => string | { body: string; sheet: string | null } | null): string {
  if (!formula?.startsWith('=')) return formula;
  let tokens;
  try { tokens = tokenize(formula.slice(1)); } catch { return formula; }
  let out = '';
  let last = 0;
  const source = formula.slice(1);
  for (const token of tokens) {
    if (token.t !== 'ref') continue;
    let parts;
    try { parts = parseReference(token.body); } catch { continue; }
    const replacement = map({ sheet: token.sheet, ...parts });
    if (replacement == null) continue;
    const prefix = token.sheet == null ? '' : token.text.slice(0, token.text.length - token.body.length);
    const rendered = typeof replacement === 'string'
      ? replacement === '#REF!' ? replacement : prefix + replacement
      : (replacement.sheet === null ? '' : quoteSheetName(replacement.sheet) + '!') + replacement.body;
    out += source.slice(last, token.start) + rendered;
    last = token.end;
  }
  return '=' + out + source.slice(last);
}

export interface RangeMove {
  source: string; destination: string; r1: number; c1: number; r2: number; c2: number; dr: number; dc: number;
}

/** References follow cells moved by Cut, including absolute references. */
export function retargetMovedReferences(formula: string, oldHome: string, newHome: string, move: RangeMove): string {
  const contains = ({ r, c }: ReferencePoint) => r !== null && r >= move.r1 && r <= move.r2 && c >= move.c1 && c <= move.c2;
  return rewriteReferences(formula, ({ sheet, from, to }) => {
    const oldTarget = sheet ?? oldHome;
    if (oldTarget.toUpperCase() === move.source.toUpperCase() && contains(from) && (!to || contains(to))) {
      const shift = (point: ReferencePoint): ReferencePoint => ({ ...point, r: point.r! + move.dr, c: point.c + move.dc });
      return { sheet: sheet !== null || newHome !== move.destination ? move.destination : null, body: body(shift(from), to && shift(to)) };
    }
    if (sheet === null && oldHome !== newHome) return { sheet: oldHome, body: body(from, to) };
    return null;
  });
}

const part = (point: ReferencePoint) => (point.absC ? '$' : '') + columnLabel(point.c) + (point.r == null ? '' : (point.absR ? '$' : '') + (point.r + 1));
const body = (from: ReferencePoint, to?: ReferencePoint | null) => to ? part(from) + ':' + part(to) : part(from);

/** Moves the relative parts of every reference, as when a formula is copied or filled. */
export function shiftFormula(formula: string, rows: number, columns: number): string {
  return rewriteReferences(formula, ({ from, to }) => {
    const move = (point: ReferencePoint): ReferencePoint => ({ ...point, r: point.r == null || point.absR ? point.r : point.r + rows, c: point.absC ? point.c : point.c + columns });
    const a = move(from);
    const b = to && move(to);
    const bad = (point: ReferencePoint | null) => point && (point.c < 0 || point.c >= LIMITS.columns || (point.r != null && (point.r < 0 || point.r >= LIMITS.rows)));
    return bad(a) || bad(b) ? '#REF!' : body(a, b);
  });
}

/**
 * Adjusts references after rows or columns are inserted (count > 0) or deleted (count < 0) at
 * `at` on the sheet named `target`, for a formula stored on the sheet named `home`.
 */
export interface StructureChange { home: string; target: string; axis: 'row' | 'col'; at: number; count: number }

export function adjustForStructure(formula: string, { home, target, axis, at, count }: StructureChange): string {
  return rewriteReferences(formula, ({ sheet, from, to }) => {
    if ((sheet ?? home).toLowerCase() !== target.toLowerCase()) return null;
    const key = axis === 'row' ? 'r' : 'c';
    const first = from[key];
    if (first == null) return null;
    const moveIndex = (index: number) => {
      if (index < at) return index;
      if (count > 0) return index + count;
      return index < at - count ? null : index + count;
    };
    if (!to) {
      const index = moveIndex(first);
      return index == null ? '#REF!' : index === first ? null : body({ ...from, [key]: index });
    }
    const last = to[key];
    const originalStart = Math.min(first, last ?? Infinity);
    const originalEnd = last == null ? null : Math.max(first, last);
    let start = originalStart;
    let end = originalEnd;
    if (count < 0) {
      const removedEnd = at - count - 1;
      if (start >= at && end != null && end <= removedEnd) return '#REF!';
      const newStart = start < at ? start : start > removedEnd ? start + count : at;
      const newEnd = end == null ? null : end < at ? end : end > removedEnd ? end + count : at - 1;
      start = newStart;
      end = newEnd;
    } else {
      if (start >= at) start += count;
      if (end != null && end >= at) end += count;
    }
    if (start === originalStart && end === originalEnd) return null;
    return body({ ...from, [key]: start }, { ...to, [key]: end });
  });
}

/** Renames references to a sheet inside a formula. */
export function renameSheetReferences(formula: string, oldName: string, newName: string): string {
  if (!formula?.startsWith('=')) return formula;
  let tokens;
  try { tokens = tokenize(formula.slice(1)); } catch { return formula; }
  const source = formula.slice(1);
  let out = '';
  let last = 0;
  for (const token of tokens) {
    if (token.t !== 'ref' || token.sheet == null || token.sheet.toLowerCase() !== oldName.toLowerCase()) continue;
    out += source.slice(last, token.start) + quoteSheetName(newName) + '!' + token.body;
    last = token.end;
  }
  return '=' + out + source.slice(last);
}
