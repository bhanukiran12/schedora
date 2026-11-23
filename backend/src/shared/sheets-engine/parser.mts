import { columnIndex } from '../workbook-ops.mjs';
import { ERROR_CODES, FormulaError, fail, type ErrorCode, type FormulaNode, type Reference } from './types.mts';

type Token = { start: number; end: number } & (
  | { t: 'str' | 'fn' | 'name' | 'op'; v: string }
  | { t: 'num'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'error'; v: ErrorCode }
  | { t: 'ref'; text: string; sheet: string | null; body: string }
);

const SHEET_PREFIX = String.raw`(?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!`;
const CELL = String.raw`\$?[A-Za-z]{1,3}\$?[0-9]+`;
const COLUMN = String.raw`\$?[A-Za-z]{1,3}`;
const REFERENCE = new RegExp(String.raw`^(${SHEET_PREFIX})?(${CELL}(?::(?:${CELL}|${COLUMN}))?|${COLUMN}:${COLUMN})(?![A-Za-z0-9_(])`);

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    const space = /^\s+/.exec(rest);
    if (space) { index += space[0].length; continue; }
    let match;
    const errorCode = rest.startsWith('#') ? ERROR_CODES.find(code => rest.startsWith(code)) : undefined;
    if ((match = /^"((?:[^"]|"")*)"/.exec(rest))) tokens.push({ t: 'str', v: match[1].replaceAll('""', '"'), start: index, end: index + match[0].length });
    else if (errorCode) tokens.push({ t: 'error', v: errorCode, start: index, end: index + errorCode.length });
    else if ((match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/.exec(rest)) && !/^[0-9]+:/.test(rest)) tokens.push({ t: 'num', v: Number(match[0]), start: index, end: index + match[0].length });
    else if ((match = REFERENCE.exec(rest))) tokens.push({ t: 'ref', text: match[0], sheet: match[1] ? unquote(match[1].slice(0, -1)) : null, body: match[2], start: index, end: index + match[0].length });
    else if ((match = /^([A-Za-z_][A-Za-z0-9_.]*)\s*\(/.exec(rest))) { tokens.push({ t: 'fn', v: match[1].toUpperCase(), start: index, end: index + match[0].length }); }
    else if ((match = /^(TRUE|FALSE)(?![A-Za-z0-9_])/i.exec(rest))) tokens.push({ t: 'bool', v: match[1].toUpperCase() === 'TRUE', start: index, end: index + match[0].length });
    else if ((match = /^(<=|>=|<>|[-+*/^&=<>%(),;:])/.exec(rest))) tokens.push({ t: 'op', v: match[1] === ';' ? ',' : match[1], start: index, end: index + match[0].length });
    else if ((match = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest))) tokens.push({ t: 'name', v: match[0], start: index, end: index + match[0].length });
    else fail('#ERROR!');
    index = tokens[tokens.length - 1].end;
  }
  return tokens;
}
const unquote = (name: string) => name.startsWith("'") ? name.slice(1, -1).replaceAll("''", "'") : name;

export function parsePoint(text: string) {
  const match = /^(\$?)([A-Za-z]{1,3})(?:(\$?)([0-9]+))?$/.exec(text);
  return match ? { absC: Boolean(match[1]), c: columnIndex(match[2]), absR: Boolean(match[3]), r: match[4] == null ? null : Number(match[4]) - 1 } : null;
}

/** An open-ended reference such as A2:A has a null ending row. */
export function parseReference(body: string): Omit<Reference, 'sheet'> {
  const [left, right] = body.split(':');
  const from = parsePoint(left);
  const to = right == null ? null : parsePoint(right);
  if (!from || (right != null && !to)) fail('#REF!');
  return { from, to };
}

// ---- Parser -------------------------------------------------------------------------------------
function parse(tokens: readonly Token[]): FormulaNode {
  let index = 0;
  const peek = (): Token | undefined => tokens[index];
  const isOp = (value: string) => { const token = peek(); return token?.t === 'op' && token.v === value; };
  const take = (value: string) => { if (!isOp(value)) fail('#ERROR!'); index++; };
  const binary = (next: () => FormulaNode, operators: string[]) => (): FormulaNode => {
    let node = next();
    for (let token = peek(); token?.t === 'op' && operators.includes(token.v); token = peek()) {
      index++;
      node = { k: 'bin', op: token.v, a: node, b: next() };
    }
    return node;
  };
  const primary = (): FormulaNode => {
    const token = peek();
    index++;
    if (!token) fail('#ERROR!');
    if (token.t === 'num') return { k: 'val', v: token.v };
    if (token.t === 'str') return { k: 'val', v: token.v };
    if (token.t === 'bool') return { k: 'val', v: token.v };
    if (token.t === 'error') return { k: 'error', code: token.v };
    if (token.t === 'ref') return { k: 'ref', sheet: token.sheet, ...parseReference(token.body) };
    if (token.t === 'name') return { k: 'name', v: token.v };
    if (token.t === 'fn') {
      const args: FormulaNode[] = [];
      if (!isOp(')')) {
        do {
          if (isOp(',') || isOp(')')) args.push({ k: 'val', v: '' });
          else args.push(comparison());
        } while (isOp(',') && ++index);
      }
      take(')');
      return { k: 'fn', name: token.v, args };
    }
    if (token.t === 'op' && token.v === '(') { const node = comparison(); take(')'); return node; }
    if (token.t === 'op' && (token.v === '-' || token.v === '+')) return { k: 'unary', op: token.v, a: power() };
    fail('#ERROR!');
  };
  const postfix = (): FormulaNode => { let node = primary(); while (isOp('%')) { index++; node = { k: 'pct', a: node }; } return node; };
  const power = binary(postfix, ['^']);
  const product = binary(power, ['*', '/']);
  const sum = binary(product, ['+', '-']);
  const concat = binary(sum, ['&']);
  const comparison = binary(concat, ['=', '<>', '<', '>', '<=', '>=']);
  const tree = comparison();
  if (index !== tokens.length) fail('#ERROR!');
  return tree;
}

/** Parses a cell formula, including its leading equals sign. */
export function parseFormula(raw: string): FormulaNode | FormulaError {
  if (!raw.startsWith('=')) return new FormulaError('#ERROR!');
  try { return parse(tokenize(raw.slice(1))); }
  catch (error) { return error instanceof FormulaError ? error : new FormulaError('#ERROR!'); }
}

