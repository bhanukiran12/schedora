import { normalizeFormat } from '../shared/workbook-ops.mjs';

const escape = text => String(text).replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
const codeFor = format => {
  const decimals = format.dp ?? 2;
  const digits = decimals ? '.' + '0'.repeat(decimals) : '';
  return ({ number: `#,##0${digits}`, percent: `0${digits}%`, currency: `"₹"#,##0${digits}`,
    accounting: `"₹"#,##0${digits};("₹"#,##0${digits});"₹ –"`, scientific: `0${digits}E+00`,
    date: 'yyyy-mm-dd', time: 'hh:mm:ss', datetime: 'yyyy-mm-dd hh:mm:ss', duration: '[h]:mm:ss', plain: '@' })[format.num]
    ?? (format.dp == null ? '' : `0${digits}`);
};
const fontName = { serif: 'Times New Roman', monospace: 'Consolas', 'sans-serif': 'Arial' };
const rgb = value => value ? ` rgb="FF${value.slice(1).toUpperCase()}"` : '';

export function xlsxStyles(sheets) {
  const formats = [null];
  const byFormat = new Map();
  const supported = ({ note, condition, validation, ...format } = {}) => normalizeFormat(format) || null;
  const id = cell => {
    const format = supported(cell?.format ?? (cell?.bold ? { b: true } : {}));
    if (!format) return 0;
    const key = JSON.stringify(format);
    if (!byFormat.has(key)) { byFormat.set(key, formats.length); formats.push(format); }
    return byFormat.get(key);
  };
  for (const sheet of sheets) for (const row of sheet.rows) for (const cell of row) id(cell);
  const fonts = ['<font><sz val="11"/><name val="Calibri"/></font>'];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borders = ['<border/>'];
  const numbers = new Map();
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  for (const format of formats.slice(1)) {
    const font = fonts.push(`<font>${format.b ? '<b/>' : ''}${format.i ? '<i/>' : ''}${format.u ? '<u/>' : ''}${format.s ? '<strike/>' : ''}<sz val="${format.size ?? 11}"/><name val="${fontName[format.font] ?? 'Calibri'}"/>${format.color ? `<color${rgb(format.color)}/>` : ''}</font>`) - 1;
    const fill = format.fill ? fills.push(`<fill><patternFill patternType="solid"><fgColor${rgb(format.fill)}/><bgColor indexed="64"/></patternFill></fill>`) - 1 : 0;
    const border = format.border ? borders.push(`<border>${[['left','l'],['right','r'],['top','t'],['bottom','b']].map(([tag, side]) => format.border.includes(side) ? `<${tag} style="thin"/>` : `<${tag}/>`).join('')}</border>`) - 1 : 0;
    const code = codeFor(format);
    if (code && !numbers.has(code)) numbers.set(code, 164 + numbers.size);
    const alignment = format.align || format.wrap ? `<alignment${format.align ? ` horizontal="${format.align}"` : ''}${format.wrap ? ' wrapText="1"' : ''}/>` : '';
    xfs.push(`<xf numFmtId="${numbers.get(code) ?? 0}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0" applyFont="1"${code ? ' applyNumberFormat="1"' : ''}${fill ? ' applyFill="1"' : ''}${border ? ' applyBorder="1"' : ''}${alignment ? ' applyAlignment="1"' : ''}>${alignment}</xf>`);
  }
  const group = (name, items) => `<${name} count="${items.length}">${items.join('')}</${name}>`;
  const numberXml = numbers.size ? group('numFmts', [...numbers].map(([code, index]) => `<numFmt numFmtId="${index}" formatCode="${escape(code)}"/>`)) : '';
  return { id, document: `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${numberXml}${group('fonts', fonts)}${group('fills', fills)}${group('borders', borders)}<cellStyleXfs count="1"><xf/></cellStyleXfs>${group('cellXfs', xfs)}</styleSheet>` };
}

