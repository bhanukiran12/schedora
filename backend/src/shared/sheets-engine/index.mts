import { LIMITS, cellAddress } from '../workbook-ops.mjs';

export { adjustForStructure, quoteSheetName, renameSheetReferences, retargetMovedReferences, rewriteReferences, shiftFormula } from './address.mts';
export { createEvaluator, displayValue, FUNCTION_NAMES, parseInput, sheetValue, toText, typedValue } from './evaluator.mts';
export { parseFormula, tokenize } from './parser.mts';
export { FormulaError } from './types.mts';
export type { CellChange, CellValue, ErrorCode, Evaluator, FormulaNode, FormulaSheet, ParsedInput, Recalculation, Reference } from './types.mts';

export const SHEET_ROWS = LIMITS.rows;
export const SHEET_COLUMNS = LIMITS.columns;
export const sheetAddress = cellAddress;
