// Schedora Sheets: workbook shape, limits and the change operations shared by the server and the
// browser. The source of truth is backend/src/shared/; `npm run sync-shared` copies it to
// frontend/shared/.
//
// Every edit is an operation that names what it expected to find (`from`) and what it writes (`to`).
// The server applies an operation only when the stored value still equals `from`; when the stored
// value already equals `to` the operation counts as done (a retried request is harmless). Anything
// else is a conflict: the stored value is kept and returned, so the editor can offer both versions.

import { normalizeSheetSettings, safeSheetLink, validRasterData } from './workbook-settings.mjs';

export const LIMITS = Object.freeze({
  sheets: 30, rows: 5000, columns: 52, cellLength: 5000, nameLength: 60,
  bytes: 2 * 1024 * 1024, batch: 5000, frozen: 10, width: [24, 800]
});
export const DEFAULT_SIZE = Object.freeze({ rows: 1000, columns: 26 });
export const LINKED_SHEET_NAME = 'Form Responses';
export const FORMAT_NUMBERS = ['auto', 'number', 'percent', 'currency', 'plain', 'date', 'time', 'datetime', 'duration', 'scientific', 'accounting'];
export const ROW_HEIGHT = [20, 240];
export const FORMAT_ALIGN = ['left', 'center', 'right'];
export const FORMAT_FONTS = ['sans-serif', 'serif', 'monospace', 'Arial', 'Calibri', 'Roboto', 'Georgia', 'Verdana', 'Times New Roman', 'Courier New'];
export const CELL_NOTE_LIMIT = 1000;
export const VALIDATION_NUMBER = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?\s*$/i;

const SHEET_ID = /^[a-f0-9]{32}$/;
const COLOR = /^#[0-9a-f]{6}$/i;
const PROP_KEY = /^(?:rows|columns|frozen|frozenColumns|names|merges|reports|settings|width\.[A-Z]{1,2}|height\.[1-9][0-9]{0,3})$/;

export function columnLabel(index) {
  let label = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) label = String.fromCharCode(65 + (n - 1) % 26) + label;
  return label;
}

export function columnIndex(label) {
  let index = 0;
  for (const character of label.toUpperCase()) index = index * 26 + character.charCodeAt(0) - 64;
  return index - 1;
}

export const cellAddress = (row, column) => columnLabel(column) + (row + 1);

/** Parses "B12" into zero-based { row, column }; null when malformed or outside the sheet limits. */
export function parseAddress(address) {
  const match = /^([A-Z]{1,2})([1-9][0-9]{0,4})$/.exec(address);
  if (!match) return null;
  const column = columnIndex(match[1]);
  const row = Number(match[2]) - 1;
  return column < LIMITS.columns && row < LIMITS.rows ? { row, column } : null;
}

export const equal = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export function normalizeNames(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 100) return undefined;
  const result = new Map();
  for (const [name, value] of Object.entries(input)) {
    const key = name.toUpperCase();
    if (!/^[A-Z_][A-Z0-9_]{0,39}$/.test(key) || /^[A-Z]{1,3}\d+$/.test(key) || ['TRUE', 'FALSE'].includes(key) || result.has(key) || typeof value !== 'string') return undefined;
    const range = value.toUpperCase().replaceAll('$', '');
    const addresses = range.split(':');
    if (range !== '#REF!' && (addresses.length > 2 || addresses.some(address => !parseAddress(address)))) return undefined;
    result.set(key, range);
  }
  return Object.fromEntries([...result].sort(([a], [b]) => a.localeCompare(b)));
}

function validationRule(value) {
  if (!value || typeof value !== 'object') return undefined;
  if (value.kind === 'checkbox') return { kind: 'checkbox' };
  if (value.kind === 'list' && Array.isArray(value.options) && value.options.length >= 1 && value.options.length <= 30
      && value.options.every(option => typeof option === 'string' && option.trim() === option && option.length >= 1 && option.length <= 120 && !option.startsWith('='))) {
    return { kind: 'list', options: [...new Set(value.options)] };
  }
  if (value.kind === 'number' && Number.isFinite(value.min) && Number.isFinite(value.max) && value.min <= value.max) return { kind: 'number', min: value.min, max: value.max };
  return undefined;
}

