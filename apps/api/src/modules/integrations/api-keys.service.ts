import { Inject, Injectable } from '@nestjs/common';
import type { ApiKeyCreate, z } from '@flexa/contracts';
import { sql, type Db, type DbHandle } from '@flexa/db';
import { randomToken, sha256 } from '@flexa/security';
import { randomBytes } from 'node:crypto';
import { audit } from '../../common/audit';
import { authorize } from '../../common/authorize';
import { API_KEY_PREFIX } from '../../common/guards';
import { isUniqueViolation, ProblemError } from '../../common/problem';
import { dbCtx, type TenantRequestContext } from '../../common/request-context';
import { DB } from '../../infra/tokens';

type KeyRow = { id: string; name: string; prefix: string; scopes: ('read' | 'write')[]; rate_limit_per_minute: number; created_by: string; created_at: string; expires_at: string | null; revoked_at: string | null; last_used_at: string | null };
const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);
const view = (k: KeyRow, key?: string) => ({
  id: k.id, name: k.name, prefix: k.prefix, scopes: k.scopes, rateLimitPerMinute: k.rate_limit_per_minute, createdBy: k.created_by,
  createdAt: new Date(k.created_at).toISOString(), expiresAt: iso(k.expires_at), revokedAt: iso(k.revoked_at), lastUsedAt: iso(k.last_used_at), ...(key ? { key } : {}),
});
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** API keys (Faz 5): `fx_<prefix>_<secret>`, stored as a SHA-256 hash, shown once. A key acts with its creator's
 *  current rights narrowed to its scopes (read = safe methods only), with its own per-minute budget. */
@Injectable()
export class ApiKeysService {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  private async rows(tx: Db, id?: string): Promise<KeyRow[]> {
    return (await tx.execute<KeyRow>(sql`SELECT id, name, prefix, scopes, rate_limit_per_minute, created_by, created_at, expires_at, revoked_at, last_used_at
      FROM api_keys ${id ? sql`WHERE id = ${id}` : sql``} ORDER BY created_at DESC`)).rows;
  }

  async list(t: TenantRequestContext) {
    authorize(t, 'tenant.config.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => ({ data: (await this.rows(tx)).map((k) => view(k)) }));
  }

  async create(t: TenantRequestContext, body: z.infer<typeof ApiKeyCreate>, ip: string) {
    authorize(t, 'tenant.config.manage');
    const expires = body.expiresAt ? new Date(body.expiresAt) : null;
    if (expires && expires <= new Date()) throw new ProblemError('VALIDATION_FAILED', 'expiresAt must be in the future');
    const prefix = Array.from(randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('');
    const key = `${API_KEY_PREFIX}${prefix}_${randomToken()}`;
    return this.db.withTenant(dbCtx(t), async (tx) => {
      try {
        const r = await tx.execute<{ id: string }>(sql`INSERT INTO api_keys (tenant_id, name, prefix, key_hash, scopes, rate_limit_per_minute, created_by, expires_at)
          VALUES (${t.tenant.id}, ${body.name}, ${prefix}, ${sha256(key)}, ${`{${body.scopes.join(',')}}`}::text[], ${body.rateLimitPerMinute}, ${t.principal.userId}, ${expires})
          RETURNING id`);
        const id = r.rows[0]?.id ?? '';
        await audit(tx, t.tenant.id, { action: 'api_key.created', actorId: t.principal.userId, targetType: 'api_key', targetId: id, ip, details: { name: body.name, scopes: body.scopes, prefix } });
        const [row] = await this.rows(tx, id);
        if (!row) throw new ProblemError('INTERNAL');
        return view(row, key);
      } catch (e) {
        if (e instanceof ProblemError) throw e;
        if (isUniqueViolation(e)) throw new ProblemError('CONFLICT', `an API key named "${body.name}" exists`);
        throw e;
      }
    });
  }

  async revoke(t: TenantRequestContext, id: string, ip: string) {
    authorize(t, 'tenant.config.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const r = await tx.execute(sql`UPDATE api_keys SET revoked_at = coalesce(revoked_at, now()) WHERE id = ${id}`);
      if ((r.rowCount ?? 0) === 0) throw new ProblemError('NOT_FOUND');
      await audit(tx, t.tenant.id, { action: 'api_key.revoked', actorId: t.principal.userId, targetType: 'api_key', targetId: id, ip });
      const [row] = await this.rows(tx, id);
      if (!row) throw new ProblemError('NOT_FOUND');
      return view(row);
    });
  }
}
