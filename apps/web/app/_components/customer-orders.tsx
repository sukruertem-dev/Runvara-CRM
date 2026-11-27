'use client';

import { Alert, Badge, Button, Combobox, Dialog, DialogContent, DialogFooter, Field, IconButton, Input, Select, Textarea, useToast } from '@flexa/ui';
import { Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useApp } from '../../lib/app-context';
import { errorText, useProducts } from '../../lib/catalog';
import type { Customer } from '../../lib/customers';
import { formatDate } from '../../lib/format';
import { t } from '../../lib/i18n';
import { CHANNELS, downloadCustomerExport, ORDER_TONE, PAYMENTS, useAnonymize, useB2cOrders, useCreateB2cOrder, useOrderUpdates } from '../../lib/orders';
import { quoteMoney } from '../../lib/quotes';
import { Section } from './record-parts';

// The customer's orders (customer 360) and the KVKK requests (P9e, docs/p9-plan.md §36–37).

const NONE = 'none';

export function CustomerOrders({ customer }: { customer: Customer }) {
  const list = useB2cOrders({ customerId: customer.id });
  const [creating, setCreating] = useState(false);
  useOrderUpdates();
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <Section title={t('b2corder.title')} testId="customer-orders">
      {rows.length === 0 ? <p className="m-0 text-sm text-fg-muted">{t('b2corder.none')}</p> : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm">
          {rows.slice(0, 10).map((o) => (
            <li key={o.id} className="flex items-center gap-2">
              <Link href={`/sales/b2c/orders/${o.id}`} className="flex-1">{o.number}</Link>
              <span className="text-xs text-fg-muted">{formatDate(o.createdAt)}</span>
              <span className="tabular-nums">{quoteMoney(o.total, o.currency)}</span>
              <Badge tone={ORDER_TONE[o.status]}>{t(`b2corder.status.${o.status}`)}</Badge>
            </li>
          ))}
        </ul>
      )}
      {customer.canEdit ? <Button className="mt-3" size="sm" variant="secondary" icon={<Plus aria-hidden size={16} />} onClick={() => { setCreating(true); }} data-testid="b2corder-new">{t('b2corder.new')}</Button> : null}
      {creating ? <NewOrderDialog customer={customer} onClose={() => { setCreating(false); }} /> : null}
    </Section>
  );
}

