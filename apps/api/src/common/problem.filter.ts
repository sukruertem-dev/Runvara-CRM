import { ArgumentsHost, Catch, HttpException, type ExceptionFilter } from '@nestjs/common';
import { PROBLEM_TYPE_BASE, type ErrorCode, type ProblemDetails } from '@runvara/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { ProblemError } from './problem';

const TITLES: Partial<Record<ErrorCode, string>> = {
  VALIDATION_FAILED: 'Validation failed',
  NOT_FOUND: 'Not found',
  MODULE_DISABLED: 'Not found',
  INTERNAL: 'Internal error',
};

function httpCode(status: number): ErrorCode {
  switch (status) {
    case 400: return 'VALIDATION_FAILED';
    case 401: return 'UNAUTHENTICATED';
    case 403: return 'FORBIDDEN';
    case 404: return 'NOT_FOUND';
    case 409: return 'CONFLICT';
    case 429: return 'RATE_LIMITED';
    default: return status >= 500 ? 'INTERNAL' : 'VALIDATION_FAILED';
  }
}

export function toProblem(err: unknown, req: FastifyRequest): { problem: ProblemDetails; headers: Record<string, string> } {
  const base = { instance: req.url.split('?')[0] ?? req.url, requestId: req.id };
  if (err instanceof ProblemError) {
    return {
      problem: {
        type: `${PROBLEM_TYPE_BASE}${err.code}`,
        title: TITLES[err.code] ?? err.code.replace(/_/g, ' ').toLowerCase(),
        status: err.status,
        code: err.code,
        ...(err.detail ? { detail: err.detail } : {}),
        ...base,
        ...err.extensions,
      },
      headers: err.headers,
    };
  }
  if (err instanceof ZodError) {
    return {
      problem: {
        type: `${PROBLEM_TYPE_BASE}VALIDATION_FAILED`, title: 'Validation failed', status: 400, code: 'VALIDATION_FAILED', ...base,
        errors: err.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message })),
      },
      headers: {},
    };
  }
  const status = err instanceof HttpException ? err.getStatus() : (err as { statusCode?: number }).statusCode ?? 500;
  const code = httpCode(status);
  const headers: Record<string, string> = {};
  if (status === 429) {
    const retry = (err as { headers?: Record<string, string> }).headers?.['retry-after'];
    if (retry) headers['retry-after'] = retry;
  }
  return { problem: { type: `${PROBLEM_TYPE_BASE}${code}`, title: TITLES[code] ?? code.toLowerCase(), status, code, ...base }, headers };
}

@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const { problem, headers } = toProblem(err, req);
    if (problem.status >= 500) req.log.error({ err }, 'unhandled error');
    void reply.status(problem.status).headers(headers).type('application/problem+json').send(problem);
  }
}