export function validationMessage(rule, raw) {
  if (!rule || raw == null || raw === '') return '';
  const value = raw.startsWith("'") ? raw.slice(1) : raw;
  if (rule.kind === 'list') return rule.options.includes(value) ? '' : 'Choose one of the dropdown options.';
  if (rule.kind === 'checkbox') return /^(true|false)$/i.test(raw) ? '' : 'Enter TRUE or FALSE for the checkbox.';
  const number = Number(raw);
  return VALIDATION_NUMBER.test(raw) && Number.isFinite(number) && number >= rule.min && number <= rule.max ? '' : `Enter a number between ${rule.min} and ${rule.max}.`;
}

/** A cell format, normalized; null for "no formatting"; undefined when invalid. */
export function normalizeFormat(format) {
  if (format == null) return null;
  if (typeof format !== 'object' || Array.isArray(format)) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(format)) {
    if (['b', 'i', 'u', 's', 'wrap', 'overflow', 'vertical'].includes(key)) { if (value !== true) return undefined; out[key] = true; }
    else if (key === 'align') { if (!FORMAT_ALIGN.includes(value)) return undefined; out.align = value; }
    else if (key === 'valign') { if (!['top', 'middle', 'bottom'].includes(value)) return undefined; out.valign = value; }
    else if (key === 'rotation') { if (!Number.isInteger(value) || value < -90 || value > 90) return undefined; out.rotation = value; }
    else if (key === 'link') { if (!safeSheetLink(value)) return undefined; out.link = value; }
    else if (key === 'image') { if (!validRasterData(value)) return undefined; out.image = value; }
    else if (key === 'imageAlt') { if (typeof value !== 'string' || value.length > 300) return undefined; out.imageAlt = value; }
    else if (key === 'currency') { if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) return undefined; try { new Intl.NumberFormat('en', { style: 'currency', currency: value }).format(1); } catch { return undefined; } out.currency = value; }
    else if (key === 'pattern') { if (typeof value !== 'string' || value.length > 100 || !/^[0#.,%€₹$£¥() +\-;dmMyYhHsSaAtT:/\\\\"'\[\]]+$/.test(value)) return undefined; out.pattern = value; }
    else if (key === 'color' || key === 'fill') { if (typeof value !== 'string' || !COLOR.test(value)) return undefined; out[key] = value.toLowerCase(); }
    else if (key === 'num') { if (!FORMAT_NUMBERS.includes(value)) return undefined; if (value !== 'auto') out.num = value; }
    else if (key === 'dp') { if (!Number.isInteger(value) || value < 0 || value > 10) return undefined; out.dp = value; }
    else if (key === 'font') { if (!FORMAT_FONTS.includes(value)) return undefined; out.font = value; }
    else if (key === 'size') { if (!Number.isInteger(value) || value < 6 || value > 96) return undefined; out.size = value; }
    else if (key === 'border') { if (typeof value !== 'string' || !/^(?=.+)t?r?b?l?$/.test(value)) return undefined; out.border = value; }
    else if (key === 'note') { if (typeof value !== 'string' || value.length > CELL_NOTE_LIMIT) return undefined; if (value.trim()) out.note = value; }
    else if (key === 'validation') { const rule = validationRule(value); if (!rule) return undefined; out.validation = rule; }
    else if (key === 'condition') {
      if (!value || !['gt', 'lt', 'eq', 'gte', 'lte'].includes(value.op) || !Number.isFinite(value.value) || typeof value.fill !== 'string' || !COLOR.test(value.fill)) return undefined;
      out.condition = { op: value.op, value: value.value, fill: value.fill.toLowerCase() };
    }
    else return undefined;
  }
  return Object.keys(out).length ? Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b))) : null;
}

export function blankSheet(id, name, size = DEFAULT_SIZE) {
  return { id, name, cells: {}, formats: {}, rows: size.rows, columns: size.columns, widths: {}, heights: {}, frozen: 0, frozenColumns: 0, names: {}, merges: [], reports: [], settings: {} };
}

const bounded = (value, min, max, fallback) => Number.isInteger(value) && value >= min && value <= max ? value : fallback;

