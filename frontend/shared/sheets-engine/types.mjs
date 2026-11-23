export const ERROR_CODES = ['#DIV/0!', '#REF!', '#NAME?', '#VALUE!', '#N/A', '#NUM!', '#CYCLE!', '#ERROR!'];
export class FormulaError extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}
export function fail(code) {
    throw new FormulaError(code);
}
