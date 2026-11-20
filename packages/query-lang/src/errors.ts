export type RqlErrorCode = 'RQL_SYNTAX' | 'UNKNOWN_FIELD' | 'BAD_OPERATOR' | 'BAD_VALUE' | 'LIMIT_EXCEEDED';

/** Every failure of the RQL pipeline. `position` is a 0-based character offset into the query text. */
export class RqlError extends Error {
  readonly code: RqlErrorCode;
  readonly position: number;

  constructor(code: RqlErrorCode, message: string, position: number) {
    super(message);
    this.name = 'RqlError';
    this.code = code;
    this.position = position;
  }
}
