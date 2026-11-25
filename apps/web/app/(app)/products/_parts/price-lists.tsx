'use client';

import { Alert, Badge, Button, Combobox, Dialog, DialogContent, DialogFooter, EmptyState, ErrorState, Field, IconButton, Input, SegmentBadge, Select, Skeleton, Switch, useToast } from '@flexa/ui';
import { Pencil, Plus, Tags, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useApp } from '../../../../lib/app-context';
import {
  errorText, resolvePrice, useAccountSearch, useCreatePriceList, usePriceItems, usePriceLists, useProducts, useSetPrices, useUpdatePriceList, type PriceItem, type PriceList, type PriceListInput,
} from '../../../../lib/catalog';
import { formatDate } from '../../../../lib/format';
import { t } from '../../../../lib/i18n';

const ALL = 'all';
const decimal = (v: string): string => v.trim().replace(',', '.');

export function PriceLists({ canWrite }: { canWrite: boolean }) {
  const lists = usePriceLists();
  const [editing, setEditing] = useState<PriceList | 'new' | null>(null);
  const [open, setOpen] = useState<PriceList | null>(null);

  if (lists.isError) return <ErrorState title={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => { void lists.refetch(); }} />;
  if (!lists.data) return <Skeleton className="h-48 w-full" />;
  return (
    <div className="flex flex-col gap-4">
      {canWrite ? <Button className="self-start" onClick={() => { setEditing('new'); }} data-testid="plist-add">{t('plist.add')}</Button> : null}
      {lists.data.data.length === 0 ? (
        <EmptyState icon={Tags} title={t('plist.empty')} description={t('plist.emptyBody')} />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="plist-list">
          {lists.data.data.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-3">
              <div className="min-w-0 flex-1">
                <p className="m-0 font-semibold">{l.name}</p>
                <p className="m-0 mt-0.5 text-xs text-fg-muted">
                  {l.currency} · {t('plist.products', { count: String(l.productCount) })}
                  {l.validFrom || l.validTo ? ` · ${l.validFrom ? formatDate(l.validFrom) : '…'} – ${l.validTo ? formatDate(l.validTo) : t('plist.openEnd')}` : ''}
                </p>
              </div>
              {l.segment ? <SegmentBadge segment={l.segment} label={t(`shell.segment.${l.segment}`)} /> : null}
              {l.account ? <Badge tone="info">{l.account.name}</Badge> : null}
              {l.active ? null : <Badge tone="neutral">{t('cat.inactive')}</Badge>}
              <Button variant="secondary" size="sm" aria-label={`${t('plist.prices')}: ${l.name}`} onClick={() => { setOpen(l); }}>{t('plist.prices')}</Button>
              {canWrite ? <IconButton size="sm" label={`${t('cat.edit')}: ${l.name}`} onClick={() => { setEditing(l); }}><Pencil aria-hidden size={14} /></IconButton> : null}
            </li>
          ))}
        </ul>
      )}
      <TryPrice />
      {editing ? <ListDialog existing={editing === 'new' ? null : editing} onClose={() => { setEditing(null); }} /> : null}
      {open ? <PricesDialog list={open} canWrite={canWrite} onClose={() => { setOpen(null); }} /> : null}
    </div>
  );
}

function AccountPicker({ value, onChange }: { value: { id: string; name: string } | null; onChange: (v: { id: string; name: string } | null) => void }) {
  const [term, setTerm] = useState('');
  const found = useAccountSearch(term);
  const rows = found.data?.data ?? [];
  const options = value && !rows.some((r) => r.id === value.id) ? [value, ...rows] : rows;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium">{t('plist.account')}</span>
      <Combobox
        aria-label={t('plist.account')}
        value={value?.id ?? null}
        onValueChange={(id) => { onChange(options.find((o) => o.id === id) ?? null); }}
        options={options.map((o) => ({ value: o.id, label: o.name }))}
        placeholder={t('plist.anyAccount')}
        searchPlaceholder={t('plist.accountSearch')}
        emptyText={t('common.noResults')}
        onSearch={setTerm}
      />
    </div>
  );
}

