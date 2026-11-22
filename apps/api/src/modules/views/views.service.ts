import { Inject, Injectable } from '@nestjs/common';
import { can } from '@flexa/authz';
import type { DashboardLayout, SavedViewCreate, SavedViewPatch, z } from '@flexa/contracts';
import { sql, type Db, type DbHandle } from '@flexa/db';
import { compileQuery, type FieldRegistry } from '@flexa/query-lang';
import { parseSort, rqlProblem } from '../../common/keyset-list';
import { isUniqueViolation, ProblemError } from '../../common/problem';
import { dbCtx, type TenantRequestContext } from '../../common/request-context';
import { DB } from '../../infra/tokens';
import { CRM, crmRegistry, isCrmType } from '../crm/crm-objects';
import { loadFieldDefs, RESOURCE_TYPES, taskRegistry, type ResourceType } from '../tasks/task-fields';

type Widgets = z.infer<typeof DashboardLayout>['widgets'];

type ViewRow = {
  id: string;
  resource_type: ResourceType;
  owner_user_id: string;
  name: string;
  visibility: 'private' | 'workspace';
  view_type: z.infer<typeof SavedViewCreate>['viewType'];
  query: string;
  sort: string | null;
  config: Record<string, unknown>;
  version: number;
  created_at: Date;
  updated_at: Date;
};

/** A new user's dashboard. Pipeline and SLA widgets are dropped while their module is off. */
const DEFAULT_LAYOUT: Widgets = [
  { id: 'open', kind: 'kpi_open_tasks', x: 0, y: 0, w: 3, h: 2 },
  { id: 'mine', kind: 'kpi_my_tasks', x: 3, y: 0, w: 3, h: 2 },
  { id: 'overdue', kind: 'kpi_overdue_tasks', x: 6, y: 0, w: 3, h: 2 },
  { id: 'sla', kind: 'sla_status', x: 9, y: 0, w: 3, h: 2 },
  { id: 'status', kind: 'tasks_by_status', x: 0, y: 2, w: 6, h: 4 },
  { id: 'burndown', kind: 'burndown', x: 6, y: 2, w: 6, h: 4 },
  { id: 'priority', kind: 'tasks_by_priority', x: 0, y: 6, w: 6, h: 4 },
  { id: 'funnel', kind: 'pipeline_funnel', x: 6, y: 6, w: 6, h: 4 },
];
const WIDGET_MODULE: Partial<Record<string, string>> = { pipeline_funnel: 'crm', sla_status: 'automation_sla' };

@Injectable()
export class ViewsService {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  private view(t: TenantRequestContext, r: ViewRow) {
    return {
      id: r.id,
      resourceType: r.resource_type,
      ownerUserId: r.owner_user_id,
      mine: r.owner_user_id === t.principal.userId,
      name: r.name,
      visibility: r.visibility,
      viewType: r.view_type,
      query: r.query,
      sort: r.sort,
      config: r.config,
      version: r.version,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    };
  }

  /** A view is saved only when its filter and sort compile against the resource field registry. */
  private async check(tx: Db, t: TenantRequestContext, resource: ResourceType, query: string, sort: string | null): Promise<void> {
    const defs = await loadFieldDefs(tx, resource);
    const registry: FieldRegistry = isCrmType(resource) ? crmRegistry(CRM[resource], defs) : taskRegistry(defs);
    try {
      if (query) compileQuery(query, registry, { userId: t.principal.userId, timezone: t.tenant.timezone, now: new Date() });
    } catch (e) {
      rqlProblem(e);
    }
    if (sort) parseSort(sort, registry);
  }

  private assertPublish(t: TenantRequestContext, visibility: string | undefined): void {
    if (visibility === 'workspace' && !can(t.authz, 'tenant.config.manage').allow) {
      throw new ProblemError('FORBIDDEN', 'publishing a workspace view needs tenant.config.manage');
    }
  }

