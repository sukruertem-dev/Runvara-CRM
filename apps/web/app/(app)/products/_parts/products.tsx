'use client';

import { Alert, Badge, Button, Checkbox, Dialog, DialogContent, DialogFooter, EmptyState, ErrorState, Field, IconButton, Input, SegmentBadge, Select, Skeleton, Switch, Textarea, useToast } from '@flexa/ui';
import { Package, Pencil } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { useApp } from '../../../../lib/app-context';
import { errorText, useCreateProduct, useProducts, useTaxRates, useUpdateProduct, type Product, type ProductInput } from '../../../../lib/catalog';
import { t } from '../../../../lib/i18n';

const SKU = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const NONE = 'none';

export function Products({ canWrite }: { canWrite: boolean }) {
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const list = useProducts(useDeferredValue(q.trim()), all);
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  const showCost = rows.some((r) => r.cost !== undefined);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('product.search')} className="min-w-56 flex-1">
          <Input type="search" value={q} onChange={(e) => { setQ(e.target.value); }} data-testid="product-search" />
        </Field>
        <label className="inline-flex h-control items-center gap-2 text-sm"><Checkbox checked={all} onCheckedChange={(v) => { setAll(v === true); }} />{t('product.showInactive')}</label>
        {canWrite ? <Button onClick={() => { setEditing('new'); }} data-testid="product-add">{t('product.add')}</Button> : null}
      </div>

      {list.isError ? (
        <ErrorState title={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => { void list.refetch(); }} />
      ) : !list.data ? (
        <Skeleton className="h-48 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={Package} title={t('product.empty')} description={t('product.emptyBody')} />
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-surface" tabIndex={0} role="region" aria-label={t('cat.tab.products')}>
          <table className="w-full border-collapse text-sm" data-testid="product-table">
            <thead>
              <tr className="border-b border-line text-left text-xs text-fg-muted">
                <th scope="col" className="px-3 py-2 font-medium">{t('product.sku')}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t('product.name')}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t('product.category')}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t('product.segments')}</th>
                {showCost ? <th scope="col" className="px-3 py-2 text-right font-medium">{t('product.cost')}</th> : null}
                <th scope="col" className="px-3 py-2 font-medium">{t('product.status')}</th>
                {canWrite ? <th scope="col" className="px-3 py-2 text-right font-medium">{t('product.actions')}</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-b border-line last:border-b-0">
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{p.sku}</td>
                  <td className="px-3 py-2 font-medium">{p.name}</td>
                  <td className="px-3 py-2 text-fg-muted">{p.category ?? '—'}</td>
                  <td className="px-3 py-2"><span className="inline-flex gap-1">{p.segments.map((s) => <SegmentBadge key={s} segment={s} label={t(`shell.segment.${s}`)} />)}</span></td>
                  {showCost ? <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{p.cost ? `${p.cost.amount} ${p.cost.currency}` : '—'}</td> : null}
                  <td className="px-3 py-2"><Badge tone={p.active ? 'success' : 'neutral'}>{p.active ? t('cat.active') : t('cat.inactive')}</Badge></td>
                  {canWrite ? (
                    <td className="px-3 py-2 text-right">
                      <IconButton size="sm" label={`${t('cat.edit')}: ${p.name}`} onClick={() => { setEditing(p); }}><Pencil aria-hidden size={14} /></IconButton>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.hasNextPage ? <Button variant="secondary" className="self-center" loading={list.isFetchingNextPage} onClick={() => { void list.fetchNextPage(); }}>{t('cat.more')}</Button> : null}
      {editing ? <ProductDialog existing={editing === 'new' ? null : editing} onClose={() => { setEditing(null); }} /> : null}
    </div>
  );
}

