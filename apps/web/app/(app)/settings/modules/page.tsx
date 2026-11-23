'use client';

import { Badge, Button, Dialog, DialogContent, DialogFooter, ErrorState, ModuleIcon, SegmentedControl, Skeleton, Switch, useToast } from '@flexa/ui';
import { useState } from 'react';
import { ApiError } from '../../../../lib/api';
import { useApp } from '../../../../lib/app-context';
import { messageForCode } from '../../../../lib/errors';
import { moduleLabel, t, tOptional } from '../../../../lib/i18n';
import { useModules, useSetSalesMode, useToggleModule, type ModuleState, type SalesMode } from '../../../../lib/platform';
import { PageContainer } from '../../../_components/app-shell';
import { ENTITLEMENT_TONE, groupsText, MODULE_ICONS } from '../_parts/module-parts';
import { SettingsGate, SettingsHeader } from '../_parts/settings-nav';

// Module catalogue (MOD-01…04, docs/p7-plan.md §11): switch modules, see the plan entitlement and the
// dependencies, confirm a cascade, and choose the sales mode.

const SALES_MODES: readonly SalesMode[] = ['b2b_only', 'b2c_only', 'both'];

export default function ModulesPage() {
  return (
    <PageContainer>
      <SettingsGate anyOf={['tenant.modules.manage', 'tenant.config.read']}>
        <Modules />
      </SettingsGate>
    </PageContainer>
  );
}

function Modules() {
  const { can, nav } = useApp();
  const modules = useModules();
  const toggle = useToggleModule();
  const salesMode = useSetSalesMode();
  const toast = useToast();
  const [cascade, setCascade] = useState<{ module: ModuleState; dependents: string[] } | null>(null);
  const manage = can('tenant.modules.manage');
  const header = <SettingsHeader title={t('modules.title')} lead={t('modules.lead')} />;

  if (modules.isError) return <>{header}<ErrorState title={t('error.fallback')} retryLabel={t('common.retry')} onRetry={() => { void modules.refetch(); }} /></>;
  if (!modules.data || !nav) return <>{header}<Skeleton className="h-96 w-full" /></>;

  const fail = (err: unknown, m: ModuleState) => {
    if (err instanceof ApiError && err.code === 'MODULE_HAS_DEPENDENTS') {
      const deps = err.problem.dependents;
      setCascade({ module: m, dependents: Array.isArray(deps) ? deps.filter((d): d is string => typeof d === 'string') : [] });
      return;
    }
    if (err instanceof ApiError && err.code === 'MODULE_DEPENDENCY_UNMET' && Array.isArray(err.problem.missing)) {
      const missing = (err.problem.missing as unknown[]).map((g) => (Array.isArray(g) ? g.filter((x): x is string => typeof x === 'string') : []));
      toast.toast({ kind: 'error', title: t('modules.missing', { list: groupsText(missing) }) });
      return;
    }
    toast.toast({ kind: 'error', title: err instanceof ApiError ? messageForCode(err.code) : t('error.fallback') });
  };

  const switchModule = (m: ModuleState, enable: boolean, withCascade = false) => {
    toggle.mutate({ id: m.id, enable, cascade: withCascade }, {
      onSuccess: () => {
        setCascade(null);
        toast.toast({ kind: 'success', title: t(enable ? 'modules.enabled' : 'modules.disabled', { name: moduleLabel(m.displayNameKey) }) });
      },
      onError: (err) => { fail(err, m); },
    });
  };

  return (
    <>
      {header}
      <section className="mb-6 rounded-card border border-line bg-surface p-4" aria-labelledby="sales-mode-h">
        <h2 id="sales-mode-h" className="m-0 text-base font-semibold">{t('modules.salesMode.title')}</h2>
        <p className="m-0 mb-3 mt-1 text-sm text-fg-muted">{t('modules.salesMode.lead')}</p>
        {can('tenant.sales_mode.manage') ? (
          <SegmentedControl
            label={t('modules.salesMode.title')}
            value={nav.salesMode}
            onValueChange={(v) => {
              salesMode.mutate(v, {
                onSuccess: () => { toast.toast({ kind: 'success', title: t('modules.salesMode.saved') }); },
                onError: (err) => { toast.toast({ kind: 'error', title: err instanceof ApiError ? messageForCode(err.code) : t('error.fallback') }); },
              });
            }}
            options={SALES_MODES.map((v) => ({ value: v, label: t(`modules.salesMode.${v}`) }))}
          />
        ) : (
          <p className="m-0 text-sm font-medium">{t(`modules.salesMode.${nav.salesMode}`)}</p>
        )}
      </section>

      <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2" data-testid="module-list">
        {modules.data.data.map((m) => {
          const name = moduleLabel(m.displayNameKey);
          const purchasable = m.entitlement === 'included' || m.entitlement === 'add_on';
          const disabled = !manage || m.alwaysOn || toggle.isPending || (!m.enabled && !purchasable);
          return (
            <li key={m.id} className="flex gap-3 rounded-card border border-line bg-surface p-4" data-testid={`module-${m.id}`}>
              <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-btn bg-subtle text-fg-muted">
                <ModuleIcon name={MODULE_ICONS[m.id] ?? 'square'} size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <h3 className="m-0 text-sm font-semibold">{name}</h3>
                  {m.alwaysOn ? <Badge tone="neutral">{t('modules.alwaysOn')}</Badge> : <Badge tone={ENTITLEMENT_TONE[m.entitlement]}>{t(`plan.entitlement.${m.entitlement}`)}</Badge>}
                </div>
                <p className="m-0 mt-1 text-xs text-fg-muted">{tOptional(`module.${m.id}.description`) ?? ''}</p>
                {m.dependsOn.length > 0 ? <p className="m-0 mt-1 text-xs text-fg-muted">{t('modules.needs', { list: groupsText(m.dependsOn) })}</p> : null}
              </div>
              <Switch
                checked={m.enabled}
                disabled={disabled}
                aria-label={t(m.enabled ? 'modules.disable' : 'modules.enable', { name })}
                onCheckedChange={(on) => { switchModule(m, on); }}
              />
            </li>
          );
        })}
      </ul>
      <p className="m-0 mt-4 text-xs text-fg-muted">{t('modules.planHint')}</p>

      <Dialog open={cascade !== null} onOpenChange={(open) => { if (!open) setCascade(null); }}>
        {cascade ? (
          <DialogContent title={t('modules.cascade.title')} closeLabel={t('common.close')} description={t('modules.cascade.body', { name: moduleLabel(cascade.module.displayNameKey) })}>
            <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm">
              {cascade.dependents.map((d) => <li key={d}>{moduleLabel(d)}</li>)}
            </ul>
            <DialogFooter>
              <Button variant="secondary" onClick={() => { setCascade(null); }}>{t('common.cancel')}</Button>
              <Button variant="danger" loading={toggle.isPending} onClick={() => { switchModule(cascade.module, false, true); }}>{t('modules.cascade.confirm')}</Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}