export const rangesOverlap = (a, b) => a.r1 <= b.r2 && b.r1 <= a.r2 && a.c1 <= b.c2 && b.c1 <= a.c2;
export function normalizeMerges(input) {
  if (!Array.isArray(input) || input.length > 100) return;
  const merges = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') return;
    const { r1, c1, r2, c2 } = item;
    if (![r1, c1, r2, c2].every(Number.isInteger) || r1 < 0 || c1 < 0 || r2 < r1 || c2 < c1
        || r2 >= LIMITS.rows || c2 >= LIMITS.columns || (r1 === r2 && c1 === c2)) return;
    const range = { r1, c1, r2, c2 };
    if (merges.some(other => rangesOverlap(range, other))) return;
    merges.push(range);
  }
  return merges.sort((a, b) => a.r1 - b.r1 || a.c1 - b.c1);
}

export function normalizeReports(input) {
  if (!Array.isArray(input) || input.length > 20) return;
  const ids = new Set();
  const reports = [];
  for (const report of input) {
    if (!report || typeof report !== 'object') return;
    const { id, source, title, r1, c1, r2, c2, header, type, follow, group, split, value, aggregate } = report;
    if (typeof id !== 'string' || !SHEET_ID.test(id) || ids.has(id) || typeof source !== 'string' ||
        !(source === 'responses' || SHEET_ID.test(source) || /^response-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(source)) ||
        typeof title !== 'string' || !title.trim() || title.length > 100 || typeof header !== 'boolean' || typeof follow !== 'boolean' ||
        ![r1, c1, r2, c2].every(Number.isInteger) || r1 < 0 || c1 < 0 || r2 < r1 || c2 < c1 || r2 >= LIMITS.rows || c2 >= LIMITS.columns) return;
    const chart = ['column', 'line', 'pie'].includes(type);
    if (chart ? (r2 - r1 > 99 || c2 - c1 > 8) : type !== 'pivot' || !['sum', 'count', 'average'].includes(aggregate) ||
        ![group, value].every(col => Number.isInteger(col) && col >= c1 && col <= c2) ||
        (split !== null && (!Number.isInteger(split) || split < c1 || split > c2 || split === group))) return;
    ids.add(id);
    reports.push({ id, source, title: title.trim(), r1, c1, r2, c2, header, type, follow,
      ...(chart ? {} : { group, split, value, aggregate }) });
  }
  return reports;
}

export function mergeAt(sheet, r, c) {
  return sheet?.merges?.find(item => item.r1 <= r && r <= item.r2 && item.c1 <= c && c <= item.c2);
}

export function coveredByMerge(sheet, address) {
  if (!sheet.merges?.length) return false;
  const point = parseAddress(address);
  if (!point) return false;
  const { row, column } = point;
  const merge = mergeAt(sheet, row, column);
  return Boolean(merge && (merge.r1 !== row || merge.c1 !== column));
}

export function mergeProblem(sheet) {
  for (const { r1, c1, r2, c2 } of sheet.merges ?? []) {
    if (r2 >= sheet.rows || c2 >= sheet.columns) return 'The merged cells must fit inside the sheet.';
    if ((r1 < sheet.frozen && r2 >= sheet.frozen) || (c1 < sheet.frozenColumns && c2 >= sheet.frozenColumns)) return 'A merged range cannot cross a frozen row or column boundary.';
  }
  if (sheet.merges?.length && Object.keys(sheet.cells).some(address => coveredByMerge(sheet, address))) return 'Only the top-left cell in a merged range can contain a value.';
  return '';
}

/**
 * Validates a stored or submitted sheet and fills defaults, so prototype workbooks (cells only,
 * 12 × 50) keep working. Throws an Error whose message is safe to show.
 */