  async list(t: TenantRequestContext, resource: string | undefined) {
    if (!resource || !(RESOURCE_TYPES as readonly string[]).includes(resource)) throw new ProblemError('VALIDATION_FAILED', `resource must be one of ${RESOURCE_TYPES.join(', ')}`);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      // RLS returns own views and workspace views only.
      const r = await tx.execute<ViewRow>(sql`SELECT * FROM saved_views WHERE resource_type = ${resource} ORDER BY visibility DESC, lower(name), id`);
      return { data: r.rows.map((row) => this.view(t, row)) };
    });
  }

  async create(t: TenantRequestContext, body: z.infer<typeof SavedViewCreate>) {
    this.assertPublish(t, body.visibility);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await this.check(tx, t, body.resourceType, body.query ?? '', body.sort ?? null);
      try {
        const r = await tx.execute<ViewRow>(sql`
          INSERT INTO saved_views (tenant_id, owner_user_id, resource_type, name, visibility, view_type, query, sort, config)
          VALUES (${t.tenant.id}, ${t.principal.userId}, ${body.resourceType}, ${body.name}, ${body.visibility ?? 'private'}, ${body.viewType},
                  ${body.query ?? ''}, ${body.sort ?? null}, ${JSON.stringify(body.config ?? {})}::jsonb)
          RETURNING *`);
        return this.view(t, r.rows[0] as ViewRow);
      } catch (e) {
        if (isUniqueViolation(e)) throw new ProblemError('CONFLICT', 'a view with this name already exists');
        throw e;
      }
    });
  }

  async update(t: TenantRequestContext, id: string, version: number, body: z.infer<typeof SavedViewPatch>) {
    this.assertPublish(t, body.visibility);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      // Only the owner may change a view; another member's workspace view is "not found" for writing.
      const [cur] = (await tx.execute<ViewRow>(sql`SELECT * FROM saved_views WHERE id = ${id} AND owner_user_id = ${t.principal.userId} FOR UPDATE`)).rows;
      if (!cur) throw new ProblemError('NOT_FOUND');
      if (cur.version !== version) throw new ProblemError('PRECONDITION_FAILED');
      const query = body.query ?? cur.query;
      const sort = body.sort === undefined ? cur.sort : body.sort;
      await this.check(tx, t, cur.resource_type, query, sort);
      try {
        const r = await tx.execute<ViewRow>(sql`
          UPDATE saved_views SET
            name = ${body.name ?? cur.name}, visibility = ${body.visibility ?? cur.visibility}, view_type = ${body.viewType ?? cur.view_type},
            query = ${query}, sort = ${sort}, config = ${JSON.stringify(body.config ?? cur.config)}::jsonb, version = version + 1
          WHERE id = ${id} RETURNING *`);
        return this.view(t, r.rows[0] as ViewRow);
      } catch (e) {
        if (isUniqueViolation(e)) throw new ProblemError('CONFLICT', 'a view with this name already exists');
        throw e;
      }
    });
  }

  async remove(t: TenantRequestContext, id: string): Promise<void> {
    await this.db.withTenant(dbCtx(t), async (tx) => {
      const r = await tx.execute(sql`DELETE FROM saved_views WHERE id = ${id} AND owner_user_id = ${t.principal.userId} RETURNING id`);
      if (r.rows.length === 0) throw new ProblemError('NOT_FOUND');
    });
  }

  private visibleWidgets(t: TenantRequestContext, widgets: Widgets): Widgets {
    return widgets.filter((w) => {
      const m = WIDGET_MODULE[w.kind];
      return !m || t.authz.enabledModules.has(m);
    });
  }

  async dashboard(t: TenantRequestContext) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const [row] = (await tx.execute<{ layout: Widgets; version: number }>(sql`SELECT layout, version FROM user_dashboards WHERE user_id = ${t.principal.userId}`)).rows;
      return { widgets: this.visibleWidgets(t, row?.layout ?? DEFAULT_LAYOUT), version: row?.version ?? 0 };
    });
  }

  async saveDashboard(t: TenantRequestContext, body: z.infer<typeof DashboardLayout>) {
    if (new Set(body.widgets.map((w) => w.id)).size !== body.widgets.length) throw new ProblemError('VALIDATION_FAILED', 'duplicate widget id');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const r = await tx.execute<{ version: number }>(sql`
        INSERT INTO user_dashboards (tenant_id, user_id, layout) VALUES (${t.tenant.id}, ${t.principal.userId}, ${JSON.stringify(body.widgets)}::jsonb)
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET layout = EXCLUDED.layout, version = user_dashboards.version + 1, updated_at = now()
        RETURNING version`);
      return { widgets: this.visibleWidgets(t, body.widgets), version: r.rows[0]?.version ?? 1 };
    });
  }
}
