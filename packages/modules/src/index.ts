import catalog from './catalog.json';

export type ModuleId =
  | 'core'
  | 'crm'
  | 'sales_b2b'
  | 'sales_b2c'
  | 'sales_tracking'
  | 'call_center'
  | 'dialer'
  | 'call_qa'
  | 'data_service'
  | 'automation_sla'
  | 'reporting_advanced'
  | 'api_webhooks'
  | 'ai_assistant';

export interface ModuleManifest {
  id: ModuleId;
  version: string;
  displayNameKey: string;
  family: number;
  /** CNF: every group must be satisfied; a group is satisfied when any member is enabled. */
  dependsOn: ModuleId[][];
  optionalIntegrations?: ModuleId[];
  permissions: { key: string; labelKey: string }[];
  routes: { apiPrefixes: string[] };
  menu: { id: string; labelKey: string; path: string; icon: string; requires: string[]; salesModes?: string[] }[];
  planEntitlement: { includedIn: string[]; addOn: boolean };
  alwaysOn?: boolean;
}

export const MODULES: readonly ModuleManifest[] = catalog.modules as ModuleManifest[];
const BY_ID = new Map<string, ModuleManifest>(MODULES.map((m) => [m.id, m]));

export function isModuleId(id: string): id is ModuleId {
  return BY_ID.has(id);
}

export function getModule(id: ModuleId): ModuleManifest {
  const m = BY_ID.get(id);
  if (!m) throw new Error(`unknown module ${id}`);
  return m;
}

/** Validates ids, dependency references and acyclicity. Called at process start (ADR-0014 §1). */
export function assertCatalogValid(modules: readonly ModuleManifest[] = MODULES): void {
  const ids = new Set(modules.map((m) => m.id));
  if (ids.size !== modules.length) throw new Error('duplicate module id');
  const state = new Map<string, 1 | 2>();
  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) throw new Error(`module dependency cycle: ${[...path, id].join(' -> ')}`);
    state.set(id, 1);
    const m = modules.find((x) => x.id === id);
    for (const dep of m?.dependsOn.flat() ?? []) {
      if (!ids.has(dep)) throw new Error(`module ${id} depends on unknown module ${dep}`);
      visit(dep, [...path, id]);
    }
    state.set(id, 2);
  };
  for (const id of ids) visit(id, []);
}

export type ToggleError =
  | { code: 'MODULE_UNKNOWN' }
  | { code: 'MODULE_ALWAYS_ON' }
  | { code: 'MODULE_DEPENDENCY_UNMET'; missing: ModuleId[][] }
  | { code: 'MODULE_HAS_DEPENDENTS'; dependents: ModuleId[] };

export type TogglePlan = { ok: true; enable: ModuleId[]; disable: ModuleId[] } | { ok: false; error: ToggleError };

function unmetGroups(m: ModuleManifest, enabled: ReadonlySet<string>): ModuleId[][] {
  return m.dependsOn.filter((group) => !group.some((d) => enabled.has(d)));
}

/** Plans enabling or disabling one module against the currently enabled set (MOD-02, MOD-03).
 *  Disabling never deletes data; `cascade` also disables modules that would lose a dependency. */
export function planToggle(current: ReadonlySet<string>, id: string, enable: boolean, options: { cascade?: boolean } = {}): TogglePlan {
  if (!isModuleId(id)) return { ok: false, error: { code: 'MODULE_UNKNOWN' } };
  const m = getModule(id);
  if (enable) {
    if (current.has(id)) return { ok: true, enable: [], disable: [] };
    const missing = unmetGroups(m, current);
    if (missing.length > 0) return { ok: false, error: { code: 'MODULE_DEPENDENCY_UNMET', missing } };
    return { ok: true, enable: [id], disable: [] };
  }
  if (m.alwaysOn) return { ok: false, error: { code: 'MODULE_ALWAYS_ON' } };
  if (!current.has(id)) return { ok: true, enable: [], disable: [] };
  const remaining = new Set(current);
  remaining.delete(id);
  const disable: ModuleId[] = [id];
  // Fixed point: repeatedly remove modules whose dependencies are no longer satisfied.
  for (let changed = true; changed; ) {
    changed = false;
    for (const other of MODULES) {
      if (remaining.has(other.id) && unmetGroups(other, remaining).length > 0) {
        remaining.delete(other.id);
        disable.push(other.id);
        changed = true;
      }
    }
  }
  if (disable.length > 1 && !options.cascade) {
    return { ok: false, error: { code: 'MODULE_HAS_DEPENDENTS', dependents: disable.slice(1) } };
  }
  return { ok: true, enable: [], disable };
}

/** Module that owns an API path (longest matching prefix), or null for platform routes (/v1/auth, /healthz). */
export function moduleForPath(path: string): ModuleId | null {
  let best: { id: ModuleId; len: number } | null = null;
  for (const m of MODULES) {
    for (const prefix of m.routes.apiPrefixes) {
      if ((path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}:`) || path.startsWith(`${prefix}?`)) && prefix.length > (best?.len ?? 0)) {
        best = { id: m.id, len: prefix.length };
      }
    }
  }
  return best?.id ?? null;
}

/** Module that owns a permission key. */
export function moduleForPermission(key: string): ModuleId | null {
  for (const m of MODULES) if (m.permissions.some((p) => p.key === key)) return m.id;
  return null;
}

export const ALWAYS_ON_MODULES: readonly ModuleId[] = MODULES.filter((m) => m.alwaysOn).map((m) => m.id);

assertCatalogValid();

export * from './plans';
