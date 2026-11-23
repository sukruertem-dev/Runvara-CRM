import { configKey, diffJson, mergeLayer, validateConfig, type JsonObject, type PatchOp } from '@flexa/config';
import type { BundlePlan, ConfigBundleValue, z } from '@flexa/contracts';
import { entitled, getModule, isModuleId } from '@flexa/modules';
import { SlaError, validateCalendar, type BusinessCalendar } from '@flexa/sla';
import { ProblemError } from '../../common/problem';
import { buildTaskWorkflow, checkCustomField } from '../tasks/config-defs';

// Dry run of a configuration bundle against the tenant's current configuration (ADR-0011 §3, docs/p7-plan.md
// §7). Pure: the caller exports the tenant's state as a bundle and passes both. Items are matched by natural
// key. Settings are versioned and revertible, so a different value is an `update`; for every other
// definition a different value under the same key is a `conflict` the import may keep. Missing module
// dependencies, modules outside the plan, missing SLA calendars and invalid items always block.

type Plan = z.infer<typeof BundlePlan>;
type Op = Plan['operations'][number];
type Section = Op['section'];

export interface PlanContext {
  plan: { id: string; addOns: readonly string[] };
}

/** Canonical JSON (sorted keys) so equal definitions compare equal whatever the key order. */
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, canon(x)]));
  }
  return v;
}

const asJson = (v: unknown): JsonObject => canon(v) as JsonObject;
const patchOf = (from: unknown, to: unknown): PatchOp[] => diffJson(asJson(from), asJson(to));

/** Compares a bundle item with the tenant's item of the same key. */
function compare(section: Section, key: string, current: unknown, incoming: unknown, validate: () => string | null): Op {
  if (current === undefined) {
    const problem = validate();
    return problem === null ? { section, key, action: 'create' } : { section, key, action: 'conflict', reason: 'invalid', detail: problem };
  }
  const patch = patchOf(current, incoming);
  return patch.length === 0 ? { section, key, action: 'unchanged' } : { section, key, action: 'conflict', reason: 'definition_differs', patch };
}

const problemText = (fn: () => void): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof ProblemError ? (e.detail ?? e.code) : (e as Error).message;
  }
};

/** Tenant-layer value an import writes: the bundle's value plus the tenant's own local properties (a logo). */
export function importedSettingValue(key: string, incoming: JsonObject, current: JsonObject | undefined): JsonObject {
  const local = configKey(key)?.localProperties ?? [];
  const kept = Object.fromEntries(Object.entries(current ?? {}).filter(([k]) => local.includes(k)));
  return { ...incoming, ...kept };
}

