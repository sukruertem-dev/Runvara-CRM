'use client';

import { Alert, Badge, Button, Dialog, DialogContent, DialogFooter, Field, Input, Select, Switch, useToast } from '@flexa/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useApp } from '../../lib/app-context';
import { CONTRACT_TONE, ORDER_TONE, useB2bUpdates, useContracts, useCreateContract, useCreateOrder, useOrders } from '../../lib/b2b';
import { errorText } from '../../lib/catalog';
import { formatDate } from '../../lib/format';
import { t } from '../../lib/i18n';
import { quoteMoney, useQuotes } from '../../lib/quotes';
import { Section } from './record-parts';

const day = (d: string): string => formatDate(`${d}T12:00:00`);

/** Contracts and orders of a B2B opportunity (B2B-06); both need it won. */
export function B2bPanels({ opportunityId, won }: { opportunityId: string; won: boolean }) {
  const { nav, can } = useApp();
  const on = nav?.modules.some((m) => m.id === 'sales_b2b') ?? false;
  const contracts = useContracts({ opportunityId }, on);
  const orders = useOrders({ opportunityId }, on);
  const accepted = useQuotes({ opportunityId, status: 'accepted' }, on && won);
  const [creating, setCreating] = useState<'contract' | 'order' | null>(null);
  useB2bUpdates();
  if (!on || !contracts.data || !orders.data) return null;
  const cs = contracts.data.pages.flatMap((p) => p.data);
  const os = orders.data.pages.flatMap((p) => p.data);
  const quotes = accepted.data?.pages.flatMap((p) => p.data) ?? [];
  const ordered = new Set(os.map((o) => o.quote?.id));
  const orderable = quotes.filter((q) => !ordered.has(q.id));
  return (
    <>
      <Section title={t('contract.title')} testId="contracts-panel">
        {cs.length === 0 ? <p className="m-0 text-sm text-fg-muted">{t('contract.panelEmpty')}</p> : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {cs.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 text-sm">
                <Link href={`/sales/b2b/contracts/${c.id}`} className="font-semibold text-fg">{c.number}</Link>
                <span className="text-xs text-fg-muted">{t('contract.period', { start: day(c.startDate), end: day(c.endDate) })}</span>
                <Badge tone={CONTRACT_TONE[c.status]}>{t(`contract.status.${c.status}`)}</Badge>
              </li>
            ))}
          </ul>
        )}
        {can('sales_b2b.contract.manage') ? (won
          ? <Button className="mt-2" size="sm" variant="secondary" onClick={() => { setCreating('contract'); }} data-testid="contract-new">{t('contract.new')}</Button>
          : <p className="m-0 mt-2 text-xs text-fg-muted">{t('contract.needsWon')}</p>) : null}
      </Section>
      <Section title={t('order.title')} testId="orders-panel">
        {os.length === 0 ? <p className="m-0 text-sm text-fg-muted">{t('order.panelEmpty')}</p> : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {os.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-2 text-sm">
                <Link href={`/sales/b2b/orders/${o.id}`} className="font-semibold text-fg">{o.number}</Link>
                <span className="tabular-nums">{quoteMoney(o.totals.total, o.currency)}</span>
                <Badge tone={ORDER_TONE[o.status]}>{t(`order.status.${o.status}`)}</Badge>
              </li>
            ))}
          </ul>
        )}
        {can('sales_b2b.quote.create') && orderable.length > 0 ? <Button className="mt-2" size="sm" variant="secondary" onClick={() => { setCreating('order'); }} data-testid="order-new">{t('order.new')}</Button> : null}
      </Section>
      {creating === 'contract' ? <ContractDialog opportunityId={opportunityId} quotes={quotes.map((q) => ({ id: q.id, number: q.number }))} onClose={() => { setCreating(null); }} /> : null}
      {creating === 'order' ? <OrderDialog quotes={orderable.map((q) => ({ id: q.id, number: q.number }))} contracts={cs.filter((c) => c.status === 'active').map((c) => ({ id: c.id, number: c.number }))} onClose={() => { setCreating(null); }} /> : null}
    </>
  );
}