function ProductPicker({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const [term, setTerm] = useState('');
  const found = useProducts(term, false);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium">{t('plist.product')}</span>
      <Combobox
        aria-label={t('plist.product')}
        value={value}
        onValueChange={onChange}
        options={(found.data?.pages.flatMap((p) => p.data) ?? []).map((p) => ({ value: p.id, label: `${p.name} (${p.sku})` }))}
        placeholder={t('plist.productPick')}
        searchPlaceholder={t('product.search')}
        emptyText={t('common.noResults')}
        onSearch={setTerm}
      />
    </div>
  );
}

function ListDialog({ existing, onClose }: { existing: PriceList | null; onClose: () => void }) {
  const { nav, tenant } = useApp();
  const create = useCreatePriceList();
  const update = useUpdatePriceList();
  const { toast } = useToast();
  const [name, setName] = useState(existing?.name ?? '');
  const [currency, setCurrency] = useState(existing?.currency ?? tenant?.currency ?? 'TRY');
  const [segment, setSegment] = useState<string>(existing?.segment ?? ALL);
  const [account, setAccount] = useState<{ id: string; name: string } | null>(existing?.account ?? null);
  const [from, setFrom] = useState(existing?.validFrom ?? '');
  const [to, setTo] = useState(existing?.validTo ?? '');
  const [active, setActive] = useState(existing?.active ?? true);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setError(null);
    const common = { name: name.trim(), validFrom: from || null, validTo: to || null, active };
    try {
      if (existing) await update.mutateAsync({ list: existing, patch: common });
      else {
        const body: PriceListInput = { ...common, currency: currency.trim().toUpperCase(), segment: segment === 'b2b' || segment === 'b2c' ? segment : null, accountId: account?.id ?? null };
        await create.mutateAsync(body);
      }
      toast({ kind: 'success', title: t('cat.saved') });
      onClose();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={existing ? t('plist.editTitle') : t('plist.add')} closeLabel={t('common.close')}>
        <form method="post" onSubmit={(e) => { e.preventDefault(); void submit(); }} className="flex flex-col gap-3" data-testid="plist-dialog">
          {error ? <Alert kind="error">{error}</Alert> : null}
          <Field label={t('plist.name')}><Input value={name} onChange={(e) => { setName(e.target.value); }} maxLength={120} required autoFocus /></Field>
          {existing ? null : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('plist.currency')}><Input value={currency} onChange={(e) => { setCurrency(e.target.value); }} maxLength={3} required /></Field>
                <Field label={t('plist.segment')}>
                  <Select value={segment} onValueChange={setSegment} options={[{ value: ALL, label: t('plist.allSegments') }, ...(nav?.segments ?? []).map((s) => ({ value: s, label: t(`shell.segment.${s}`) }))]} />
                </Field>
              </div>
              <AccountPicker value={account} onChange={setAccount} />
              <p className="m-0 text-xs text-fg-muted">{t('plist.fixed')}</p>
            </>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('plist.validFrom')}><Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); }} /></Field>
            <Field label={t('plist.validTo')}><Input type="date" value={to} min={from || undefined} onChange={(e) => { setTo(e.target.value); }} /></Field>
          </div>
          <label className="inline-flex items-center gap-2 text-sm"><Switch checked={active} onCheckedChange={setActive} aria-label={t('cat.active')} /><span aria-hidden>{t('cat.active')}</span></label>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" loading={create.isPending || update.isPending} disabled={!name.trim() || currency.trim().length !== 3} data-testid="plist-save">{t('common.save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PricesDialog({ list, canWrite, onClose }: { list: PriceList; canWrite: boolean; onClose: () => void }) {
  const items = usePriceItems(list.id);
  const set = useSetPrices();
  const { toast } = useToast();
  const [editing, setEditing] = useState<PriceItem | 'new' | null>(null);
  const rows = items.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={t('plist.pricesOf', { name: list.name })} closeLabel={t('common.close')} wide>
        <div className="flex flex-col gap-3" data-testid="prices-dialog">
          {!items.data ? (
            <Skeleton className="h-24 w-full" />
          ) : rows.length === 0 ? (
            <p className="m-0 text-sm text-fg-muted">{t('plist.noPrices')}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {rows.map((r) => (
                <li key={r.productId} className="flex flex-wrap items-start gap-3 rounded-input border border-line p-3">
                  <div className="min-w-0 flex-1">
                    <p className="m-0 text-sm font-semibold">{r.productName} <span className="font-mono text-xs font-normal text-fg-muted">{r.sku}</span></p>
                    <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0 text-sm tabular-nums">
                      {r.breaks.map((b) => (
                        <li key={b.minQty}>
                          ≥ {b.minQty}: <strong>{b.unitPrice} {list.currency}</strong>
                          {b.marginPercent ? <span className="ml-2 text-xs text-fg-muted">{t('plist.margin', { value: b.marginPercent })}</span> : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                  {canWrite ? (
                    <div className="flex gap-1">
                      <IconButton size="sm" label={`${t('cat.edit')}: ${r.productName}`} onClick={() => { setEditing(r); }}><Pencil aria-hidden size={14} /></IconButton>
                      <IconButton size="sm" label={`${t('plist.removeProduct')}: ${r.productName}`} onClick={() => { set.mutate({ listId: list.id, productId: r.productId, breaks: [] }, { onError: (e) => { toast({ kind: 'error', title: errorText(e) }); } }); }}>
                        <Trash2 aria-hidden size={14} />
                      </IconButton>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {items.hasNextPage ? <Button variant="secondary" size="sm" onClick={() => { void items.fetchNextPage(); }}>{t('cat.more')}</Button> : null}
          {canWrite ? (
            editing ? <PriceForm key={editing === 'new' ? 'new' : editing.productId} list={list} item={editing === 'new' ? null : editing} onDone={() => { setEditing(null); }} /> : <Button className="self-start" variant="secondary" onClick={() => { setEditing('new'); }} data-testid="price-add">{t('plist.setPrice')}</Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PriceForm({ list, item, onDone }: { list: PriceList; item: PriceItem | null; onDone: () => void }) {
  const set = useSetPrices();
  const { toast } = useToast();
  const [productId, setProductId] = useState<string | null>(item?.productId ?? null);
  const [breaks, setBreaks] = useState(() => (item?.breaks ?? [{ minQty: '1', unitPrice: '' }]).map((b, i) => ({ key: i, minQty: b.minQty, unitPrice: b.unitPrice })));
  const [error, setError] = useState<string | null>(null);

  function patch(key: number, change: Partial<{ minQty: string; unitPrice: string }>): void {
    setBreaks((list_) => list_.map((b) => (b.key === key ? { ...b, ...change } : b)));
  }
  async function submit(): Promise<void> {
    if (!productId) return;
    setError(null);
    try {
      await set.mutateAsync({ listId: list.id, productId, breaks: breaks.map((b) => ({ minQty: decimal(b.minQty), unitPrice: decimal(b.unitPrice) })) });
      toast({ kind: 'success', title: t('cat.saved') });
      onDone();
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <form method="post" onSubmit={(e) => { e.preventDefault(); void submit(); }} className="flex flex-col gap-3 rounded-input border border-line bg-subtle p-3" data-testid="price-form">
      {error ? <Alert kind="error">{error}</Alert> : null}
      {item ? <p className="m-0 text-sm font-semibold">{item.productName}</p> : <ProductPicker value={productId} onChange={setProductId} />}
      {breaks.map((b, i) => (
        <div key={b.key} className="flex items-end gap-2">
          <Field label={t('plist.minQty')} className="flex-1"><Input inputMode="decimal" value={b.minQty} onChange={(e) => { patch(b.key, { minQty: e.target.value }); }} required /></Field>
          <Field label={`${t('plist.unitPrice')} (${list.currency})`} className="flex-1"><Input inputMode="decimal" value={b.unitPrice} onChange={(e) => { patch(b.key, { unitPrice: e.target.value }); }} required /></Field>
          <IconButton size="sm" label={`${t('plist.removeBreak')} ${String(i + 1)}`} disabled={breaks.length === 1} onClick={() => { setBreaks((x) => x.filter((y) => y.key !== b.key)); }}><Trash2 aria-hidden size={14} /></IconButton>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" size="sm" icon={<Plus aria-hidden size={14} />} onClick={() => { setBreaks((x) => [...x, { key: Math.max(...x.map((y) => y.key)) + 1, minQty: '', unitPrice: '' }]); }}>{t('plist.addBreak')}</Button>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onDone}>{t('common.cancel')}</Button>
        <Button type="submit" size="sm" loading={set.isPending} disabled={!productId} data-testid="price-save">{t('common.save')}</Button>
      </div>
    </form>
  );
}

/** Which price applies to a customer and quantity (docs/p8-plan.md §3). */
function TryPrice() {
  const { nav, tenant } = useApp();
  const segments = nav?.segments ?? [];
  const [productId, setProductId] = useState<string | null>(null);
  const [account, setAccount] = useState<{ id: string; name: string } | null>(null);
  const [segment, setSegment] = useState<'b2b' | 'b2c'>(segments[0] ?? 'b2b');
  const [quantity, setQuantity] = useState('1');
  const [currency, setCurrency] = useState('');
  const [result, setResult] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(): Promise<void> {
    if (!productId) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const code = currency.trim().toUpperCase();
      const res = await resolvePrice({ items: [{ productId, quantity: decimal(quantity) }], segment, accountId: account?.id ?? null, ...(code ? { currency: code } : {}) });
      const r = res.data[0];
      if (r?.price) {
        const p = r.price;
        setResult([
          t('try.result', { price: p.unitPrice, currency: p.currency, list: p.priceListName, source: t(`try.source.${p.source}`) }),
          ...(p.fxRate ? [t('try.converted', { price: p.listUnitPrice, currency: p.listCurrency, rate: p.fxRate })] : []),
        ]);
      } else setResult([t(`try.reason.${r?.reason ?? 'no_price'}`)]);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-card border border-line bg-surface p-4" aria-labelledby="try-h">
      <h2 id="try-h" className="m-0 text-base font-semibold">{t('try.title')}</h2>
      <p className="m-0 mb-3 mt-1 text-sm text-fg-muted">{t('try.lead')}</p>
      <form method="post" onSubmit={(e) => { e.preventDefault(); void run(); }} className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="try-form">
        <ProductPicker value={productId} onChange={setProductId} />
        <AccountPicker value={account} onChange={setAccount} />
        <Field label={t('plist.segment')}><Select value={segment} onValueChange={(v) => { setSegment(v as 'b2b' | 'b2c'); }} options={segments.map((s) => ({ value: s, label: t(`shell.segment.${s}`) }))} /></Field>
        <Field label={t('try.quantity')}><Input inputMode="decimal" value={quantity} onChange={(e) => { setQuantity(e.target.value); }} required /></Field>
        <Field label={t('try.currency')}><Input value={currency} placeholder={tenant?.currency ?? 'TRY'} maxLength={3} onChange={(e) => { setCurrency(e.target.value); }} /></Field>
        <Button type="submit" variant="secondary" loading={busy} disabled={!productId} data-testid="try-run">{t('try.run')}</Button>
      </form>
      <div role="status" className="mt-3 text-sm" data-testid="try-result">{result?.map((x) => <p key={x} className="m-0">{x}</p>)}</div>
      {error ? <Alert kind="error">{error}</Alert> : null}
    </section>
  );
}
