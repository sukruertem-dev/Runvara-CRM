import { Inject, Injectable } from '@nestjs/common';
import { can } from '@flexa/authz';
import { CONFIG_KEYS, configKey, type JsonObject } from '@flexa/config';
import { BUNDLE_FORMAT, ConfigBundle, type ConfigBundleValue } from '@flexa/contracts';
import { asc, isNull, schema, sql, type Db, type DbHandle } from '@flexa/db';
import { audit } from '../../common/audit';
import { authorize } from '../../common/authorize';
import { ProblemError } from '../../common/problem';
import { dbCtx, type TenantRequestContext } from '../../common/request-context';
import { DB } from '../../infra/tokens';
import { SlaService } from '../integrations/sla.service';
import { insertCustomField, insertTaskWorkflow } from '../tasks/config-defs';
import { RESOURCE_TYPES } from '../tasks/task-fields';
import { enabledModules, toggleModuleTx } from '../tenancy/modules';
import { setSalesModeTx } from '../tenancy/tenancy.controller';
import { blueprint, BLUEPRINT_LIST } from './blueprints';
import { enableOrder, importedSettingValue, planBundle } from './bundle-plan';
import { ConfigService } from './config.service';

// Configuration export, import and blueprints (CFG-04/05, ADR-0011 §3, docs/p7-plan.md §7–8).

type Plan = ReturnType<typeof planBundle>;
type ConflictPolicy = 'fail' | 'keep';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