const NONE = 'none';

function ContractDialog({ opportunityId, quotes, onClose }: { opportunityId: string; quotes: { id: string; number: string }[]; onClose: () => void }) {
  const create = useCreateContract();
  const router = useRouter();
  const { toast } = useToast();
  const [quoteId, setQuoteId] = useState(quotes[0]?.id ?? NONE);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [autoRenew, setAutoRenew] = useState(false);
  const [notice, setNotice] = useState('30');
  const [error, setError] = useState<string | null>(null);
  function run(): void {
    setError(null);
    create.mutateAsync({ opportunityId, quoteId: quoteId === NONE ? null : quoteId, startDate: start, endDate: end, autoRenew, renewalNoticeDays: Number(notice) }).then(
      (c) => { toast({ kind: 'success', title: t('contract.created') }); router.push(`/sales/b2b/contracts/${c.id}`); },
      (e: unknown) => { setError(errorText(e)); },
    );
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={t('contract.new')} closeLabel={t('common.close')}>
        <form method="post" onSubmit={(e) => { e.preventDefault(); run(); }} className="flex flex-col gap-3" data-testid="contract-dialog">
          {error ? <Alert kind="error">{error}</Alert> : null}
          <Field label={t('quote.one')}>
            <Select aria-label={t('quote.one')} value={quoteId} onValueChange={setQuoteId} options={[{ value: NONE, label: '—' }, ...quotes.map((q) => ({ value: q.id, label: q.number }))]} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('contract.start')}><Input type="date" value={start} onChange={(e) => { setStart(e.target.value); }} required /></Field>
            <Field label={t('contract.end')}><Input type="date" value={end} min={start || undefined} onChange={(e) => { setEnd(e.target.value); }} required /></Field>
          </div>
          <Field label={t('contract.notice')}><Input type="number" min={0} max={365} value={notice} onChange={(e) => { setNotice(e.target.value); }} /></Field>
          <label className="inline-flex items-center gap-2 text-sm"><Switch checked={autoRenew} onCheckedChange={setAutoRenew} aria-label={t('contract.autoRenew')} />{t('contract.autoRenew')}</label>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" loading={create.isPending} disabled={!start || !end || end < start} data-testid="contract-save">{t('contract.new')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function OrderDialog({ quotes, contracts, onClose }: { quotes: { id: string; number: string }[]; contracts: { id: string; number: string }[]; onClose: () => void }) {
  const create = useCreateOrder();
  const router = useRouter();
  const { toast } = useToast();
  const [quoteId, setQuoteId] = useState(quotes[0]?.id ?? '');
  const [contractId, setContractId] = useState(contracts[0]?.id ?? NONE);
  const [error, setError] = useState<string | null>(null);
  function run(): void {
    setError(null);
    create.mutateAsync({ quoteId, contractId: contractId === NONE ? null : contractId }).then(
      (o) => { toast({ kind: 'success', title: t('order.created') }); router.push(`/sales/b2b/orders/${o.id}`); },
      (e: unknown) => { setError(errorText(e)); },
    );
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={t('order.new')} closeLabel={t('common.close')}>
        <form method="post" onSubmit={(e) => { e.preventDefault(); run(); }} className="flex flex-col gap-3" data-testid="order-dialog">
          {error ? <Alert kind="error">{error}</Alert> : null}
          <Field label={t('quote.one')}><Select aria-label={t('quote.one')} value={quoteId} onValueChange={setQuoteId} options={quotes.map((q) => ({ value: q.id, label: q.number }))} /></Field>
          <Field label={t('order.contract')}>
            <Select aria-label={t('order.contract')} value={contractId} onValueChange={setContractId} options={[{ value: NONE, label: t('order.noContract') }, ...contracts.map((c) => ({ value: c.id, label: c.number }))]} />
          </Field>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" loading={create.isPending} disabled={!quoteId} data-testid="order-save">{t('order.new')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
