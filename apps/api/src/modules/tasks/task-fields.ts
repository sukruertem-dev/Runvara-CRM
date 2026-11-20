import { compileFormula, evaluate, FormulaError, type Formula } from '@flexa/formula';
import { schema, sql, type Db } from '@flexa/db';
import type { FieldRegistry } from '@flexa/query-lang';
import { ProblemError } from '../../common/problem';

export type FieldDefRow = typeof schema.customFieldDefinitions.$inferSelect;

export type ResourceType = 'task' | 'account' | 'contact' | 'lead' | 'opportunity' | 'case';
export const RESOURCE_TYPES: readonly ResourceType[] = ['task', 'account', 'contact', 'lead', 'opportunity', 'case'];

/** Scalar attributes a formula may reference ({priority}, {due_at} …) in addition to {custom.cf_x}, per resource.
 *  The read path passes exactly these keys (snake_case) to the evaluator. */
export const FORMULA_SCALARS: Readonly<Record<ResourceType, readonly string[]>> = {
  task: ['priority', 'estimate_minutes', 'due_at', 'start_at', 'created_at', 'closed_at', 'title'],
  account: ['name', 'created_at'],
  contact: ['first_name', 'last_name', 'created_at'],
  lead: ['score', 'created_at'],
  opportunity: ['amount', 'probability', 'expected_close', 'created_at', 'closed_at'],
  case: ['priority', 'created_at', 'closed_at'],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function loadFieldDefs(tx: Db, resourceType: ResourceType): Promise<FieldDefRow[]> {
  const rows = await tx.select().from(schema.customFieldDefinitions);
  return rows.filter((d) => d.resourceType === resourceType).sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
}

function resourceOf(defs: readonly FieldDefRow[], fallback: ResourceType): ResourceType {
  const rt = defs[0]?.resourceType;
  return (RESOURCE_TYPES as readonly string[]).includes(rt ?? '') ? (rt as ResourceType) : fallback;
}

export function formulaRefs(defs: readonly FieldDefRow[], resourceType: ResourceType = resourceOf(defs, 'task')): Set<string> {
  return new Set<string>([...FORMULA_SCALARS[resourceType], ...defs.filter((d) => d.type !== 'formula').map((d) => `custom.${d.key}`)]);
}

export function compileDefFormula(source: string, defs: readonly FieldDefRow[], resourceType: ResourceType): Formula {
  try {
    return compileFormula(source, formulaRefs(defs, resourceType));
  } catch (e) {
    if (e instanceof FormulaError) throw new ProblemError('FORMULA_INVALID', e.message, { formulaCode: e.code, position: e.position });
    throw e;
  }
}

function invalid(key: string, reason: string): ProblemError {
  return new ProblemError('CUSTOM_FIELD_INVALID', `${key}: ${reason}`, { field: key });
}

/** Validates a custom-value patch against active definitions. Unknown or formula keys are rejected;
 *  `null` clears a value (unless required). Returns the normalised values. */
export async function validateCustom(
  tx: Db,
  defs: readonly FieldDefRow[],
  input: Readonly<Record<string, unknown>>,
  mode: 'create' | 'update',
): Promise<Record<string, unknown>> {
  const active = new Map(defs.filter((d) => !d.archivedAt).map((d) => [d.key, d]));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const def = active.get(key);
    if (!def) throw new ProblemError('CUSTOM_FIELD_UNKNOWN', `unknown custom field "${key}"`, { field: key });
    if (def.type === 'formula') throw invalid(key, 'formula fields are computed and cannot be written');
    if (value === null) {
      if (def.required) throw invalid(key, 'required');
      out[key] = null;
      continue;
    }
    out[key] = await normalise(tx, def, value);
  }
  if (mode === 'create') {
    for (const def of active.values()) {
      if (def.type === 'formula' || key_in(out, def.key)) continue;
      if (def.defaultValue !== null && def.defaultValue !== undefined) out[def.key] = await normalise(tx, def, def.defaultValue);
      else if (def.required) throw invalid(def.key, 'required');
    }
  }
  return out;
}

const key_in = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

async function normalise(tx: Db, def: FieldDefRow, value: unknown): Promise<unknown> {
  const options = new Set(def.options.map((o) => o.id));
  switch (def.type) {
    case 'text':
      if (typeof value !== 'string' || value.length > 10_000) throw invalid(def.key, 'expected text (≤ 10 000 chars)');
      return value;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(def.key, 'expected a finite number');
      return value;
    case 'date':
      if (typeof value !== 'string' || !ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw invalid(def.key, 'expected YYYY-MM-DD');
      return value;
    case 'select':
      if (typeof value !== 'string' || !options.has(value)) throw invalid(def.key, 'unknown option');
      return value;
    case 'multi_select': {
      if (!Array.isArray(value) || value.length > 200 || value.some((v) => typeof v !== 'string' || !options.has(v))) throw invalid(def.key, 'expected known option ids');
      return [...new Set(value as string[])];
    }
    case 'user': {
      if (typeof value !== 'string' || !UUID.test(value)) throw invalid(def.key, 'expected a user id');
      const r = await tx.execute(sql`SELECT 1 FROM memberships WHERE user_id = ${value} AND status = 'active'`);
      if ((r.rowCount ?? 0) === 0) throw invalid(def.key, 'user is not a member of this workspace');
      return value;
    }
    case 'relation': {
      const ref = value as { type?: unknown; id?: unknown };
      if (typeof ref !== 'object' || ref.type !== def.relationTarget || typeof ref.id !== 'string' || !UUID.test(ref.id)) throw invalid(def.key, `expected {type: "${def.relationTarget ?? ''}", id}`);
      const r = await tx.execute(sql`SELECT 1 FROM record_registry WHERE record_type = ${ref.type} AND record_id = ${ref.id} AND deleted_at IS NULL`);
      if ((r.rowCount ?? 0) === 0) throw invalid(def.key, 'related record not found');
      return { type: ref.type, id: ref.id };
    }
    case 'formula':
      throw invalid(def.key, 'formula fields are computed');
  }
}

/** Adds computed formula values to a record's custom map (read path). Failing formulas yield null. */
export function withFormulas(defs: readonly FieldDefRow[], formulas: ReadonlyMap<string, Formula>, task: Record<string, unknown>, custom: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of defs) {
    if (d.archivedAt) continue;
    if (d.type === 'formula') {
      const f = formulas.get(d.key);
      const record: Record<string, unknown> = { ...task };
      for (const [k, v] of Object.entries(custom)) record[`custom.${k}`] = v;
      try {
        out[d.key] = f ? evaluate(f, record) : null;
      } catch {
        out[d.key] = null;
      }
    } else if (key_in(custom, d.key)) {
      out[d.key] = custom[d.key];
    }
  }
  return out;
}