export function normalizeSheet(sheet) {
  if (!sheet || typeof sheet !== 'object') throw new Error('Invalid sheet.');
  const name = typeof sheet.name === 'string' ? sheet.name.trim() : '';
  if (typeof sheet.id !== 'string' || !SHEET_ID.test(sheet.id)) throw new Error('Invalid sheet id.');
  if (!name || name.length > LIMITS.nameLength || /[\u0000-\u001f]/.test(name)) throw new Error('Sheet names need 1 to 60 visible characters.');
  if (!sheet.cells || typeof sheet.cells !== 'object' || Array.isArray(sheet.cells)) throw new Error('Invalid sheet cells.');
  const cells = {};
  for (const [address, value] of Object.entries(sheet.cells)) {
    if (!parseAddress(address) || typeof value !== 'string' || value.length > LIMITS.cellLength) throw new Error('Invalid cell address or value.');
    if (value !== '') cells[address] = value;
  }
  const formats = {};
  for (const [address, value] of Object.entries(sheet.formats ?? {})) {
    const format = normalizeFormat(value);
    if (!parseAddress(address) || format === undefined) throw new Error('Invalid cell format.');
    if (format) formats[address] = format;
  }
  const widths = {};
  for (const [column, width] of Object.entries(sheet.widths ?? {})) {
    if (!/^[A-Z]{1,2}$/.test(column) || columnIndex(column) >= LIMITS.columns || !Number.isInteger(width) || width < LIMITS.width[0] || width > LIMITS.width[1]) throw new Error('Invalid column width.');
    widths[column] = width;
  }
  const heights = {};
  const names = normalizeNames(sheet.names ?? {});
  if (!names) throw new Error('Invalid named ranges.');
  for (const [row, height] of Object.entries(sheet.heights ?? {})) {
    if (!/^[1-9][0-9]{0,3}$/.test(row) || Number(row) > LIMITS.rows || !Number.isInteger(height) || height < ROW_HEIGHT[0] || height > ROW_HEIGHT[1]) throw new Error('Invalid row height.');
    heights[row] = height;
  }
  const merges = normalizeMerges(sheet.merges ?? []);
  if (!merges) throw new Error('Invalid merged ranges.');
  const reports = normalizeReports(sheet.reports ?? []);
  if (!reports) throw new Error('Invalid saved charts or pivot tables.');
  const settings = normalizeSheetSettings(sheet.settings ?? {});
  if (!settings) throw new Error('Invalid sheet settings.');
  const normalized = {
    id: sheet.id, name, cells, formats, settings,
    rows: bounded(sheet.rows, 1, LIMITS.rows, DEFAULT_SIZE.rows),
    columns: bounded(sheet.columns, 1, LIMITS.columns, DEFAULT_SIZE.columns),
    widths, heights, frozen: bounded(sheet.frozen, 0, LIMITS.frozen, 0), frozenColumns: bounded(sheet.frozenColumns, 0, LIMITS.frozen, 0), names, merges, reports
  };
  const problem = mergeProblem(normalized);
  if (problem) throw new Error(problem);
  return normalized;
}

const reservedName = name => name.toLowerCase() === LINKED_SHEET_NAME.toLowerCase();
const nameTaken = (sheets, name, exceptId) => reservedName(name) || sheets.some(sheet => sheet.id !== exceptId && sheet.name.toLowerCase() === name.toLowerCase());

