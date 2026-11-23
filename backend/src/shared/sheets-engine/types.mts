export const ERROR_CODES = ['#DIV/0!', '#REF!', '#NAME?', '#VALUE!', '#N/A', '#NUM!', '#CYCLE!', '#ERROR!'] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class FormulaError extends Error {
  declare readonly code: ErrorCode;

  constructor(code: ErrorCode) {
    super(code);
    this.code = code;
  }
}

export function fail(code: ErrorCode): never {
  throw new FormulaError(code);
}

export type Scalar = string | number | boolean;
export type CellValue = Scalar | FormulaError;

export interface FormulaSheet {
  readonly name: string;
  readonly cells: Readonly<Record<string, string>>;
  readonly literal?: boolean;
  readonly rows?: number;
  readonly columns?: number;
  readonly names?: Readonly<Record<string, string>>;
  readonly settings?: { readonly namedFunctions?: readonly { readonly name: string; readonly args: readonly string[]; readonly formula: string }[] };
  readonly merges?: readonly { r1: number; c1: number; r2: number; c2: number }[];
  readonly limit?: { readonly rows: number; readonly columns: number };
}

export interface Evaluator {
  value(sheet: FormulaSheet, address: string): CellValue;
  spillValue(sheet: FormulaSheet, address: string): Scalar | undefined;
  spillAddresses(sheet: FormulaSheet): string[];
  block(sheet: FormulaSheet, r1: number, c1: number, r2: number, c2: number): CellValue[];
  update(sheets: readonly FormulaSheet[], changes?: readonly CellChange[]): Recalculation;
  recalculate(): Recalculation;
}

export interface CellChange { readonly sheet: string; readonly address: string }
export interface Recalculation { readonly invalidated: number; readonly evaluated: number }

export interface ReferencePoint {
  readonly r: number | null;
  readonly c: number;
  readonly absR: boolean;
  readonly absC: boolean;
}

export interface Reference {
  readonly sheet: string | null;
  readonly from: ReferencePoint;
  readonly to: ReferencePoint | null;
}

export type FormulaNode = Readonly<
  | { k: 'val'; v: Scalar }
  | { k: 'error'; code: ErrorCode }
  | { k: 'name'; v: string }
  | ({ k: 'ref' } & Reference)
  | { k: 'pct'; a: FormulaNode }
  | { k: 'unary'; op: '+' | '-'; a: FormulaNode }
  | { k: 'fn'; name: string; args: readonly FormulaNode[] }
  | { k: 'bin'; op: string; a: FormulaNode; b: FormulaNode }
>;

export type ParsedInput = Readonly<
  | { kind: 'value'; value: Scalar }
  | { kind: 'date'; value: Date }
  | { kind: 'time'; value: number }
  | { kind: 'formula'; node: FormulaNode | FormulaError }
>;