export function planBundle(current: ConfigBundleValue, incoming: ConfigBundleValue, ctx: PlanContext): Plan {
  const ops: Op[] = [];

  if (incoming.salesMode !== undefined) {
    ops.push(incoming.salesMode === current.salesMode
      ? { section: 'salesMode', key: 'salesMode', action: 'unchanged' }
      : { section: 'salesMode', key: 'salesMode', action: 'update', patch: [{ op: 'replace', path: '', value: incoming.salesMode }] });
  }

  // Modules: the result is the union; every new module must be in the plan and have its dependencies met by
  // the union (the import enables them in dependency order).
  const enabledAfter = new Set<string>(['core', ...current.modules]);
  const wanted = [...new Set(incoming.modules)].filter((m) => m !== 'core');
  for (const m of wanted) if (isModuleId(m) && entitled(ctx.plan.id, ctx.plan.addOns, m)) enabledAfter.add(m);
  // Fixed point: a new module whose dependencies stay unmet does not satisfy anyone else's.
  for (let changed = true; changed;) {
    changed = false;
    for (const m of [...enabledAfter]) {
      if (current.modules.includes(m) || m === 'core' || !isModuleId(m)) continue;
      if (getModule(m).dependsOn.some((group) => !group.some((d) => enabledAfter.has(d)))) {
        enabledAfter.delete(m);
        changed = true;
      }
    }
  }
  for (const m of wanted) {
    if (current.modules.includes(m)) {
      ops.push({ section: 'modules', key: m, action: 'unchanged' });
    } else if (!isModuleId(m)) {
      ops.push({ section: 'modules', key: m, action: 'conflict', reason: 'invalid', detail: 'unknown module' });
    } else if (!entitled(ctx.plan.id, ctx.plan.addOns, m)) {
      ops.push({ section: 'modules', key: m, action: 'conflict', reason: 'module_not_in_plan', detail: `not part of the ${ctx.plan.id} plan` });
    } else {
      const missing = getModule(m).dependsOn.filter((group) => !group.some((d) => enabledAfter.has(d)));
      ops.push(missing.length === 0
        ? { section: 'modules', key: m, action: 'create' }
        : { section: 'modules', key: m, action: 'conflict', reason: 'module_dependency', detail: missing.map((g) => g.join(' | ')).join(', ') });
    }
  }

  for (const [key, value] of Object.entries(incoming.settings)) {
    const def = configKey(key);
    if (!def || def.portable === false || !def.overridableAt.includes('tenant')) {
      ops.push({ section: 'settings', key, action: 'conflict', reason: 'invalid', detail: 'not a portable tenant setting' });
      continue;
    }
    const local = (def.localProperties ?? []).filter((p) => p in value);
    if (local.length > 0) {
      ops.push({ section: 'settings', key, action: 'conflict', reason: 'invalid', detail: `${local.join(', ')} cannot be imported` });
      continue;
    }
    const before = current.settings[key] as JsonObject | undefined;
    const after = importedSettingValue(key, value as JsonObject, before);
    const errors = validateConfig(def, after, mergeLayer(def.default, after));
    if (errors.length > 0) {
      ops.push({ section: 'settings', key, action: 'conflict', reason: 'invalid', detail: errors.map((e) => `${e.path}: ${e.message}`).join('; ') });
      continue;
    }
    const patch = patchOf(before ?? {}, after);
    ops.push(patch.length === 0 ? { section: 'settings', key, action: 'unchanged' } : { section: 'settings', key, action: before ? 'update' : 'create', patch });
  }

  const fields = new Map(current.customFields.map((f) => [`${f.resourceType}.${f.key}`, f]));
  for (const f of incoming.customFields) {
    const key = `${f.resourceType}.${f.key}`;
    ops.push(compare('customFields', key, fields.get(key), f, () => problemText(() => { checkCustomField(f); })));
  }

  // Transition order carries no meaning (statuses keep theirs: it is the board order).
  const byKey = <T extends { key: string }>(xs: readonly T[]): T[] => [...xs].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const wfShape = (w: ConfigBundleValue['taskWorkflows'][number]) => ({ ...w, transitions: byKey(w.transitions) });
  const workflows = new Map(current.taskWorkflows.map((w) => [w.key, wfShape(w)]));
  for (const w of incoming.taskWorkflows) {
    ops.push(compare('taskWorkflows', w.key, workflows.get(w.key), wfShape(w), () => problemText(() => { buildTaskWorkflow(w); })));
  }

  const calendars = new Map(current.calendars.map((c) => [c.name, c]));
  const calendarOps = new Map<string, Op>();
  for (const c of incoming.calendars) {
    const op = compare('calendars', c.name, calendars.get(c.name), c, () => problemText(() => {
      try {
        validateCalendar({ timezone: c.timezone, weeklyHours: c.weeklyHours as BusinessCalendar['weeklyHours'], holidays: c.holidays as BusinessCalendar['holidays'] });
      } catch (e) {
        if (e instanceof SlaError) throw new ProblemError('SLA_POLICY_INVALID', e.message);
        throw e;
      }
    }));
    calendarOps.set(c.name, op);
    ops.push(op);
  }

  const policies = new Map(current.slaPolicies.map((p) => [p.name, p]));
  for (const p of incoming.slaPolicies) {
    const calendarOp = calendarOps.get(p.calendar);
    const calendarExists = calendars.has(p.calendar) || calendarOp?.action === 'create';
    if (!policies.has(p.name) && !calendarExists) {
      ops.push({ section: 'slaPolicies', key: p.name, action: 'conflict', reason: 'calendar_missing', detail: p.calendar });
      continue;
    }
    ops.push(compare('slaPolicies', p.name, policies.get(p.name), p, () =>
      p.firstResponseMinutes === null && p.resolutionMinutes === null ? 'set first response and/or resolution time' : null));
  }

  // Tag names are case-insensitive in the database (citext).
  const tags = new Map(current.tags.map((x) => [x.name.toLowerCase(), x]));
  for (const x of incoming.tags) {
    const cur = tags.get(x.name.toLowerCase());
    ops.push(compare('tags', x.name, cur && { ...cur, name: x.name }, x, () => null));
  }

  const queues = new Map(current.queues.map((q) => [`${q.kind}.${q.name}`, q]));
  for (const q of incoming.queues) ops.push(compare('queues', `${q.kind}.${q.name}`, queues.get(`${q.kind}.${q.name}`), q, () => null));

  const count = (a: Op['action']) => ops.filter((o) => o.action === a).length;
  const blocking = ops.filter((o) => o.action === 'conflict' && o.reason !== 'definition_differs').length;
  return {
    operations: ops,
    summary: { create: count('create'), update: count('update'), unchanged: count('unchanged'), conflict: count('conflict') },
    blocking,
    applicable: blocking === 0,
  };
}

/** Modules to enable, in an order where each one's dependencies are already on. */
export function enableOrder(current: readonly string[], toEnable: readonly string[]): string[] {
  const on = new Set(['core', ...current]);
  const pending = [...toEnable];
  const order: string[] = [];
  while (pending.length > 0) {
    const i = pending.findIndex((m) => isModuleId(m) && getModule(m).dependsOn.every((g) => g.some((d) => on.has(d))));
    if (i < 0) break;
    const [m] = pending.splice(i, 1);
    if (m === undefined) break;
    on.add(m);
    order.push(m);
  }
  return order;
}
