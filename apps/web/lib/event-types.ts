const EVENT_RESOURCES = ['task', 'account', 'contact', 'lead', 'opportunity', 'case'] as const;
const RECORD_EVENTS = ['created', 'updated', 'status_changed', 'assigned', 'deleted', 'restored'] as const;

/**
 * Event types a webhook subscription can name (docs/events.md), grouped for the integrations screen. A
 * subscription may also use `prefix.*` or `*`; the API accepts any type matching its pattern, so this list is
 * guidance for people, not a gate.
 */
export const WEBHOOK_EVENT_GROUPS: readonly { group: string; types: readonly string[] }[] = [
  ...EVENT_RESOURCES.map((r) => ({ group: r, types: RECORD_EVENTS.map((e) => `${r}.${e}`) })),
  { group: 'lead_extra', types: ['lead.converted'] },
  { group: 'activity', types: ['comment.created', 'attachment.uploaded', 'activity.logged', 'record.merged'] },
  { group: 'sla', types: ['sla.warning', 'sla.breached', 'sla.met'] },
];
