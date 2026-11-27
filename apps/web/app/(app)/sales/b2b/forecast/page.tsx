'use client';

import { Alert, Badge, Button, Dialog, DialogContent, DialogFooter, EmptyState, ErrorState, Field, IconButton, Input, SegmentedControl, Skeleton, Textarea, useToast } from '@flexa/ui';
import { Camera, ChevronLeft, ChevronRight, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useApp } from '../../../../../lib/app-context';
import { errorText } from '../../../../../lib/catalog';
import { shiftPeriod, thisPeriod, useAdjust, useForecast, useSnapshots, useStale, useTakeSnapshot, type Forecast } from '../../../../../lib/forecast';
import { formatDate, formatLocale, relativeTime } from '../../../../../lib/format';
import { t } from '../../../../../lib/i18n';
import { quoteMoney } from '../../../../../lib/quotes';
import { PageContainer } from '../../../../_components/app-shell';

// B2B forecast (B2B-07, docs/p9-plan.md §15–18): weighted pipeline by person, the Manager's call, snapshots, and
// the untouched opportunities of the scope (TRK-05).

type Owner = Forecast['owners'][number];

function periodLabel(period: string): string {
  const q = /^(\d{4})-Q([1-4])$/.exec(period);
  if (q) return t('forecast.quarterOf', { year: q[1] ?? '', q: q[2] ?? '' });
  return new Intl.DateTimeFormat(formatLocale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${period}-01T12:00:00Z`));
}
const day = (d: string): string => formatDate(`${d}T12:00:00`);

export default function ForecastPage() {
  const { can } = useApp();
  const [kind, setKind] = useState<'month' | 'quarter'>('month');
  const [period, setPeriod] = useState(() => thisPeriod('month'));
  const data = useForecast(period);
  const choose = (k: 'month' | 'quarter'): void => { setKind(k); setPeriod(thisPeriod(k)); };
  if (!can('sales_b2b.forecast.read')) {
    return <PageContainer><EmptyState icon={TrendingUp} title={t('forecast.noAccess')} description={t('forecast.noAccessBody')} /></PageContainer>;
  }
  return (
    <PageContainer>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="m-0 flex-1 font-display text-xl font-bold">{t('forecast.title')}</h1>
        <SegmentedControl label={t('forecast.periodKind')} value={kind} onValueChange={choose} options={[{ value: 'month', label: t('forecast.month') }, { value: 'quarter', label: t('forecast.quarter') }]} />
        <div className="flex items-center gap-1">
          <IconButton size="sm" label={t('forecast.prev')} onClick={() => { setPeriod((p) => shiftPeriod(p, -1)); }}><ChevronLeft aria-hidden size={16} /></IconButton>
          <span className="min-w-32 text-center font-semibold" data-testid="forecast-period" aria-live="polite">{periodLabel(period)}</span>
          <IconButton size="sm" label={t('forecast.next')} onClick={() => { setPeriod((p) => shiftPeriod(p, 1)); }}><ChevronRight aria-hidden size={16} /></IconButton>
        </div>
      </div>
      {data.isError ? <ErrorState title={errorText(data.error)} retryLabel={t('common.retry')} onRetry={() => { void data.refetch(); }} />
        : !data.data ? <Skeleton className="h-64 w-full" /> : <Body f={data.data} />}
    </PageContainer>
  );
}

function Body({ f }: { f: Forecast }) {
  const [adjusting, setAdjusting] = useState<Owner | null>(null);
  return (
    <div className="flex flex-col gap-6">
      <p className="m-0 text-sm text-fg-muted">{t('forecast.lead', { from: day(f.from), to: day(f.to) })}</p>
      {f.totals.length === 0 ? <EmptyState icon={TrendingUp} title={t('forecast.empty')} description={t('forecast.emptyBody')} /> : (
        <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2 lg:grid-cols-4" data-testid="forecast-totals" aria-label={t('forecast.totals')}>
          {f.totals.flatMap((x) => ([
            ['pipeline', x.pipeline], ['weighted', x.weighted], ['won', x.won], ['forecast', x.forecast],
          ] as const).map(([k, v]) => (
            <li key={`${x.currency}${k}`} className="rounded-card border border-line bg-surface p-4">
              <p className="m-0 text-xs font-semibold text-fg-muted">{t(`forecast.col.${k}`)}</p>
              <p className="m-0 mt-1 font-display text-lg font-bold tabular-nums" data-testid={`total-${k}`}>{quoteMoney(v, x.currency)}</p>
            </li>
          )))}
        </ul>
      )}
      {f.owners.length ? (
        <section aria-labelledby="fc-people">
          <h2 id="fc-people" className="m-0 mb-2 text-base font-semibold">{t('forecast.people')}</h2>
          <div className="overflow-x-auto rounded-card border border-line bg-surface">
            <table className="w-full min-w-[720px] border-collapse text-sm" data-testid="forecast-owners">
              <thead>
                <tr className="border-b border-line text-left text-xs text-fg-muted">
                  <th scope="col" className="px-3 py-2 font-semibold">{t('forecast.col.owner')}</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">{t('forecast.col.count')}</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">{t('forecast.col.pipeline')}</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">{t('forecast.col.weighted')}</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">{t('forecast.col.won')}</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">{t('forecast.col.forecast')}</th>
                  <th scope="col" className="px-3 py-2"><span className="sr-only">{t('forecast.adjust')}</span></th>
                </tr>
              </thead>
              <tbody>
                {f.owners.map((o) => (
                  <tr key={`${o.owner.id}${o.currency}`} className="border-b border-line last:border-0" data-testid="forecast-owner">
                    <th scope="row" className="px-3 py-2 text-left font-medium">{o.owner.displayName}</th>
                    <td className="px-3 py-2 text-right tabular-nums">{o.count}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{quoteMoney(o.pipeline, o.currency)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{quoteMoney(o.weighted, o.currency)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{quoteMoney(o.won, o.currency)}</td>
                    <td className="px-3 py-2 text-right">
                      <span className="font-semibold tabular-nums" data-testid="owner-forecast">{quoteMoney(o.forecast, o.currency)}</span>
                      {o.adjustment ? (
                        <span className="mt-0.5 block text-xs text-fg-muted">
                          <Badge tone="info">{t('forecast.adjusted')}</Badge> {o.adjustment.updatedBy.displayName}{o.adjustment.note ? ` · ${o.adjustment.note}` : ''}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {o.canAdjust ? <Button size="sm" variant="secondary" onClick={() => { setAdjusting(o); }} aria-label={t('forecast.adjustOf', { name: o.owner.displayName })} data-testid="owner-adjust">{t('forecast.adjust')}</Button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {f.opportunities.length ? (
        <section aria-labelledby="fc-opps">
          <h2 id="fc-opps" className="m-0 mb-2 text-base font-semibold">{t('forecast.opportunities')}</h2>
          <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="forecast-opps">
            {f.opportunities.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-3">
                <div className="min-w-48 flex-1">
                  <p className="m-0 font-semibold"><Link href={`/crm/opportunity/${o.id}`}>{o.name}</Link></p>
                  <p className="m-0 mt-0.5 text-xs text-fg-muted">{o.owner.displayName} · {o.stage} · {o.expectedClose ? day(o.expectedClose) : '—'}</p>
                </div>
                <span className="tabular-nums">{quoteMoney(o.amount, o.currency)}</span>
                <Badge tone="neutral">%{o.probability}</Badge>
                <span className="font-semibold tabular-nums">{quoteMoney(o.weighted, o.currency)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <Snapshots period={f.period} canTake={f.canSnapshot} />
      <Stale />
      {adjusting ? <AdjustDialog period={f.period} owner={adjusting} onClose={() => { setAdjusting(null); }} /> : null}
    </div>
  );
}

function AdjustDialog({ period, owner, onClose }: { period: string; owner: Owner; onClose: () => void }) {
  const adjust = useAdjust();
  const { toast } = useToast();
  const [amount, setAmount] = useState(owner.adjustment?.amount ?? owner.forecast);
  const [note, setNote] = useState(owner.adjustment?.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const valid = /^\d{1,14}(\.\d{1,4})?$/.test(amount.trim());
  function save(value: string | null): void {
    setError(null);
    adjust.mutateAsync({ period, ownerId: owner.owner.id, currency: owner.currency, amount: value, note: note.trim() }).then(
      () => { toast({ kind: 'success', title: value === null ? t('forecast.cleared') : t('forecast.saved') }); onClose(); },
      (e: unknown) => { setError(errorText(e)); },
    );
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={t('forecast.adjustOf', { name: owner.owner.displayName })} closeLabel={t('common.close')}>
        <form method="post" className="flex flex-col gap-3" data-testid="adjust-dialog" onSubmit={(e) => { e.preventDefault(); save(amount.trim()); }}>
          {error ? <Alert kind="error">{error}</Alert> : null}
          <p className="m-0 text-sm text-fg-muted">{t('forecast.computed', { weighted: quoteMoney(owner.weighted, owner.currency), won: quoteMoney(owner.won, owner.currency) })}</p>
          <Field label={t('forecast.amount', { currency: owner.currency })}><Input inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); }} required autoFocus data-testid="adjust-amount" /></Field>
          <Field label={t('forecast.note')}><Textarea value={note} maxLength={500} rows={2} onChange={(e) => { setNote(e.target.value); }} /></Field>
          <DialogFooter>
            {owner.adjustment ? <Button variant="ghost" onClick={() => { save(null); }} disabled={adjust.isPending}>{t('forecast.clear')}</Button> : null}
            <Button type="submit" loading={adjust.isPending} disabled={!valid} data-testid="adjust-save">{t('common.save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Snapshots({ period, canTake }: { period: string; canTake: boolean }) {
  const list = useSnapshots(period);
  const take = useTakeSnapshot();
  const { toast } = useToast();
  const rows = list.data?.data ?? [];
  return (
    <section aria-labelledby="fc-snaps">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 id="fc-snaps" className="m-0 flex-1 text-base font-semibold">{t('forecast.snapshots')}</h2>
        {canTake ? (
          <Button size="sm" variant="secondary" icon={<Camera aria-hidden size={16} />} loading={take.isPending} data-testid="snapshot-take"
            onClick={() => { take.mutateAsync(period).then(() => { toast({ kind: 'success', title: t('forecast.snapshotTaken') }); }, (e: unknown) => { toast({ kind: 'error', title: errorText(e) }); }); }}>
            {t('forecast.snapshotTake')}
          </Button>
        ) : null}
      </div>
      {list.isError ? <Alert kind="error">{errorText(list.error)}</Alert> : !list.data ? <Skeleton className="h-16 w-full" />
        : rows.length === 0 ? <p className="m-0 text-sm text-fg-muted">{t('forecast.noSnapshots')}</p> : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="snapshot-list">
            {rows.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-3 text-sm">
                <span className="min-w-40 flex-1">{relativeTime(s.takenAt)} · {s.takenBy?.displayName ?? t('forecast.scheduled')}</span>
                {s.totals.map((x) => <span key={x.currency} className="font-semibold tabular-nums">{quoteMoney(x.forecast, x.currency)}</span>)}
                <Badge tone={s.kind === 'manual' ? 'info' : 'neutral'}>{t(`forecast.kind.${s.kind}`)}</Badge>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

function Stale() {
  const list = useStale();
  const rows = list.data?.data ?? [];
  if (!list.data || rows.length === 0) return null;
  return (
    <section aria-labelledby="fc-stale">
      <h2 id="fc-stale" className="m-0 mb-2 text-base font-semibold">{t('pulse.staleTitle', { days: String(list.data.staleDays) })}</h2>
      <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="stale-list">
        {rows.map((o) => (
          <li key={o.id} className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-3">
            <div className="min-w-48 flex-1">
              <p className="m-0 font-semibold"><Link href={`/crm/opportunity/${o.id}`}>{o.name}</Link></p>
              <p className="m-0 mt-0.5 text-xs text-fg-muted">{o.owner.displayName} · {o.stage} · {o.nextStep ? t('pulse.next', { title: o.nextStep.title }) : t('pulse.noNext')}</p>
            </div>
            <Badge tone="warning">{t('pulse.idle', { days: String(o.idleDays) })}</Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}
