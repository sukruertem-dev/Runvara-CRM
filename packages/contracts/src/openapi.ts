import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { ENDPOINTS } from './endpoints';

const Problem = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    code: z.string(),
    detail: z.string().optional(),
    requestId: z.string().optional(),
    errors: z.array(z.object({ path: z.string(), code: z.string(), message: z.string() })).optional(),
  })
  .openapi('Problem');

const STATUS_TEXT: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 302: 'Redirect',
  400: 'Validation failed', 401: 'Unauthenticated', 403: 'Forbidden', 404: 'Not found (or not visible)',
  409: 'Conflict', 410: 'Gone (token invalid or expired)', 422: 'Business rule violated', 429: 'Rate limited',
};

export function buildOpenApiDocument(info: { version: string; serverUrl: string }): ReturnType<OpenApiGeneratorV31['generateDocument']> {
  const registry = new OpenAPIRegistry();
  registry.registerComponent('securitySchemes', 'bearer', { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
  registry.registerComponent('securitySchemes', 'refreshCookie', { type: 'apiKey', in: 'cookie', name: 'rv_rt' });
  for (const e of ENDPOINTS) {
    const params = [...e.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
    const responses: Record<string, { description: string; content?: Record<string, { schema: z.ZodType }> }> = {};
    for (const [code, schema] of Object.entries(e.responses)) {
      responses[code] = schema ? { description: STATUS_TEXT[Number(code)] ?? code, content: { 'application/json': { schema } } } : { description: STATUS_TEXT[Number(code)] ?? code };
    }
    for (const code of e.errors) {
      responses[String(code)] = { description: STATUS_TEXT[code] ?? String(code), content: { 'application/problem+json': { schema: Problem } } };
    }
    registry.registerPath({
      method: e.method,
      path: e.path,
      summary: e.summary,
      tags: [e.tag],
      security: e.auth === 'access' || e.auth === 'tenant' ? [{ bearer: [] }] : e.auth === 'refresh_cookie' ? [{ refreshCookie: [] }] : [],
      request: {
        ...(params.length ? { params: z.object(Object.fromEntries(params.map((p) => [p, z.string()]))) } : {}),
        ...(e.body ? { body: { content: { 'application/json': { schema: e.body } } } } : {}),
      },
      responses,
    });
  }
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: { title: 'Runvara API', version: info.version, description: 'Errors use RFC 9457 problem+json (ADR-0012).' },
    servers: [{ url: info.serverUrl }],
  });
}