function ProductDialog({ existing, onClose }: { existing: Product | null; onClose: () => void }) {
  const { nav, tenant, can } = useApp();
  const taxes = useTaxRates();
  const create = useCreateProduct();
  const update = useUpdateProduct();
  const { toast } = useToast();
  const segmentsOffered = nav?.segments ?? [];
  const [sku, setSku] = useState(existing?.sku ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [category, setCategory] = useState(existing?.category ?? '');
  const [unit, setUnit] = useState(existing?.unit ?? 'adet');
  const [tax, setTax] = useState(existing?.taxRateId ?? NONE);
  const [segments, setSegments] = useState<readonly ('b2b' | 'b2c')[]>(existing?.segments ?? segmentsOffered);
  const [cost, setCost] = useState(existing?.cost?.amount ?? '');
  const [costCurrency, setCostCurrency] = useState(existing?.cost?.currency ?? tenant?.currency ?? 'TRY');
  const [active, setActive] = useState(existing?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const canCost = can('fields.cost_margin.read');

  async function submit(): Promise<void> {
    setError(null);
    if (!SKU.test(sku.trim())) { setError(t('product.skuInvalid')); return; }
    if (segments.length === 0) { setError(t('product.segmentsRequired')); return; }
    const body: ProductInput = {
      sku: sku.trim(), name: name.trim(), description, category: category.trim() || null, unit: unit.trim() || 'adet', taxRateId: tax === NONE ? null : tax, segments: [...segments], active,
      ...(canCost ? { cost: cost.trim() ? { amount: cost.trim().replace(',', '.'), currency: costCurrency.trim().toUpperCase() } : null } : {}),
    };
    try {
      if (existing) await update.mutateAsync({ product: existing, patch: body });
      else await create.mutateAsync(body);
      toast({ kind: 'success', title: t('cat.saved') });
      onClose();
    } catch (e) {
      setError(errorText(e));
    }
  }

  // An inactive rate stays selectable only where it is already used.
  const taxOptions = [{ value: NONE, label: t('product.noTax') }, ...(taxes.data?.data ?? []).filter((x) => x.active || x.id === existing?.taxRateId).map((x) => ({ value: x.id, label: `${x.name} (%${Number(x.rate).toString()})` }))];

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={existing ? t('product.editTitle') : t('product.add')} closeLabel={t('common.close')} wide>
        <form method="post" onSubmit={(e) => { e.preventDefault(); void submit(); }} className="flex flex-col gap-3" data-testid="product-dialog">
          {error ? <Alert kind="error">{error}</Alert> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('product.sku')}><Input value={sku} onChange={(e) => { setSku(e.target.value); }} maxLength={64} required autoFocus /></Field>
            <Field label={t('product.name')}><Input value={name} onChange={(e) => { setName(e.target.value); }} maxLength={200} required /></Field>
            <Field label={t('product.category')}><Input value={category} onChange={(e) => { setCategory(e.target.value); }} maxLength={80} /></Field>
            <Field label={t('product.unit')}><Input value={unit} onChange={(e) => { setUnit(e.target.value); }} maxLength={20} /></Field>
            <Field label={t('product.tax')}><Select value={tax} onValueChange={setTax} options={taxOptions} /></Field>
            <fieldset className="m-0 border-0 p-0">
              <legend className="mb-1 p-0 text-sm font-medium">{t('product.segments')}</legend>
              <div className="flex h-control items-center gap-4">
                {segmentsOffered.map((s) => (
                  <label key={s} className="inline-flex items-center gap-2 text-sm">
                    <Checkbox checked={segments.includes(s)} onCheckedChange={(v) => { setSegments(v === true ? [...segments, s] : segments.filter((x) => x !== s)); }} />
                    {t(`shell.segment.${s}`)}
                  </label>
                ))}
              </div>
            </fieldset>
            {canCost ? (
              <>
                <Field label={t('product.cost')}><Input inputMode="decimal" value={cost} onChange={(e) => { setCost(e.target.value); }} /></Field>
                <Field label={t('product.costCurrency')}><Input value={costCurrency} onChange={(e) => { setCostCurrency(e.target.value); }} maxLength={3} /></Field>
              </>
            ) : null}
          </div>
          <Field label={t('product.description')}><Textarea value={description} onChange={(e) => { setDescription(e.target.value); }} rows={3} maxLength={4000} /></Field>
          <label className="inline-flex items-center gap-2 text-sm"><Switch checked={active} onCheckedChange={setActive} aria-label={t('cat.active')} /><span aria-hidden>{t('cat.active')}</span></label>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" loading={create.isPending || update.isPending} disabled={!sku.trim() || !name.trim()} data-testid="product-save">{t('common.save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
