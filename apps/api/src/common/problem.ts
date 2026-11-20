import { ERROR_CODES, type ErrorCode } from '@flexa/contracts';

/** Throw from anywhere; rendered as RFC 9457 problem+json by ProblemFilter (ADR-0012). */
export class ProblemError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    readonly detail?: string,
    readonly extensions: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(detail ?? code);
    this.status = ERROR_CODES[code];
  }
}

export const notFound = (): ProblemError => new ProblemError('NOT_FOUND');
export const forbidden = (detail?: string): ProblemError => new ProblemError('FORBIDDEN', detail);
export const unauthenticated = (detail?: string): ProblemError => new ProblemError('UNAUTHENTICATED', detail);

/** PostgreSQL unique violation on a given constraint (drizzle wraps the driver error in `cause`). */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = (err as { cause?: unknown }).cause ?? err;
  const pg = e as { code?: string; constraint?: string };
  return pg.code === '23505' && (constraint === undefined || pg.constraint === constraint);
}
