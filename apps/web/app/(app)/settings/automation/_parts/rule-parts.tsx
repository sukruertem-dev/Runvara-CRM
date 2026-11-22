'use client';

import { Checkbox, Combobox, Field, Input, Select, Textarea } from '@flexa/ui';
import { useState } from 'react';
import { t } from '../../../../../lib/i18n';
import type { Resource, RqlField } from '../../../../../lib/records';
import { useAssignmentPolicies, type RuleDefinition, type Webhook, type WorkflowStatus, type WorkflowTransition } from '../../../../../lib/settings';
import { labelOf } from '../../../../../lib/settings';
import { useDirectory, useDirectorySearch } from '../../../../../lib/tasks';

export type Trigger = RuleDefinition['trigger'];
export type Action = RuleDefinition['actions'][number];
export type Target = Extract<Action, { type: 'assign' }>['to'];

export const TRIGGER_TYPES = ['record.created', 'record.updated', 'field_changed', 'status_changed', 'schedule', 'inbound_webhook', 'sla'] as const;
export const ACTION_TYPES = ['update_field', 'create_task', 'assign', 'notify', 'send_email', 'transition', 'call_webhook'] as const;
const SLA_RESOURCES: readonly Resource[] = ['case', 'task', 'lead'];

/** Field names an action or a field_changed trigger may name (`^[a-zA-Z]…$` or `custom.cf_…`). */
const writableName = (f: RqlField) => /^(?:[a-zA-Z][a-zA-Z0-9]{0,47}|custom\.cf_[a-z0-9_]{1,45})$/.test(f.name);

export function defaultTrigger(type: Trigger['type']): Trigger {
  switch (type) {
    case 'field_changed': return { type, fields: ['priority'] };
    case 'status_changed': return { type };
    case 'schedule': return { type, cron: '0 9 * * 1-5', timezone: 'Europe/Istanbul' };
    case 'sla': return { type, event: 'warning' };
    default: return { type };
  }
}

export function defaultAction(type: Action['type'], fields: RqlField[]): Action {
  switch (type) {
    case 'update_field': return { type, field: fields.find(writableName)?.name ?? 'priority', value: '' };
    case 'create_task': return { type, title: t('settings.rule.defaultTaskTitle'), priority: 2, assignTo: { kind: 'record_owner' } };
    case 'assign': return { type, to: { kind: 'record_owner' } };
    case 'notify': return { type, to: { kind: 'record_owner' }, message: t('settings.rule.defaultMessage') };
    case 'send_email': return { type, to: { kind: 'record_owner' }, subject: t('settings.rule.defaultSubject'), body: t('settings.rule.defaultMessage') };
    case 'transition': return { type, transitionKey: 'start' };
    case 'call_webhook': return { type, subscriptionId: '' };
  }
}

export const triggerAllowed = (type: Trigger['type'], resource: Resource) => type !== 'sla' || SLA_RESOURCES.includes(resource);

