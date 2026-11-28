'use client';

import { Alert, Badge, Button, Dialog, DialogContent, DialogFooter, ErrorState, Field, Input, Select, Skeleton, Textarea, useToast } from '@flexa/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { errorText } from '../../../../../../lib/catalog';
import { dateTime } from '../../../../../../lib/format';
import { t, tOptional } from '../../../../../../lib/i18n';
import { ORDER_TONE, PAYMENT_TONE, PAYMENTS, REASONS, RETURN_TONE, useB2cOrder, useCreateReturn, useOrderPayment, useOrderStep, useOrderUpdates, type B2cOrder, type OrderStep } from '../../../../../../lib/orders';
import { quoteMoney } from '../../../../../../lib/quotes';
import { PageContainer } from '../../../../../_components/app-shell';

// One B2C order (B2C-02/03/05, docs/p9-plan.md §36): lines, workflow steps, payment, history and returns.

export default function B2cOrderPage() {
  const { id } = useParams<{ id: string }>();
  const q = useB2cOrder(id);
  useOrderUpdates();
  return (
    <PageContainer>
      {q.isError ? <ErrorState title={errorText(q.error)} retryLabel={t('common.retry')} onRetry={() => { void q.refetch(); }} />
        : !q.data ? <Skeleton className="h-64 w-full" /> : <Order o={q.data} />}
    </PageContainer>
  );
}