@Injectable()
export class BundleService {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    private readonly config: ConfigService,
    private readonly sla: SlaService,
  ) {}

  // -------------------------------------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------------------------------------

  async export(t: TenantRequestContext): Promise<ConfigBundleValue> {
    authorize(t, 'tenant.config.read', 'read');
    return this.db.withTenant(dbCtx(t), (tx) => this.current(tx, t, true));
  }

  /** The tenant's configuration as a bundle, normalised through the contract so it compares equal to an
   *  imported bundle with the same content. */
  async current(tx: Db, t: TenantRequestContext, withMeta = false): Promise<ConfigBundleValue> {
    const tenant = (await tx.execute<{ slug: string; sales_mode: 'b2b_only' | 'b2c_only' | 'both' }>(sql`SELECT slug, sales_mode FROM tenants`)).rows[0];
    const modules = [...(await enabledModules(tx))].filter((m) => m !== 'core').sort();

    const layers = await this.config.tenantLayers(tx, t);
    const settings: Record<string, JsonObject> = {};
    for (const def of CONFIG_KEYS) {
      const value = layers.get(def.key);
      if (!value || def.portable === false || !def.overridableAt.includes('tenant')) continue;
      const local = def.localProperties ?? [];
      const portable: JsonObject = Object.fromEntries(Object.entries(value).filter(([k]) => !local.includes(k)));
      if (Object.keys(portable).length > 0) settings[def.key] = portable;
    }

    const defs = (await tx.select().from(schema.customFieldDefinitions).where(isNull(schema.customFieldDefinitions.archivedAt)).orderBy(asc(schema.customFieldDefinitions.position)))
      .filter((d) => (RESOURCE_TYPES as readonly string[]).includes(d.resourceType))
      .sort((a, b) => (a.resourceType < b.resourceType ? -1 : a.resourceType > b.resourceType ? 1 : 0));
    const customFields = defs.map((d) => ({
      resourceType: d.resourceType, key: d.key, type: d.type, label: d.labelI18n, required: d.required,
      ...(d.defaultValue === null ? {} : { defaultValue: d.defaultValue }),
      options: d.options, ...(d.relationTarget ? { relationTarget: d.relationTarget } : {}), ...(d.formula ? { formula: d.formula } : {}), indexed: d.indexed,
    }));

    const wfs = await tx.execute<{ id: string; key: string; name: string }>(sql`SELECT id, key, name FROM workflows WHERE resource_type = 'task' ORDER BY key`);
    const st = await tx.execute<{ id: string; workflow_id: string; key: string; label_i18n: Record<string, string>; category: string; color_token: string; is_initial: boolean; wip_limit: number | null }>(
      sql`SELECT s.id, s.workflow_id, s.key, s.label_i18n, s.category, s.color_token, s.is_initial, s.wip_limit FROM statuses s JOIN workflows w ON w.id = s.workflow_id WHERE w.resource_type = 'task' ORDER BY s.position`);
    const tr = await tx.execute<{ workflow_id: string; key: string; label_i18n: Record<string, string>; from_status_id: string | null; to_status_id: string; conditions: unknown[]; validators: unknown[]; post_functions: unknown[] }>(
      sql`SELECT x.workflow_id, x.key, x.label_i18n, x.from_status_id, x.to_status_id, x.conditions, x.validators, x.post_functions FROM workflow_transitions x JOIN workflows w ON w.id = x.workflow_id WHERE w.resource_type = 'task' ORDER BY x.key`);
    const statusKey = new Map(st.rows.map((s) => [s.id, s.key]));
    const taskWorkflows = wfs.rows.map((w) => ({
      key: w.key, name: w.name,
      statuses: st.rows.filter((s) => s.workflow_id === w.id).map((s) => ({ key: s.key, label: s.label_i18n, category: s.category, colorToken: s.color_token, isInitial: s.is_initial, wipLimit: s.wip_limit })),
      transitions: tr.rows.filter((x) => x.workflow_id === w.id).map((x) => ({
        key: x.key, label: x.label_i18n, from: x.from_status_id === null ? null : (statusKey.get(x.from_status_id) ?? null), to: statusKey.get(x.to_status_id) ?? '',
        conditions: x.conditions, validators: x.validators, postFunctions: x.post_functions,
      })),
    }));

    const cals = await tx.execute<{ id: string; name: string; timezone: string; weekly_hours: unknown[]; holidays: unknown[] }>(sql`SELECT id, name, timezone, weekly_hours, holidays FROM business_calendars ORDER BY name`);
    const calendarName = new Map(cals.rows.map((c) => [c.id, c.name]));
    const pols = await tx.execute<{ name: string; resource_type: string; criteria: string; position: number; calendar_id: string; first_response_minutes: number | null; resolution_minutes: number | null; warn_percent: number; pause_statuses: string[]; enabled: boolean }>(
      sql`SELECT name, resource_type, criteria, position, calendar_id, first_response_minutes, resolution_minutes, warn_percent, pause_statuses, enabled FROM sla_policies ORDER BY resource_type, position, name`);
    const tags = await tx.execute<{ name: string; color_token: string }>(sql`SELECT name::text AS name, color_token FROM tags ORDER BY name`);
    const queues = await tx.execute<{ kind: string; name: string; segment: string | null }>(sql`SELECT kind, name, segment::text AS segment FROM queues ORDER BY kind, name`);

    return ConfigBundle.parse({
      format: BUNDLE_FORMAT,
      ...(withMeta ? { meta: { kind: 'export', id: tenant?.slug ?? '', exportedAt: new Date().toISOString() } } : {}),
      salesMode: tenant?.sales_mode,
      modules,
      settings,
      customFields,
      taskWorkflows,
      calendars: cals.rows.map((c) => ({ name: c.name, timezone: c.timezone, weeklyHours: c.weekly_hours, holidays: c.holidays })),
      slaPolicies: pols.rows.map((p) => ({
        name: p.name, resourceType: p.resource_type, criteria: p.criteria, position: p.position, calendar: calendarName.get(p.calendar_id) ?? '',
        firstResponseMinutes: p.first_response_minutes, resolutionMinutes: p.resolution_minutes, warnPercent: p.warn_percent, pauseStatuses: p.pause_statuses, enabled: p.enabled,
      })),
      tags: tags.rows.map((x) => ({ name: x.name, colorToken: x.color_token })),
      queues: queues.rows.map((q) => ({ kind: q.kind, name: q.name, segment: q.segment })),
    });
  }

  // -------------------------------------------------------------------------------------------------------
  // Plan and apply
  // -------------------------------------------------------------------------------------------------------

  async preview(t: TenantRequestContext, bundle: ConfigBundleValue): Promise<Plan> {
    authorize(t, 'tenant.config.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => planBundle(await this.current(tx, t), bundle, { plan: t.plan }));
  }

  async import(t: TenantRequestContext, bundle: ConfigBundleValue, onConflict: ConflictPolicy, note: string | undefined, ip: string, source: { kind: 'import' | 'blueprint' | 'onboarding'; id?: string }) {
    authorize(t, 'tenant.config.manage');
    return this.db.withTenant(dbCtx(t), (tx) => this.applyTx(tx, t, bundle, onConflict, note, ip, source));
  }

  /** Plans again inside the transaction (under a tenant-wide lock), refuses on conflicts the policy does not
   *  allow, then applies every create and update. Nothing is deleted. */
  async applyTx(tx: Db, t: TenantRequestContext, bundle: ConfigBundleValue, onConflict: ConflictPolicy, note: string | undefined, ip: string, source: { kind: 'import' | 'blueprint' | 'onboarding'; id?: string }) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`config-import:${t.tenant.id}`}, 0))`);
    const current = await this.current(tx, t);
    const plan = planBundle(current, bundle, { plan: t.plan });
    if (plan.blocking > 0 || (onConflict === 'fail' && plan.summary.conflict > 0)) {
      throw new ProblemError('IMPORT_CONFLICTS', `${String(plan.summary.conflict)} conflict(s), ${String(plan.blocking)} blocking`, { plan });
    }
    const todo = (section: Plan['operations'][number]['section']) =>
      new Set(plan.operations.filter((o) => o.section === section && (o.action === 'create' || o.action === 'update')).map((o) => o.key));

    if (todo('salesMode').size > 0 && bundle.salesMode) {
      authorize(t, 'tenant.sales_mode.manage');
      await setSalesModeTx(tx, t, bundle.salesMode, ip);
    }
    const modules = todo('modules');
    if (modules.size > 0) {
      authorize(t, 'tenant.modules.manage');
      for (const id of enableOrder(current.modules, [...modules])) await toggleModuleTx(tx, t, id, true, false, ip, source.kind);
    }
    const settings = todo('settings');
    for (const [key, value] of Object.entries(bundle.settings)) {
      const def = configKey(key);
      if (!def || !settings.has(key)) continue;
      await this.config.writeTx(tx, t, def, 'tenant', importedSettingValue(key, value as JsonObject, current.settings[key] as JsonObject | undefined), null, note ?? `${source.kind}${source.id ? `: ${source.id}` : ''}`, ip);
    }
    const calendars = todo('calendars');
    for (const c of bundle.calendars) if (calendars.has(c.name)) await this.sla.createCalendarTx(tx, t, c, ip);
    const fields = todo('customFields');
    for (const f of bundle.customFields) if (fields.has(`${f.resourceType}.${f.key}`)) await insertCustomField(tx, t, f, ip);
    const workflows = todo('taskWorkflows');
    for (const w of bundle.taskWorkflows) if (workflows.has(w.key)) await insertTaskWorkflow(tx, t, w, ip);
    const policies = todo('slaPolicies');
    if (policies.size > 0) {
      const cals = await tx.execute<{ id: string; name: string }>(sql`SELECT id, name FROM business_calendars`);
      const calendarId = new Map(cals.rows.map((c) => [c.name, c.id]));
      for (const p of bundle.slaPolicies) {
        if (!policies.has(p.name)) continue;
        const id = calendarId.get(p.calendar);
        if (!id) throw new ProblemError('IMPORT_CONFLICTS', `calendar "${p.calendar}" not found`, { plan });
        await this.sla.createPolicyTx(tx, t, {
          name: p.name, resourceType: p.resourceType, criteria: p.criteria, position: p.position, calendarId: id,
          ...(p.firstResponseMinutes === null ? {} : { firstResponseMinutes: p.firstResponseMinutes }),
          ...(p.resolutionMinutes === null ? {} : { resolutionMinutes: p.resolutionMinutes }),
          warnPercent: p.warnPercent, pauseStatuses: p.pauseStatuses, enabled: p.enabled,
        }, ip);
      }
    }
    const tags = todo('tags');
    for (const x of bundle.tags) {
      if (tags.has(x.name)) await tx.execute(sql`INSERT INTO tags (tenant_id, name, color_token) VALUES (${t.tenant.id}, ${x.name}, ${x.colorToken})`);
    }
    const queues = todo('queues');
    for (const q of bundle.queues) {
      if (queues.has(`${q.kind}.${q.name}`)) await tx.execute(sql`INSERT INTO queues (tenant_id, kind, name, segment) VALUES (${t.tenant.id}, ${q.kind}, ${q.name}, ${q.segment}::segment)`);
    }

    await audit(tx, t.tenant.id, {
      action: 'config.imported', actorId: t.principal.userId, targetType: 'config', ip,
      details: { source: source.kind, ...(source.id ? { sourceId: source.id } : {}), from: bundle.meta ?? null, onConflict, summary: plan.summary, note: note ?? null },
    });
    return { plan, applied: true };
  }

  // -------------------------------------------------------------------------------------------------------
  // Blueprints and onboarding
  // -------------------------------------------------------------------------------------------------------

  blueprints(t: TenantRequestContext) {
    if (!can(t.authz, 'tenant.config.manage').allow) authorize(t, 'tenant.config.read', 'read');
    return {
      data: BLUEPRINT_LIST.map((b) => ({
        id: b.id, version: b.version, nameKey: b.nameKey, descriptionKey: b.descriptionKey, salesMode: b.bundle.salesMode ?? 'both', modules: b.bundle.modules,
        counts: { customFields: b.bundle.customFields.length, taskWorkflows: b.bundle.taskWorkflows.length, slaPolicies: b.bundle.slaPolicies.length, tags: b.bundle.tags.length, queues: b.bundle.queues.length },
      })),
    };
  }

  /** The bundle an onboarding choice stands for: the blueprint (if any) with the chosen sales mode and modules. */
  onboardingBundle(choice: { blueprint: string | null; salesMode: 'b2b_only' | 'b2c_only' | 'both'; modules: string[] }): ConfigBundleValue {
    const base = choice.blueprint ? blueprint(choice.blueprint).bundle : ConfigBundle.parse({ format: BUNDLE_FORMAT });
    return { ...base, salesMode: choice.salesMode, modules: choice.modules };
  }

  async onboardingState(t: TenantRequestContext): Promise<{ status: 'pending' | 'completed' | 'skipped'; blueprint: string | null }> {
    return this.db.withTenant(dbCtx(t), async (tx) => this.onboardingOf(tx, t));
  }

  private async onboardingOf(tx: Db, t: TenantRequestContext): Promise<{ status: 'pending' | 'completed' | 'skipped'; blueprint: string | null }> {
    const layer = (await this.config.tenantLayers(tx, t)).get('onboarding') ?? {};
    const status = str(layer.status);
    return { status: status === 'pending' || status === 'skipped' ? status : 'completed', blueprint: str(layer.blueprint) ?? null };
  }

  async completeOnboarding(t: TenantRequestContext, choice: { blueprint: string | null; salesMode: 'b2b_only' | 'b2c_only' | 'both'; modules: string[] }, ip: string) {
    authorize(t, 'tenant.config.manage');
    const bundle = this.onboardingBundle(choice);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await this.assertPending(tx, t);
      // A first-time setup keeps whatever the workspace already defined under the same names.
      const result = await this.applyTx(tx, t, bundle, 'keep', undefined, ip, { kind: 'onboarding', ...(choice.blueprint ? { id: choice.blueprint } : {}) });
      await this.setOnboarding(tx, t, 'completed', choice.blueprint, ip);
      return result;
    });
  }

  async skipOnboarding(t: TenantRequestContext, ip: string) {
    authorize(t, 'tenant.config.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await this.assertPending(tx, t);
      await this.setOnboarding(tx, t, 'skipped', null, ip);
      return { status: 'skipped' as const, blueprint: null };
    });
  }

  private async assertPending(tx: Db, t: TenantRequestContext): Promise<void> {
    const state = await this.onboardingOf(tx, t);
    if (state.status !== 'pending') throw new ProblemError('CONFLICT', `onboarding is already ${state.status}`);
  }

  private async setOnboarding(tx: Db, t: TenantRequestContext, status: 'completed' | 'skipped', blueprintId: string | null, ip: string): Promise<void> {
    const def = configKey('onboarding');
    if (!def) throw new Error('onboarding key is not registered');
    await this.config.writeTx(tx, t, def, 'tenant', { status, blueprint: blueprintId }, null, `onboarding ${status}`, ip);
  }
}