function NewOrderDialog({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const create = useCreateB2cOrder();
  const router = useRouter();
  const [term, setTerm] = useState('');
  const products = useProducts(term, false);
  const found = (products.data?.pages.flatMap((p) => p.data) ?? []).filter((p) => p.segments.includes('b2c'));
  const [lines, setLines] = useState<{ productId: string; label: string; quantity: string }[]>([]);
  const [channel, setChannel] = useState<(typeof CHANNELS)[number]>('phone');
  const [address, setAddress] = useState<string>(customer.addresses.find((a) => a.isDefault)?.id ?? NONE);
  const [payment, setPayment] = useState<(typeof PAYMENTS)[number]>('pending');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const valid = lines.length > 0 && lines.every((l) => /^\d+(\.\d{1,3})?$/.test(l.quantity) && Number(l.quantity) > 0);
  function save(): void {
    setError(null);
    create.mutateAsync({ customerId: customer.id, channel, lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity })), shippingAddressId: address === NONE ? null : address, paymentStatus: payment, note: note.trim() }).then(
      (o) => { router.push(`/sales/b2c/orders/${o.id}`); },
      (e: unknown) => { setError(errorText(e)); },
    );
  }
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent title={t('b2corder.new')} closeLabel={t('common.close')}>
        <form method="post" className="flex flex-col gap-3" data-testid="b2corder-dialog" onSubmit={(e) => { e.preventDefault(); save(); }}>
          {error ? <Alert kind="error">{error}</Alert> : null}
          <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label={t('b2corder.lines')}>
            {lines.map((l, i) => (
              <li key={l.productId} className="flex items-end gap-2">
                <span className="min-w-0 flex-1 truncate pb-2 text-sm">{l.label}</span>
                <div className="w-28"><Field label={t('quote.qty')}><Input inputMode="decimal" value={l.quantity} onChange={(e) => { setLines((x) => x.map((y, j) => (j === i ? { ...y, quantity: e.target.value } : y))); }} /></Field></div>
                <IconButton size="sm" label={t('b2corder.removeLine', { name: l.label })} onClick={() => { setLines((x) => x.filter((_, j) => j !== i)); }}><Trash2 aria-hidden size={14} /></IconButton>
              </li>
            ))}
          </ul>
          <Combobox aria-label={t('quote.addProduct')} value={null} options={found.filter((p) => !lines.some((l) => l.productId === p.id)).map((p) => ({ value: p.id, label: `${p.name} (${p.sku})` }))}
            onSearch={setTerm} placeholder={t('quote.addProduct')} searchPlaceholder={t('quote.searchProduct')} emptyText={t('common.noResults')}
            onValueChange={(id) => { const p = found.find((x) => x.id === id); if (p) setLines((x) => [...x, { productId: p.id, label: `${p.name} (${p.sku})`, quantity: '1' }]); }} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('b2corder.channel')}>
              <Select aria-label={t('b2corder.channel')} value={channel} onValueChange={(v) => { setChannel(v as (typeof CHANNELS)[number]); }} options={CHANNELS.map((c) => ({ value: c, label: t(`b2corder.channel.${c}`) }))} />
            </Field>
            <Field label={t('b2corder.paymentLabel')}>
              <Select aria-label={t('b2corder.paymentLabel')} value={payment} onValueChange={(v) => { setPayment(v as (typeof PAYMENTS)[number]); }} options={PAYMENTS.slice(0, 2).map((p) => ({ value: p, label: t(`b2corder.payment.${p}`) }))} />
            </Field>
          </div>
          <Field label={t('b2corder.shipTo')}>
            <Select aria-label={t('b2corder.shipTo')} value={address} onValueChange={setAddress}
              options={[{ value: NONE, label: '—' }, ...customer.addresses.map((a) => ({ value: a.id, label: `${a.label || a.city} · ${a.line1}` }))]} />
          </Field>
          <Field label={t('b2corder.note')}><Textarea value={note} maxLength={4000} rows={2} onChange={(e) => { setNote(e.target.value); }} /></Field>
          <p className="m-0 text-xs text-fg-muted">{t('b2corder.priceHint')}</p>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" loading={create.isPending} disabled={!valid} data-testid="b2corder-save">{t('b2corder.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** KVKK requests: Admin only (the same permission as the workspace privacy settings). */
export function CustomerPrivacy({ customer }: { customer: Customer }) {
  const { can } = useApp();
  const { toast } = useToast();
  const [erasing, setErasing] = useState(false);
  if (!can('tenant.config.manage')) return null;
  return (
    <Section title={t('kvkk.title')} testId="customer-privacy">
      <p className="m-0 mb-3 text-sm text-fg-muted">{t('kvkk.lead')}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => { downloadCustomerExport(customer.id).catch((e: unknown) => { toast({ kind: 'error', title: errorText(e) }); }); }} data-testid="kvkk-export">{t('kvkk.export')}</Button>
        <Button size="sm" variant="danger" onClick={() => { setErasing(true); }} data-testid="kvkk-anonymize">{t('kvkk.anonymize')}</Button>
      </div>
      {erasing ? <AnonymizeDialog customer={customer} onClose={() => { setErasing(false); }} /> : null}
    </Section>
  );
}

function AnonymizeDialog({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const run = useAnonymize(customer.id);
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent title={t('kvkk.anonymize')} closeLabel={t('common.close')}>
        <form method="post" className="flex flex-col gap-3" data-testid="kvkk-dialog" onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          run.mutateAsync({ confirmName: name.trim() }).then(() => { toast({ kind: 'success', title: t('kvkk.done') }); onClose(); }, (x: unknown) => { setError(errorText(x)); });
        }}>
          <Alert kind="warning">{t('kvkk.warning')}</Alert>
          {error ? <Alert kind="error">{error}</Alert> : null}
          <Field label={t('kvkk.confirm', { name: customer.fullName })}><Input value={name} onChange={(e) => { setName(e.target.value); }} autoComplete="off" /></Field>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" variant="danger" loading={run.isPending} disabled={!name.trim()} data-testid="kvkk-confirm">{t('kvkk.anonymize')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
