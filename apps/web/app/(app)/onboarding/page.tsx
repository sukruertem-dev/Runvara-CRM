'use client';

import { Badge, Button, cn, EmptyState, ErrorState, ModuleIcon, Skeleton, useToast } from '@flexa/ui';
import { Check, Rocket } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../../../lib/api';
import { useApp } from '../../../lib/app-context';
import { messageForCode } from '../../../lib/errors';
import { moduleLabel, t, tOptional } from '../../../lib/i18n';
import {
  previewOnboarding, useApplyConfig, useBlueprints, useModules, useOnboarding, useSkipOnboarding,
  type Blueprint, type ModuleState, type OnboardingChoice, type Plan, type SalesMode,
} from '../../../lib/platform';
import { PageContainer } from '../../_components/app-shell';
import { PlanView } from '../settings/_parts/plan-view';
import { ENTITLEMENT_TONE, groupsText, MODULE_ICONS } from '../settings/_parts/module-parts';

// Onboarding wizard (docs/p7-plan.md §8): industry blueprint → sales mode → modules → summary (dry run) →
// one transaction. Reachable from the home page card while the workspace's onboarding is pending.

const STEPS = ['blueprint', 'salesMode', 'modules', 'review'] as const;
type Step = (typeof STEPS)[number];
const SALES_MODES: readonly SalesMode[] = ['b2b_only', 'b2c_only', 'both'];

const usable = (m: ModuleState): boolean => m.entitlement === 'included' || m.entitlement === 'add_on';

/** Adds missing dependencies (preferring the segment of the sales mode) until every chosen module's are met. */
function withDependencies(chosen: readonly string[], catalogue: readonly ModuleState[], salesMode: SalesMode): string[] {
  const out = new Set(chosen);
  const byId = new Map(catalogue.map((m) => [m.id, m]));
  for (let changed = true; changed;) {
    changed = false;
    for (const id of [...out]) {
      for (const group of byId.get(id)?.dependsOn ?? []) {
        if (group.some((d) => d === 'core' || out.has(d))) continue;
        const preferred = salesMode === 'b2c_only' ? 'sales_b2c' : 'sales_b2b';
        const pick = group.find((d) => d === preferred && byId.get(d) && usable(byId.get(d) as ModuleState)) ?? group.find((d) => { const m = byId.get(d); return m ? usable(m) : false; });
        if (pick) {
          out.add(pick);
          changed = true;
        }
      }
    }
  }
  return [...out];
}

/** Removes `id` and every chosen module that can no longer have its dependencies met. */
function withoutModule(chosen: readonly string[], id: string, catalogue: readonly ModuleState[]): string[] {
  const out = new Set(chosen.filter((m) => m !== id));
  const byId = new Map(catalogue.map((m) => [m.id, m]));
  for (let changed = true; changed;) {
    changed = false;
    for (const m of [...out]) {
      if ((byId.get(m)?.dependsOn ?? []).some((g) => !g.some((d) => d === 'core' || out.has(d)))) {
        out.delete(m);
        changed = true;
      }
    }
  }
  return [...out];
}

export default function OnboardingPage() {
  const { can } = useApp();
  const manage = can('tenant.config.manage');
  const state = useOnboarding(manage);
  if (!manage) {
    return <PageContainer><EmptyState icon={Rocket} title={t('settings.noAccess')} description={t('settings.noAccessBody')} /></PageContainer>;
  }
  if (state.isError) return <PageContainer><ErrorState title={t('error.fallback')} retryLabel={t('common.retry')} onRetry={() => { void state.refetch(); }} /></PageContainer>;
  if (!state.data) return <PageContainer><Skeleton className="h-96 w-full" /></PageContainer>;
  if (state.data.status !== 'pending') {
    return (
      <PageContainer>
        <EmptyState icon={Check} title={t('onboarding.notPending')} description="" action={<Button asChild variant="secondary"><Link href="/settings/modules">{t('onboarding.goSettings')}</Link></Button>} />
      </PageContainer>
    );
  }
  return <PageContainer><Wizard /></PageContainer>;
}

