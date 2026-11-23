// Schedora Sheets import and export: CSV, TSV and XLSX (Office Open XML) without dependencies.
// XLSX uses the platform's CompressionStream / DecompressionStream for deflate, so it runs in
// browsers and in Node tests alike.
import { LIMITS, ROW_HEIGHT, cellAddress, columnIndex, columnLabel, normalizeFormat, normalizeMerges, parseAddress } from '../shared/workbook-ops.mjs';
import { readXlsxStyles, xlsxStyles } from './sheet-xlsx-styles.mjs';

/** Parses delimited text (RFC 4180 quoting) into rows of strings. */
export function parseDelimited(text, delimiter = text.includes('\t') && !text.includes(',') ? '\t' : ',') {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let index = 0;
  const source = text.replace(/^﻿/, '');
  while (index < source.length) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { field += '"'; index += 2; continue; }
      if (character === '"') { quoted = false; index++; continue; }
      field += character;
      index++;
      continue;
    }
    if (character === '"' && field === '') { quoted = true; index++; continue; }
    if (character === delimiter) { row.push(field); field = ''; index++; continue; }
    if (character === '\r' || character === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += character === '\r' && source[index + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += character;
    index++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Clipboard text from other spreadsheets: tab separated, quoted only when a cell holds a newline. */
export const parseClipboard = text => parseDelimited(text.replace(/\r?\n$/, ''), '\t');

export function clipboardTable(rows, escape) {
  return '<table><tbody>' + rows.map(row => '<tr>' + row.map(({ value, format }) => {
    const styles = [
      format?.b && 'font-weight:bold', format?.i && 'font-style:italic',
      format?.u && 'text-decoration:underline', format?.color && 'color:' + format.color,
      format?.fill && 'background-color:' + format.fill, format?.align && 'text-align:' + format.align
    ].filter(Boolean).join(';');
    return `<td${styles ? ` style="${escape(styles)}"` : ''}>${escape(value).replace(/\r?\n/g, '<br>')}</td>`;
  }).join('') + '</tr>').join('') + '</tbody></table>';
}

export function parseClipboardTable(markup) {
  if (!markup || markup.length > 4 * 1024 * 1024) return null;
  // A template keeps external markup inert. Only plain text and allowlisted format properties leave it.
  const template = document.createElement('template');
  const tag = /<[a-z][\w:-]*(?:"[^"]*"|'[^']*'|[^"'<>])*>/gi;
  const attribute = /("[^"]*"|'[^']*')|(\s)style(?=\s*=)/gi;
  template.innerHTML = markup.replace(tag, element => element.replace(attribute, (part, quoted, space) => quoted ? part : space + 'data-clipboard-style'));
  const table = template.content.querySelector('table');
  if (!table || table.rows.length > LIMITS.rows) return null;
  const color = input => {
    const match = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(input);
    return match ? '#' + match.slice(1).map(component => Number(component).toString(16).padStart(2, '0')).join('') : null;
  };
  const text = node => {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1 || ['SCRIPT', 'STYLE', 'TABLE', 'TEMPLATE'].includes(node.tagName)) return '';
    return node.tagName === 'BR' ? '\n' : Array.from(node.childNodes, text).join('');
  };
  return Array.from(table.rows, row => Array.from(row.cells).slice(0, LIMITS.columns).map(cell => {
    const format = {};
    const style = document.createElement('span').style;
    const allowed = new Set(['font-weight', 'font-style', 'text-decoration', 'background-color', 'text-align', 'color']);
    for (const property of (cell.getAttribute('data-clipboard-style') ?? '').split(';')) {
      const [, name, value] = /^\s*([a-z-]+)\s*:\s*(.*?)\s*$/i.exec(property) ?? [];
      if (name && allowed.has(name.toLowerCase())) style.setProperty(name.toLowerCase(), value);
    }
    const { fontWeight, fontStyle, textDecoration, backgroundColor, textAlign } = style;
    if (fontWeight === 'bold' || Number(fontWeight) >= 600 || cell.querySelector('b,strong')) format.b = true;
    if (fontStyle === 'italic' || cell.querySelector('i,em')) format.i = true;
    if (textDecoration.includes('underline') || cell.querySelector('u')) format.u = true;
    if (['left', 'center', 'right'].includes(textAlign)) format.align = textAlign;
    const ink = color(style.color);
    const fill = color(backgroundColor);
    if (ink) format.color = ink;
    if (fill) format.fill = fill;
    const raw = text(cell);
    return { value: /^[=']/.test(raw) ? "'" + raw : raw, format: normalizeFormat(format) };
  }));
}

const needsQuotes = (value, delimiter) => value.includes(delimiter) || /["\r\n]/.test(value);
/**
 * Writes rows as CSV or TSV. Text that a spreadsheet would run as a formula (= + - @ at the start)
 * is prefixed with an apostrophe, the same protection as the Forms CSV export. Numbers are written
 * as numbers.
 */
export function toDelimited(rows, delimiter = ',') {
  return rows.map(row => row.map(cell => {
    let value = typeof cell === 'number' ? String(cell) : String(cell ?? '');
    if (typeof cell !== 'number' && /^[=+\-@\t\r]/.test(value)) value = "'" + value;
    return delimiter === '\t' && !/[\r\n"]/.test(value) ? value : needsQuotes(value, delimiter) || delimiter === ',' ? '"' + value.replace(/"/g, '""') + '"' : value;
  }).join(delimiter)).join('\r\n') + '\r\n';
}

/** Turns parsed rows into sheet cells starting at A1, within the sheet limits. */
export function rowsToCells(rows) {
  const cells = {};
  rows.slice(0, LIMITS.rows).forEach((row, r) => row.slice(0, LIMITS.columns).forEach((value, c) => {
    if (value !== '') cells[cellAddress(r, c)] = value.slice(0, LIMITS.cellLength);
  }));
  return { cells, rows: Math.min(rows.length, LIMITS.rows), columns: Math.min(Math.max(0, ...rows.map(row => row.length)), LIMITS.columns) };
}

// ---- ZIP (stored entries for writing; stored or deflated for reading) ----------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
const encoder = new TextEncoder();

function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = typeof content === 'string' ? encoder.encode(content) : content;
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true); entry.setUint16(4, 20, true); entry.setUint16(6, 20, true); entry.setUint16(8, 0x0800, true);
    entry.setUint32(16, crc, true); entry.setUint32(20, data.length, true); entry.setUint32(24, data.length, true);
    entry.setUint16(28, nameBytes.length, true); entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const size = central.reduce((total, part) => total + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

const XLSX_EXPANDED_LIMIT = 32 * 1024 * 1024;

async function inflate(bytes, expectedSize) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const output = new Uint8Array(expectedSize);
  let offset = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.length > expectedSize) {
        await reader.cancel();
        throw new Error('Invalid XLSX entry size.');
      }
      output.set(value, offset);
      offset += value.length;
    }
    if (offset !== expectedSize) throw new Error('Invalid XLSX entry size.');
    return output;
  } finally {
    reader.releaseLock();
  }
}

async function unzip(buffer) {
  const view = new DataView(buffer);
  let end = buffer.byteLength - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error('This file is not an XLSX workbook.');
  const count = view.getUint16(end + 10, true);
  if (count > 1024) throw new Error('This XLSX workbook contains too many parts.');
  let pointer = view.getUint32(end + 16, true);
  let expanded = 0;
  const files = new Map();
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index++) {
    if (view.getUint32(pointer, true) !== 0x02014b50) throw new Error('The XLSX file is damaged.');
    const method = view.getUint16(pointer + 10, true);
    const compressed = view.getUint32(pointer + 20, true);
    const size = view.getUint32(pointer + 24, true);
    expanded += size;
    if (expanded > XLSX_EXPANDED_LIMIT) throw new Error('This XLSX workbook expands beyond 32 MB.');
    const nameLength = view.getUint16(pointer + 28, true);
    const extra = view.getUint16(pointer + 30, true);
    const comment = view.getUint16(pointer + 32, true);
    const local = view.getUint32(pointer + 42, true);
    const name = decoder.decode(new Uint8Array(buffer, pointer + 46, nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = new Uint8Array(buffer, start, compressed);
    if (method === 0 && compressed === size) files.set(name, data);
    else if (method === 8) files.set(name, () => inflate(data, size));
    pointer += 46 + nameLength + extra + comment;
  }
  return {
    async text(name) {
      const entry = files.get(name);
      if (!entry) return null;
      return decoder.decode(typeof entry === 'function' ? await entry() : entry);
    }
  };
}

// ---- XLSX ---------------------------------------------------------------------------------------
const xml = value => String(value).replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const safeSheetName = (name, used) => {
  let base = name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31).trim() || 'Sheet';
  let candidate = base;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = base.slice(0, 28) + ' ' + n;
  used.add(candidate.toLowerCase());
  return candidate;
};

/**
 * Builds an .xlsx Blob. `sheets` is [{ name, rows: [[{ value, formula? }]] }] where value is the
 * computed value (number, string or boolean). Formulas are written with their computed value so the
 * file opens with results before the other application recalculates.
 */
export function writeXlsx(sheets) {
  const used = new Set();
  const names = sheets.map(sheet => safeSheetName(sheet.name, used));
  const styles = xlsxStyles(sheets);
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((name, index) => `<sheet name="${xml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', styles.document]
  ];
  sheets.forEach((sheet, index) => {
    const rows = sheet.rows.map((row, r) => {
      const cells = row.map((cell, c) => {
        if (!cell) return '';
        const ref = cellAddress(r, c);
        const styleId = styles.id(cell);
        const style = styleId ? ` s="${styleId}"` : '';
        if (cell.value === '' && !cell.formula) return style ? `<c r="${ref}"${style}/>` : '';
        const formula = cell.formula ? `<f>${xml(cell.formula.slice(1))}</f>` : '';
        if (typeof cell.value === 'number' && Number.isFinite(cell.value)) return `<c r="${ref}"${style}>${formula}<v>${cell.value}</v></c>`;
        if (typeof cell.value === 'boolean') return `<c r="${ref}" t="b"${style}>${formula}<v>${cell.value ? 1 : 0}</v></c>`;
        if (formula) return `<c r="${ref}" t="str"${style}>${formula}<v>${xml(cell.value)}</v></c>`;
        return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(cell.value)}</t></is></c>`;
      }).join('');
      const height = sheet.heights?.[r + 1];
      return cells || height ? `<row r="${r + 1}"${height ? ` ht="${height * 0.75}" customHeight="1"` : ''}>${cells}</row>` : '';
    }).join('');
    const frozen = sheet.frozen ?? 0;
    const frozenColumns = sheet.frozenColumns ?? 0;
    const split = `${frozenColumns ? ` xSplit="${frozenColumns}"` : ''}${frozen ? ` ySplit="${frozen}"` : ''}`;
    const pane = frozen ? (frozenColumns ? 'bottomRight' : 'bottomLeft') : 'topRight';
    const views = split ? `<sheetViews><sheetView workbookViewId="0"><pane${split} topLeftCell="${cellAddress(frozen, frozenColumns)}" activePane="${pane}" state="frozen"/></sheetView></sheetViews>` : '';
    const widths = Object.entries(sheet.widths ?? {}).map(([col, width]) => {
      const position = columnIndex(col) + 1;
      return `<col min="${position}" max="${position}" width="${Math.max(1, (width - 5) / 7).toFixed(2)}" customWidth="1"/>`;
    }).join('');
    const merges = sheet.merges ?? [];
    const mergeXml = merges.length ? `<mergeCells count="${merges.length}">${merges.map(({ r1, c1, r2, c2 }) => `<mergeCell ref="${cellAddress(r1, c1)}:${cellAddress(r2, c2)}"/>`).join('')}</mergeCells>` : '';
    files.push([`xl/worksheets/sheet${index + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${views}${widths ? `<cols>${widths}</cols>` : ''}<sheetData>${rows}</sheetData>${mergeXml}</worksheet>`]);
  });
  return zip(files);
}

