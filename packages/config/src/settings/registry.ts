import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';
import { deriveAccent } from './brand';

// Configuration key registry (ADR-0011 §1). Every key is declared here with its JSON Schema, platform
// default, the layers that may override it and its owning module. Unregistered keys cannot be read or
// written. Each layer stores a partial object; the effective value is the deep merge of the layers and must
// satisfy the full schema.

export type ConfigScope = 'tenant' | 'team' | 'user';
export const CONFIG_SCOPES: readonly ConfigScope[] = ['tenant', 'team', 'user'];

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

export interface ConfigKeyDef {
  key: string;
  module: string;
  schemaVersion: number;
  description: string;
  schema: JsonObject;
  default: JsonObject;
  overridableAt: readonly ConfigScope[];
  /** Upgrades a stored value written with schema version `from` to `from + 1` (lazy on read, kept on write). */
  upgrades?: Readonly<Record<number, (v: JsonObject) => JsonObject>>;
  /** Whether the tenant layer travels in configuration bundles (export, import, blueprints). Default true. */
  portable?: boolean;
  /** Properties that refer to tenant-local data (e.g. an uploaded asset) and are left out of bundles. */
  localProperties?: readonly string[];
  /** Checks JSON Schema cannot express (IANA time zones, derivable brand colors). Returns error messages. */
  check?: (effective: JsonObject) => { path: string; message: string }[];
}

export const NOTIFICATION_KINDS = ['mention', 'assigned', 'automation'] as const;
export const NOTIFICATION_CHANNELS = ['in_app', 'email'] as const;

const timeZones = new Set(Intl.supportedValuesOf('timeZone'));
// Intl lists canonical zones only; UTC and Etc/* aliases are valid IANA names too.
for (const z of ['UTC', 'Etc/UTC', 'Etc/GMT']) timeZones.add(z);
const currencies = new Set(Intl.supportedValuesOf('currency'));

const channels: JsonObject = { type: 'array', items: { enum: [...NOTIFICATION_CHANNELS] }, uniqueItems: true, maxItems: 2 };

export const CONFIG_KEYS: readonly ConfigKeyDef[] = [
  {
    key: 'locale',
    module: 'core',
    schemaVersion: 1,
    description: 'Language, time zone and date/time display (CFG-07).',
    overridableAt: ['tenant', 'user'],
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['language', 'timezone', 'dateFormat', 'timeFormat', 'weekStart'],
      properties: {
        language: { enum: ['tr', 'en'] },
        timezone: { type: 'string', minLength: 1, maxLength: 64 },
        dateFormat: { enum: ['dmy', 'mdy', 'ymd'] },
        timeFormat: { enum: ['24h', '12h'] },
        weekStart: { enum: ['monday', 'sunday'] },
      },
    },
    default: { language: 'tr', timezone: 'Europe/Istanbul', dateFormat: 'dmy', timeFormat: '24h', weekStart: 'monday' },
    check: (v) => (typeof v.timezone === 'string' && !timeZones.has(v.timezone) ? [{ path: '/timezone', message: 'unknown IANA time zone' }] : []),
  },
  {
    key: 'currency',
    module: 'core',
    schemaVersion: 1,
    description: 'Tenant currency (CFG-07). Amounts are never converted.',
    overridableAt: ['tenant'],
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'decimals'],
      properties: { code: { type: 'string', pattern: '^[A-Z]{3}$' }, decimals: { type: 'integer', minimum: 0, maximum: 4 } },
    },
    default: { code: 'TRY', decimals: 2 },
    check: (v) => (typeof v.code === 'string' && !currencies.has(v.code) ? [{ path: '/code', message: 'unknown ISO 4217 currency' }] : []),
  },
  {
    key: 'brand',
    module: 'core',
    schemaVersion: 1,
    description: 'Tenant accent color and logo (CFG-06). The accent must pass the contrast checks.',
    overridableAt: ['tenant'],
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['accent', 'logoAssetId'],
      properties: {
        accent: { anyOf: [{ type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' }, { type: 'null' }] },
        logoAssetId: { anyOf: [{ type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' }, { type: 'null' }] },
      },
    },
    default: { accent: null, logoAssetId: null },
    localProperties: ['logoAssetId'],
    check: (v) => {
      if (typeof v.accent !== 'string') return [];
      const d = deriveAccent(v.accent);
      return d.ok ? [] : [{ path: '/accent', message: 'BRAND_CONTRAST_UNSATISFIABLE' }];
    },
  },
  {
    key: 'ui',
    module: 'core',
    schemaVersion: 1,
    description: 'Theme and density. The tenant sets the default, each user may override it.',
    overridableAt: ['tenant', 'user'],
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['theme', 'density'],
      properties: { theme: { enum: ['system', 'light', 'dark'] }, density: { enum: ['comfortable', 'compact'] } },
    },
    default: { theme: 'system', density: 'comfortable' },
  },
  {
    key: 'notifications.defaults',
    module: 'core',
    schemaVersion: 1,
    description: 'Default channels per notification kind, used for users who have not chosen their own.',
    overridableAt: ['tenant'],
    schema: {
      type: 'object',
      additionalProperties: false,
      required: [...NOTIFICATION_KINDS],
      properties: Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k, channels])),
    },
    default: { mention: ['in_app'], assigned: ['in_app'], automation: ['in_app'] },
  },
  {
    key: 'onboarding',
    module: 'core',
    schemaVersion: 1,
    description: 'Onboarding state (docs/p7-plan.md §8). New tenants start pending; older tenants count as completed.',
    overridableAt: ['tenant'],
    portable: false,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'blueprint'],
      properties: {
        status: { enum: ['pending', 'completed', 'skipped'] },
        blueprint: { anyOf: [{ type: 'string', pattern: '^[a-z][a-z0-9-]{1,63}$' }, { type: 'null' }] },
      },
    },
    default: { status: 'completed', blueprint: null },
  },
];