function Choice({ name, value, checked, onChange, title, body, extra, testId, type = 'radio', disabled = false }: {
  name: string; value: string; checked: boolean; onChange: () => void; title: string; body: string; extra?: ReactNode; testId: string; type?: 'radio' | 'checkbox'; disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer gap-3 rounded-card border bg-surface p-4 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2',
        checked ? 'border-primary bg-accent-soft dark:border-accent' : 'border-line hover:border-line-strong',
        disabled && 'cursor-not-allowed opacity-60',
      )}
      data-testid={testId}
    >
      <input type={type} name={name} value={value} checked={checked} disabled={disabled} onChange={onChange} className="mt-1 size-4 shrink-0 accent-primary" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="mt-1 block text-xs text-fg-muted">{body}</span>
        {extra}
      </span>
    </label>
  );
}

function Wizard() {
  const router = useRouter();
  const toast = useToast();
  const { nav } = useApp();
  const blueprints = useBlueprints();
  const modules = useModules();
  const apply = useApplyConfig();
  const skip = useSkipOnboarding();
  const [step, setStep] = useState<Step>('blueprint');
  const [blueprint, setBlueprint] = useState<string | null>(null);
  const [salesMode, setSalesMode] = useState<SalesMode>(nav?.salesMode ?? 'both');
  const [chosen, setChosen] = useState<string[]>(['crm']);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planError, setPlanError] = useState(false);

  const catalogue = (modules.data?.data ?? []).filter((m) => !m.alwaysOn);
  const choice: OnboardingChoice = { blueprint, salesMode, modules: chosen };

  // The summary is a dry run of exactly what will be applied.
  useEffect(() => {
    if (step !== 'review') return;
    setPlan(null);
    setPlanError(false);
    let live = true;
    previewOnboarding({ blueprint, salesMode, modules: chosen }).then((p) => { if (live) setPlan(p); }, () => { if (live) setPlanError(true); });
    return () => { live = false; };
  }, [step, blueprint, salesMode, chosen]);

  if (!blueprints.data || !modules.data) return <Skeleton className="h-96 w-full" />;

  const pickBlueprint = (b: Blueprint | null) => {
    setBlueprint(b?.id ?? null);
    if (b) {
      setSalesMode(b.salesMode);
      setChosen(withDependencies(b.modules.filter((m) => catalogue.some((c) => c.id === m && usable(c))), catalogue, b.salesMode));
    } else {
      setChosen(['crm']);
    }
  };

  const index = STEPS.indexOf(step);
  const go = (delta: number) => { setStep(STEPS[Math.min(STEPS.length - 1, Math.max(0, index + delta))] ?? 'blueprint'); };

  const finish = () => {
    apply.mutate({ kind: 'onboarding', choice }, {
      onSuccess: () => {
        toast.toast({ kind: 'success', title: t('onboarding.done') });
        router.push('/');
      },
      onError: (err) => { toast.toast({ kind: 'error', title: err instanceof ApiError ? messageForCode(err.code) : t('error.fallback') }); },
    });
  };

  return (
    <div className="mx-auto max-w-3xl" data-testid="onboarding">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="m-0 font-display text-xl font-bold">{t('onboarding.title')}</h1>
          <p className="m-0 mt-1 text-sm text-fg-muted">{t('onboarding.step', { n: String(index + 1), total: String(STEPS.length) })}</p>
        </div>
        <Button variant="ghost" loading={skip.isPending} onClick={() => { skip.mutate(undefined, { onSuccess: () => { toast.toast({ kind: 'info', title: t('onboarding.skipped') }); router.push('/'); } }); }}>
          {t('onboarding.skip')}
        </Button>
      </div>

      <ol className="m-0 mb-6 flex list-none gap-2 p-0" aria-label={t('onboarding.title')}>
        {STEPS.map((s, i) => (
          <li key={s} aria-current={s === step ? 'step' : undefined} className={cn('flex-1 border-t-4 pt-2 text-xs', i <= index ? 'border-primary font-semibold text-fg dark:border-accent' : 'border-line text-fg-muted')}>
            {t(`onboarding.step.${s}`)}
          </li>
        ))}
      </ol>

      <fieldset className="m-0 border-0 p-0">
        <legend className="mb-1 text-base font-semibold">{t(`onboarding.step.${step}`)}</legend>
        {step === 'blueprint' ? (
          <>
            <p className="m-0 mb-4 text-sm text-fg-muted">{t('onboarding.blueprint.lead')}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {blueprints.data.data.map((b) => (
                <Choice
                  key={b.id} name="blueprint" value={b.id} checked={blueprint === b.id} onChange={() => { pickBlueprint(b); }} testId={`blueprint-${b.id}`}
                  title={tOptional(b.nameKey) ?? b.id} body={tOptional(b.descriptionKey) ?? ''}
                  extra={<span className="mt-2 block text-xs text-fg-muted">{t('onboarding.blueprint.contents', { fields: String(b.counts.customFields), workflows: String(b.counts.taskWorkflows), sla: String(b.counts.slaPolicies) })}</span>}
                />
              ))}
              <Choice name="blueprint" value="" checked={blueprint === null} onChange={() => { pickBlueprint(null); }} testId="blueprint-empty" title={t('onboarding.blueprint.empty')} body={t('onboarding.blueprint.emptyBody')} />
            </div>
          </>
        ) : null}

        {step === 'salesMode' ? (
          <>
            <p className="m-0 mb-4 text-sm text-fg-muted">{t('onboarding.salesMode.lead')}</p>
            <div className="grid gap-3 sm:grid-cols-3">
              {SALES_MODES.map((v) => (
                <Choice key={v} name="salesMode" value={v} checked={salesMode === v} testId={`sales-mode-${v}`}
                  onChange={() => { setSalesMode(v); setChosen((c) => withDependencies(c, catalogue, v)); }}
                  title={t(`modules.salesMode.${v}`)} body={t(`onboarding.salesMode.${v}.body`)} />
              ))}
            </div>
          </>
        ) : null}

        {step === 'modules' ? (
          <>
            <p className="m-0 mb-4 text-sm text-fg-muted">{t('onboarding.modules.lead')}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {catalogue.map((m) => {
                const on = chosen.includes(m.id);
                return (
                  <Choice
                    key={m.id} type="checkbox" name="modules" value={m.id} checked={on} disabled={!usable(m)} testId={`onboarding-module-${m.id}`}
                    onChange={() => { setChosen((c) => (on ? withoutModule(c, m.id, catalogue) : withDependencies([...c, m.id], catalogue, salesMode))); }}
                    title={moduleLabel(m.displayNameKey)} body={tOptional(`module.${m.id}.description`) ?? ''}
                    extra={
                      <span className="mt-2 flex flex-wrap items-center gap-1.5">
                        <ModuleIcon name={MODULE_ICONS[m.id] ?? 'square'} size={14} className="text-fg-muted" />
                        <Badge tone={ENTITLEMENT_TONE[m.entitlement]}>{t(`plan.entitlement.${m.entitlement}`)}</Badge>
                        {m.dependsOn.length > 0 ? <span className="text-xs text-fg-muted">{t('modules.needs', { list: groupsText(m.dependsOn) })}</span> : null}
                      </span>
                    }
                  />
                );
              })}
            </div>
          </>
        ) : null}

        {step === 'review' ? (
          <>
            <p className="m-0 mb-4 text-sm text-fg-muted">{t('onboarding.review.lead')}</p>
            {planError ? <ErrorState title={t('error.fallback')} retryLabel={t('common.retry')} onRetry={() => { setStep('modules'); }} /> : plan ? <PlanView plan={plan} /> : <Skeleton className="h-48 w-full" />}
          </>
        ) : null}
      </fieldset>

      <div className="mt-6 flex justify-between gap-2">
        <Button variant="secondary" disabled={index === 0} onClick={() => { go(-1); }}>{t('onboarding.back')}</Button>
        {step === 'review' ? (
          <Button loading={apply.isPending} disabled={!plan || plan.blocking > 0} onClick={finish} data-testid="onboarding-finish">{t('onboarding.finish')}</Button>
        ) : (
          <Button onClick={() => { go(1); }} data-testid="onboarding-next">{t('onboarding.next')}</Button>
        )}
      </div>
    </div>
  );
}
