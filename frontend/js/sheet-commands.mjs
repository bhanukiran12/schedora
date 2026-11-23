import { cellAddress, LIMITS, parseAddress } from '../shared/workbook-ops.mjs';
import { retargetMovedReferences, shiftFormula } from './sheet-formulas.mjs';

const contains = (range, row, column) => row >= range.r1 && row <= range.r2 && column >= range.c1 && column <= range.c2;
const put = (map, address, value) => { if (value == null || value === '') delete map[address]; else map[address] = value; };

export function moveWorkbookRange(sheets, sourceId, destinationId, range, row, column) {
  const source = sheets.find(sheet => sheet.id === sourceId);
  const destination = sheets.find(sheet => sheet.id === destinationId);
  const dr = row - range.r1;
  const dc = column - range.c1;
  const target = { r1: row, c1: column, r2: range.r2 + dr, c2: range.c2 + dc };
  if (!source || !destination || row < 0 || column < 0 || target.r2 >= LIMITS.rows || target.c2 >= LIMITS.columns) return false;
  if (source === destination && !dr && !dc) return false;

  for (const key of ['cells', 'formats']) {
    const values = [];
    for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) {
      const address = cellAddress(r, c);
      values.push([cellAddress(r + dr, c + dc), source[key][address]]);
      delete source[key][address];
    }
    for (const [address, value] of values) put(destination[key], address, value);
  }
  destination.rows = Math.max(destination.rows, target.r2 + 1);
  destination.columns = Math.max(destination.columns, target.c2 + 1);
  const movement = { ...range, source: source.name, destination: destination.name, dr, dc };
  for (const sheet of sheets) for (const [address, formula] of Object.entries(sheet.cells)) {
    if (!formula.startsWith('=')) continue;
    const point = parseAddress(address);
    const oldHome = sheet === destination && contains(target, point.row, point.column) ? source.name : sheet.name;
    sheet.cells[address] = retargetMovedReferences(formula, oldHome, sheet.name, movement);
  }
  return true;
}

const dateShape = /^\d{4}-\d{2}-\d{2}$/;
const integerSuffix = /^(.*?)(\d+)$/;
const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const modulo = (value, length) => ((value % length) + length) % length;

function progression(values, defaultStep = 0) {
  const step = values.length > 1 ? values[1] - values[0] : defaultStep;
  return values.every((value, index) => Math.abs(value - (values[0] + step * index)) <= Number.EPSILON * 16 * Math.max(1, Math.abs(value)))
    ? index => values[0] + step * index : null;
}

export function fillSeries(values) {
  if (!values.length) return null;
  const numeric = values.map(value => /^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(value ?? '') ? Number(value) : NaN);
  if (numeric.every(Number.isFinite)) {
    const next = progression(numeric);
    if (next) return index => String(Number(next(index).toPrecision(15)));
  }
  if (values.every(value => dateShape.test(value ?? '') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value)) {
    const day = 86400000;
    const next = progression(values.map(value => Date.parse(value) / day), 1);
    if (next) return index => {
      const date = new Date(next(index) * day);
      return date.getUTCFullYear() >= 0 && date.getUTCFullYear() <= 9999 ? date.toISOString().slice(0, 10) : values[modulo(index, values.length)];
    };
  }
  for (const words of [weekdays, weekdays.map(word => word.slice(0, 3)), months, months.map(word => word.slice(0, 3))]) {
    const terms = words.map(word => word.toLowerCase());
    const start = terms.indexOf(values[0]?.toLowerCase());
    if (start < 0 || !values.every((value, index) => value?.toLowerCase() === terms[(start + index) % terms.length])) continue;
    return index => {
      const word = words[modulo(start + index, words.length)];
      return values[0] === values[0].toLowerCase() ? word.toLowerCase() : values[0] === values[0].toUpperCase() ? word.toUpperCase() : word;
    };
  }
  const suffixes = values.map(value => integerSuffix.exec(value ?? ''));
  if (suffixes.every(match => match && match[1] && match[1] === suffixes[0][1])) {
    const next = progression(suffixes.map(match => Number(match[2])), 1);
    const width = Math.min(...suffixes.map(match => match[2].length));
    if (next) return index => {
      const value = next(index);
      return suffixes[0][1] + (value < 0 ? '-' : '') + String(Math.abs(value)).padStart(width, '0');
    };
  }
  return null;
}

export function extendFill(sheet, source, target, axis) {
  const vertical = axis === 'row';
  const start = vertical ? source.r1 : source.c1;
  const count = (vertical ? source.r2 : source.c2) - start + 1;
  const tracks = new Map();
  for (let r = target.r1; r <= target.r2; r++) for (let c = target.c1; c <= target.c2; c++) {
    if (contains(source, r, c)) continue;
    const track = vertical ? c : r;
    if (!tracks.has(track)) {
      const values = Array.from({ length: count }, (_, index) => sheet.cells[cellAddress(vertical ? start + index : r, vertical ? c : start + index)]);
      tracks.set(track, fillSeries(values));
    }
    const offset = (vertical ? r : c) - start;
    const seed = start + modulo(offset, count);
    const sr = vertical ? seed : r;
    const sc = vertical ? c : seed;
    const address = cellAddress(r, c);
    const origin = cellAddress(sr, sc);
    const raw = sheet.cells[origin];
    const series = tracks.get(track);
    const value = series ? series(offset) : raw?.startsWith('=') ? shiftFormula(raw, r - sr, c - sc) : raw;
    put(sheet.cells, address, value);
    put(sheet.formats, address, sheet.formats[origin]);
  }
}