/** True when an operation is well formed. The server rejects a batch holding any malformed one. */
export function validOp(op) {
  if (!op || typeof op !== 'object') return false;
  const sheetId = typeof op.sheet === 'string' && SHEET_ID.test(op.sheet);
  const text = value => value === null || (typeof value === 'string' && value.length <= LIMITS.cellLength);
  switch (op.op) {
    case 'group': return Array.isArray(op.ops) && op.ops.length > 0 && op.ops.length <= LIMITS.batch
      && op.ops.every(item => ['cell', 'format', 'sheet-prop'].includes(item?.op) && validOp(item));
    case 'cell': return sheetId && Boolean(parseAddress(op.cell)) && text(op.from) && text(op.to);
    case 'format': return sheetId && Boolean(parseAddress(op.cell)) && normalizeFormat(op.from) !== undefined && normalizeFormat(op.to) !== undefined;
    case 'sheet-add': try { normalizeSheet(op.sheet); return op.index == null || Number.isInteger(op.index); } catch { return false; }
    case 'sheet-delete': return sheetId;
    case 'sheet-name': return sheetId && typeof op.to === 'string' && op.to.trim().length > 0 && op.to.trim().length <= LIMITS.nameLength && (op.from === null || typeof op.from === 'string');
    case 'sheet-move': return sheetId && Number.isInteger(op.to) && op.to >= 0;
    case 'sheet-prop': {
      if (!sheetId || !PROP_KEY.test(op.key ?? '')) return false;
      if (op.key === 'settings') return normalizeSheetSettings(op.from) !== undefined && normalizeSheetSettings(op.to) !== undefined;
      if (op.key === 'names') return normalizeNames(op.from) !== undefined && normalizeNames(op.to) !== undefined;
      if (op.key === 'merges') return Boolean(normalizeMerges(op.from) && normalizeMerges(op.to));
      if (op.key === 'reports') return Boolean(normalizeReports(op.from) && normalizeReports(op.to));
      const ok = value => value === null || Number.isInteger(value);
      if (!ok(op.from) || !ok(op.to)) return false;
      if (op.key === 'rows') return op.to >= 1 && op.to <= LIMITS.rows;
      if (op.key === 'columns') return op.to >= 1 && op.to <= LIMITS.columns;
      if (op.key === 'frozen' || op.key === 'frozenColumns') return op.to >= 0 && op.to <= LIMITS.frozen;
      if (op.key.startsWith('height.')) return Number(op.key.slice(7)) <= LIMITS.rows && (op.to === null || (op.to >= ROW_HEIGHT[0] && op.to <= ROW_HEIGHT[1]));
      return op.to === null || (op.to >= LIMITS.width[0] && op.to <= LIMITS.width[1] && columnIndex(op.key.slice(6)) < LIMITS.columns);
    }
    default: return false;
  }
}

const readProp = (sheet, key) => key.startsWith('width.') ? sheet.widths[key.slice(6)] ?? null
  : key.startsWith('height.') ? sheet.heights?.[key.slice(7)] ?? null : sheet[key] ?? (['merges', 'reports'].includes(key) ? [] : key === 'settings' ? {} : null);

/**
 * Applies one operation to `sheets` in place. Returns 'applied', 'noop' (already true) or
 * 'conflict' (something else is stored; nothing changed). With { force: true } the operation is
 * written whatever is stored: the browser uses it to show its unsynced edits on top of the
 * workspace version.
 */
