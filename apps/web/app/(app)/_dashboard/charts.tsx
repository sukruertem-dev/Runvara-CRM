'use client';

import { cn } from '@flexa/ui';
import { formatNumber } from '../../../lib/format';
import { t } from '../../../lib/i18n';

/** Big tabular number with a label (§10.5.1 §4 "sayılar kahramandır"). */
export function Kpi({ value, tone = 'default', testId }: { value: number | undefined; tone?: 'default' | 'danger'; testId?: string }) {
  return (
    <p className={cn('m-0 font-display text-3xl font-bold tabular-nums', tone === 'danger' && value ? 'text-danger' : 'text-fg')} data-testid={testId}>
      {value === undefined ? '–' : formatNumber(value)}
    </p>
  );
}

const SERIES = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];

export interface BarDatum {
  label: string;
  value: number;
  /** Shown instead of the value (e.g. a currency amount). */
  display?: string;
}

/**
 * Horizontal bars with direct labels (no legend needed, readable without colour). The data is also given as a
 * visually hidden list for screen readers.
 */
export function BarList({ title, data, testId }: { title: string; data: BarDatum[]; testId?: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (data.length === 0) return <p className="m-0 text-sm text-fg-muted">{t('dash.noData')}</p>;
  return (
    <figure className="m-0" data-testid={testId}>
      <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-hidden>
        {data.map((d, i) => (
          <li key={d.label} className="grid grid-cols-[minmax(5rem,9rem)_1fr_auto] items-center gap-2 text-xs">
            <span className="truncate text-fg-muted">{d.label}</span>
            <span className="h-3 overflow-hidden rounded-full bg-subtle">
              <span className="block h-full rounded-full" style={{ width: `${String((d.value / max) * 100)}%`, background: SERIES[i % SERIES.length] }} />
            </span>
            <span className="tabular-nums text-fg">{d.display ?? formatNumber(d.value)}</span>
          </li>
        ))}
      </ul>
      <figcaption className="sr-only">{t('dash.chartSummary', { title, items: data.map((d) => `${d.label} ${d.display ?? String(d.value)}`).join(', ') })}</figcaption>
    </figure>
  );
}

/** Funnel: centred bars narrowing by value, stage order preserved. */
export function Funnel({ title, data, testId }: { title: string; data: BarDatum[]; testId?: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (data.length === 0) return <p className="m-0 text-sm text-fg-muted">{t('dash.noData')}</p>;
  return (
    <figure className="m-0" data-testid={testId}>
      <ol className="m-0 flex list-none flex-col items-center gap-1.5 p-0" aria-hidden>
        {data.map((d, i) => (
          <li key={d.label} className="flex w-full flex-col items-center gap-0.5">
            {/* Text sits beside the shape, not on it: chart colours are not text-contrast pairs in both themes. */}
            <span className="flex w-full justify-between gap-2 text-xs">
              <span className="truncate text-fg-muted">{d.label}</span>
              <span className="tabular-nums text-fg">{d.display ?? d.value}</span>
            </span>
            <span className="h-2.5 rounded-full" style={{ width: `${String(Math.max(8, (d.value / max) * 100))}%`, background: SERIES[i % SERIES.length] }} />
          </li>
        ))}
      </ol>
      <figcaption className="sr-only">{t('dash.chartSummary', { title, items: data.map((d) => `${d.label} ${d.display ?? String(d.value)}`).join(', ') })}</figcaption>
    </figure>
  );
}

/**
 * Two daily series (opened vs closed) as paired columns; series differ by colour and by fill pattern
 * (solid vs outlined), so they stay distinguishable without colour.
 */
export function PairedColumns({ title, days, a, b, labels, testId }: { title: string; days: string[]; a: number[]; b: number[]; labels: [string, string]; testId?: string }) {
  const max = Math.max(1, ...a, ...b);
  const w = 100 / Math.max(1, days.length);
  return (
    <figure className="m-0 flex h-full flex-col gap-2" data-testid={testId}>
      <div className="flex gap-4 text-xs text-fg-muted" aria-hidden>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block size-2.5 rounded-[2px] bg-chart-1" /> {labels[0]}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block size-2.5 rounded-[2px] border-2 border-chart-2" /> {labels[1]}
        </span>
      </div>
      <svg viewBox="0 0 100 50" preserveAspectRatio="none" className="min-h-24 w-full flex-1" aria-hidden>
        {days.map((d, i) => {
          const ha = ((a[i] ?? 0) / max) * 46;
          const hb = ((b[i] ?? 0) / max) * 46;
          const x = i * w;
          return (
            <g key={d}>
              <rect x={x + w * 0.12} y={50 - ha} width={w * 0.36} height={ha} fill="var(--chart-1)" />
              <rect x={x + w * 0.52} y={50 - hb} width={w * 0.36} height={hb} fill="none" stroke="var(--chart-2)" strokeWidth={0.6} vectorEffect="non-scaling-stroke" />
            </g>
          );
        })}
        <line x1="0" y1="50" x2="100" y2="50" stroke="var(--border)" strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="sr-only">
        {t('dash.chartSummary', { title, items: days.map((d, i) => `${d}: ${labels[0]} ${String(a[i] ?? 0)}, ${labels[1]} ${String(b[i] ?? 0)}`).join('; ') })}
      </figcaption>
    </figure>
  );
}