export function TriggerEditor({ trigger, onChange, fields, statuses }: { trigger: Trigger; onChange: (t: Trigger) => void; fields: RqlField[]; statuses: WorkflowStatus[] }) {
  switch (trigger.type) {
    case 'field_changed': {
      const picked = new Set(trigger.fields);
      return (
        <fieldset className="m-0 border-0 p-0">
          <legend className="mb-1 text-sm font-medium">{t('settings.rule.watchFields')}</legend>
          <div className="grid max-h-48 grid-cols-2 gap-1.5 overflow-y-auto rounded-input border border-line p-2 sm:grid-cols-3">
            {fields.filter(writableName).map((f) => (
              <label key={f.name} className="inline-flex items-center gap-2 text-sm">
                <Checkbox
                  checked={picked.has(f.name)}
                  onCheckedChange={(v) => {
                    const next = new Set(picked);
                    if (v === true) next.add(f.name);
                    else next.delete(f.name);
                    if (next.size > 0) onChange({ ...trigger, fields: [...next].slice(0, 20) });
                  }}
                />
                <code className="text-xs">{f.name}</code>
              </label>
            ))}
          </div>
        </fieldset>
      );
    }
    case 'status_changed':
      return (
        <Field label={t('settings.rule.toStatus')}>
          <Select
            value={trigger.toStatus ?? '*'}
            onValueChange={(v) => { onChange(v === '*' ? { type: 'status_changed' } : { type: 'status_changed', toStatus: v }); }}
            options={[{ value: '*', label: t('settings.rule.anyStatus') }, ...statuses.map((s) => ({ value: s.key, label: labelOf(s.label, s.key) }))]}
          />
        </Field>
      );
    case 'schedule':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('settings.rule.cron')} hint={t('settings.rule.cronHint')}>
            <Input value={trigger.cron} onChange={(e) => { onChange({ ...trigger, cron: e.target.value }); }} className="font-mono" maxLength={100} />
          </Field>
          <Field label={t('settings.timezone')}>
            <Input value={trigger.timezone} onChange={(e) => { onChange({ ...trigger, timezone: e.target.value }); }} maxLength={64} />
          </Field>
        </div>
      );
    case 'sla':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('settings.rule.slaEvent')}>
            <Select value={trigger.event} onValueChange={(v) => { onChange({ ...trigger, event: v as 'warning' }); }} options={(['warning', 'breached', 'met'] as const).map((e) => ({ value: e, label: t(`settings.rule.sla.${e}`) }))} />
          </Field>
          <Field label={t('settings.rule.milestone')}>
            <Select
              value={trigger.milestone ?? '*'}
              onValueChange={(v) => { onChange(v === '*' ? { type: 'sla', event: trigger.event } : { ...trigger, milestone: v as 'resolution' }); }}
              options={[{ value: '*', label: t('settings.rule.anyMilestone') }, { value: 'first_response', label: t('settings.sla.firstResponse') }, { value: 'resolution', label: t('settings.sla.resolution') }]}
            />
          </Field>
        </div>
      );
    case 'inbound_webhook':
      return <p className="m-0 text-sm text-fg-muted">{t('settings.rule.inboundHint')}</p>;
    default:
      return null;
  }
}

function UserPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [term, setTerm] = useState('');
  const search = useDirectorySearch(term);
  const names = useDirectory([value]);
  const options = [...(search.data?.data ?? []).map((u) => ({ value: u.id, label: u.displayName }))];
  if (value && !options.some((o) => o.value === value)) options.unshift({ value, label: names.get(value) ?? value });
  return (
    <Combobox
      value={value || null}
      onValueChange={(v) => { if (v) onChange(v); }}
      options={options}
      placeholder={t('settings.rule.pickUser')}
      searchPlaceholder={t('settings.rule.searchUser')}
      emptyText={t('settings.rule.noUser')}
      onSearch={setTerm}
    />
  );
}

export function TargetEditor({ value, onChange, label }: { value: Target; onChange: (t: Target) => void; label: string }) {
  const policies = useAssignmentPolicies(value.kind === 'policy');
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={label}>
        <Select
          value={value.kind}
          onValueChange={(v) => {
            if (v === 'record_owner') onChange({ kind: 'record_owner' });
            else if (v === 'user') onChange({ kind: 'user', userId: '' });
            else onChange({ kind: 'policy', policyId: '' });
          }}
          options={(['record_owner', 'user', 'policy'] as const).map((k) => ({ value: k, label: t(`settings.rule.target.${k}`) }))}
        />
      </Field>
      {value.kind === 'user' ? (
        <Field label={t('settings.rule.user')}>
          <UserPicker value={value.userId} onChange={(userId) => { onChange({ kind: 'user', userId }); }} />
        </Field>
      ) : value.kind === 'policy' ? (
        <Field label={t('settings.rule.policy')} hint={policies.data?.data.length === 0 ? t('settings.rule.noPolicies') : undefined}>
          <Select value={value.policyId || undefined} onValueChange={(policyId) => { onChange({ kind: 'policy', policyId }); }} options={(policies.data?.data ?? []).map((p) => ({ value: p.id, label: p.name }))} placeholder={t('settings.rule.pickPolicy')} />
        </Field>
      ) : null}
    </div>
  );
}

