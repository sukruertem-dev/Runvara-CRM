'use client';

import { Alert, Badge, Button, Dialog, DialogContent, DialogFooter, ErrorState, Field, IconButton, Input, Select, Skeleton, Switch, Textarea, useToast } from '@flexa/ui';
import { ArrowDown, ArrowLeft, ArrowUp, Plus, Save, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../../../../../lib/api';
import { useApp } from '../../../../../lib/app-context';
import { messageForCode } from '../../../../../lib/errors';
import { dateTime } from '../../../../../lib/format';
import { t } from '../../../../../lib/i18n';
import { useRqlFields, type Resource } from '../../../../../lib/records';
import { useRule, useRuleMutations, useRuleRuns, useWebhooks, useWorkflows, type Rule, type RuleDefinition } from '../../../../../lib/settings';
import { FilterBar } from '../../../../_components/filter-bar';
import { PageContainer } from '../../../../_components/app-shell';
import { ReadOnlyNotice, SettingsGate } from '../../_parts/settings-nav';
import { ACTION_TYPES, ActionEditor, defaultAction, defaultTrigger, TRIGGER_TYPES, triggerAllowed, TriggerEditor, type Action } from '../_parts/rule-parts';

const RESOURCES: Resource[] = ['task', 'account', 'contact', 'lead', 'opportunity', 'case'];

interface Draft {
  name: string;
  description: string;
  enabled: boolean;
  definition: RuleDefinition;
}

const EMPTY: Draft = {
  name: '',
  description: '',
  enabled: true,
  definition: { resourceType: 'task', trigger: { type: 'record.created' }, condition: '', actions: [{ type: 'notify', to: { kind: 'record_owner' }, message: '' }] },
};

function Step({ n, title, lead, children }: { n: number; title: string; lead: string; children: ReactNode }) {
  const id = `rule-step-${String(n)}`;
  return (
    <section aria-labelledby={id} className="rounded-card border border-line bg-surface p-4" data-testid={`rule-step-${String(n)}`}>
      <div className="mb-3 flex items-start gap-3">
        <span aria-hidden className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-on-primary dark:bg-accent-btn dark:text-on-accent">{n}</span>
        <div>
          <h2 id={id} className="m-0 text-base font-semibold"><span className="sr-only">{t('settings.rule.step', { n: String(n) })} </span>{title}</h2>
          <p className="m-0 text-sm text-fg-muted">{lead}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function Runs({ ruleId }: { ruleId: string }) {
  const runs = useRuleRuns(ruleId);
  const tone = (s: string) => (s === 'succeeded' ? 'success' : s === 'skipped' ? 'neutral' : 'danger');
  return (
    <section aria-labelledby="rule-runs" className="mt-6">
      <h2 id="rule-runs" className="m-0 mb-2 text-base font-semibold">{t('settings.rule.runs')}</h2>
      {runs.data?.data.length ? (
        <ul className="m-0 flex list-none flex-col divide-y divide-line rounded-card border border-line bg-surface p-0 text-sm">
          {runs.data.data.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <Badge tone={tone(r.status)}>{t(`settings.rule.run.${r.status}`)}</Badge>
              <span className="text-fg-muted">{dateTime(r.startedAt)}</span>
              <span className="text-fg-muted">{r.record.type}</span>
              {r.durationMs !== null ? <span className="tabular-nums text-fg-muted">{r.durationMs} ms</span> : null}
              {r.error ? <span className="min-w-0 flex-1 truncate text-danger">{r.error}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-sm text-fg-muted">{t('settings.rule.noRuns')}</p>
      )}
    </section>
  );
}

function Builder({ rule }: { rule: Rule | null }) {
  const router = useRouter();
  const { can, nav } = useApp();
  const editable = can('tenant.config.manage');
  const { toast } = useToast();
  const m = useRuleMutations();
  const [draft, setDraft] = useState<Draft>(rule ? { name: rule.name, description: rule.description ?? '', enabled: rule.enabled, definition: rule.definition } : EMPTY);
  useEffect(() => { if (rule) setDraft({ name: rule.name, description: rule.description ?? '', enabled: rule.enabled, definition: rule.definition }); }, [rule]);
  const [error, setError] = useState<string | null>(null);
  /** Inbound-webhook token of a rule just created: shown once, then the page moves to the saved rule. */
  const [created, setCreated] = useState<{ id: string; token: string } | null>(null);
  const def = draft.definition;
  const fieldsQ = useRqlFields(def.resourceType);
  const fields = fieldsQ.data?.data ?? [];
  const workflows = useWorkflows();
  const wf = workflows.data?.data.find((w) => w.resourceType === def.resourceType && w.isDefault);
  const webhooksOn = nav?.modules.some((x) => x.id === 'api_webhooks') ?? false;
  const webhooks = useWebhooks(webhooksOn);
  const actionTypes = ACTION_TYPES.filter((a) => (a !== 'call_webhook' || webhooksOn) && (a !== 'transition' || wf) && (a !== 'email_customer' || def.resourceType === 'contact'));

  const setDef = (patch: Partial<RuleDefinition>) => { setDraft((d) => ({ ...d, definition: { ...d.definition, ...patch } })); };
  const setAction = (i: number, a: Action) => { setDef({ actions: def.actions.map((x, j) => (j === i ? a : x)) }); };

  async function save(): Promise<void> {
    setError(null);
    try {
      const body = { name: draft.name.trim(), description: draft.description.trim() || null, enabled: draft.enabled, definition: draft.definition };
      if (rule) {
        await m.patch.mutateAsync({ id: rule.id, body });
        toast({ title: t('settings.saved'), kind: 'success' });
      } else {
        const created = await m.create.mutateAsync({ ...body, description: body.description ?? undefined });
        toast({ title: t('settings.rule.created'), kind: 'success' });
        if (created.hookToken) setCreated({ id: created.id, token: created.hookToken });
        else router.replace(`/settings/automation/${created.id}`);
      }
    } catch (e) {
      setError(e instanceof ApiError ? `${messageForCode(e.code)} ${e.problem.detail ?? ''}`.trim() : t('error.fallback'));
    }
  }

  return (
    <PageContainer>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-2">
          <Link href="/settings/automation" className="inline-flex items-center gap-1 text-sm text-fg-muted no-underline hover:text-fg"><ArrowLeft aria-hidden size={14} /> {t('settings.automation')}</Link>
          <h1 className="m-0 font-display text-xl font-bold">{rule ? rule.name : t('settings.rule.new')}</h1>
        </div>
        {editable ? (
          <Button icon={<Save aria-hidden size={16} />} loading={m.create.isPending || m.patch.isPending} disabled={!draft.name.trim() || def.actions.length === 0} onClick={() => { void save(); }} data-testid="rule-save">
            {t('settings.save')}
          </Button>
        ) : null}
      </div>
      {editable ? null : <ReadOnlyNotice />}
      {error ? <Alert kind="error" className="mb-4">{error}</Alert> : null}
      <Dialog open={created !== null} onOpenChange={(o) => { if (!o && created) router.replace(`/settings/automation/${created.id}`); }}>
        <DialogContent title={t('settings.rule.hookTokenTitle')} description={t('settings.int.secretOnce')} closeLabel={t('common.close')}>
          <code className="block break-all rounded-input bg-subtle p-2 text-xs" data-testid="one-time-secret">{created?.token}</code>
          <DialogFooter><Button onClick={() => { if (created) router.replace(`/settings/automation/${created.id}`); }}>{t('settings.int.stored')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <fieldset disabled={!editable} className="m-0 flex flex-col gap-4 border-0 p-0">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <Field label={t('settings.rule.name')}><Input value={draft.name} maxLength={120} onChange={(e) => { setDraft((d) => ({ ...d, name: e.target.value })); }} data-testid="rule-name" /></Field>
          <label className="inline-flex items-center gap-2 self-end pb-2 text-sm"><Switch checked={draft.enabled} onCheckedChange={(v) => { setDraft((d) => ({ ...d, enabled: v })); }} />{t('settings.enabled')}</label>
        </div>
        <Field label={t('settings.rule.description')}><Textarea value={draft.description} maxLength={1000} rows={2} onChange={(e) => { setDraft((d) => ({ ...d, description: e.target.value })); }} /></Field>

        <Step n={1} title={t('settings.rule.when')} lead={t('settings.rule.whenLead')}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('settings.rule.resource')}>
              <Select
                value={def.resourceType}
                onValueChange={(v) => {
                  const resourceType = v as Resource;
                  setDef({ resourceType, condition: '', trigger: triggerAllowed(def.trigger.type, resourceType) ? def.trigger : { type: 'record.created' } });
                }}
                options={RESOURCES.map((r) => ({ value: r, label: t(`settings.resource.${r}`) }))}
              />
            </Field>
            <Field label={t('settings.rule.trigger')}>
              <Select
                value={def.trigger.type}
                onValueChange={(v) => { setDef({ trigger: defaultTrigger(v as RuleDefinition['trigger']['type']) }); }}
                options={TRIGGER_TYPES.filter((x) => triggerAllowed(x, def.resourceType)).map((x) => ({ value: x, label: t(`settings.rule.trigger.${x}`) }))}
              />
            </Field>
          </div>
          <div className="mt-3"><TriggerEditor trigger={def.trigger} onChange={(trigger) => { setDef({ trigger }); }} fields={fields} statuses={wf?.statuses ?? []} /></div>
        </Step>

        <Step n={2} title={t('settings.rule.if')} lead={t('settings.rule.ifLead')}>
          <FilterBar key={def.resourceType} resource={def.resourceType} value={def.condition} onChange={(condition) => { setDef({ condition }); }} />
          <p className="m-0 mt-2 text-xs text-fg-muted">{def.condition ? t('settings.rule.conditionSet') : t('settings.rule.conditionNone')}</p>
        </Step>

        <Step n={3} title={t('settings.rule.then')} lead={t('settings.rule.thenLead')}>
          <ol className="m-0 flex list-none flex-col gap-3 p-0">
            {def.actions.map((a, i) => (
              <li key={`${a.type}-${String(i)}`} className="rounded-input border border-line p-3" data-testid="rule-action">
                <div className="mb-3 flex flex-wrap items-end gap-2">
                  <Field label={t('settings.rule.actionType', { n: String(i + 1) })} className="min-w-48 flex-1">
                    <Select value={a.type} onValueChange={(v) => { setAction(i, defaultAction(v as Action['type'], fields)); }} options={actionTypes.map((x) => ({ value: x, label: t(`settings.rule.action.${x}`) }))} />
                  </Field>
                  {editable ? (
                    <span className="flex gap-1">
                      <IconButton size="sm" label={t('settings.moveUp', { name: t(`settings.rule.action.${a.type}`) })} disabled={i === 0} onClick={() => { const next = [...def.actions]; [next[i - 1], next[i]] = [a, next[i - 1] ?? a]; setDef({ actions: next }); }}><ArrowUp aria-hidden size={14} /></IconButton>
                      <IconButton size="sm" label={t('settings.moveDown', { name: t(`settings.rule.action.${a.type}`) })} disabled={i === def.actions.length - 1} onClick={() => { const next = [...def.actions]; [next[i + 1], next[i]] = [a, next[i + 1] ?? a]; setDef({ actions: next }); }}><ArrowDown aria-hidden size={14} /></IconButton>
                      <IconButton size="sm" label={t('settings.rule.removeAction', { n: String(i + 1) })} disabled={def.actions.length === 1} onClick={() => { setDef({ actions: def.actions.filter((_, j) => j !== i) }); }}><Trash2 aria-hidden size={14} /></IconButton>
                    </span>
                  ) : null}
                </div>
                <ActionEditor action={a} onChange={(next) => { setAction(i, next); }} fields={fields} transitions={wf?.transitions ?? []} webhooks={webhooks.data?.data ?? []} />
              </li>
            ))}
          </ol>
          {editable && def.actions.length < 10 ? (
            <Button size="sm" variant="secondary" className="mt-3" icon={<Plus aria-hidden size={14} />} onClick={() => { setDef({ actions: [...def.actions, defaultAction('notify', fields)] }); }} data-testid="rule-add-action">
              {t('settings.rule.addAction')}
            </Button>
          ) : null}
        </Step>
      </fieldset>
      <details className="mt-4 text-sm">
        <summary className="cursor-pointer text-fg-muted">{t('settings.rule.json')}</summary>
        <pre className="mt-2 max-h-72 overflow-auto rounded-input bg-subtle p-3 text-xs">{JSON.stringify(def, null, 2)}</pre>
      </details>
      {rule ? <Runs ruleId={rule.id} /> : null}
    </PageContainer>
  );
}

export default function RulePage() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === 'new';
  const q = useRule(isNew ? null : id);
  return (
    <SettingsGate anyOf={['tenant.config.read']} module="automation_sla">
      {isNew ? (
        <Builder rule={null} />
      ) : q.isPending ? (
        <PageContainer><Skeleton className="h-80 w-full" /></PageContainer>
      ) : q.isError ? (
        <PageContainer><ErrorState title={t('page.notFound')} retryLabel={t('common.retry')} onRetry={() => { void q.refetch(); }} /></PageContainer>
      ) : (
        <Builder rule={q.data} />
      )}
    </SettingsGate>
  );
}