const BY_KEY = new Map(CONFIG_KEYS.map((k) => [k.key, k]));

export function configKey(key: string): ConfigKeyDef | undefined {
  return BY_KEY.get(key);
}

// ---------------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------------

const ajv = new Ajv2020({ strict: true, allErrors: true });

/** A layer stores only the properties it overrides: the same schema without `required`. */
function partialSchema(schema: JsonObject): JsonObject {
  const rest: JsonObject = { ...schema };
  delete rest.required;
  return rest;
}

const compiled = new Map<string, { full: ValidateFunction; layer: ValidateFunction }>(
  CONFIG_KEYS.map((k) => [k.key, { full: ajv.compile(k.schema), layer: ajv.compile(partialSchema(k.schema)) }]),
);

export interface ConfigIssue {
  path: string;
  message: string;
}

const issues = (errors: ErrorObject[] | null | undefined): ConfigIssue[] =>
  (errors ?? []).map((e) => ({
    path: e.keyword === 'additionalProperties' ? `${e.instancePath}/${String((e.params as { additionalProperty?: string }).additionalProperty)}` : e.instancePath || '/',
    message: e.message ?? e.keyword,
  }));

/** Validates one layer value (partial) and the effective value it produces (full schema + semantic checks). */
export function validateConfig(def: ConfigKeyDef, layerValue: unknown, effective: JsonObject): ConfigIssue[] {
  const v = compiled.get(def.key);
  if (!v) return [{ path: '/', message: 'unregistered key' }];
  if (!v.layer(layerValue)) return issues(v.layer.errors);
  if (!v.full(effective)) return issues(v.full.errors);
  return def.check ? def.check(effective) : [];
}

/** Applies the registered upgrades to a value stored with an older schema version. */
export function upgradeValue(def: ConfigKeyDef, value: JsonObject, from: number): JsonObject {
  let out = value;
  for (let v = from; v < def.schemaVersion; v += 1) {
    const up = def.upgrades?.[v];
    if (!up) throw new Error(`config ${def.key}: no upgrade from schema version ${String(v)}`);
    out = up(out);
  }
  return out;
}