export function applyOp(sheets, op, { force = false, validate = true } = {}) {
  if (op.op === 'group') {
    const draft = structuredClone(sheets);
    let changed = false;
    for (const item of op.ops) {
      if (!draft.some(sheet => sheet.id === item.sheet)) return 'conflict';
      const outcome = applyOp(draft, item, { force, validate: false });
      if (outcome === 'conflict') return 'conflict';
      changed ||= outcome === 'applied';
    }
    for (const item of op.ops) if (item.op === 'cell') {
      const sheet = draft.find(sheet => sheet.id === item.sheet);
      if (validationMessage(sheet.formats[item.cell]?.validation, sheet.cells[item.cell])) return 'conflict';
    }
    if (draft.some(mergeProblem)) return 'conflict';
    if (!changed) return 'noop';
    sheets.splice(0, sheets.length, ...draft);
    return 'applied';
  }
  const index = sheets.findIndex(sheet => sheet.id === (op.op === 'sheet-add' ? op.sheet.id : op.sheet));
  const sheet = sheets[index];
  const check = (current, write) => {
    if (equal(current, op.to)) return 'noop';
    if (!force && !equal(current, op.from)) return 'conflict';
    write();
    return 'applied';
  };
  switch (op.op) {
    case 'cell':
      if (!sheet) return force ? 'noop' : 'conflict';
      if (validate && (validationMessage(sheet.formats[op.cell]?.validation, op.to) || (op.to && coveredByMerge(sheet, op.cell)))) return 'conflict';
      return check(sheet.cells[op.cell] ?? null, () => { if (op.to) sheet.cells[op.cell] = op.to; else delete sheet.cells[op.cell]; });
    case 'format': {
      if (!sheet) return force ? 'noop' : 'conflict';
      const to = normalizeFormat(op.to);
      return check(sheet.formats[op.cell] ?? null, () => { if (to) sheet.formats[op.cell] = to; else delete sheet.formats[op.cell]; });
    }
    case 'sheet-add': {
      const added = normalizeSheet(op.sheet);
      // Sheet ids are random, so an existing id is this same sheet: a retried add, perhaps already edited.
      if (sheet) return 'noop';
      if (!force && (sheets.length >= LIMITS.sheets || nameTaken(sheets, added.name))) return 'conflict';
      if (!force && sheets.some(sheet => Object.keys(added.names).some(name => Object.hasOwn(sheet.names ?? {}, name)))) return 'conflict';
      sheets.splice(Math.min(Math.max(op.index ?? sheets.length, 0), sheets.length), 0, structuredClone(added));
      return 'applied';
    }
    case 'sheet-delete':
      if (!sheet) return 'noop';
      sheets.splice(index, 1);
      return 'applied';
    case 'sheet-name': {
      if (!sheet) return force ? 'noop' : 'conflict';
      const to = op.to.trim();
      if (sheet.name === to) return 'noop';
      if (!force && (sheet.name !== op.from || nameTaken(sheets, to, sheet.id))) return 'conflict';
      sheet.name = to;
      return 'applied';
    }
    case 'sheet-move': {
      if (!sheet) return force ? 'noop' : 'conflict';
      const to = Math.min(op.to, sheets.length - 1);
      if (to === index) return 'noop';
      sheets.splice(index, 1);
      sheets.splice(to, 0, sheet);
      return 'applied';
    }
    case 'sheet-prop':
      if (!sheet) return force ? 'noop' : 'conflict';
      if (op.key === 'names') {
        const to = normalizeNames(op.to);
        if (!to || (!force && sheets.some(other => other.id !== sheet.id && Object.keys(to).some(name => Object.hasOwn(other.names ?? {}, name))))) return 'conflict';
        op = { ...op, from: normalizeNames(op.from), to };
      }
      if (op.key === 'merges') {
        const to = normalizeMerges(op.to);
        if (!to) return 'conflict';
        op = { ...op, from: normalizeMerges(op.from), to };
      }
      if (op.key === 'settings') {
        const to = normalizeSheetSettings(op.to);
        if (!to) return 'conflict';
        op = { ...op, from: normalizeSheetSettings(op.from), to };
      }
      if (op.key === 'reports') {
        const to = normalizeReports(op.to);
        if (!to) return 'conflict';
        op = { ...op, from: normalizeReports(op.from), to };
      }
      if (validate && ['merges', 'rows', 'columns', 'frozen', 'frozenColumns'].includes(op.key) && mergeProblem({ ...sheet, [op.key]: op.to })) return 'conflict';
      return check(readProp(sheet, op.key), () => {
        if (op.key.startsWith('width.')) { if (op.to == null) delete sheet.widths[op.key.slice(6)]; else sheet.widths[op.key.slice(6)] = op.to; }
        else if (op.key.startsWith('height.')) { const heights = sheet.heights ??= {}; if (op.to == null) delete heights[op.key.slice(7)]; else heights[op.key.slice(7)] = op.to; }
        else sheet[op.key] = op.to;
      });
    default:
      throw new Error('Unknown workbook operation.');
  }
}

/** The value an operation found, for conflict reports. */
export function currentFor(sheets, op) {
  if (op.op === 'group') return { grouped: true };
  const sheet = sheets.find(item => item.id === (op.op === 'sheet-add' ? op.sheet.id : op.sheet));
  if (!sheet) return { missing: true };
  if (op.op === 'cell') return { value: sheet.cells[op.cell] ?? null };
  if (op.op === 'format') return { value: sheet.formats[op.cell] ?? null };
  if (op.op === 'sheet-name') return { value: sheet.name };
  if (op.op === 'sheet-prop') return { value: readProp(sheet, op.key) };
  return { value: null };
}

const opKey = op => ['cell', 'format'].includes(op.op) ? `${op.op}:${op.sheet}:${op.cell}`
  : op.op === 'sheet-name' ? `name:${op.sheet}` : op.op === 'sheet-prop' ? `prop:${op.sheet}:${op.key}` : null;

/**
 * Collapses repeated edits of one cell, format, name or property into a single operation (first
 * `from`, last `to`) kept at the position of the first edit, and drops edits that end where they
 * started. Structural operations keep their order.
 */
