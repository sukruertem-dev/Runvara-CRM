import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ErrorCode } from '@flexa/contracts';
import { ProblemError } from './problem';

/** ADR-0012: PATCH/DELETE need `If-Match: "<version>"` (428 when missing, 412 when stale). */
export function requireIfMatch(header: string | string[] | undefined): number {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) throw new ProblemError('PRECONDITION_REQUIRED', 'If-Match header with the current version is required');
  const m = /^(?:W\/)?"?(\d{1,9})"?$/.exec(raw.trim());
  if (!m?.[1]) throw new ProblemError('PRECONDITION_FAILED', 'malformed If-Match');
  return Number(m[1]);
}

export const etag = (version: number): string => `"${version}"`;

/** Signed, query-bound cursor (ADR-0012): base64url(JSON) + "." + HMAC. Tampering or reuse with a
 *  different query → 400 CURSOR_INVALID. */
export class CursorCodec {
  constructor(private readonly key: string) {}

  encode(values: unknown[], fingerprint: string): string {
    const body = Buffer.from(JSON.stringify({ v: values, f: fingerprint })).toString('base64url');
    return `${body}.${this.mac(body)}`;
  }

  decode(cursor: string, fingerprint: string): unknown[] {
    const [body, mac] = cursor.split('.');
    if (!body || !mac) throw new ProblemError('CURSOR_INVALID');
    const expected = Buffer.from(this.mac(body));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new ProblemError('CURSOR_INVALID');
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { v?: unknown; f?: unknown };
    if (parsed.f !== fingerprint || !Array.isArray(parsed.v)) throw new ProblemError('CURSOR_INVALID', 'cursor belongs to a different query');
    return parsed.v;
  }

  private mac(body: string): string {
    return createHmac('sha256', this.key).update(`cursor:${body}`).digest('base64url');
  }
}

const TRIGGER_CODES: readonly ErrorCode[] = ['TEAM_HIERARCHY_CYCLE', 'ROLE_HIERARCHY_CYCLE', 'ACCOUNT_HIERARCHY_CYCLE', 'DEPENDENCY_CYCLE', 'SUBTASK_DEPTH_EXCEEDED', 'SUBTASK_CYCLE', 'SUBTASK_MOVE_WITH_CHILDREN'];

/** Maps business-rule exceptions raised by database triggers (and FK/unique violations) to problems. */
export function mapDbError(err: unknown): never {
  const cause = (err as { cause?: unknown }).cause ?? err;
  const pg = cause as { code?: string; message?: string; constraint?: string };
  const code = TRIGGER_CODES.find((c) => pg.message === c);
  if (code) throw new ProblemError(code);
  if (pg.code === '23503') throw new ProblemError('VALIDATION_FAILED', `referenced record does not exist (${pg.constraint ?? 'foreign key'})`);
  if (pg.code === '23505') throw new ProblemError('CONFLICT', `duplicate (${pg.constraint ?? 'unique'})`);
  if (pg.code === '23514') throw new ProblemError('VALIDATION_FAILED', `constraint violated (${pg.constraint ?? 'check'})`);
  throw err;
}
