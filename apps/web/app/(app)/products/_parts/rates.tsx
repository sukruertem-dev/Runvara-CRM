'use client';

import { Alert, Badge, Button, ErrorState, Field, IconButton, Input, Skeleton, useToast } from '@flexa/ui';
import { Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useApp } from '../../../../lib/app-context';
import { errorText, useCreateTaxRate, useFxRates, useRemoveFx, useSetFx, useTaxRates, useUpdateTaxRate } from '../../../../lib/catalog';
import { formatDate } from '../../../../lib/format';
import { t } from '../../../../lib/i18n';

function Card({ id, title, lead, children }: { id: string; title: string; lead?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4" aria-labelledby={id}>
      <div>
        <h2 id={id} className="m-0 text-base font-semibold">{title}</h2>
        {lead ? <p className="m-0 mt-1 text-sm text-fg-muted">{lead}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function Rates({ canTax, canFx }: { canTax: boolean; canFx: boolean }) {
  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <Taxes canWrite={canTax} />
      <Fx canWrite={canFx} />
    </div>
  );
}

function Taxes({ canWrite }: { canWrite: boolean }) {
  const list = useTaxRates();
  const create = useCreateTaxRate();
  const update = useUpdateTaxRate();
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [rate, setRate] = useState('');
  const [error, setError] = useState<string | null>(null);

  function add(): void {
    setError(null);
    create.mutateAsync({ name: name.trim(), rate: rate.trim().replace(',', '.') }).then(
      () => { setName(''); setRate(''); toast({ kind: 'success', title: t('cat.saved') }); },
      (e: unknown) => { setError(errorText(e)); },
    );
  }

  return (
    <Card id="tax-h" title={t('tax.title')}>
      {list.isError ? (
        <ErrorState title={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => { void list.refetch(); }} />
      ) : !list.data ? (
        <Skeleton className="h-20 w-full" />
      ) : list.data.data.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">{t('tax.empty')}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="tax-list">
          {list.data.data.map((r) => (
            <li key={r.id} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1">{r.name} · %{Number(r.rate).toString()}</span>
              {r.active ? null : <Badge tone="neutral">{t('cat.inactive')}</Badge>}
              {canWrite ? (
                <Button variant="ghost" size="sm" aria-label={`${r.active ? t('tax.deactivate') : t('tax.activate')}: ${r.name}`}
                  onClick={() => { update.mutate({ rate: r, patch: { active: !r.active } }, { onError: (e) => { toast({ kind: 'error', title: errorText(e) }); } }); }}>
                  {r.active ? t('tax.deactivate') : t('tax.activate')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canWrite ? (
        <form method="post" onSubmit={(e) => { e.preventDefault(); add(); }} className="flex flex-wrap items-end gap-2" data-testid="tax-form">
          <Field label={t('tax.name')} className="min-w-32 flex-1"><Input value={name} onChange={(e) => { setName(e.target.value); }} maxLength={80} required /></Field>
          <Field label={t('tax.rate')} className="w-28"><Input inputMode="decimal" value={rate} onChange={(e) => { setRate(e.target.value); }} required /></Field>
          <Button type="submit" variant="secondary" loading={create.isPending}>{t('tax.add')}</Button>
        </form>
      ) : null}
      {error ? <Alert kind="error">{error}</Alert> : null}
    </Card>
  );
}

function Fx({ canWrite }: { canWrite: boolean }) {
  const { tenant } = useApp();
  const list = useFxRates();
  const set = useSetFx();
  const remove = useRemoveFx();
  const { toast } = useToast();
  const [base, setBase] = useState('USD');
  const [quote, setQuote] = useState(tenant?.currency ?? 'TRY');
  const [validOn, setValidOn] = useState('');
  const [rate, setRate] = useState('');
  const [error, setError] = useState<string | null>(null);

  function add(): void {
    setError(null);
    set.mutateAsync({ base: base.trim().toUpperCase(), quote: quote.trim().toUpperCase(), validOn, rate: rate.trim().replace(',', '.') }).then(
      () => { setRate(''); toast({ kind: 'success', title: t('cat.saved') }); },
      (e: unknown) => { setError(errorText(e)); },
    );
  }

  return (
    <Card id="fx-h" title={t('fx.title')} lead={t('fx.lead')}>
      {list.isError ? (
        <ErrorState title={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => { void list.refetch(); }} />
      ) : !list.data ? (
        <Skeleton className="h-20 w-full" />
      ) : list.data.data.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">{t('fx.empty')}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="fx-list">
          {list.data.data.map((r) => (
            <li key={`${r.base}${r.quote}${r.validOn}`} className="flex items-center gap-2 text-sm tabular-nums">
              <span className="min-w-0 flex-1">1 {r.base} = {r.rate} {r.quote} · {formatDate(r.validOn)}</span>
              {canWrite ? (
                <IconButton size="sm" label={`${t('fx.remove')}: ${r.base}/${r.quote} ${formatDate(r.validOn)}`}
                  onClick={() => { remove.mutate({ base: r.base, quote: r.quote, validOn: r.validOn }, { onError: (e) => { toast({ kind: 'error', title: errorText(e) }); } }); }}>
                  <Trash2 aria-hidden size={14} />
                </IconButton>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canWrite ? (
        <form method="post" onSubmit={(e) => { e.preventDefault(); add(); }} className="grid grid-cols-2 items-end gap-2" data-testid="fx-form">
          <Field label={t('fx.base')}><Input value={base} onChange={(e) => { setBase(e.target.value); }} maxLength={3} required /></Field>
          <Field label={t('fx.quote')}><Input value={quote} onChange={(e) => { setQuote(e.target.value); }} maxLength={3} required /></Field>
          <Field label={t('fx.date')}><Input type="date" value={validOn} onChange={(e) => { setValidOn(e.target.value); }} required /></Field>
          <Field label={t('fx.rate')}><Input inputMode="decimal" value={rate} onChange={(e) => { setRate(e.target.value); }} required /></Field>
          <Button type="submit" variant="secondary" className="col-span-2" loading={set.isPending}>{t('fx.add')}</Button>
        </form>
      ) : null}
      {error ? <Alert kind="error">{error}</Alert> : null}
    </Card>
  );
}