export function compileFormulas(defs: readonly FieldDefRow[]): Map<string, Formula> {
  const m = new Map<string, Formula>();
  for (const d of defs) {
    if (d.type !== 'formula' || d.archivedAt || !d.formula) continue;
    try {
      m.set(d.key, compileFormula(d.formula, formulaRefs(defs)));
    } catch {
      // A definition saved before a referenced field was archived: evaluated as null, never thrown on read.
    }
  }
  return m;
}

/** RQL field registry for tasks (alias t = tasks, s = statuses). Archived/formula custom fields are not
 *  queryable, so filtering on them yields UNKNOWN_FIELD exactly like a non-existent field. */
export function taskRegistry(defs: readonly FieldDefRow[]): FieldRegistry {
  const reg: Record<string, FieldRegistry[string]> = {
    title: { sql: sql`t.title`, type: 'text', sortable: true, nullable: false },
    status: { sql: sql`s.key`, type: 'text', sortable: false, nullable: false },
    statusCategory: { sql: sql`s.category`, type: 'enum', enumValues: ['open', 'in_progress', 'closed'], sortable: true, nullable: false },
    priority: { sql: sql`t.priority`, type: 'number', sortable: true, nullable: false },
    owner: { sql: sql`t.owner_user_id`, type: 'user', sortable: false },
    assignee: { sql: sql`t.assignee_user_id`, type: 'user', sortable: false },
    queue: { sql: sql`t.queue_id`, type: 'uuid', sortable: false },
    createdBy: { sql: sql`t.created_by`, type: 'user', sortable: false },
    due: { sql: sql`t.due_at`, type: 'datetime', sortable: true },
    start: { sql: sql`t.start_at`, type: 'datetime', sortable: true },
    created: { sql: sql`t.created_at`, type: 'datetime', sortable: true, nullable: false },
    updated: { sql: sql`t.updated_at`, type: 'datetime', sortable: true, nullable: false },
    closed: { sql: sql`t.closed_at`, type: 'datetime', sortable: true },
    parent: { sql: sql`t.parent_id`, type: 'uuid', sortable: false },
    relatedType: { sql: sql`t.related_type`, type: 'text', sortable: false },
    related: { sql: sql`t.related_id`, type: 'uuid', sortable: false },
    estimate: { sql: sql`t.estimate_minutes`, type: 'number', sortable: true },
    position: { sql: sql`t.position`, type: 'text', sortable: true, nullable: false },
  };
  return { ...reg, ...customFieldRegistry(defs, 't') };
}

/** Queryable custom fields of a resource, on table alias `alias`. */
export function customFieldRegistry(defs: readonly FieldDefRow[], alias: 't'): FieldRegistry {
  const reg: Record<string, FieldRegistry[string]> = {};
  const a = sql.raw(alias); // a literal type, never user input
  for (const d of defs) {
    if (d.archivedAt || d.type === 'formula' || d.type === 'relation' || d.type === 'multi_select') continue;
    // Keys are constrained to ^cf_[a-z0-9_]{1,45}$ by the database CHECK; re-checked here because the
    // key is embedded as a literal (so expression indexes on custom->>'cf_x' can be used).
    if (!/^cf_[a-z0-9_]{1,45}$/.test(d.key)) continue;
    const k = sql.raw(`'${d.key}'`);
    const name = `custom.${d.key}`;
    if (d.type === 'number') reg[name] = { sql: sql`(${a}.custom->>${k})::numeric`, type: 'number', sortable: d.indexed };
    else if (d.type === 'date') reg[name] = { sql: sql`(${a}.custom->>${k})::date`, type: 'date', sortable: d.indexed };
    else if (d.type === 'user') reg[name] = { sql: sql`(${a}.custom->>${k})::uuid`, type: 'user', sortable: false };
    else if (d.type === 'select') reg[name] = { sql: sql`${a}.custom->>${k}`, type: 'enum', enumValues: d.options.map((o) => o.id), sortable: d.indexed };
    else reg[name] = { sql: sql`${a}.custom->>${k}`, type: 'text', sortable: d.indexed };
  }
  return reg;
}
