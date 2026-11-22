'use client';

import { Badge, Button, Dialog, DialogContent, DialogFooter, EmptyState, ErrorState, IconButton, Skeleton, Switch, useToast } from '@flexa/ui';
import { Plus, Trash2, Workflow as WorkflowIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { ApiError } from '../../../../lib/api';
import { useApp } from '../../../../lib/app-context';
import { messageForCode } from '../../../../lib/errors';
import { t } from '../../../../lib/i18n';
import { useRuleMutations, useRules, type Rule } from '../../../../lib/settings';
import { PageContainer } from '../../../_components/app-shell';
import { ReadOnlyNotice, SettingsGate, SettingsHeader } from '../_parts/settings-nav';
import { triggerSummary } from './_parts/rule-parts';

function RulesInner() {
  const { can } = useApp();
  const editable = can('tenant.config.manage');
  const { toast } = useToast();
  const q = useRules();
  const m = useRuleMutations();
  const [removing, setRemoving] = useState<Rule | null>(null);
  const fail = (e: unknown) => { toast({ title: e instanceof ApiError ? messageForCode(e.code) : t('error.fallback'), kind: 'error' }); };
  const rules = q.data?.data ?? [];
  return (
    <PageContainer>
      <SettingsHeader
        title={t('settings.automation')}
        lead={t('settings.rule.lead')}
        actions={editable ? <Button asChild><Link href="/settings/automation/new" data-testid="rule-new"><Plus aria-hidden size={16} /> {t('settings.rule.new')}</Link></Button> : undefined}
      />
      {editable ? null : <ReadOnlyNotice />}
      {q.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : q.isError ? (
        <ErrorState title={t('error.fallback')} retryLabel={t('common.retry')} onRetry={() => { void q.refetch(); }} />
      ) : rules.length === 0 ? (
        <EmptyState icon={WorkflowIcon} title={t('settings.rule.empty')} description={t('settings.rule.emptyBody')} />
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-line rounded-card border border-line bg-surface p-0">
          {rules.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="rule-row">
              <div className="min-w-0 flex-1">
                <Link href={`/settings/automation/${r.id}`} className="font-medium text-fg">{r.name}</Link>
                <p className="m-0 mt-0.5 text-xs text-fg-muted">
                  {t(`settings.resource.${r.definition.resourceType}`)} · {triggerSummary(r.definition.trigger)} · {t('settings.rule.actionCount', { count: String(r.definition.actions.length) })}
                </p>
              </div>
              <Badge tone="neutral">v{r.version}</Badge>
              <label className="inline-flex items-center gap-2 text-sm">
                <Switch
                  checked={r.enabled}
                  disabled={!editable}
                  aria-label={t('settings.rule.toggle', { name: r.name })}
                  onCheckedChange={(enabled) => { m.patch.mutate({ id: r.id, body: { enabled } }, { onError: fail }); }}
                />
                <span aria-hidden>{r.enabled ? t('settings.enabled') : t('settings.disabled')}</span>
              </label>
              {editable ? (
                <IconButton size="sm" label={t('settings.rule.delete', { name: r.name })} onClick={() => { setRemoving(r); }}><Trash2 aria-hidden size={14} /></IconButton>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <Dialog open={removing !== null} onOpenChange={(o) => { if (!o) setRemoving(null); }}>
        <DialogContent title={t('settings.rule.deleteTitle')} description={t('settings.rule.deleteBody', { name: removing?.name ?? '' })} closeLabel={t('common.close')}>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setRemoving(null); }}>{t('common.cancel')}</Button>
            <Button variant="danger" loading={m.remove.isPending} onClick={() => { if (removing) m.remove.mutate(removing.id, { onSuccess: () => { setRemoving(null); }, onError: fail }); }}>{t('settings.delete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}

export default function AutomationPage() {
  return (
    <SettingsGate anyOf={['tenant.config.read']} module="automation_sla">
      <RulesInner />
    </SettingsGate>
  );
}