function Order({ o }: { o: B2cOrder }) {
  const [stepping, setStepping] = useState<OrderStep | null>(null);
  const [returning, setReturning] = useState(false);
  const pay = useOrderPayment(o.id);
  const { toast } = useToast();
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="m-0 flex-1 font-display text-xl font-bold"><span data-testid="b2corder-number">{o.number}</span> · <Link href={`/crm/contact/${o.customer.id}`}>{o.customer.fullName}</Link></h1>
        <Badge tone={ORDER_TONE[o.status]} data-testid="b2corder-status">{t(`b2corder.status.${o.status}`)}</Badge>
        <Badge tone={PAYMENT_TONE[o.paymentStatus]} data-testid="b2corder-payment">{t(`b2corder.payment.${o.paymentStatus}`)}</Badge>
      </div>
      <p className="m-0 text-sm text-fg-muted">
        {t(`b2corder.channel.${o.channel}`)} · {t(`b2corder.delivery.${o.deliveryStatus}`)}{o.trackingNumber ? ` · ${o.carrier ?? ''} ${o.trackingNumber}` : ''} · {o.createdBy.displayName}
      </p>
      <div className="flex flex-wrap gap-2" data-testid="b2corder-steps">
        {o.steps.map((s) => (
          <Button key={s} size="sm" variant={s === 'cancel' ? 'secondary' : 'primary'} onClick={() => { setStepping(s); }} data-testid={`step-${s}`}>{t(`b2corder.step.${s}`)}</Button>
        ))}
        {o.canRequestReturn ? <Button size="sm" variant="secondary" onClick={() => { setReturning(true); }} data-testid="return-new">{t('return.new')}</Button> : null}
        {o.canPay ? (
          <div className="w-56">
            <Select aria-label={t('b2corder.paymentLabel')} value={o.paymentStatus}
              onValueChange={(v) => { pay.mutateAsync({ status: v as (typeof PAYMENTS)[number] }).then(() => { toast({ kind: 'success', title: t('b2corder.paymentSaved') }); }, (e: unknown) => { toast({ kind: 'error', title: errorText(e) }); }); }}
              options={PAYMENTS.map((p) => ({ value: p, label: t(`b2corder.payment.${p}`) }))} />
          </div>
        ) : null}
      </div>
      <section className="overflow-x-auto rounded-card border border-line bg-surface p-4" aria-labelledby="ol-title">
        <h2 id="ol-title" className="m-0 mb-2 text-base font-semibold">{t('b2corder.lines')}</h2>
        <table className="w-full min-w-[560px] border-collapse text-sm" data-testid="b2corder-lines">
          <thead>
            <tr className="border-b border-line text-left text-xs text-fg-muted">
              <th scope="col" className="py-2 pr-3 font-semibold">{t('quote.product')}</th>
              <th scope="col" className="py-2 pr-3 text-right font-semibold">{t('quote.qty')}</th>
              <th scope="col" className="py-2 pr-3 text-right font-semibold">{t('quote.unitPrice')}</th>
              <th scope="col" className="py-2 pr-3 text-right font-semibold">{t('b2corder.returned')}</th>
              <th scope="col" className="py-2 text-right font-semibold">{t('b2corder.lineTotal')}</th>
            </tr>
          </thead>
          <tbody>
            {o.lines.map((l) => (
              <tr key={l.id} className="border-b border-line last:border-0">
                <td className="py-2 pr-3">{l.name} <span className="text-fg-muted">({l.sku})</span></td>
                <td className="py-2 pr-3 text-right tabular-nums">{l.quantity} {l.unit}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{quoteMoney(l.unitPrice, o.currency)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{l.returnedQuantity}</td>
                <td className="py-2 text-right tabular-nums">{quoteMoney(l.total, o.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="m-0 mt-3 grid grid-cols-2 gap-1 text-sm sm:ml-auto sm:w-72" data-testid="b2corder-totals">
          {o.totals.discount !== '0.00' ? (
            <>
              <dt className="text-fg-muted">{t('b2corder.discount', { percent: o.discount.percent })}{o.discount.coupon ? ` · ${o.discount.coupon}` : ''}</dt>
              <dd className="m-0 text-right tabular-nums" data-testid="b2corder-discount">−{quoteMoney(o.totals.discount, o.currency)}</dd>
            </>
          ) : null}
          <dt className="text-fg-muted">{t('quote.net')}</dt><dd className="m-0 text-right tabular-nums">{quoteMoney(o.totals.net, o.currency)}</dd>
          <dt className="text-fg-muted">{t('quote.tax')}</dt><dd className="m-0 text-right tabular-nums">{quoteMoney(o.totals.tax, o.currency)}</dd>
          <dt className="font-semibold">{t('quote.total')}</dt><dd className="m-0 text-right font-semibold tabular-nums">{quoteMoney(o.totals.total, o.currency)}</dd>
        </dl>
      </section>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-card border border-line bg-surface p-4" aria-labelledby="oh-title">
          <h2 id="oh-title" className="m-0 mb-2 text-base font-semibold">{t('b2corder.history')}</h2>
          <ol className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm" data-testid="b2corder-history">
            {o.history.map((h, i) => (
              <li key={`${h.at}${String(i)}`}>
                <span className="font-medium">{tOptional(`b2corder.${h.kind === 'status' ? 'status' : 'payment'}.${h.to}`) ?? h.to}</span>
                <span className="text-fg-muted"> · {dateTime(h.at)} · {h.actor?.displayName ?? '—'}{h.note ? ` · ${h.note}` : ''}</span>
              </li>
            ))}
          </ol>
        </section>
        <section className="rounded-card border border-line bg-surface p-4" aria-labelledby="or-title">
          <h2 id="or-title" className="m-0 mb-2 text-base font-semibold">{t('return.title')}</h2>
          {o.returns.length === 0 ? <p className="m-0 text-sm text-fg-muted">{t('return.none')}</p> : (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm" data-testid="b2corder-returns">
              {o.returns.map((r) => (
                <li key={r.id} className="flex items-center gap-2">
                  <Link href={`/sales/b2c/returns/${r.id}`} className="flex-1">{r.number}</Link>
                  <span className="tabular-nums">{quoteMoney(r.amount, r.currency)}</span>
                  <Badge tone={RETURN_TONE[r.status]}>{t(`return.status.${r.status}`)}</Badge>
                </li>
              ))}
            </ul>
          )}
          {o.shippingAddress ? <p className="m-0 mt-3 text-xs text-fg-muted">{t('b2corder.shipTo')}: {[o.shippingAddress.recipient, o.shippingAddress.line1, o.shippingAddress.line2, o.shippingAddress.district, o.shippingAddress.city].filter(Boolean).join(', ')}</p> : null}
        </section>
      </div>
      {stepping ? <StepDialog o={o} step={stepping} onClose={() => { setStepping(null); }} /> : null}
      {returning ? <ReturnDialog o={o} onClose={() => { setReturning(false); }} /> : null}
    </div>
  );
}

function StepDialog({ o, step, onClose }: { o: B2cOrder; step: OrderStep; onClose: () => void }) {
  const run = useOrderStep(o.id);
  const { toast } = useToast();
  const [note, setNote] = useState('');
  const [carrier, setCarrier] = useState(o.carrier ?? '');
  const [tracking, setTracking] = useState(o.trackingNumber ?? '');
  const [error, setError] = useState<string | null>(null);
  function save(): void {
    setError(null);
    run.mutateAsync({ step, note: note.trim(), ...(step === 'ship' && carrier.trim() ? { carrier: carrier.trim() } : {}), ...(step === 'ship' && tracking.trim() ? { trackingNumber: tracking.trim() } : {}) }).then(
      () => { toast({ kind: 'success', title: t('b2corder.stepDone') }); onClose(); },
      (e: unknown) => { setError(errorText(e)); },
    );
  }
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent title={`${t(`b2corder.step.${step}`)}: ${o.number}`} closeLabel={t('common.close')}>
        <form method="post" className="flex flex-col gap-3" data-testid="step-dialog" onSubmit={(e) => { e.preventDefault(); save(); }}>
          {error ? <Alert kind="error">{error}</Alert> : null}
          {step === 'ship' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('b2corder.carrier')}><Input value={carrier} maxLength={80} onChange={(e) => { setCarrier(e.target.value); }} /></Field>
              <Field label={t('b2corder.tracking')}><Input value={tracking} maxLength={120} onChange={(e) => { setTracking(e.target.value); }} /></Field>
            </div>
          ) : null}
          <Field label={step === 'cancel' ? t('b2corder.cancelReason') : t('b2corder.note')}>
            <Textarea value={note} maxLength={500} rows={2} required={step === 'cancel'} onChange={(e) => { setNote(e.target.value); }} />
          </Field>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" loading={run.isPending} disabled={step === 'cancel' && !note.trim()} data-testid="step-save">{t(`b2corder.step.${step}`)}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ReturnDialog({ o, onClose }: { o: B2cOrder; onClose: () => void }) {
  const create = useCreateReturn();
  const { toast } = useToast();
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(o.lines.map((l) => [l.id, '0'])));
  const [reasonCode, setReasonCode] = useState<(typeof REASONS)[number]>('damaged');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const lines = o.lines.map((l) => ({ orderLineId: l.id, quantity: (qty[l.id] ?? '0').trim() })).filter((l) => /^\d+(\.\d{1,3})?$/.test(l.quantity) && Number(l.quantity) > 0);
  function save(): void {
    setError(null);
    create.mutateAsync({ orderId: o.id, reasonCode, reason: reason.trim(), lines }).then(
      () => { toast({ kind: 'success', title: t('return.created') }); onClose(); },
      (e: unknown) => { setError(errorText(e)); },
    );
  }
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent title={`${t('return.new')}: ${o.number}`} closeLabel={t('common.close')}>
        <form method="post" className="flex flex-col gap-3" data-testid="return-dialog" onSubmit={(e) => { e.preventDefault(); save(); }}>
          {error ? <Alert kind="error">{error}</Alert> : null}
          {o.lines.map((l) => {
            const left = Number(l.quantity) - Number(l.returnedQuantity);
            return (
              <Field key={l.id} label={t('return.qtyOf', { name: l.name, left: String(left) })}>
                <Input type="number" min={0} max={left} step="any" value={qty[l.id] ?? '0'} disabled={left <= 0} onChange={(e) => { setQty((x) => ({ ...x, [l.id]: e.target.value })); }} />
              </Field>
            );
          })}
          <Field label={t('return.reasonCode')}>
            <Select aria-label={t('return.reasonCode')} value={reasonCode} onValueChange={(v) => { setReasonCode(v as (typeof REASONS)[number]); }} options={REASONS.map((r) => ({ value: r, label: t(`return.reason.${r}`) }))} />
          </Field>
          <Field label={t('return.reasonText')}><Textarea value={reason} maxLength={500} rows={2} onChange={(e) => { setReason(e.target.value); }} /></Field>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" loading={create.isPending} disabled={lines.length === 0} data-testid="return-save">{t('return.request')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
