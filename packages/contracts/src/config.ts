import { z } from 'zod';
import { Uuid } from './schemas';

// P7a: layered tenant configuration, branding and user preferences (ADR-0011, docs/p7-plan.md §1–4).

export const ConfigKeyName = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/).max(64);
/** Writable layers over the API. The team layer exists in the engine; its first keys arrive with teams in P8. */
export const ConfigWriteScope = z.enum(['tenant', 'user']);
export const ConfigSource = z.enum(['platform', 'tenant', 'team', 'user']);

const JsonObject = z.record(z.string(), z.unknown());

export const PatchOp = z
  .object({ op: z.enum(['add', 'remove', 'replace']), path: z.string(), value: z.unknown().optional() })
  .openapi('JsonPatchOp');

export const ConfigWrite = z
  .object({ value: JsonObject, note: z.string().trim().max(500).optional() })
  .strict()
  .openapi('ConfigWrite');

export const ConfigRevert = z
  .object({ version: z.number().int().min(1), note: z.string().trim().max(500).optional() })
  .strict()
  .openapi('ConfigRevert');

export const ConfigIssue = z.object({ path: z.string(), message: z.string() }).openapi('ConfigIssue');

const Palette = z.object({ accent: z.string(), 'accent-hover': z.string(), 'accent-soft': z.string(), 'accent-btn': z.string(), 'accent-btn-hover': z.string() });
export const BrandTokens = z.object({ light: Palette, dark: Palette }).openapi('BrandTokens');
export const AccentCheckView = z
  .object({ theme: z.enum(['light', 'dark']), fg: z.string(), bg: z.string(), min: z.number(), ratio: z.number(), pass: z.boolean() })
  .openapi('AccentCheck');
export const BrandDerivation = z
  .object({ input: z.string(), ok: z.boolean(), adjusted: z.boolean(), tokens: BrandTokens.nullable(), checks: z.array(AccentCheckView) })
  .openapi('BrandDerivation');

export const ConfigLayerView = z
  .object({
    key: z.string(),
    scope: ConfigWriteScope,
    /** 0 = this layer has never been written (If-Match: "0" for the first write). */
    version: z.number().int(),
    value: JsonObject,
    effective: JsonObject,
    sources: z.record(z.string(), ConfigSource),
    updatedAt: z.string().nullable(),
    updatedBy: z.object({ id: Uuid, name: z.string() }).nullable(),
  })
  .openapi('ConfigLayer');

export const ConfigEffectiveResponse = z
  .object({
    data: z.record(z.string(), z.object({ value: JsonObject, sources: z.record(z.string(), ConfigSource) })),
    brand: z.object({ tokens: BrandTokens.nullable(), logo: z.object({ assetId: Uuid, mime: z.string() }).nullable() }),
  })
  .openapi('ConfigEffective');

export const ConfigKeyView = z
  .object({ key: z.string(), module: z.string(), description: z.string(), schemaVersion: z.number().int(), schema: JsonObject, default: JsonObject, overridableAt: z.array(ConfigSource) })
  .openapi('ConfigKey');
export const ConfigKeysResponse = z.object({ data: z.array(ConfigKeyView) }).openapi('ConfigKeysResponse');

export const ConfigPreviewResponse = z
  .object({
    valid: z.boolean(),
    errors: z.array(ConfigIssue),
    patch: z.array(PatchOp),
    before: JsonObject,
    after: JsonObject,
    brand: BrandDerivation.nullable(),
  })
  .openapi('ConfigPreview');

export const ConfigVersionView = z
  .object({
    version: z.number().int(),
    value: JsonObject,
    patch: z.array(PatchOp),
    note: z.string().nullable(),
    revertedFrom: z.number().int().nullable(),
    createdAt: z.string(),
    createdBy: z.object({ id: Uuid, name: z.string() }).nullable(),
  })
  .openapi('ConfigVersion');
export const ConfigHistoryResponse = z.object({ data: z.array(ConfigVersionView), current: z.number().int() }).openapi('ConfigHistory');

export const LOGO_MAX_BYTES = 524288;
export const BrandLogoUpload = z
  .object({ mime: z.enum(['image/png', 'image/webp', 'image/svg+xml']), dataBase64: z.string().min(4).max(Math.ceil(LOGO_MAX_BYTES / 3) * 4 + 4) })
  .strict()
  .openapi('BrandLogoUpload');
export const BrandLogoView = z.object({ assetId: Uuid, mime: z.string(), sizeBytes: z.number().int(), sanitized: z.boolean() }).openapi('BrandLogo');
