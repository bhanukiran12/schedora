import { LIMITS, cellAddress, columnIndex, mergeAt, parseAddress } from '../workbook-ops.mjs';
import { cellKey, cellPosition, createDependencyGraph, extentKey } from './dependencies.mts';
import { parseFormula, parseReference } from './parser.mts';
import { FormulaError, fail, type CellChange, type CellValue, type Evaluator, type FormulaNode, type FormulaSheet, type ParsedInput, type Recalculation, type Reference, type Scalar } from './types.mts';

const NUMBER = /^\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?\s*$/i;
const PERCENT = /^\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)\s*%\s*$/;
const CURRENCY = /^\s*[-+]?[₹$€£]\s?\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*$|^\s*[-+]?[₹$€£]\s?\d+(?:\.\d+)?\s*$/;
const GROUPED = /^\s*[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?\s*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(\.\d{1,3})?)?$/;
const VOLATILE_FUNCTIONS = new Set(['TODAY', 'NOW', 'RAND', 'INDIRECT', 'OFFSET']);
const ARRAY_FORMULA = /\b(?:FILTER|SORT|UNIQUE|TRANSPOSE|SEQUENCE|SPLIT|ARRAYFORMULA|XLOOKUP)\s*\(/i;
const ARRAY_CELL_LIMIT = 10000;
const DAY_MS = 86400000;
const SPREADSHEET_EPOCH = Date.UTC(1899, 11, 30);
function asDate(value: Scalar): Date | null {
  const date = typeof value === 'number' ? new Date(SPREADSHEET_EPOCH + Math.round(value * DAY_MS))
    : typeof value === 'string' && (ISO_DATE.test(value)||/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/.test(value)) ? new Date(value) : null;
  return date && Number.isFinite(date.valueOf()) && (typeof value !== 'string' || date.toISOString().slice(0, 10) === value.slice(0,10)) ? date : null;
}

function serialDate(year: number, month: number, day: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  return (date.valueOf() - SPREADSHEET_EPOCH) / DAY_MS;
}

/** What a typed (non-formula) entry means: a number, a boolean or text. */
export function typedValue(raw: string | null | undefined): Scalar {
  if (raw == null || raw === '') return '';
  if (raw.startsWith("'")) return raw.slice(1);
  if (NUMBER.test(raw)) return Number(raw);
  if (PERCENT.test(raw)) return Number(raw.replace('%', '')) / 100;
  if (GROUPED.test(raw)) return Number(raw.replace(/,/g, ''));
  if (CURRENCY.test(raw)) return Number(raw.replace(/[₹$€£,\s]/g, ''));
  const upper = raw.toUpperCase();
  if (upper === 'TRUE' || upper === 'FALSE') return upper === 'TRUE';
  return raw;
}
/** Literal (response) data: numbers are recognised, nothing else is interpreted. */
const literalValue = (raw: string | null | undefined): Scalar => raw == null || raw === '' ? '' : NUMBER.test(raw) ? Number(raw) : raw;

export function parseInput(raw: string | null | undefined, { literal = false } = {}): ParsedInput {
  if (literal) return { kind: 'value', value: literalValue(raw) };
  if (raw?.startsWith('=') && raw.length > 1) return { kind: 'formula', node: parseFormula(raw) };
  if (raw && ISO_DATE.test(raw)) {
    const date = new Date(raw);
    if (Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === raw) return { kind: 'date', value: date };
  }
  const clock = raw && CLOCK_TIME.exec(raw);
  if (clock) {
    const seconds = Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3] ?? 0) + Number(clock[4] ?? 0);
    return { kind: 'time', value: seconds / 86400 };
  }
  return { kind: 'value', value: typedValue(raw) };
}

const parsed = new Map<string, FormulaNode | FormulaError>();
function compile(raw: string): FormulaNode {
  let node = parsed.get(raw);
  if (!node) {
    node = parseFormula(raw);
    if (parsed.size >= 5000) parsed.clear();
    parsed.set(raw, node);
  }
  if (node instanceof FormulaError) throw node;
  return node;
}

// ---- Coercion -----------------------------------------------------------------------------------
const isError = (value: unknown): value is FormulaError => value instanceof FormulaError;
function toNumber(value: Scalar): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === '' || value == null) return 0;
  const typed = typedValue(String(value));
  if (typeof typed === 'number') return typed;
  fail('#VALUE!');
}
export function toText(value: CellValue | null | undefined): string {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return String(Number(value.toPrecision(15)));
  return value == null ? '' : String(value);
}
const toBool = (value: Scalar): boolean => typeof value === 'boolean' ? value : typeof value === 'number' ? value !== 0 : value === '' ? false
  : String(value).toUpperCase() === 'TRUE' ? true : String(value).toUpperCase() === 'FALSE' ? false : fail('#VALUE!');
