export type FormulaErrorCode =
  | 'FORMULA_SYNTAX'
  | 'FORMULA_UNKNOWN_REF'
  | 'FORMULA_TYPE'
  | 'FORMULA_LIMIT'
  | 'FORMULA_CYCLE';

export class FormulaError extends Error {
  readonly code: FormulaErrorCode;
  readonly position: number;

  constructor(code: FormulaErrorCode, message: string, position = 0) {
    super(message);
    this.name = 'FormulaError';
    this.code = code;
    this.position = position;
  }
}

export const MAX_SOURCE_LENGTH = 2000;
export const MAX_NODES = 500;
export const MAX_DEPTH = 50;
export const MAX_STEPS = 10_000;
