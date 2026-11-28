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

export const NOTIFICATION_KINDS = ['mention', 'assigned', 'automation', 'approval'] as const;
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
    default: { mention: ['in_app'], assigned: ['in_app'], automation: ['in_app'], approval: ['in_app'] },
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
  {
    key: 'privacy',
    module: 'core',
    schemaVersion: 1,
    description: 'Data protection (TEN-05): days between a deletion request and the deletion itself (7 to 90).',
    overridableAt: ['tenant'],
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['deletionGraceDays'],
      properties: { deletionGraceDays: { type: 'integer', minimum: 7, maximum: 90 } },
    },
    default: { deletionGraceDays: 30 },
  },
  {
    key: 'notifications.quiet',
    module: 'core',
    schemaVersion: 1,
    description: 'Do-not-disturb hours in the person’s time zone (MEN-07): no push, no e-mail, no toast; notices wait in the app.',
    overridableAt: ['tenant', 'user'],
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['enabled', 'from', 'to'],
      properties: {
        enabled: { type: 'boolean' },
        from: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' },
        to: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' },
      },
    },
    default: { enabled: false, from: '22:00', to: '07:00' },
  },
  {
    key: 'mentions',
    module: 'core',
    schemaVersion: 1,
    description: 'Mentions (A12): whether mentioning someone without access gives them read access to the record.',
    overridableAt: ['tenant'],
    schema: { type: 'object', additionalProperties: false, required: ['grantAccess'], properties: { grantAccess: { type: 'boolean' } } },
    default: { grantAccess: false },
  },
  {
    key: 'sales_b2b.quote_template',
    module: 'sales_b2b',
    schemaVersion: 1,
    description: 'Quotes: number prefix, validity in days, and the standard introduction, terms and footer.',
    overridableAt: ['tenant'],
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['prefix', 'validDays', 'intro', 'terms', 'footer'],
      properties: {
        prefix: { type: 'string', pattern: '^[A-Z0-9]{1,10}$' },
        validDays: { type: 'integer', minimum: 1, maximum: 365 },
        intro: { type: 'string', maxLength: 4000 },
        terms: { type: 'string', maxLength: 8000 },
        footer: { type: 'string', maxLength: 300 },
      },
    },
    default: { prefix: 'T', validDays: 30, intro: '', terms: '', footer: '' },
  },
  {
    key: 'sales_b2b.activity_rules',
    module: 'sales_b2b',
    schemaVersion: 1,
    description: 'B2B activity rules (TRK-05): days without a touch before an open opportunity is flagged, and whether moving it to another open stage needs an open next-step task.',
    overridableAt: ['tenant'],
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['staleDays', 'requireNextStep'],
      properties: { staleDays: { type: 'integer', minimum: 1, maximum: 90 }, requireNextStep: { type: 'boolean' } },
    },
    default: { staleDays: 7, requireNextStep: false },
  },
  {
    key: 'sales_b2c.consent_channels',
    module: 'sales_b2c',
    schemaVersion: 1,
    description: 'B2C channels the workspace uses for customer communication (B2C-06); consent is kept per channel, a turned-off channel reaches no one.',
    overridableAt: ['tenant'],
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['channels'],
      properties: { channels: { type: 'array', uniqueItems: true, maxItems: 4, items: { enum: ['email', 'sms', 'phone', 'whatsapp'] } } },
    },
    default: { channels: ['email', 'sms', 'phone', 'whatsapp'] },
  },
  {
    key: 'sales_b2c.order_workflow',
    module: 'sales_b2c',
    schemaVersion: 1,
    description: 'B2C order workflow (B2C-03): the roles that may take each step (confirm, prepare, ship, deliver, cancel) and change the payment status.',
    overridableAt: ['tenant'],
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['confirm', 'prepare', 'ship', 'deliver', 'cancel', 'payment'],
      properties: Object.fromEntries(['confirm', 'prepare', 'ship', 'deliver', 'cancel', 'payment'].map((k) => [k, {
        type: 'array', uniqueItems: true, maxItems: 10, items: { enum: ['admin', 'manager', 'sales_rep', 'call_agent', 'analyst'] },
      }])),
    },
    default: {
      confirm: ['admin', 'manager', 'sales_rep', 'call_agent'], prepare: ['admin', 'manager'], ship: ['admin', 'manager'], deliver: ['admin', 'manager'],
      cancel: ['admin', 'manager', 'sales_rep'], payment: ['admin', 'manager', 'sales_rep', 'call_agent'],
    },
  },
  {
    key: 'sales_b2c.returns',
    module: 'sales_b2c',
    schemaVersion: 1,
    description: 'Returns (B2C-05): the amount up to which a team Manager approves a return (in the order currency); above it an Admin decides.',
    overridableAt: ['tenant'],
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['managerLimit'],
      properties: { managerLimit: { type: 'string', pattern: '^[0-9]{1,14}(\\.[0-9]{1,4})?$' } },
    },
    default: { managerLimit: '5000' },
  },
  {
    key: 'sales_b2c.rfm',
    module: 'sales_b2c',
    schemaVersion: 1,
    description: 'RFM (B2C-07): the window of orders counted (days) and the days without an order after which a customer is hibernating.',
    overridableAt: ['tenant'],
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['windowDays', 'hibernatingDays'],
      properties: { windowDays: { type: 'integer', minimum: 30, maximum: 1095 }, hibernatingDays: { type: 'integer', minimum: 14, maximum: 730 } },
    },
    default: { windowDays: 365, hibernatingDays: 120 },
  },
  {
    key: 'sales_b2c.automations',
    module: 'sales_b2c',
    schemaVersion: 1,
    description: 'Built-in B2C automations (B2C-07): an abandoned order, a repeat purchase reminder, a win-back task; e-mails go only to customers with e-mail consent.',
    overridableAt: ['tenant'],
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['abandonedOrder', 'repeatPurchase', 'winback'],
      properties: {
        abandonedOrder: {
          type: 'object', additionalProperties: false, required: ['enabled', 'afterHours', 'subject', 'body'],
          properties: { enabled: { type: 'boolean' }, afterHours: { type: 'integer', minimum: 1, maximum: 720 }, subject: { type: 'string', minLength: 1, maxLength: 200 }, body: { type: 'string', minLength: 1, maxLength: 5000 } },
        },
        repeatPurchase: {
          type: 'object', additionalProperties: false, required: ['enabled', 'afterDays', 'subject', 'body'],
          properties: { enabled: { type: 'boolean' }, afterDays: { type: 'integer', minimum: 1, maximum: 365 }, subject: { type: 'string', minLength: 1, maxLength: 200 }, body: { type: 'string', minLength: 1, maxLength: 5000 } },
        },
        winback: {
          type: 'object', additionalProperties: false, required: ['enabled', 'task', 'subject', 'body'],
          properties: { enabled: { type: 'boolean' }, task: { type: 'boolean' }, subject: { type: 'string', minLength: 1, maxLength: 200 }, body: { type: 'string', minLength: 1, maxLength: 5000 } },
        },
      },
    },
    default: {
      abandonedOrder: { enabled: false, afterHours: 24, subject: 'Siparişiniz sizi bekliyor', body: 'Siparişinizi tamamlamak için bizimle iletişime geçebilirsiniz.' },
      repeatPurchase: { enabled: false, afterDays: 30, subject: 'Yeniden görmek isteriz', body: 'Son siparişinizden memnun kaldıysanız yeni ürünlerimize göz atın.' },
      winback: { enabled: false, task: true, subject: 'Sizi özledik', body: 'Uzun zamandır görüşemedik; size özel fırsatlarımız var.' },
    },
  },
  {
    key: 'approvals',
    module: 'core',
    schemaVersion: 1,
    description: 'Discount approval (ADR-0021): the discount that needs no approval, the default limit of a manager, and the hours until a request moves up.',
    overridableAt: ['tenant'],
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['discount'],
      properties: {
        discount: {
          type: 'object',
          additionalProperties: false,
          required: ['freePercent', 'managerPercent', 'timeoutHours'],
          properties: {
            freePercent: { type: 'number', minimum: 0, maximum: 100 },
            managerPercent: { type: 'number', minimum: 0, maximum: 100 },
            timeoutHours: { type: 'integer', minimum: 1, maximum: 720 },
          },
        },
      },
    },
    default: { discount: { freePercent: 8, managerPercent: 15, timeoutHours: 24 } },
    check: (v) => {
      const d = v.discount as { freePercent?: unknown; managerPercent?: unknown } | undefined;
      return typeof d?.freePercent === 'number' && typeof d.managerPercent === 'number' && d.managerPercent < d.freePercent
        ? [{ path: '/discount/managerPercent', message: 'must not be below freePercent' }]
        : [];
    },
  },
  {
    key: 'security',
    module: 'core',
    schemaVersion: 1,
    description: 'Security policies (TEN-04): two-factor requirement, password rules, session length and single sign-on.',
    overridableAt: ['tenant'],
    // "SSO required" copied into a workspace without its providers would lock everyone out: never bundled.
    portable: false,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['mfa', 'password', 'session', 'sso'],
      properties: {
        mfa: {
          type: 'object',
          additionalProperties: false,
          required: ['require', 'ssoSatisfies'],
          properties: { require: { enum: ['off', 'admins', 'all'] }, ssoSatisfies: { type: 'boolean' } },
        },
        password: {
          type: 'object',
          additionalProperties: false,
          required: ['minLength', 'requireMixed', 'maxAgeDays'],
          properties: {
            minLength: { type: 'integer', minimum: 12, maximum: 64 },
            requireMixed: { type: 'boolean' },
            maxAgeDays: { type: 'integer', minimum: 0, maximum: 365 },
          },
        },
        session: {
          type: 'object',
          additionalProperties: false,
          required: ['idleMinutes', 'maxHours'],
          properties: { idleMinutes: { type: 'integer', minimum: 15, maximum: 43_200 }, maxHours: { type: 'integer', minimum: 1, maximum: 720 } },
        },
        sso: {
          type: 'object',
          additionalProperties: false,
          required: ['required', 'adminPasswordFallback'],
          properties: { required: { type: 'boolean' }, adminPasswordFallback: { type: 'boolean' } },
        },
      },
    },
    default: {
      mfa: { require: 'off', ssoSatisfies: true },
      password: { minLength: 12, requireMixed: false, maxAgeDays: 0 },
      session: { idleMinutes: 10_080, maxHours: 720 },
      sso: { required: false, adminPasswordFallback: true },
    },
    check: (v) => {
      const password = v.password as { maxAgeDays?: unknown } | undefined;
      const age = password?.maxAgeDays;
      return typeof age === 'number' && age > 0 && age < 30 ? [{ path: '/password/maxAgeDays', message: 'must be 0 (off) or between 30 and 365' }] : [];
    },
  },
];

/** Effective `security` value (docs/p7-plan.md §18). */
export interface SecurityPolicy {
  mfa: { require: 'off' | 'admins' | 'all'; ssoSatisfies: boolean };
  password: { minLength: number; requireMixed: boolean; maxAgeDays: number };
  session: { idleMinutes: number; maxHours: number };
  sso: { required: boolean; adminPasswordFallback: boolean };
}

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