export function coalesceOps(ops) {
  const out = [];
  const seen = new Map();
  for (const op of ops) {
    if (!opKey(op)) seen.clear();
    const key = opKey(op);
    if (key && seen.has(key)) { seen.get(key).to = op.to; continue; }
    const copy = { ...op };
    if (key) seen.set(key, copy);
    out.push(copy);
  }
  return out.filter(op => !opKey(op) || !equal(op.from, op.to));
}

/** The operation that undoes `op` (applied after it). */
export function invertOp(op, sheetsBefore) {
  switch (op.op) {
    case 'group': return { op: 'group', ops: op.ops.map(item => invertOp(item, sheetsBefore)).reverse() };
    case 'cell': case 'format': case 'sheet-prop': return { ...op, from: op.to, to: op.from };
    case 'sheet-name': return { ...op, from: op.to, to: op.from };
    case 'sheet-add': return { op: 'sheet-delete', sheet: op.sheet.id };
    case 'sheet-delete': {
      const index = sheetsBefore.findIndex(sheet => sheet.id === op.sheet);
      return index < 0 ? null : { op: 'sheet-add', sheet: structuredClone(sheetsBefore[index]), index };
    }
    case 'sheet-move': {
      const index = sheetsBefore.findIndex(sheet => sheet.id === op.sheet);
      return { op: 'sheet-move', sheet: op.sheet, to: Math.max(index, 0) };
    }
    default: return null;
  }
}

/** Operations that turn `before` into `after`; used to replay drafts kept by the prototype editor. */
export function diffWorkbooks(before, after) {
  const ops = [];
  const old = new Map(before.map(sheet => [sheet.id, sheet]));
  const kept = new Set(after.map(sheet => sheet.id));
  for (const sheet of before) if (!kept.has(sheet.id)) ops.push({ op: 'sheet-delete', sheet: sheet.id });
  after.forEach((sheet, index) => {
    const previous = old.get(sheet.id);
    if (!previous) return ops.push({ op: 'sheet-add', sheet: structuredClone(sheet), index });
    if (previous.name !== sheet.name) ops.push({ op: 'sheet-name', sheet: sheet.id, from: previous.name, to: sheet.name });
    for (const key of ['rows', 'columns', 'frozen', 'frozenColumns']) {
      if (sheet[key] !== undefined && previous[key] !== sheet[key]) ops.push({ op: 'sheet-prop', sheet: sheet.id, key, from: previous[key] ?? null, to: sheet[key] });
    }
    if (!equal(previous.settings ?? {}, sheet.settings ?? {})) ops.push({ op: 'sheet-prop', sheet: sheet.id, key: 'settings', from: previous.settings ?? {}, to: sheet.settings ?? {} });
    if (!equal(previous.names ?? {}, sheet.names ?? {})) ops.push({ op: 'sheet-prop', sheet: sheet.id, key: 'names', from: previous.names ?? {}, to: sheet.names ?? {} });
    if (!equal(previous.merges ?? [], sheet.merges ?? [])) ops.push({ op: 'sheet-prop', sheet: sheet.id, key: 'merges', from: previous.merges ?? [], to: sheet.merges ?? [] });
    if (!equal(previous.reports ?? [], sheet.reports ?? [])) ops.push({ op: 'sheet-prop', sheet: sheet.id, key: 'reports', from: previous.reports ?? [], to: sheet.reports ?? [] });
    for (const [property, key] of [['widths', 'width'], ['heights', 'height']]) for (const axis of new Set([...Object.keys(previous[property] ?? {}), ...Object.keys(sheet[property] ?? {})])) {
      const from = previous[property]?.[axis] ?? null;
      const to = sheet[property]?.[axis] ?? null;
      if (from !== to) ops.push({ op: 'sheet-prop', sheet: sheet.id, key: `${key}.${axis}`, from, to });
    }
    for (const kind of ['cells', 'formats']) {
      for (const cell of new Set([...Object.keys(previous[kind] ?? {}), ...Object.keys(sheet[kind] ?? {})])) {
        const from = previous[kind]?.[cell] ?? null;
        const to = sheet[kind]?.[cell] ?? null;
        if (!equal(from, to)) ops.push({ op: kind === 'cells' ? 'cell' : 'format', sheet: sheet.id, cell, from, to });
      }
    }
  });
  return ops;
}
