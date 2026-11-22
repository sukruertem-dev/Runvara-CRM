import { z } from 'zod';
import { Uuid } from './schemas';

// P6b: saved views, dashboards, aggregation and dependency edges (docs/p6-plan.md §7).

export const ViewResource = z.enum(['task', 'account', 'contact', 'lead', 'opportunity', 'case']);
export const ViewType = z.enum(['list', 'board', 'table', 'calendar', 'gantt', 'pipeline']);

const viewWritable = {
  name: z.string().trim().min(1).max(120),
  visibility: z.enum(['private', 'workspace']),
  viewType: ViewType,
  query: z.string().max(4000),
  sort: z.string().max(200).nullable(),
  config: z.record(z.string(), z.unknown()),
};

export const SavedViewCreate = z
  .object({ resourceType: ViewResource, ...viewWritable })
  .partial({ visibility: true, query: true, sort: true, config: true })
  .strict()
  .openapi('SavedViewCreate');
export const SavedViewPatch = z
  .object(viewWritable)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'empty patch')
  .openapi('SavedViewPatch');
export const SavedView = z
  .object({
    id: Uuid,
    resourceType: ViewResource,
    ownerUserId: Uuid,
    mine: z.boolean(),
    ...viewWritable,
    version: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('SavedView');
export const SavedViewListResponse = z.object({ data: z.array(SavedView) }).openapi('SavedViewListResponse');

export const DashboardWidget = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,40}$/),
    kind: z.enum(['kpi_open_tasks', 'kpi_overdue_tasks', 'kpi_my_tasks', 'tasks_by_status', 'tasks_by_priority', 'burndown', 'pipeline_funnel', 'sla_status']),
    x: z.number().int().min(0).max(11),
    y: z.number().int().min(0).max(200),
    w: z.number().int().min(1).max(12),
    h: z.number().int().min(1).max(8),
  })
  .strict();
export const DashboardLayout = z.object({ widgets: z.array(DashboardWidget).max(24), version: z.number().int().optional() }).strict().openapi('DashboardLayout');

export const AggregateResponse = z
  .object({ data: z.array(z.object({ key: z.string().nullable(), count: z.number().int(), sum: z.string().optional() })), total: z.number().int() })
  .openapi('AggregateResponse');

export const DependencyEdgesQuery = z
  .object({
    ids: z
      .string()
      .transform((v) => v.split(',').filter(Boolean))
      .pipe(z.array(Uuid).min(1).max(500)),
  })
  .strict();
export const DependencyEdgesResponse = z
  .object({ data: z.array(z.object({ blockerId: Uuid, blockedId: Uuid })) })
  .openapi('DependencyEdgesResponse');

export const SlaSummary = z
  .object({ recordType: z.enum(['case', 'task', 'lead']), breached: z.number().int(), running: z.number().int(), paused: z.number().int(), met: z.number().int() })
  .openapi('SlaSummary');
