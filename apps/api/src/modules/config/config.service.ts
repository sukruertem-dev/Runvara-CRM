import { Inject, Injectable } from '@nestjs/common';
import { can } from '@flexa/authz';
import {
  CONFIG_KEYS, configKey, deriveAccent, diffJson, mergeLayer, resolveLayers, upgradeValue, validateConfig,
  type ConfigKeyDef, type JsonObject, type LayerValue, type PatchOp,
} from '@flexa/config';
import { sql, type Db, type DbHandle } from '@flexa/db';
import { audit } from '../../common/audit';
import { authorize } from '../../common/authorize';
import { ProblemError } from '../../common/problem';
import { dbCtx, type ClientInfo, type TenantRequestContext } from '../../common/request-context';
import { DB } from '../../infra/tokens';

// Layered configuration (ADR-0011, docs/p7-plan.md §1–2). Tenant layer: `tenant.config.read` to read,
// `tenant.config.manage` to write (Matrix A A02). User layer: always the authenticated caller — the scope id
// is never taken from the request.

export type WriteScope = 'tenant' | 'user';

type LayerRow = {
  key: string;
  scope_type: WriteScope;
  version: number;
  value: JsonObject;
  schema_version: number;
  created_at: string;
  created_by: string | null;
  created_by_name: string | null;
};

export interface Who {
  id: string;
  name: string;
}

const who = (id: string | null, name: string | null): Who | null => (id ? { id, name: name ?? '' } : null);

/** Tenant columns that other code reads directly (SLA calendars, relative dates, mail locale). */
const LANGUAGE_LOCALE: Record<string, string> = { tr: 'tr-TR', en: 'en-US' };

@Injectable()
export class ConfigService {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  // -------------------------------------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------------------------------------