export function readXlsxStyles(source, attribute, unxml) {
  const section = name => new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`).exec(source)?.[1] ?? '';
  const entries = (parent, child) => [...section(parent).matchAll(new RegExp(`<${child}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${child}>)`, 'g'))];
  const fonts = entries('fonts', 'font');
  const fills = entries('fills', 'fill');
  const borders = entries('borders', 'border');
  const custom = new Map(entries('numFmts', 'numFmt').map(([, tag]) => [Number(attribute(tag, 'numFmtId')), unxml(attribute(tag, 'formatCode') ?? '')]));
  const color = (xml, tag) => new RegExp(`<${tag}\\b[^>]*\\brgb="(?:[0-9A-F]{2})?([0-9A-F]{6})"`, 'i').exec(xml)?.[1];
  const formatFromNumber = (id, format) => {
    if (!id) return;
    const code = custom.get(id) ?? ({ 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00', 14: 'yyyy-mm-dd', 18: 'hh:mm:ss', 19: 'hh:mm:ss', 20: 'hh:mm:ss', 21: 'hh:mm:ss', 22: 'yyyy-mm-dd hh:mm:ss', 46: '[h]:mm:ss', 49: '@' })[id];
    if (!code) return;
    if (code === '@') format.num = 'plain';
    else if (/^\[h\]/i.test(code)) format.num = 'duration';
    else if (/y|d/i.test(code) && /h|s/i.test(code)) format.num = 'datetime';
    else if (/y|d/i.test(code)) format.num = 'date';
    else if (/h|s/i.test(code)) format.num = 'time';
    else if (code.includes('%')) format.num = 'percent';
    else if (/E[+-]/i.test(code)) format.num = 'scientific';
    else if (code.includes('₹')) format.num = code.includes(';') ? 'accounting' : 'currency';
    else if (/^[#,0.]+$/.test(code)) format.num = code.includes(',') ? 'number' : 'auto';
    if (['auto', 'number', 'percent', 'scientific', 'currency', 'accounting'].includes(format.num)) format.dp = Math.min(10, /\.(0+)/.exec(code)?.[1].length ?? 0);
  };
  return entries('cellXfs', 'xf').map(([, tag, alignment = ''], index) => {
    if (!index && !tag.includes('apply')) return null;
    const format = {};
    const font = fonts[Number(attribute(tag, 'fontId'))]?.[2] ?? '';
    for (const [key, markup] of [['b','b'],['i','i'],['u','u'],['s','strike']]) if (new RegExp(`<${markup}\\b`).test(font)) format[key] = true;
    const size = Number(/<sz\b[^>]*\bval="([\d.]+)"/.exec(font)?.[1]);
    if (Number.isInteger(size) && size >= 9 && size <= 18) format.size = size;
    const name = /<name\b[^>]*\bval="([^"]+)"/.exec(font)?.[1];
    const family = Object.keys(fontName).find(key => fontName[key] === name);
    if (family) format.font = family;
    const ink = color(font, 'color');
    const fill = color(fills[Number(attribute(tag, 'fillId'))]?.[2] ?? '', 'fgColor');
    if (ink) format.color = `#${ink}`;
    if (fill) format.fill = `#${fill}`;
    const border = borders[Number(attribute(tag, 'borderId'))]?.[2] ?? '';
    const edges = [['top','t'],['right','r'],['bottom','b'],['left','l']].filter(([side]) => new RegExp(`<${side}\\b[^>]*\\bstyle="`).test(border)).map(([, side]) => side).join('');
    if (edges) format.border = edges;
    const align = attribute(alignment, 'horizontal');
    if (['left', 'right', 'center'].includes(align)) format.align = align;
    if (attribute(alignment, 'wrapText') === '1') format.wrap = true;
    formatFromNumber(Number(attribute(tag, 'numFmtId')), format);
    return normalizeFormat(format);
  });
}