const rank = (value: Scalar) => typeof value === 'number' ? 0 : typeof value === 'string' ? 1 : 2;
function compare(left: Scalar, right: Scalar): number {
  if (left === '' && typeof right === 'number') left = 0;
  if (right === '' && typeof left === 'number') right = 0;
  if (rank(left) !== rank(right)) return rank(left) - rank(right);
  if (typeof left === 'string' && typeof right === 'string') { const a = left.toLowerCase(); const b = right.toLowerCase(); return a < b ? -1 : a > b ? 1 : 0; }
  const a = Number(left);
  const b = Number(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A COUNTIF-style criterion such as ">=5", "<>done", "a*" or 12 as a predicate. */
function criterion(spec: Scalar): (value: Scalar) => boolean {
  if (typeof spec !== 'string') return value => compare(value, spec) === 0 && value !== '';
  const match = /^(<=|>=|<>|=|<|>)?(.*)$/s.exec(spec)!;
  const op = match[1] || '=';
  const target = typedValue(match[2]);
  if (typeof target === 'string' && (op === '=' || op === '<>') && /[*?]/.test(target)) {
    const pattern = new RegExp('^' + target.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'is');
    return value => pattern.test(toText(value)) === (op === '=');
  }
  return value => {
    if (op === '=' && target === '') return value === '';
    if (op === '<>' && target === '') return value !== '';
    if (value === '' && op !== '<>') return false;
    if (rank(value) !== rank(target) && op !== '<>') return false;
    const order = compare(value, target);
    const comparison: Record<string, boolean> = { '=': order === 0, '<>': order !== 0, '<': order < 0, '>': order > 0, '<=': order <= 0, '>=': order >= 0 };
    return comparison[op];
  };
}

// ---- Evaluator ----------------------------------------------------------------------------------
/**
 * An evaluator caches cells and records the dependencies read by their formulas.
 * Pass the edited cells to update() for in-place changes; replace sheet objects for snapshots.
 */
export function createEvaluator(sheets: readonly FormulaSheet[], { now = () => new Date(), random = Math.random } = {}): Evaluator {
  let sources = [...sheets];
  let functionSignature=JSON.stringify(sources.map(source=>source.settings?.namedFunctions??[]));
  const nameIndex = () => new Map(sources.map((sheet, id) => [sheet.name.toUpperCase(), id]));
  const describeLayout = (list: readonly FormulaSheet[]) => JSON.stringify(list.map(sheet => [sheet.name, Boolean(sheet.literal), sheet.limit?.rows ?? LIMITS.rows, sheet.limit?.columns ?? LIMITS.columns, sheet.rows, sheet.columns, sheet.names, sheet.merges]));
  const nameAliases = () => new Map(sources.flatMap((source, sheet) => Object.entries(source.names ?? {}).map(([name, address]) => [name, { sheet, address }] as const)));
  let layout = describeLayout(sources);
  let byName = nameIndex();
  let aliases = nameAliases();
  let graph = createDependencyGraph();
  const cache = new Map<number, CellValue>();
  const extent = new Map<number, number>();
  const stack: number[] = [];
  const visiting = new Map<number, number>();
  const volatile = new Set<number>();
  let calculationTime: Date | undefined;
  let evaluated = 0;
  let work = 0;
  let arrayAnchors = new Set<number>();
  let spills = new Map<number, Scalar>();
  let priorSpills: Map<number, Scalar> | undefined;
  let spillsDirty = false;
  let arrayRandom: Map<number, number[]> | undefined;
  const randomOffsets = new Map<number, number>();

  const lastRow = (sheet: number) => {
    const known = extent.get(sheet);
    if (known != null) return known;
    let max = 0;
    for (const address of Object.keys(sources[sheet].cells)) { const row = Number(/[0-9]+$/.exec(address)?.[0]); if (row > max) max = row; }
    extent.set(sheet, max);
    return max;
  };
  const owner = () => stack.at(-1);
  const isCell = (row: number, column: number) => Number.isInteger(row) && Number.isInteger(column) && row >= 0 && column >= 0 && row < LIMITS.rows && column < LIMITS.columns;
  const isFormula = (raw: string | undefined): raw is `=${string}` => raw?.startsWith('=') === true && raw.length > 1;
  function indexArrays() {
    arrayAnchors = new Set();
    for (const [sheet, source] of sources.entries()) {
      if (source.literal) continue;
      for (const [address, raw] of Object.entries(source.cells)) {
        if (!isFormula(raw) || !ARRAY_FORMULA.test(raw)) continue;
        const point = parseAddress(address);
        if (point) arrayAnchors.add(cellKey(sheet, point.row, point.column));
      }
    }
    spillsDirty = Boolean(arrayAnchors.size);
  }
  indexArrays();
  const dependOnCell = (sheet: number, row: number, column: number) => {
    const reader = owner();
    if (reader !== undefined && isCell(row, column)) graph.point(reader, cellKey(sheet, row, column));
  };

  function cellValue(sheet: number, row: number, column: number): Scalar {
    const source = sources[sheet];
    if (!isCell(row, column) || (source.limit && (row >= source.limit.rows || column >= source.limit.columns))) fail('#REF!');
    const key = cellKey(sheet, row, column);
    const spilled = spills.get(key) ?? priorSpills?.get(key);
    if (spilled !== undefined && !Object.hasOwn(source.cells, cellAddress(row, column))) return spilled;
    const hit = cache.get(key);
    if (hit !== undefined) { if (isError(hit)) throw hit; return hit; }
    if (++work > 400000) fail('#ERROR!');
    const raw = source.cells[cellAddress(row, column)];
    if (source.literal || !isFormula(raw)) {
      const value = source.literal ? literalValue(raw) : typedValue(raw);
      cache.set(key, value);
      return value;
    }
    const pathIndex = visiting.get(key);
    if (pathIndex !== undefined) {
      const cycle = new FormulaError('#CYCLE!');
      for (let index = pathIndex; index < stack.length; index++) cache.set(stack[index], cycle);
      throw cycle;
    }
    if (stack.length > 1500) fail('#ERROR!');
    visiting.set(key, stack.length);
    stack.push(key);
    evaluated++;
    const outerArrayDepth = arrayDepth;
    arrayDepth = 0;
    try {
      let value = evaluate(compile(raw), sheet);
      if (value instanceof Range) value = value.single();
      else if (value instanceof ArrayValue) value = spillArray(sheet, row, column, value);
      const cycle = cache.get(key);
      if (isError(cycle)) throw cycle;
      if (typeof value === 'number' && !Number.isFinite(value)) fail('#NUM!');
      cache.set(key, value);
      return value;
    } catch (error) {
      const failure = isError(error) ? error : new FormulaError('#ERROR!');
      const cycle = cache.get(key);
      if (isError(cycle)) throw cycle;
      cache.set(key, failure);
      throw failure;
    } finally {
      visiting.delete(key);
      stack.pop();
      arrayDepth = outerArrayDepth;
    }
  }

  class Range {
    declare readonly sheet: number;
    declare readonly r1: number;
    declare readonly c1: number;
    declare readonly r2: number;
    declare readonly c2: number;

    constructor(sheet: number, r1: number, c1: number, r2: number, c2: number) {
      this.sheet = sheet;
      this.r1 = r1;
      this.c1 = c1;
      this.r2 = r2;
      this.c2 = c2;
    }
    get rows() { return this.r2 - this.r1 + 1; }
    get columns() { return this.c2 - this.c1 + 1; }
    at(row: number, column: number): Scalar {
      if (row < 0 || column < 0 || row >= this.rows || column >= this.columns) dependOnCell(this.sheet, this.r1 + row, this.c1 + column);
      return cellValue(this.sheet, this.r1 + row, this.c1 + column);
    }
    single() {
      if (this.rows === 1 && this.columns === 1) return this.at(0, 0);
      fail('#VALUE!');
    }
    *values() { for (let row = 0; row < this.rows; row++) for (let column = 0; column < this.columns; column++) yield this.at(row, column); }
  }

  class ArrayValue {
    declare readonly data: Scalar[][];
    constructor(data: Scalar[][]) {
      if (!data.length || !data[0]?.length) fail('#N/A');
      if (data.length * data[0].length > ARRAY_CELL_LIMIT) fail('#NUM!');
      this.data = data;
    }
    get rows() { return this.data.length; }
    get columns() { return this.data[0].length; }
    at(row: number, column: number): Scalar { return this.data[row]?.[column] ?? fail('#REF!'); }
    single(): Scalar { return this.rows === 1 && this.columns === 1 ? this.at(0, 0) : fail('#VALUE!'); }
    *values() { for (const row of this.data) yield* row; }
  }

  function spillArray(sheet: number, row: number, column: number, value: ArrayValue): Scalar {
    const source = sources[sheet];
    if (!isCell(row + value.rows - 1, column + value.columns - 1)) fail('#REF!');
    if (row + value.rows > (source.rows ?? LIMITS.rows) || column + value.columns > (source.columns ?? LIMITS.columns)) fail('#REF!');
    if ((value.rows > 1 || value.columns > 1) && mergeAt(source, row, column)) fail('#REF!');
    for (let r = 0; r < value.rows; r++) for (let c = 0; c < value.columns; c++) {
      if (!r && !c) continue;
      if (Object.hasOwn(source.cells, cellAddress(row + r, column + c)) || spills.has(cellKey(sheet, row + r, column + c)) || mergeAt(source, row + r, column + c)) fail('#REF!');
    }
    for (let r = 0; r < value.rows; r++) for (let c = 0; c < value.columns; c++) {
      if (r || c) spills.set(cellKey(sheet, row + r, column + c), value.at(r, c));
    }
    return value.at(0, 0);
  }

  function resolveSheet(name: string | null, current: number): number {
    if (name == null) return current;
    const sheet = byName.get(name.toUpperCase());
    if (sheet === undefined) fail('#REF!');
    return sheet;
  }

  function trackedRange(sheet: number, r1: number, c1: number, r2: number, c2: number): Range {
    const reader = owner();
    if (r1 === r2 && c1 === c2) dependOnCell(sheet, r1, c1);
    else if (reader !== undefined) graph.range(reader, sheet, r1, c1, r2, c2);
    return new Range(sheet, r1, c1, r2, c2);
  }

  function reference(node: Reference, current: number): Range {
    const sheet = resolveSheet(node.sheet, current);
    const { from, to } = node;
    if (!to) {
      if (from.r == null) fail('#REF!');
      return trackedRange(sheet, from.r, from.c, from.r, from.c);
    }
    const r1 = from.r ?? 0;
    const reader = owner();
    if (to.r == null && reader !== undefined) graph.point(reader, extentKey(sheet));
    const r2 = to.r ?? Math.max(r1, Math.min(lastRow(sheet), LIMITS.rows) - 1);
    return trackedRange(sheet, Math.min(r1, r2), Math.min(from.c, to.c), Math.max(r1, r2), Math.max(from.c, to.c));
  }

  const isTable = (value: Scalar | Range | ArrayValue): value is Range | ArrayValue => value instanceof Range || value instanceof ArrayValue;
  const scalar = (node: FormulaNode, sheet: number): Scalar => { const value = evaluate(node, sheet); return isTable(value) ? value.single() : value; };
  // Numbers from ranges count; text and blanks in ranges are skipped, as in other spreadsheets.
  function numbers(args: readonly FormulaNode[], sheet: number): number[] {
    const out: number[] = [];
    for (const node of args) {
      const value = evaluate(node, sheet);
      if (isTable(value)) { for (const item of value.values()) if (typeof item === 'number') out.push(item); }
      else if (value !== '') out.push(toNumber(value));
    }
    return out;
  }
  const flat = (args: readonly FormulaNode[], sheet: number): Scalar[] => args.flatMap(node => { const value = evaluate(node, sheet); return isTable(value) ? [...value.values()] : [value]; });
  const rangeArg = (node: FormulaNode, sheet: number): Range => { const value = evaluate(node, sheet); if (!(value instanceof Range)) fail('#VALUE!'); return value; };
  const round = (value: number, digits: number, mode?: 'up' | 'down') => {
    const factor = 10 ** digits;
    const scaled = Number((value * factor).toPrecision(15));
    const rounded = mode === 'up' ? Math.sign(scaled) * Math.ceil(Math.abs(scaled)) : mode === 'down' ? Math.trunc(scaled) : Math.sign(scaled) * Math.round(Math.abs(scaled));
    return rounded / factor;
  };
  type ConditionalMode = 'count' | 'sum' | 'average';
  const conditional = (args: readonly FormulaNode[], sheet: number, mode: ConditionalMode) => {
    const range = rangeArg(args[0], sheet);
    const test = criterion(scalar(args[1], sheet));
    const target = args[2] ? rangeArg(args[2], sheet) : range;
    let count = 0;
    let total = 0;
    for (let row = 0; row < range.rows; row++) {
      for (let column = 0; column < range.columns; column++) {
        if (!test(range.at(row, column))) continue;
        count++;
        if (mode !== 'count') { const value = target.at(row, column); if (typeof value === 'number') total += value; }
      }
    }
    if (mode === 'count') return count;
    if (mode === 'sum') return total;
    if (!count) fail('#DIV/0!');
    return total / count;
  };
  const multiConditional = (args: readonly FormulaNode[], sheet: number, mode: ConditionalMode) => {
    const target = mode === 'count' ? null : rangeArg(args[0], sheet);
    const pairs: Array<[Range, (value: Scalar) => boolean]> = [];
    for (let index = mode === 'count' ? 0 : 1; index < args.length; index += 2) pairs.push([rangeArg(args[index], sheet), criterion(scalar(args[index + 1], sheet))]);
    const shape = target ?? pairs[0][0];
    let count = 0;
    let total = 0;
    for (let row = 0; row < shape.rows; row++) {
      for (let column = 0; column < shape.columns; column++) {
        if (!pairs.every(([range, test]) => test(range.at(row, column)))) continue;
        count++;
        if (target) { const value = target.at(row, column); if (typeof value === 'number') total += value; }
      }
    }
    return mode === 'count' ? count : mode === 'sum' ? total : count ? total / count : fail('#DIV/0!');
  };
  const lookupIndex = (range: Range, value: Scalar, exact: boolean, byColumn = true) => {
    const length = byColumn ? range.rows : range.columns;
    const read = (index: number) => byColumn ? range.at(index, 0) : range.at(0, index);
    if (exact) {
      for (let index = 0; index < length; index++) if (compare(read(index), value) === 0 && read(index) !== '') return index;
      if (typeof value === 'string' && /[*?]/.test(value)) { const test = criterion('=' + value); for (let index = 0; index < length; index++) if (test(read(index))) return index; }
      fail('#N/A');
    }
    let found = -1;
    for (let index = 0; index < length; index++) { const item = read(index); if (item === '') continue; if (compare(item, value) <= 0) found = index; else break; }
    return found < 0 ? fail('#N/A') : found;
  };
  const text = (node: FormulaNode, sheet: number) => toText(scalar(node, sheet));
  const count = (args: readonly FormulaNode[], min: number, max = min) => { if (args.length < min || args.length > max) fail('#N/A'); };
  const clock = () => calculationTime ??= now();
  const matrix = (rows: number, columns: number, value: (r: number, c: number) => Scalar) => {
    if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(columns) || rows < 1 || columns < 1 || rows * columns > ARRAY_CELL_LIMIT) fail('#NUM!');
    return new ArrayValue(Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) => value(row, column))));
  };
  const table = (node: FormulaNode, sheet: number) => {
    arrayDepth++;
    try { const value = evaluate(node, sheet); return isTable(value) ? value : new ArrayValue([[value]]); }
    finally { arrayDepth--; }
  };
  const integer = (node: FormulaNode, sheet: number) => Math.trunc(toNumber(scalar(node, sheet)));
  const dateArg = (node: FormulaNode, sheet: number) => asDate(scalar(node, sheet)) ?? fail('#VALUE!');
  let arrayDepth = 0;
  const sampleRandom = () => {
    const key = owner();
    if (!arrayRandom || key === undefined) return random();
    const offset = randomOffsets.get(key) ?? 0;
    randomOffsets.set(key, offset + 1);
    let values = arrayRandom.get(key);
    if (!values) arrayRandom.set(key, values = []);
    return values[offset] ??= random();
  };

  const FUNCTIONS = {
    SUM: (args, sheet) => numbers(args, sheet).reduce((total, value) => total + value, 0),
    AVERAGE: (args, sheet) => { const values = numbers(args, sheet); return values.length ? values.reduce((a, b) => a + b, 0) / values.length : fail('#DIV/0!'); },
    MIN: (args, sheet) => { const values = numbers(args, sheet); return values.length ? Math.min(...values) : 0; },
    MAX: (args, sheet) => { const values = numbers(args, sheet); return values.length ? Math.max(...values) : 0; },
    MEDIAN: (args, sheet) => {
      const values = numbers(args, sheet).sort((a, b) => a - b);
      if (!values.length) fail('#NUM!');
      const middle = Math.floor(values.length / 2);
      return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    },
    PRODUCT: (args, sheet) => numbers(args, sheet).reduce((total, value) => total * value, 1),
    COUNT: (args, sheet) => flat(args, sheet).filter(value => typeof value === 'number').length,
    COUNTA: (args, sheet) => flat(args, sheet).filter(value => value !== '').length,
    COUNTBLANK: (args, sheet) => flat(args, sheet).filter(value => value === '').length,
    COUNTIF: (args, sheet) => { count(args, 2); return conditional(args, sheet, 'count'); },
    SUMIF: (args, sheet) => { count(args, 2, 3); return conditional(args, sheet, 'sum'); },
    AVERAGEIF: (args, sheet) => { count(args, 2, 3); return conditional(args, sheet, 'average'); },
    COUNTIFS: (args, sheet) => { if (!args.length || args.length % 2) fail('#N/A'); return multiConditional(args, sheet, 'count'); },
    SUMIFS: (args, sheet) => { if (args.length < 3 || !(args.length % 2)) fail('#N/A'); return multiConditional(args, sheet, 'sum'); },
    AVERAGEIFS: (args, sheet) => { if (args.length < 3 || !(args.length % 2)) fail('#N/A'); return multiConditional(args, sheet, 'average'); },
    IF: (args, sheet) => { count(args, 2, 3); return toBool(scalar(args[0], sheet)) ? scalar(args[1], sheet) : args[2] ? scalar(args[2], sheet) : false; },
    IFS: (args, sheet) => {
      if (!args.length || args.length % 2) fail('#N/A');
      for (let index = 0; index < args.length; index += 2) if (toBool(scalar(args[index], sheet))) return scalar(args[index + 1], sheet);
      return fail('#N/A');
    },
    SWITCH: (args, sheet) => {
      if (args.length < 3) fail('#N/A');
      const value = scalar(args[0], sheet);
      for (let index = 1; index + 1 < args.length; index += 2) if (!compare(value, scalar(args[index], sheet))) return scalar(args[index + 1], sheet);
      return args.length % 2 === 0 ? scalar(args.at(-1)!, sheet) : fail('#N/A');
    },
    IFERROR: (args, sheet) => { count(args, 1, 2); try { return scalar(args[0], sheet); } catch (error) { if (!isError(error) || error.code === '#CYCLE!') throw error; return args[1] ? scalar(args[1], sheet) : ''; } },
    IFNA: (args, sheet) => { count(args, 2); try { return scalar(args[0], sheet); } catch (error) { if (!isError(error) || error.code !== '#N/A') throw error; return scalar(args[1], sheet); } },
    AND: (args, sheet) => flat(args, sheet).filter(value => value !== '').every(toBool),
    OR: (args, sheet) => flat(args, sheet).filter(value => value !== '').some(toBool),
    NOT: (args, sheet) => { count(args, 1); return !toBool(scalar(args[0], sheet)); },
    ABS: (args, sheet) => { count(args, 1); return Math.abs(toNumber(scalar(args[0], sheet))); },
    INT: (args, sheet) => { count(args, 1); return Math.floor(toNumber(scalar(args[0], sheet))); },
    ROUND: (args, sheet) => { count(args, 1, 2); return round(toNumber(scalar(args[0], sheet)), args[1] ? toNumber(scalar(args[1], sheet)) : 0); },
    ROUNDUP: (args, sheet) => { count(args, 1, 2); return round(toNumber(scalar(args[0], sheet)), args[1] ? toNumber(scalar(args[1], sheet)) : 0, 'up'); },
    ROUNDDOWN: (args, sheet) => { count(args, 1, 2); return round(toNumber(scalar(args[0], sheet)), args[1] ? toNumber(scalar(args[1], sheet)) : 0, 'down'); },
    MOD: (args, sheet) => { count(args, 2); const divisor = toNumber(scalar(args[1], sheet)); if (!divisor) fail('#DIV/0!'); const value = toNumber(scalar(args[0], sheet)); return value - divisor * Math.floor(value / divisor); },
    POWER: (args, sheet) => { count(args, 2); return toNumber(scalar(args[0], sheet)) ** toNumber(scalar(args[1], sheet)); },
    SQRT: (args, sheet) => { count(args, 1); const value = toNumber(scalar(args[0], sheet)); return value < 0 ? fail('#NUM!') : Math.sqrt(value); },
    CONCAT: (args, sheet) => flat(args, sheet).map(toText).join(''),
    CONCATENATE: (args, sheet) => flat(args, sheet).map(toText).join(''),
    TEXTJOIN: (args, sheet) => { if (args.length < 3) fail('#N/A'); const separator = text(args[0], sheet); const skip = toBool(scalar(args[1], sheet)); return flat(args.slice(2), sheet).filter(value => !skip || value !== '').map(toText).join(separator); },
    LEN: (args, sheet) => { count(args, 1); return text(args[0], sheet).length; },
    LOWER: (args, sheet) => { count(args, 1); return text(args[0], sheet).toLowerCase(); },
    UPPER: (args, sheet) => { count(args, 1); return text(args[0], sheet).toUpperCase(); },
    PROPER: (args, sheet) => { count(args, 1); return text(args[0], sheet).toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_, before, letter) => before + letter.toUpperCase()); },
    TRIM: (args, sheet) => { count(args, 1); return text(args[0], sheet).trim().replace(/ {2,}/g, ' '); },
    LEFT: (args, sheet) => { count(args, 1, 2); return text(args[0], sheet).slice(0, args[1] ? toNumber(scalar(args[1], sheet)) : 1); },
    RIGHT: (args, sheet) => { count(args, 1, 2); const value = text(args[0], sheet); const size = args[1] ? toNumber(scalar(args[1], sheet)) : 1; return size ? value.slice(-size) : ''; },
    MID: (args, sheet) => { count(args, 3); const start = toNumber(scalar(args[1], sheet)); if (start < 1) fail('#VALUE!'); return text(args[0], sheet).substr(start - 1, toNumber(scalar(args[2], sheet))); },
    SUBSTITUTE: (args, sheet) => { count(args, 3); const search = text(args[1], sheet); return search ? text(args[0], sheet).split(search).join(text(args[2], sheet)) : text(args[0], sheet); },
    FIND: (args, sheet) => { count(args, 2, 3); const at = text(args[1], sheet).indexOf(text(args[0], sheet), (args[2] ? toNumber(scalar(args[2], sheet)) : 1) - 1); return at < 0 ? fail('#VALUE!') : at + 1; },
    SEARCH: (args, sheet) => { count(args, 2, 3); const at = text(args[1], sheet).toLowerCase().indexOf(text(args[0], sheet).toLowerCase(), (args[2] ? toNumber(scalar(args[2], sheet)) : 1) - 1); return at < 0 ? fail('#VALUE!') : at + 1; },
    VALUE: (args, sheet) => { count(args, 1); return toNumber(scalar(args[0], sheet)); },
    ISBLANK: (args, sheet) => { count(args, 1); return scalar(args[0], sheet) === ''; },
    ISNUMBER: (args, sheet) => { count(args, 1); try { return typeof scalar(args[0], sheet) === 'number'; } catch (error) { if (isError(error)) return false; throw error; } },
    ISTEXT: (args, sheet) => { count(args, 1); try { const value = scalar(args[0], sheet); return typeof value === 'string' && value !== ''; } catch (error) { if (isError(error)) return false; throw error; } },
    ISERROR: (args, sheet) => { count(args, 1); try { scalar(args[0], sheet); return false; } catch (error) { if (isError(error) && error.code !== '#CYCLE!') return true; throw error; } },
    VLOOKUP: (args, sheet) => {
      count(args, 3, 4);
      const key = scalar(args[0], sheet);
      const table = rangeArg(args[1], sheet);
      const column = toNumber(scalar(args[2], sheet));
      if (column < 1 || column > table.columns) fail('#REF!');
      const exact = args[3] ? !toBool(scalar(args[3], sheet)) : false;
      return table.at(lookupIndex(new Range(table.sheet, table.r1, table.c1, table.r2, table.c1), key, exact), column - 1);
    },
    HLOOKUP: (args, sheet) => {
      count(args, 3, 4);
      const key = scalar(args[0], sheet);
      const table = rangeArg(args[1], sheet);
      const row = toNumber(scalar(args[2], sheet));
      if (row < 1 || row > table.rows) fail('#REF!');
      const exact = args[3] ? !toBool(scalar(args[3], sheet)) : false;
      return table.at(row - 1, lookupIndex(new Range(table.sheet, table.r1, table.c1, table.r1, table.c2), key, exact, false));
    },
    XLOOKUP: (args, sheet) => {
      count(args, 3, 6);
      const key = scalar(args[0], sheet);
      const lookup = table(args[1], sheet);
      const results = table(args[2], sheet);
      const horizontal = lookup.rows === 1;
      if ((!horizontal && lookup.columns !== 1) || (horizontal ? lookup.columns !== results.columns : lookup.rows !== results.rows)) fail('#VALUE!');
      const matchMode = args[4] ? integer(args[4], sheet) : 0;
      const searchMode = args[5] ? integer(args[5], sheet) : 1;
      if (![0, -1, 1, 2].includes(matchMode) || ![1, -1, 2, -2].includes(searchMode)) fail('#VALUE!');
      const length = horizontal ? lookup.columns : lookup.rows;
      const wildcard = matchMode === 2 ? criterion('=' + toText(key)) : null;
      let nearest = -1;
      let nearestValue: Scalar = '';
      for (let step = 0; step < length; step++) {
        const index = searchMode < 0 ? length - 1 - step : step;
        const value = horizontal ? lookup.at(0, index) : lookup.at(index, 0);
        const order = compare(value, key);
        if (wildcard ? wildcard(value) : !order) { nearest = index; break; }
        if ((matchMode === -1 && order < 0 && (nearest < 0 || compare(value, nearestValue) > 0)) ||
            (matchMode === 1 && order > 0 && (nearest < 0 || compare(value, nearestValue) < 0))) { nearest = index; nearestValue = value; }
      }
      if (nearest < 0) return args[3] ? scalar(args[3], sheet) : fail('#N/A');
      if ((horizontal ? results.rows : results.columns) === 1) return horizontal ? results.at(0, nearest) : results.at(nearest, 0);
      return horizontal ? matrix(results.rows, 1, row => results.at(row, nearest)) : matrix(1, results.columns, (_, column) => results.at(nearest, column));
    },
    MATCH: (args, sheet) => {
      count(args, 2, 3);
      const range = rangeArg(args[1], sheet);
      const exact = args[2] ? toNumber(scalar(args[2], sheet)) === 0 : false;
      return lookupIndex(range, scalar(args[0], sheet), exact, range.columns === 1) + 1;
    },
    INDEX: (args, sheet) => {
      count(args, 2, 3);
      const range = rangeArg(args[0], sheet);
      let row = toNumber(scalar(args[1], sheet));
      let column = args[2] ? toNumber(scalar(args[2], sheet)) : 1;
      if (range.rows === 1 && !args[2]) { column = row; row = 1; }
      if (row < 1 || column < 1 || row > range.rows || column > range.columns) fail('#REF!');
      return range.at(row - 1, column - 1);
    },
    ROWS: (args, sheet) => { count(args, 1); return table(args[0], sheet).rows; },
    COLUMNS: (args, sheet) => { count(args, 1); return table(args[0], sheet).columns; },
    DATE: (args, sheet) => {
      count(args, 3);
      const year = integer(args[0], sheet);
      return serialDate(year >= 0 && year < 1900 ? year + 1900 : year, integer(args[1], sheet) - 1, integer(args[2], sheet));
    },
    DATEVALUE: (args, sheet) => { count(args, 1); return (dateArg(args[0], sheet).valueOf() - SPREADSHEET_EPOCH) / DAY_MS; },
    YEAR: (args, sheet) => { count(args, 1); return dateArg(args[0], sheet).getUTCFullYear(); },
    MONTH: (args, sheet) => { count(args, 1); return dateArg(args[0], sheet).getUTCMonth() + 1; },
    DAY: (args, sheet) => { count(args, 1); return dateArg(args[0], sheet).getUTCDate(); },
    EDATE: (args, sheet) => {
      count(args, 2);
      const date = dateArg(args[0], sheet);
      const day = date.getUTCDate();
      date.setUTCDate(1);
      date.setUTCMonth(date.getUTCMonth() + integer(args[1], sheet) + 1, 0);
      return serialDate(date.getUTCFullYear(), date.getUTCMonth(), Math.min(day, date.getUTCDate()));
    },
    EOMONTH: (args, sheet) => {
      count(args, 2);
      const date = dateArg(args[0], sheet);
      return serialDate(date.getUTCFullYear(), date.getUTCMonth() + integer(args[1], sheet) + 1, 0);
    },
    TODAY: args => {
      count(args, 0);
      const date = clock();
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    },
    NOW: args => {
      count(args, 0);
      const date = clock();
      return (date.valueOf() - date.getTimezoneOffset() * 60000 - SPREADSHEET_EPOCH) / DAY_MS;
    },
    RAND: args => { count(args, 0); return sampleRandom(); },
    SEQUENCE: (args, sheet) => {
      count(args, 1, 4);
      const rows = integer(args[0], sheet);
      const columns = args[1] ? integer(args[1], sheet) : 1;
      const start = args[2] ? toNumber(scalar(args[2], sheet)) : 1;
      const step = args[3] ? toNumber(scalar(args[3], sheet)) : 1;
      return matrix(rows, columns, (r, c) => start + (r * columns + c) * step);
    },
    TRANSPOSE: (args, sheet) => {
      count(args, 1);
      const input = table(args[0], sheet);
      return matrix(input.columns, input.rows, (r, c) => input.at(c, r));
    },
    UNIQUE: (args, sheet) => {
      count(args, 1, 3);
      const input = table(args[0], sheet);
      if (input.rows * input.columns > ARRAY_CELL_LIMIT) fail('#NUM!');
      const byColumn = args[1] && toBool(scalar(args[1], sheet));
      const once = args[2] && toBool(scalar(args[2], sheet));
      const entries = Array.from({ length: byColumn ? input.columns : input.rows }, (_, index) =>
        Array.from({ length: byColumn ? input.rows : input.columns }, (_, at) => byColumn ? input.at(at, index) : input.at(index, at)));
      const distinct = new Map<string, { entry: Scalar[]; count: number }>();
      for (const entry of entries) {
        const key = JSON.stringify(entry);
        const known = distinct.get(key);
        if (known) known.count++; else distinct.set(key, { entry, count: 1 });
      }
      const output = [...distinct.values()].filter(item => !once || item.count === 1).map(item => item.entry);
      if (!output.length) fail('#N/A');
      return byColumn ? matrix(input.rows, output.length, (row, column) => output[column][row]) : new ArrayValue(output);
    },
    FILTER: (args, sheet) => {
      if (args.length < 2) fail('#N/A');
      const input = table(args[0], sheet);
      const conditions = args.slice(1).map(node => table(node, sheet));
      const byRow = conditions.every(condition => condition.columns === 1 && condition.rows === input.rows);
      if (!byRow && !conditions.every(condition => condition.rows === 1 && condition.columns === input.columns)) fail('#N/A');
      const indices = Array.from({ length: byRow ? input.rows : input.columns }, (_, index) => index)
        .filter(index => conditions.every(condition => toBool(byRow ? condition.at(index, 0) : condition.at(0, index))));
      if (!indices.length) fail('#N/A');
      return matrix(byRow ? indices.length : input.rows, byRow ? input.columns : indices.length, (row, column) =>
        input.at(byRow ? indices[row] : row, byRow ? column : indices[column]));
    },
    SORT: (args, sheet) => {
      if (args.length < 3 || args.length % 2 === 0) fail('#N/A');
      const input = table(args[0], sheet);
      if (input.rows * input.columns > ARRAY_CELL_LIMIT) fail('#NUM!');
      const rules: Array<{ column: number; direction: number }> = [];
      for (let index = 1; index < args.length; index += 2) {
        const column = integer(args[index], sheet) - 1;
        if (column < 0 || column >= input.columns) fail('#VALUE!');
        rules.push({ column, direction: toBool(scalar(args[index + 1], sheet)) ? 1 : -1 });
      }
      const order = Array.from({ length: input.rows }, (_, row) => row);
      order.sort((a, b) => {
        for (const rule of rules) {
          const difference = compare(input.at(a, rule.column), input.at(b, rule.column));
          if (difference) return difference * rule.direction;
        }
        return a - b;
      });
      return matrix(input.rows, input.columns, (row, column) => input.at(order[row], column));
    },
    SPLIT: (args, sheet) => {
      count(args, 2, 4);
      const delimiter = text(args[1], sheet);
      if (!delimiter) fail('#VALUE!');
      const each = args[2] ? toBool(scalar(args[2], sheet)) : true;
      const removeEmpty = args[3] ? toBool(scalar(args[3], sheet)) : true;
      const value = text(args[0], sheet);
      const entries = each ? value.split(new RegExp(`[${delimiter.replace(/[\\\]\-^]/g, '\\$&')}]`)) : value.split(delimiter);
      return new ArrayValue([(removeEmpty ? entries.filter(Boolean) : entries).map(typedValue)]);
    },
    ARRAYFORMULA: (args, sheet) => {
      count(args, 1);
      arrayDepth++;
      try { const input = table(args[0], sheet); return matrix(input.rows, input.columns, (row, column) => input.at(row, column)); }
      finally { arrayDepth--; }
    },
    INDIRECT: (args, sheet) => {
      count(args, 1, 2);
      if (args[1] && !toBool(scalar(args[1], sheet))) fail('#REF!');
      const node = parseFormula('=' + text(args[0], sheet).trim());
      if (isError(node) || node.k !== 'ref') fail('#REF!');
      return reference(node, sheet);
    },
    OFFSET: (args, sheet) => {
      count(args, 3, 5);
      const base = rangeArg(args[0], sheet);
      const row = base.r1 + Math.trunc(toNumber(scalar(args[1], sheet)));
      const column = base.c1 + Math.trunc(toNumber(scalar(args[2], sheet)));
      const height = args[3] ? Math.trunc(toNumber(scalar(args[3], sheet))) : base.rows;
      const width = args[4] ? Math.trunc(toNumber(scalar(args[4], sheet))) : base.columns;
      if (height < 1 || width < 1 || !isCell(row, column) || !isCell(row + height - 1, column + width - 1)) fail('#REF!');
      return trackedRange(base.sheet, row, column, row + height - 1, column + width - 1);
    },
    PI: args => { count(args, 0); return Math.PI; }
  } satisfies Record<(typeof FUNCTION_NAMES)[number], (args: readonly FormulaNode[], sheet: number) => Scalar | Range | ArrayValue>;

  function binary(op: string, left: Scalar, right: Scalar): Scalar {
    switch (op) {
      case '+': return toNumber(left) + toNumber(right);
      case '-': return toNumber(left) - toNumber(right);
      case '*': return toNumber(left) * toNumber(right);
      case '/': { const divisor = toNumber(right); if (!divisor) fail('#DIV/0!'); return toNumber(left) / divisor; }
      case '^': return toNumber(left) ** toNumber(right);
      case '&': return toText(left) + toText(right);
      case '=': return compare(left, right) === 0;
      case '<>': return compare(left, right) !== 0;
      case '<': return compare(left, right) < 0;
      case '>': return compare(left, right) > 0;
      case '<=': return compare(left, right) <= 0;
      case '>=': return compare(left, right) >= 0;
      default: return fail('#ERROR!');
    }
  }

  let namedFunctionDepth = 0;
  function bindNamedArguments(node: FormulaNode, args: ReadonlyMap<string, FormulaNode>): FormulaNode {
    if (node.k === 'name' && args.has(node.v)) return args.get(node.v)!;
    if (node.k === 'bin') return { ...node, a: bindNamedArguments(node.a, args), b: bindNamedArguments(node.b, args) };
    if (node.k === 'unary' || node.k === 'pct') return { ...node, a: bindNamedArguments(node.a, args) };
    if (node.k === 'fn') return { ...node, args: node.args.map(arg => bindNamedArguments(arg, args)) };
    return node;
  }
  function evaluate(node: FormulaNode, sheet: number): Scalar | Range | ArrayValue {
    switch (node.k) {
      case 'val': return node.v;
      case 'error': throw new FormulaError(node.code);
      case 'name': {
        const alias = aliases.get(node.v.toUpperCase());
        if (!alias) fail('#NAME?');
        if (alias.address === '#REF!') fail('#REF!');
        return reference({ sheet: null, ...parseReference(alias.address) }, alias.sheet);
      }
      case 'ref': return reference(node, sheet);
      case 'pct': return toNumber(scalar(node.a, sheet)) / 100;
      case 'unary': { const value = toNumber(scalar(node.a, sheet)); return node.op === '-' ? -value : value; }
      case 'fn': {
        if (!Object.hasOwn(FUNCTIONS, node.name)) {
          const custom = sources.flatMap(source => source.settings?.namedFunctions ?? []).find(fn => fn.name === node.name);
          if (!custom) fail('#NAME?');
          if (custom.args.length !== node.args.length) fail('#VALUE!');
          if (namedFunctionDepth >= 30) fail('#CYCLE!');
          namedFunctionDepth++;
          try { return evaluate(bindNamedArguments(compile(custom.formula), new Map(custom.args.map((name, index) => [name, node.args[index]]))), sheet); }
          finally { namedFunctionDepth--; }
        }
        const reader = owner();
        if (reader !== undefined && VOLATILE_FUNCTIONS.has(node.name)) volatile.add(reader);
        const run: (args: readonly FormulaNode[], sheet: number) => Scalar | Range | ArrayValue = FUNCTIONS[node.name as keyof typeof FUNCTIONS];
        return run(node.args, sheet);
      }
      case 'bin': {
        if (!arrayDepth) return binary(node.op, scalar(node.a, sheet), scalar(node.b, sheet));
        const left = table(node.a, sheet);
        const right = table(node.b, sheet);
        if ((left.rows !== right.rows && left.rows !== 1 && right.rows !== 1) ||
            (left.columns !== right.columns && left.columns !== 1 && right.columns !== 1)) fail('#VALUE!');
        return matrix(Math.max(left.rows, right.rows), Math.max(left.columns, right.columns), (row, col) => binary(node.op,
          left.at(left.rows === 1 ? 0 : row, left.columns === 1 ? 0 : col), right.at(right.rows === 1 ? 0 : row, right.columns === 1 ? 0 : col)));
      }
    }
    fail('#ERROR!');
  }

  function readCell(sheet: number, row: number, column: number): CellValue {
    work = 0;
    try { return cellValue(sheet, row, column); }
    catch (error) { if (isError(error)) return error; throw error; }
  }

  function resetCalculation() {
    const invalidated = cache.size + spills.size;
    cache.clear();
    graph = createDependencyGraph();
    extent.clear();
    volatile.clear();
    spills.clear();
    calculationTime = undefined;
    spillsDirty = Boolean(arrayAnchors.size);
    return { invalidated, evaluated: 0 };
  }

  function prepareSpills() {
    if (!spillsDirty) return;
    spillsDirty = false;
    const anchors = [...arrayAnchors].sort((a, b) => a - b);
    arrayRandom = new Map();
    try {
      // Recompute newly revealed spill dependencies until all spill values agree with the prior pass.
      for (let pass = 0; pass < 12; pass++) {
        priorSpills = spills;
        spills = new Map();
        cache.clear(); graph = createDependencyGraph(); volatile.clear(); randomOffsets.clear();
        for (const key of anchors) {
          const { sheet, row, column } = cellPosition(key);
          readCell(sheet, row, column);
        }
        if (spills.size === priorSpills.size && [...spills].every(([key, value]) => priorSpills?.get(key) === value)) return;
      }
      const candidates = new Set([...spills.keys(), ...priorSpills?.keys() ?? []]);
      const unstable = new Set([...candidates].filter(key => spills.get(key) !== priorSpills?.get(key)));
      for (const key of unstable) spills.delete(key);
      for (const key of graph.plan(unstable).dirty) {
        cache.delete(key);
        if (arrayAnchors.has(key)) cache.set(key, new FormulaError('#CYCLE!'));
      }
    } finally {
      priorSpills = undefined;
      arrayRandom = undefined;
      randomOffsets.clear();
    }
  }

  function recalculate(roots: Iterable<number>): Recalculation {
    calculationTime = undefined;
    const { dirty, order } = graph.plan([...roots, ...volatile]);
    for (const key of dirty) {
      cache.delete(key);
      graph.forget(key);
      volatile.delete(key);
    }
    const before = evaluated;
    for (const key of order) {
      const { sheet, row, column } = cellPosition(key);
      const source = sources[sheet];
      if (row < LIMITS.rows && !source.literal && isFormula(source.cells[cellAddress(row, column)])) {
        // Reads recurse into invalidated precedents first. The cache keeps a shared precedent
        // from running twice even when several downstream formulas need it.
        readCell(sheet, row, column);
      }
    }
    return { invalidated: dirty.size, evaluated: evaluated - before };
  }

  function update(next: readonly FormulaSheet[], changes?: readonly CellChange[]): Recalculation {
    const nextLayout = describeLayout(next);
    const nextFunctions=JSON.stringify(next.map(source=>source.settings?.namedFunctions??[]));
    const functionsChanged=functionSignature!==nextFunctions;
    functionSignature=nextFunctions;
    if (layout !== nextLayout || functionsChanged) {
      sources = [...next];
      layout = nextLayout;
      byName = nameIndex();
      aliases = nameAliases();
      indexArrays();
      return resetCalculation();
    }

    const roots = new Set<number>();
    const extentCandidates = new Map<number, number>();
    const changed = (sheet: number, address: string) => {
      const point = parseAddress(address.toUpperCase());
      if (!point) return;
      roots.add(cellKey(sheet, point.row, point.column));
      const count = extent.get(sheet);
      if (count !== undefined && point.row >= count - 1) {
        extentCandidates.set(sheet, Math.max(point.row + 1, extentCandidates.get(sheet) ?? count));
      }
    };
    if (changes) {
      for (const change of changes) {
        const id = byName.get(change.sheet.toUpperCase());
        if (id !== undefined) changed(id, change.address);
      }
    } else {
      for (const [id, sheet] of next.entries()) {
        const previous = sources[id].cells;
        if (previous === sheet.cells) continue;
        for (const [address, value] of Object.entries(sheet.cells)) if (previous[address] !== value) changed(id, address);
        for (const address of Object.keys(previous)) if (!Object.hasOwn(sheet.cells, address)) changed(id, address);
      }
    }
    sources = [...next];
    if (roots.size && (arrayAnchors.size || [...roots].some(key => {
      const { sheet, row, column } = cellPosition(key);
      const raw = sources[sheet].cells[cellAddress(row, column)];
      return !sources[sheet].literal && isFormula(raw) && ARRAY_FORMULA.test(raw);
    }))) {
      indexArrays();
      return resetCalculation();
    }
    for (const [sheet, candidate] of extentCandidates) {
      const cells = sources[sheet].cells;
      let count = candidate;
      search: for (; count > 0; count--) {
        for (let column = 0; column < LIMITS.columns; column++) {
          if (Object.hasOwn(cells, cellAddress(count - 1, column))) break search;
        }
      }
      if (count !== extent.get(sheet)) {
        extent.set(sheet, count);
        roots.add(extentKey(sheet));
      }
    }
    return roots.size ? recalculate(roots) : { invalidated: 0, evaluated: 0 };
  }

  return {
    update,
    recalculate: () => arrayAnchors.size ? resetCalculation() : recalculate([]),
    spillValue(sheet, address) {
      if (!arrayAnchors.size) return undefined;
      prepareSpills();
      const id = byName.get(sheet.name.toUpperCase());
      const point = parseAddress(address.toUpperCase());
      return id === undefined || !point ? undefined : spills.get(cellKey(id, point.row, point.column));
    },
    spillAddresses(sheet) {
      if (!arrayAnchors.size) return [];
      prepareSpills();
      const id = byName.get(sheet.name.toUpperCase());
      const addresses: string[] = [];
      for (const key of spills.keys()) {
        const point = cellPosition(key);
        if (point.sheet === id) addresses.push(cellAddress(point.row, point.column));
      }
      return addresses;
    },
    /** The computed value of a cell, or a FormulaError (returned, not thrown). */
    value(sheet, address) {
      const point = parseAddress(address.toUpperCase());
      const id = byName.get(sheet.name.toUpperCase());
      if (!point || id === undefined) return new FormulaError('#REF!');
      prepareSpills();
      return readCell(id, point.row, point.column);
    },
    /** Values of a rectangular block, for status-bar totals. */
    block(sheet, r1, c1, r2, c2) {
      const out: CellValue[] = [];
      const id = byName.get(sheet.name.toUpperCase());
      prepareSpills();
      for (let row = r1; row <= r2; row++) for (let column = c1; column <= c2; column++) {
        out.push(id === undefined ? new FormulaError('#REF!') : readCell(id, row, column));
      }
      return out;
    }
  };
}