  async effective(t: TenantRequestContext) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const rows = await this.heads(tx, t);
      const data: Record<string, { value: JsonObject; sources: Record<string, string> }> = {};
      for (const def of CONFIG_KEYS) data[def.key] = resolveLayers(def.default, this.layersOf(def, rows));
      const brand = data.brand?.value ?? {};
      const accent = typeof brand.accent === 'string' ? deriveAccent(brand.accent) : null;
      let logo: { assetId: string; mime: string } | null = null;
      if (typeof brand.logoAssetId === 'string') {
        const a = (await tx.execute<{ id: string; mime: string }>(sql`SELECT id, mime FROM tenant_assets WHERE id = ${brand.logoAssetId}`)).rows[0];
        logo = a ? { assetId: a.id, mime: a.mime } : null;
      }
      return { data, brand: { tokens: accent?.ok ? accent.themes : null, logo } };
    });
  }

  keys(t: TenantRequestContext) {
    this.canRead(t, 'tenant');
    return {
      data: CONFIG_KEYS.map((k) => ({ key: k.key, module: k.module, description: k.description, schemaVersion: k.schemaVersion, schema: k.schema, default: k.default, overridableAt: ['platform', ...k.overridableAt] })),
    };
  }

  async layer(t: TenantRequestContext, key: string, scope: WriteScope) {
    const def = this.def(key, scope);
    this.canRead(t, scope);
    return this.db.withTenant(dbCtx(t), (tx) => this.layerView(tx, t, def, scope));
  }

  async history(t: TenantRequestContext, key: string, scope: WriteScope) {
    const def = this.def(key, scope);
    this.canRead(t, scope);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const r = await tx.execute<{ version: number; value: JsonObject; schema_version: number; change_note: string | null; reverted_from: number | null; created_at: string; created_by: string | null; created_by_name: string | null }>(sql`
        SELECT s.version, s.value, s.schema_version, s.change_note, s.reverted_from, s.created_at, s.created_by, u.display_name AS created_by_name
        FROM tenant_settings s
        LEFT JOIN memberships m ON m.user_id = s.created_by
        LEFT JOIN users u ON u.id = m.user_id
        WHERE s.scope_type = ${scope} AND s.scope_id = ${this.scopeId(t, scope)} AND s.key = ${def.key}
        ORDER BY s.version DESC LIMIT 200`);
      const head = await this.headVersion(tx, t, def.key, scope);
      const rows = r.rows.map((x) => ({ ...x, value: this.upgraded(def, x.value, x.schema_version) }));
      return {
        current: head,
        data: rows.map((x, i) => ({
          version: x.version,
          value: x.value,
          patch: diffJson(rows[i + 1]?.value ?? {}, x.value),
          note: x.change_note,
          revertedFrom: x.reverted_from,
          createdAt: new Date(x.created_at).toISOString(),
          createdBy: who(x.created_by, x.created_by_name),
        })),
      };
    });
  }

  // -------------------------------------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------------------------------------

  async preview(t: TenantRequestContext, key: string, scope: WriteScope, value: JsonObject) {
    const def = this.def(key, scope);
    this.canWrite(t, scope);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const rows = await this.heads(tx, t, def.key);
      const current = rows.find((r) => r.scope_type === scope);
      const before = current ? this.upgraded(def, current.value, current.schema_version) : {};
      const effective = this.effectiveWith(def, rows, scope, value);
      const errors = validateConfig(def, value, effective);
      const brand = def.key === 'brand' && typeof effective.accent === 'string' ? deriveAccent(effective.accent) : null;
      return {
        valid: errors.length === 0,
        errors,
        patch: diffJson(before, value),
        before,
        after: value,
        brand: brand ? { input: brand.input, ok: brand.ok, adjusted: brand.ok ? brand.adjusted : false, tokens: brand.ok ? brand.themes : null, checks: brand.checks } : null,
      };
    });
  }

  async write(t: TenantRequestContext, key: string, scope: WriteScope, value: JsonObject, expected: number, note: string | undefined, client: ClientInfo, revertedFrom: number | null = null) {
    const def = this.def(key, scope);
    this.canWrite(t, scope);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const rows = await this.heads(tx, t, def.key, true);
      const current = rows.find((r) => r.scope_type === scope);
      const currentVersion = current?.version ?? 0;
      if (expected !== currentVersion) throw new ProblemError('PRECONDITION_FAILED', `current version is ${String(currentVersion)}`);
      const effective = this.effectiveWith(def, rows, scope, value);
      const errors = validateConfig(def, value, effective);
      if (errors.length > 0) {
        const contrastFailed = errors.some((e) => e.message === 'BRAND_CONTRAST_UNSATISFIABLE');
        throw new ProblemError(contrastFailed ? 'BRAND_CONTRAST_UNSATISFIABLE' : 'CONFIG_INVALID', errors.map((e) => `${e.path}: ${e.message}`).join('; '), {
          errors: errors.map((e) => ({ path: e.path, code: contrastFailed ? 'BRAND_CONTRAST_UNSATISFIABLE' : 'CONFIG_INVALID', message: e.message })),
        });
      }
      if (def.key === 'brand' && typeof value.logoAssetId === 'string') {
        const asset = (await tx.execute(sql`SELECT 1 FROM tenant_assets WHERE id = ${value.logoAssetId}`)).rows[0];
        if (!asset) throw new ProblemError('CONFIG_INVALID', '/logoAssetId: unknown asset', { errors: [{ path: '/logoAssetId', code: 'CONFIG_INVALID', message: 'unknown asset' }] });
      }
      const before = current ? this.upgraded(def, current.value, current.schema_version) : {};
      const version = currentVersion + 1;
      const scopeId = this.scopeId(t, scope);
      await tx.execute(sql`
        INSERT INTO tenant_settings (tenant_id, scope_type, scope_id, key, version, value, schema_version, created_by, change_note, reverted_from)
        VALUES (${t.tenant.id}, ${scope}, ${scopeId}, ${def.key}, ${version}, ${JSON.stringify(value)}::jsonb, ${def.schemaVersion},
                ${t.principal.userId}, ${note ?? null}, ${revertedFrom})`);
      await tx.execute(sql`
        INSERT INTO tenant_settings_head (tenant_id, scope_type, scope_id, key, version)
        VALUES (${t.tenant.id}, ${scope}, ${scopeId}, ${def.key}, ${version})
        ON CONFLICT (tenant_id, scope_type, scope_id, key) DO UPDATE SET version = EXCLUDED.version`);
      if (scope === 'tenant') await this.syncTenantColumns(tx, def.key, effective);
      const patch = diffJson(before, value);
      await audit(tx, t.tenant.id, {
        action: revertedFrom === null ? 'config.changed' : 'config.reverted',
        actorId: t.principal.userId,
        targetType: 'config',
        ip: client.ip,
        details: { key: def.key, scope, version, ...(revertedFrom === null ? {} : { revertedFrom }), patch: redact(patch), note: note ?? null },
      });
      // Realtime + webhooks/rules: which key changed, never its value.
      await tx.execute(sql`INSERT INTO outbox_events (tenant_id, type, actor, payload, correlation_id)
        VALUES (${t.tenant.id}, 'config.changed', ${JSON.stringify({ type: 'user', id: t.principal.userId })}::jsonb,
                ${JSON.stringify({ key: def.key, scope, version, ...(scope === 'user' ? { userId: t.principal.userId } : {}) })}::jsonb, gen_random_uuid())`);
      return this.layerView(tx, t, def, scope);
    });
  }

  async revert(t: TenantRequestContext, key: string, scope: WriteScope, target: number, expected: number, note: string | undefined, client: ClientInfo) {
    const def = this.def(key, scope);
    this.canWrite(t, scope);
    const row = await this.db.withTenant(dbCtx(t), async (tx) => (await tx.execute<{ value: JsonObject; schema_version: number }>(sql`
      SELECT value, schema_version FROM tenant_settings
      WHERE scope_type = ${scope} AND scope_id = ${this.scopeId(t, scope)} AND key = ${def.key} AND version = ${target}`)).rows[0]);
    if (!row) throw new ProblemError('NOT_FOUND', `version ${String(target)} does not exist`);
    // The old value is validated again: the schema or the brand checks may have changed since it was written.
    return this.write(t, key, scope, this.upgraded(def, row.value, row.schema_version), expected, note, client, target);
  }

  // -------------------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------------------

  private def(key: string, scope: WriteScope): ConfigKeyDef {
    const def = configKey(key);
    if (!def) throw new ProblemError('CONFIG_KEY_UNKNOWN', `unknown configuration key "${key}"`);
    if (!def.overridableAt.includes(scope)) throw new ProblemError('CONFIG_KEY_NOT_OVERRIDABLE', `"${key}" cannot be set at the ${scope} layer`);
    return def;
  }

  private canRead(t: TenantRequestContext, scope: WriteScope): void {
    if (scope === 'user') return;
    if (can(t.authz, 'tenant.config.manage').allow) return;
    authorize(t, 'tenant.config.read', 'read');
  }

  private canWrite(t: TenantRequestContext, scope: WriteScope): void {
    if (scope === 'tenant') authorize(t, 'tenant.config.manage');
  }

  private scopeId(t: TenantRequestContext, scope: WriteScope): string {
    return scope === 'tenant' ? t.tenant.id : t.principal.userId;
  }

  /** Current tenant and user layer rows (optionally of one key; `lock` serialises writers of that key). */
  private async heads(tx: Db, t: TenantRequestContext, key?: string, lock = false): Promise<LayerRow[]> {
    if (lock && key) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`config:${t.tenant.id}:${key}`}, 0))`);
    const r = await tx.execute<LayerRow>(sql`
      SELECT h.key, h.scope_type, h.version, s.value, s.schema_version, s.created_at, s.created_by, u.display_name AS created_by_name
      FROM tenant_settings_head h
      JOIN tenant_settings s USING (tenant_id, scope_type, scope_id, key, version)
      LEFT JOIN memberships m ON m.user_id = s.created_by
      LEFT JOIN users u ON u.id = m.user_id
      WHERE ((h.scope_type = 'tenant' AND h.scope_id = ${t.tenant.id}) OR (h.scope_type = 'user' AND h.scope_id = ${t.principal.userId}))
        ${key ? sql`AND h.key = ${key}` : sql``}`);
    return r.rows;
  }

  private async headVersion(tx: Db, t: TenantRequestContext, key: string, scope: WriteScope): Promise<number> {
    const r = await tx.execute<{ version: number }>(sql`SELECT version FROM tenant_settings_head WHERE scope_type = ${scope} AND scope_id = ${this.scopeId(t, scope)} AND key = ${key}`);
    return r.rows[0]?.version ?? 0;
  }

  private upgraded(def: ConfigKeyDef, value: JsonObject, schemaVersion: number): JsonObject {
    return schemaVersion < def.schemaVersion ? upgradeValue(def, value, schemaVersion) : value;
  }

  private layersOf(def: ConfigKeyDef, rows: readonly LayerRow[]): LayerValue[] {
    const out: LayerValue[] = [];
    for (const scope of ['tenant', 'user'] as const) {
      const row = rows.find((r) => r.key === def.key && r.scope_type === scope);
      if (row && def.overridableAt.includes(scope)) out.push({ scope, value: this.upgraded(def, row.value, row.schema_version) });
    }
    return out;
  }

  /** The effective value if `scope` held `value` (layers above it unchanged). */
  private effectiveWith(def: ConfigKeyDef, rows: readonly LayerRow[], scope: WriteScope, value: JsonObject): JsonObject {
    let eff = def.default;
    for (const layer of this.layersOf(def, rows)) {
      if (layer.scope === scope) continue;
      if (layer.scope === 'user' && scope === 'tenant') continue;
      eff = mergeLayer(eff, layer.value);
    }
    return mergeLayer(eff, value);
  }

  private async layerView(tx: Db, t: TenantRequestContext, def: ConfigKeyDef, scope: WriteScope) {
    const rows = await this.heads(tx, t, def.key);
    const row = rows.find((r) => r.scope_type === scope);
    // Effective value as this layer sees it: a tenant layer is shown without the caller's own overrides.
    const layers = this.layersOf(def, rows).filter((l) => scope === 'user' || l.scope !== 'user');
    const resolved = resolveLayers(def.default, layers);
    return {
      key: def.key,
      scope,
      version: row?.version ?? 0,
      value: row ? this.upgraded(def, row.value, row.schema_version) : {},
      effective: resolved.value,
      sources: resolved.sources,
      updatedAt: row ? new Date(row.created_at).toISOString() : null,
      updatedBy: row ? who(row.created_by, row.created_by_name) : null,
    };
  }

  private async syncTenantColumns(tx: Db, key: string, effective: JsonObject): Promise<void> {
    // Values were validated against the full schema before this runs, so the fields are strings.
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    if (key === 'locale') {
      const locale = LANGUAGE_LOCALE[str(effective.language)] ?? 'tr-TR';
      await tx.execute(sql`UPDATE tenants SET timezone = ${str(effective.timezone)}, locale = ${locale}`);
    } else if (key === 'currency') {
      await tx.execute(sql`UPDATE tenants SET currency = ${str(effective.code)}`);
    }
  }
}

/** Audit keeps the shape of the change; long values (none of today's keys are secret) are shortened. */
function redact(patch: PatchOp[]): PatchOp[] {
  return patch.map((p) => (p.op !== 'remove' && typeof p.value === 'string' && p.value.length > 200 ? { ...p, value: `${p.value.slice(0, 200)}…` } : p));
}
