export const SHEET_ROWS = 50;
export const SHEET_COLUMNS = 12;
const addressPattern = /^[A-L](?:[1-9]|[1-4][0-9]|50)$/;
export const sheetAddress = (row, column) => String.fromCharCode(65 + column) + (row + 1);

export function sheetValue(cells, address, sheets = [], visiting = new Map(), budget = { remaining: 3000, depth: 0 }) {
  if (--budget.remaining < 0) throw new Error('#ERROR!');
  const raw = cells[address] ?? '';
  if (!raw.startsWith('=')) return raw;
  const active = visiting.get(cells) ?? new Set();
  if (active.has(address)) throw new Error('#CYCLE!');
  if (budget.depth >= 50) throw new Error('#ERROR!');
  visiting.set(cells, active);
  active.add(address);
  budget.depth++;
  try {
    const source = raw.slice(1).trim().toUpperCase();
    const tokens = source.match(/'(?:[^']|'')*'![A-Z]+[0-9]+|[A-Z]+[0-9]*|(?:\d+\.?\d*|\.\d+)|[+*/(),:\-]/g) ?? [];
    if (tokens.join('') !== source.replace(/'(?:[^']|'')*'|\s+/g, part => part.startsWith("'") ? part : '') || tokens.length > 150) throw new Error('#ERROR!');
    let index = 0;
    const read = (key, sourceCells = cells) => {
      if (!addressPattern.test(key)) throw new Error('#REF!');
      return sheetValue(sourceCells, key, sheets, visiting, budget);
    };
    const numeric = value => {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error('#VALUE!');
      return number;
    };
    function factor() {
      const token = tokens[index++];
      if (token === '-') return -factor();
      if (token === '(') {
        const value = expression();
        if (tokens[index++] !== ')') throw new Error('#ERROR!');
        return value;
      }
      if (/^[A-Z]+[0-9]+$/.test(token)) return numeric(read(token));
      const linked = /^'((?:[^']|'')*)'!([A-Z]+[0-9]+)$/.exec(token);
      if (linked) {
        const sheet = sheets.find(item => item.name.toUpperCase() === linked[1].replaceAll("''", "'"));
        if (!sheet) throw new Error('#REF!');
        if (!addressPattern.test(linked[2])) throw new Error('#REF!');
        if (sheet.literal && !Object.hasOwn(sheet.cells, linked[2])) throw new Error('#REF!');
        return numeric(sheet.literal ? sheet.cells[linked[2]] : read(linked[2], sheet.cells));
      }
      if (/^(?:\d|\.)/.test(token)) return numeric(token);
      if (!['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT'].includes(token) || tokens[index++] !== '(') throw new Error('#ERROR!');
      const values = [];
      do {
        if (tokens[index + 1] === ':') {
          const start = tokens[index];
          const end = tokens[index + 2];
          index += 3;
          if (!addressPattern.test(start) || !addressPattern.test(end)) throw new Error('#REF!');
          const rows = [Number(start.slice(1)), Number(end.slice(1))];
          const columns = [start.charCodeAt(0) - 65, end.charCodeAt(0) - 65];
          for (let row = Math.min(...rows); row <= Math.max(...rows); row++) {
            for (let column = Math.min(...columns); column <= Math.max(...columns); column++) {
              const value = read(sheetAddress(row - 1, column));
              if (value !== '' && Number.isFinite(Number(value))) values.push(Number(value));
            }
          }
        } else values.push(expression());
        if (tokens[index] !== ',') break;
        index++;
      } while (true);
      if (tokens[index++] !== ')') throw new Error('#ERROR!');
      if (token === 'COUNT') return values.length;
      if (token === 'MIN') return values.length ? Math.min(...values) : 0;
      if (token === 'MAX') return values.length ? Math.max(...values) : 0;
      const sum = values.reduce((total, value) => total + value, 0);
      if (token === 'SUM') return sum;
      if (!values.length) throw new Error('#DIV/0!');
      return sum / values.length;
    }
    function term() {
      let value = factor();
      while (['*', '/'].includes(tokens[index])) {
        const operator = tokens[index++];
        const right = factor();
        if (operator === '/' && right === 0) throw new Error('#DIV/0!');
        value = operator === '*' ? value * right : value / right;
      }
      return value;
    }
    function expression() {
      let value = term();
      while (['+', '-'].includes(tokens[index])) {
        const operator = tokens[index++];
        const right = term();
        value = operator === '+' ? value + right : value - right;
      }
      return value;
    }
    const result = expression();
    if (index !== tokens.length || !Number.isFinite(result)) throw new Error('#ERROR!');
    return result;
  } finally {
    active.delete(address);
    budget.depth--;
  }
}