export function ActionEditor({ action, onChange, fields, transitions, webhooks }: { action: Action; onChange: (a: Action) => void; fields: RqlField[]; transitions: WorkflowTransition[]; webhooks: Webhook[] }) {
  switch (action.type) {
    case 'update_field': {
      const field = fields.find((f) => f.name === action.field);
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('settings.rule.field')}>
            <Select value={action.field} onValueChange={(v) => { onChange({ ...action, field: v }); }} options={fields.filter(writableName).map((f) => ({ value: f.name, label: f.name }))} />
          </Field>
          <Field label={t('settings.rule.value')} hint={t('settings.rule.valueHint')}>
            {field?.enumValues ? (
              <Select value={String(action.value ?? '')} onValueChange={(v) => { onChange({ ...action, value: v }); }} options={field.enumValues.map((v) => ({ value: v, label: v }))} />
            ) : (
              <Input
                value={action.value === null ? '' : String(action.value)}
                inputMode={field?.type === 'number' ? 'decimal' : undefined}
                onChange={(e) => {
                  const raw = e.target.value;
                  onChange({ ...action, value: raw === '' ? null : field?.type === 'number' && !Number.isNaN(Number(raw)) ? Number(raw) : field?.type === 'boolean' ? raw === 'true' : raw });
                }}
              />
            )}
          </Field>
        </div>
      );
    }
    case 'create_task':
      return (
        <div className="flex flex-col gap-3">
          <Field label={t('settings.rule.taskTitle')}><Input value={action.title} maxLength={500} onChange={(e) => { onChange({ ...action, title: e.target.value }); }} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('task.form.priority')}>
              <Select value={String(action.priority)} onValueChange={(v) => { onChange({ ...action, priority: Number(v) }); }} options={[0, 1, 2, 3, 4].map((p) => ({ value: String(p), label: t(`tasks.priority.${String(p)}` as 'tasks.priority.0') }))} />
            </Field>
            <Field label={t('settings.rule.dueInDays')}>
              <Input type="number" min={0} max={3650} value={action.dueInDays ?? ''} onChange={(e) => { const { dueInDays: _drop, ...rest } = action; onChange(e.target.value === '' ? rest : { ...rest, dueInDays: Math.max(0, Number(e.target.value)) }); }} />
            </Field>
          </div>
          <TargetEditor label={t('settings.rule.assignTo')} value={action.assignTo} onChange={(assignTo) => { onChange({ ...action, assignTo }); }} />
        </div>
      );
    case 'assign':
      return <TargetEditor label={t('settings.rule.assignTo')} value={action.to} onChange={(to) => { onChange({ ...action, to }); }} />;
    case 'notify':
      return (
        <div className="flex flex-col gap-3">
          <TargetEditor label={t('settings.rule.recipient')} value={action.to} onChange={(to) => { onChange({ ...action, to }); }} />
          <Field label={t('settings.rule.message')}><Textarea value={action.message} maxLength={500} rows={2} onChange={(e) => { onChange({ ...action, message: e.target.value }); }} /></Field>
        </div>
      );
    case 'send_email':
      return (
        <div className="flex flex-col gap-3">
          <TargetEditor label={t('settings.rule.recipient')} value={action.to} onChange={(to) => { onChange({ ...action, to }); }} />
          <Field label={t('settings.rule.subject')}><Input value={action.subject} maxLength={200} onChange={(e) => { onChange({ ...action, subject: e.target.value }); }} /></Field>
          <Field label={t('settings.rule.body')}><Textarea value={action.body} maxLength={5000} rows={4} onChange={(e) => { onChange({ ...action, body: e.target.value }); }} /></Field>
        </div>
      );
    case 'transition':
      return (
        <Field label={t('settings.rule.transition')}>
          <Select value={action.transitionKey} onValueChange={(v) => { onChange({ ...action, transitionKey: v }); }} options={transitions.map((x) => ({ value: x.key, label: labelOf(x.label, x.key) }))} />
        </Field>
      );
    case 'call_webhook':
      return (
        <Field label={t('settings.rule.webhook')} hint={webhooks.length === 0 ? t('settings.rule.noWebhooks') : undefined}>
          <Select value={action.subscriptionId || undefined} onValueChange={(v) => { onChange({ ...action, subscriptionId: v }); }} options={webhooks.map((w) => ({ value: w.id, label: w.name }))} placeholder={t('settings.rule.pickWebhook')} />
        </Field>
      );
  }
}

/** One-line description of a trigger for the rule list. */
export function triggerSummary(tr: Trigger): string {
  switch (tr.type) {
    case 'field_changed': return `${t('settings.rule.trigger.field_changed')}: ${tr.fields.join(', ')}`;
    case 'status_changed': return tr.toStatus ? `${t('settings.rule.trigger.status_changed')} → ${tr.toStatus}` : t('settings.rule.trigger.status_changed');
    case 'schedule': return `${t('settings.rule.trigger.schedule')} (${tr.cron})`;
    case 'sla': return `${t('settings.rule.trigger.sla')}: ${t(`settings.rule.sla.${tr.event}`)}`;
    default: return t(`settings.rule.trigger.${tr.type}`);
  }
}