const attribute = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
const unxml = value => value.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi, (_, name, decimal, hex) => decimal ? String.fromCodePoint(Number(decimal)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[name.toLowerCase()]);
const textOf = fragment => [...fragment.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(match => unxml(match[1])).join('');

/** Reads an .xlsx file into [{ name, cells }] with formulas kept as formulas and values as text. */
export async function readXlsx(buffer) {
  const archive = await unzip(buffer);
  const workbook = await archive.text('xl/workbook.xml');
  if (!workbook) throw new Error('This file is not an XLSX workbook.');
  const relations = await archive.text('xl/_rels/workbook.xml.rels') || '';
  const targets = new Map([...relations.matchAll(/<Relationship\b[^>]*>/g)].map(([tag]) => [attribute(tag, 'Id'), attribute(tag, 'Target')]));
  const shared = [...((await archive.text('xl/sharedStrings.xml')) || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(match => textOf(match[1]));
  const styles = readXlsxStyles(await archive.text('xl/styles.xml') ?? '', attribute, unxml);
  const out = [];
  for (const [tag] of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = unxml(attribute(tag, 'name') || 'Sheet');
    const target = targets.get(attribute(tag, 'r:id'));
    if (!target) continue;
    const path = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    const source = await archive.text(path);
    if (!source) continue;
    const cells = {};
    const formats = {};
    const widths = {};
    const heights = {};
    const pane = /<pane\b[^>]*>/.exec(source)?.[0] ?? '';
    for (const [row] of source.matchAll(/<row\b[^>]*>/g)) {
      const index = Number(attribute(row, 'r'));
      const height = Number(attribute(row, 'ht'));
      if (index > 0 && index <= LIMITS.rows && height > 0) heights[index] = Math.min(ROW_HEIGHT[1], Math.max(ROW_HEIGHT[0], Math.round(height / 0.75)));
    }
    for (const [col] of source.matchAll(/<col\b[^>]*>/g)) {
      const start = Number(attribute(col, 'min'));
      const end = Math.min(Number(attribute(col, 'max')), LIMITS.columns);
      const width = Number(attribute(col, 'width'));
      if (!start || !(width > 0)) continue;
      for (let index = start; index <= end; index++) widths[columnLabel(index - 1)] = Math.min(LIMITS.width[1], Math.max(LIMITS.width[0], Math.round(width * 7 + 5)));
    }
    for (const match of source.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attribute(match[1], 'r');
      const parsed = ref && /^([A-Z]{1,3})([0-9]+)$/.exec(ref);
      if (!parsed || columnIndex(parsed[1]) >= LIMITS.columns || Number(parsed[2]) > LIMITS.rows || Number(parsed[2]) < 1) continue;
      const format = styles[Number(attribute(match[1], 's')) || 0];
      if (format) formats[ref] = format;
      const body = match[2] || '';
      const type = attribute(match[1], 't');
      const formula = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(body)?.[1];
      const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let text;
      if (formula) text = '=' + unxml(formula);
      else if (type === 's') text = shared[Number(value)] ?? '';
      else if (type === 'inlineStr') text = textOf(body);
      else if (type === 'b') text = value === '1' ? 'TRUE' : 'FALSE';
      else text = value == null ? '' : unxml(value);
      // Text that only looks like a number or formula keeps its meaning as text.
      if (!formula && (type === 's' || type === 'inlineStr' || type === 'str') && /^[=']|^\s*[-+]?(?:\d|\.\d)/.test(text)) text = "'" + text;
      if (text !== '') cells[ref] = text.slice(0, LIMITS.cellLength);
    }
    const split = axis => Math.min(LIMITS.frozen, Math.max(0, Number.parseInt(attribute(pane, axis), 10) || 0));
    const frozen = attribute(pane, 'state') === 'frozen' || attribute(pane, 'state') === 'frozenSplit';
    const regions = [...source.matchAll(/<mergeCell\b[^>]*>/g)].flatMap(([tag]) => {
      const [start, end] = (attribute(tag, 'ref') ?? '').replaceAll('$', '').split(':').map(parseAddress);
      return start && end ? [{ r1: start.row, c1: start.column, r2: end.row, c2: end.column }] : [];
    });
    const merges = normalizeMerges(regions);
    if (!merges) throw new Error('This file contains overlapping or too many merged ranges.');
    const frozenRows = frozen ? split('ySplit') : 0;
    const frozenColumns = frozen ? split('xSplit') : 0;
    out.push({ name, cells, formats, widths, heights, merges,
      frozen: merges.some(item => item.r1 < frozenRows && item.r2 >= frozenRows) ? 0 : frozenRows,
      frozenColumns: merges.some(item => item.c1 < frozenColumns && item.c2 >= frozenColumns) ? 0 : frozenColumns });
  }
  return out;
}

/** Saves a Blob through a temporary link. */
export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