export const FUNCTION_NAMES = ['SUM', 'AVERAGE', 'COUNT', 'COUNTA', 'COUNTIF', 'SUMIF', 'AVERAGEIF', 'COUNTIFS', 'SUMIFS', 'AVERAGEIFS', 'MIN', 'MAX', 'MEDIAN', 'PRODUCT', 'COUNTBLANK', 'IF', 'IFS', 'SWITCH', 'IFERROR', 'IFNA', 'AND', 'OR', 'NOT', 'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'ABS', 'INT', 'MOD', 'POWER', 'SQRT', 'CONCAT', 'CONCATENATE', 'TEXTJOIN', 'LEN', 'LOWER', 'UPPER', 'PROPER', 'TRIM', 'LEFT', 'RIGHT', 'MID', 'SUBSTITUTE', 'FIND', 'SEARCH', 'VALUE', 'ISBLANK', 'ISNUMBER', 'ISTEXT', 'ISERROR', 'VLOOKUP', 'HLOOKUP', 'XLOOKUP', 'MATCH', 'INDEX', 'ROWS', 'COLUMNS', 'DATE', 'DATEVALUE', 'YEAR', 'MONTH', 'DAY', 'EDATE', 'EOMONTH', 'TODAY', 'NOW', 'RAND', 'SEQUENCE', 'TRANSPOSE', 'UNIQUE', 'FILTER', 'SORT', 'SPLIT', 'ARRAYFORMULA', 'INDIRECT', 'OFFSET', 'PI'] as const;

/**
 * Compatibility wrapper used by tests and older callers: the value of `address` in `cells`, where
 * `sheets` lists the sheets formulas may name. Throws an Error whose message is the error code.
 */
export function sheetValue(cells: FormulaSheet['cells'], address: string, sheets: readonly FormulaSheet[] = []): Scalar {
  const current = sheets.find(sheet => sheet.cells === cells) ?? { name: '\u0000current', cells };
  const evaluator = createEvaluator(sheets.includes(current) ? sheets : [...sheets, current]);
  const value = evaluator.value(current, address);
  if (isError(value)) throw new Error(value.code);
  return value;
}

// ---- Display ------------------------------------------------------------------------------------
/** The text a cell shows for a computed value and its number format. */
export function displayValue(value: CellValue, format: { num?: string; dp?: number; currency?: string; pattern?: string; locale?: string; timeZone?: string } = {}): string {
  if (isError(value)) return value.code;
  const locale=format.locale??'en-IN';
  const zoned=(date:Date|null)=>{if(!date||!format.timeZone||typeof value!=='string'||!value.includes('T'))return date;try{const parts=new Intl.DateTimeFormat('en-CA',{timeZone:format.timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date);const part=(name:string)=>parts.find(item=>item.type===name)?.value;return new Date(`${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}Z`)}catch{return date}};
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (format.pattern && /[dyhHsS]/.test(format.pattern)) {
    const date = zoned(asDate(value));
    if (date) {
      const clock = /h|H/.test(format.pattern);
      const part = (number: number) => String(number).padStart(2, '0');
      return format.pattern.replace(/yyyy|YYYY|yy|YY|dd|DD|mm|MM|HH|hh|ss|SS|AM\/PM/gi, (token, offset: number) => {
        switch (token.toLowerCase()) {
          case 'yyyy': return String(date.getUTCFullYear());
          case 'yy': return String(date.getUTCFullYear()).slice(-2);
          case 'dd': return part(date.getUTCDate());
          case 'mm': return part(clock && (format.pattern![offset-1] === ':' || format.pattern![offset+2] === ':' || !/[dy]/i.test(format.pattern!)) ? date.getUTCMinutes() : date.getUTCMonth() + 1);
          case 'hh': return part(date.getUTCHours());
          case 'ss': return part(date.getUTCSeconds());
          default: return date.getUTCHours() >= 12 ? 'PM' : 'AM';
        }
      });
    }
  }
  if (format.num === 'date' || format.num === 'time' || format.num === 'datetime') {
    const date = zoned(asDate(value));
    if (date) {
      const [day, clock] = date.toISOString().slice(0, -5).split('T');
      return format.num === 'date' ? day : format.num === 'time' ? clock : `${day} ${clock}`;
    }
  }
  if (typeof value !== 'number') return value;
  const dp = format.dp;
  if (format.pattern && /[0#]/.test(format.pattern)) {
    const sections = format.pattern.split(';');
    const pattern = value < 0 && sections[1] ? sections[1] : value === 0 && sections[2] ? sections[2] : sections[0];
    const decimals = /\.([0#]+)/.exec(pattern)?.[1] ?? '';
    const scaled = pattern.includes('%') ? Math.abs(value) * 100 : Math.abs(value);
    const amount = scaled.toLocaleString(locale, { useGrouping: pattern.includes(','), minimumFractionDigits: Math.min(10, decimals.replaceAll('#', '').length), maximumFractionDigits: Math.min(10, decimals.length) });
    const prefix = /^[^0#]*/.exec(pattern)?.[0].replace(/[(),]/g, '') ?? '';
    const suffix = /[^0#]*$/.exec(pattern)?.[0].replace(/[(),]/g, '') ?? '';
    return value < 0 && pattern.includes('(') ? `(${prefix}${amount}${suffix})` : `${value < 0 ? '-' : ''}${prefix}${amount}${suffix}`;
  }
  if ((format.currency||format.locale) && ['currency', 'accounting'].includes(format.num ?? '')) return new Intl.NumberFormat(locale, { style: 'currency', currency: format.currency??({'en-IN':'INR','en-US':'USD','en-GB':'GBP','de-DE':'EUR','fr-FR':'EUR'}[locale]??'INR'), currencySign: format.num === 'accounting' ? 'accounting' : 'standard', minimumFractionDigits: dp ?? 2, maximumFractionDigits: dp ?? 2 }).format(value);
  switch (format.num) {
    case 'number': return value.toLocaleString(locale, { minimumFractionDigits: dp ?? 2, maximumFractionDigits: dp ?? 2 });
    case 'percent': return (value * 100).toLocaleString(locale, { minimumFractionDigits: dp ?? 2, maximumFractionDigits: dp ?? 2 }) + '%';
    case 'currency': return (value < 0 ? '-₹' : '₹') + Math.abs(value).toLocaleString(locale, { minimumFractionDigits: dp ?? 2, maximumFractionDigits: dp ?? 2 });
    case 'accounting': { const amount = `₹${Math.abs(value).toLocaleString(locale, { minimumFractionDigits: dp ?? 2, maximumFractionDigits: dp ?? 2 })}`; return value === 0 ? '₹ –' : value < 0 ? `(${amount})` : amount; }
    case 'scientific': return value.toExponential(dp ?? 2).toUpperCase();
    case 'duration': {
      const seconds = Math.round(Math.abs(value) * 86400);
      return `${value < 0 ? '-' : ''}${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    }
    default:
      if (dp != null) return value.toFixed(dp);
      return Math.abs(value) >= 1e15 || (Math.abs(value) < 1e-9 && value !== 0) ? value.toExponential(4) : String(Number(value.toPrecision(10)));
  }
}

