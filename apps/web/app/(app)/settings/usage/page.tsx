'use client';

import { Badge, cn, ErrorState, Skeleton } from '@flexa/ui';
import { formatDate, formatNumber } from '../../../../lib/format';
import { moduleLabel, t, tOptional } from '../../../../lib/i18n';
import { formatBytes, useUsage, type UsageDimension } from '../../../../lib/platform';
import { PageContainer } from '../../../_components/app-shell';
import { SettingsGate, SettingsHeader } from '../_parts/settings-nav';

// Plan, quota and usage (TEN-09, docs/p7-plan.md §9 and §11).

const LEVEL_TONE = { ok: 'neutral', warning: 'warning', soft: 'warning', hard: 'danger' } as const;
const BAR = { ok: 'bg-primary dark:bg-accent', warning: 'bg-warning', soft: 'bg-warning', hard: 'bg-danger' } as const;

/** A calendar day (YYYY-MM-DD) read at noon UTC, so no display time zone moves it to another date. */
const formatDay = (day: string): string => formatDate(`${day}T12:00:00Z`);

const dimensionValue = (d: Pick<UsageDimension, 'dimension'>, v: number): string =>
  d.dimension === 'storage_bytes' ? formatBytes(v, formatNumber) : formatNumber(v);

export default function UsagePage() {
  return (
    <PageContainer>
      <SettingsGate anyOf={['tenant.config.read']}>
        <Usage />
      </SettingsGate>
    </PageContainer>
  );
}

function Usage() {
  const usage = useUsage();
  const header = <SettingsHeader title={t('usage.title')} lead={t('usage.lead')} />;
  if (usage.isError) return <>{header}<ErrorState title={t('error.fallback')} retryLabel={t('common.retry')} onRetry={() => { void usage.refetch(); }} /></>;
  if (!usage.data) return <>{header}<Skeleton className="h-96 w-full" /></>;
  const { plan, dimensions, rates, apiRequests } = usage.data;
  const max = Math.max(1, ...apiRequests.map((d) => d.count));
  const total = apiRequests.reduce((n, d) => n + d.count, 0);
  return (
    <>
      {header}
      <section className="mb-6 grid gap-3 rounded-card border border-line bg-surface p-4 sm:grid-cols-3" aria-label={t('usage.plan')} data-testid="usage-plan">
        <div>
          <p className="m-0 text-xs text-fg-muted">{t('usage.plan')}</p>
          <p className="m-0 mt-1 font-display text-lg font-bold">{tOptional(plan.displayNameKey) ?? plan.id}</p>
          {plan.trialEndsAt ? <p className="m-0 mt-1 text-xs text-fg-muted">{t('usage.trialEnds', { date: formatDate(plan.trialEndsAt) })}</p> : null}
        </div>
        <div>
          <p className="m-0 text-xs text-fg-muted">{t('usage.addOns')}</p>
          <p className="m-0 mt-1 text-sm">{plan.addOns.length ? plan.addOns.map(moduleLabel).join(', ') : t('usage.noAddOns')}</p>
        </div>
        <div>
          <p className="m-0 text-xs text-fg-muted">{t('usage.rates')}</p>
          <p className="m-0 mt-1 text-sm">{t('usage.rates.body', { tenant: formatNumber(rates.apiRpm), user: formatNumber(rates.apiRpmPerUser) })}</p>
        </div>
        <p className="m-0 text-xs text-fg-muted sm:col-span-3">{t('usage.change')}</p>
      </section>

      <ul className="m-0 mb-6 grid list-none gap-3 p-0 sm:grid-cols-2" data-testid="usage-dimensions">
        {dimensions.map((d) => {
          const label = t(`usage.dim.${d.dimension}`);
          const pct = d.limit > 0 ? Math.round((d.used / d.limit) * 100) : 0;
          return (
            <li key={d.dimension} className="rounded-card border border-line bg-surface p-4" data-testid={`usage-${d.dimension}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="m-0 text-sm font-semibold">{label}</h2>
                  <p className="m-0 text-xs text-fg-muted">{t(`usage.dim.${d.dimension}.hint`)}</p>
                </div>
                {d.level !== 'ok' ? <Badge tone={LEVEL_TONE[d.level]}>{t(`usage.level.${d.level}`)}</Badge> : null}
              </div>
              {d.limit === 0 ? (
                <p className="m-0 mt-3 text-sm text-fg-muted">{t('usage.notInPlan')}</p>
              ) : (
                <>
                  <p className="m-0 mt-3 text-sm tabular-nums">{t('usage.of', { used: dimensionValue(d, d.used), limit: dimensionValue(d, d.limit) })}</p>
                  <div
                    role="progressbar"
                    aria-label={label}
                    aria-valuemin={0}
                    aria-valuemax={d.limit}
                    aria-valuenow={Math.min(d.used, d.limit)}
                    aria-valuetext={`${String(pct)} %`}
                    className="mt-2 h-2 overflow-hidden rounded-full bg-subtle"
                  >
                    <div className={cn('h-full rounded-full', BAR[d.level])} style={{ width: `${String(Math.min(100, pct))}%` }} />
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>

      <section className="rounded-card border border-line bg-surface p-4" aria-labelledby="api-h" data-testid="usage-api">
        <h2 id="api-h" className="m-0 text-sm font-semibold">{t('usage.api')}</h2>
        <p className="m-0 mt-1 text-xs text-fg-muted">{t('usage.api.total', { count: formatNumber(total) })}</p>
        <div className="mt-3 flex h-28 items-end gap-0.5" aria-hidden>
          {apiRequests.map((d) => (
            <div key={d.day} className="flex h-full flex-1 items-end" title={`${formatDay(d.day)}: ${formatNumber(d.count)}`}>
              <div className="w-full rounded-t-sm bg-info" style={{ height: `${String(d.count === 0 ? 0 : Math.max(4, (d.count / max) * 100))}%` }} />
            </div>
          ))}
        </div>
        <table className="sr-only">
          <caption>{t('usage.api')}</caption>
          <tbody>
            {apiRequests.filter((d) => d.count > 0).map((d) => (
              <tr key={d.day}><th scope="row">{formatDay(d.day)}</th><td>{formatNumber(d.count)}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
