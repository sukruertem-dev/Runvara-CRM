'use client';

import { priceQuote, type Priced } from '@flexa/contracts/dist/pricing';
import { Alert, Button, Combobox, Field, IconButton, Input, Textarea, useToast } from '@flexa/ui';
import { Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../../../../../lib/api';
import { errorText, useProducts, useTaxRates } from '../../../../../../lib/catalog';
import { formatDate } from '../../../../../../lib/format';
import { t } from '../../../../../../lib/i18n';
import { quoteMoney, useSaveQuote, type Quote } from '../../../../../../lib/quotes';
import { Section } from '../../../../../_components/record-parts';

const decimal = (v: string): string => v.trim().replace(',', '.');
const QTY = /^\d{1,11}(\.\d{1,3})?$/;
const PRICE = /^\d{1,14}(\.\d{1,4})?$/;
const PERCENT = /^\d{1,3}(\.\d{1,3})?$/;
const percentOk = (v: string): boolean => PERCENT.test(decimal(v)) && Number(decimal(v)) <= 100;

interface DraftLine {
  key: string;
  productId: string;
  label: string;
  unit: string;
  quantity: string;
  /** Empty = the catalogue's price. */
  unitPrice: string;
  listPrice: string | null;
  discount: string;
  taxPercent: string;
  description: string;
}

const lineOk = (l: DraftLine): boolean => QTY.test(decimal(l.quantity)) && Number(decimal(l.quantity)) > 0 && (l.unitPrice.trim() === '' || PRICE.test(decimal(l.unitPrice))) && percentOk(l.discount);

function Sums({ p, currency }: { p: Priced; currency: string }) {
  const row = (label: string, value: string, strong = false) => (
    <div key={label} className={`flex justify-between gap-4 ${strong ? 'text-base font-bold' : 'text-sm'}`}>
      <dt>{label}</dt>
      <dd className="m-0 tabular-nums">{quoteMoney(value, currency)}</dd>
    </div>
  );
  return (
    <dl className="m-0 ml-auto flex w-full max-w-sm flex-col gap-1" data-testid="quote-totals">
      {row(t('quote.subtotal'), p.totals.subtotal)}
      {Number(p.totals.discount) > 0 ? row(t('quote.discount'), p.totals.discount) : null}
      {row(t('quote.net'), p.totals.net)}
      {p.taxes.map((x) => row(t('quote.tax', { percent: String(Number(x.percent)) }), x.tax))}
      {row(t('quote.total'), p.totals.total, true)}
    </dl>
  );
}

export function QuoteEditor({ quote, onDirty, onConflict }: { quote: Quote; onDirty: (dirty: boolean) => void; onConflict: () => void }) {
  const c = quote.content;
  const save = useSaveQuote();
  const { toast } = useToast();
  const seq = useRef(0);
  const initial = useMemo<DraftLine[]>(() => c.lines.map((l, i) => ({
    key: `s${String(i)}`, productId: l.productId, label: `${l.name} (${l.sku})`, unit: l.unit, quantity: l.quantity, unitPrice: l.unitPrice === l.listPrice ? '' : l.unitPrice, listPrice: l.listPrice,
    discount: l.discountPercent, taxPercent: l.taxPercent, description: l.description,
  })), [c.lines]);
  const [lines, setLines] = useState(initial);
  const [discount, setDiscount] = useState(c.discountPercent);
  const [validUntil, setValidUntil] = useState(c.validUntil);
  const [intro, setIntro] = useState(c.intro);
  const [terms, setTerms] = useState(c.terms);
  const [term, setTerm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const products = useProducts(term, false);
  const taxes = useTaxRates();
  const found = (products.data?.pages.flatMap((p) => p.data) ?? []).filter((p) => p.segments.includes('b2b'));

  const dirty = lines !== initial || discount !== c.discountPercent || validUntil !== c.validUntil || intro !== c.intro || terms !== c.terms;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => () => { onDirty(false); }, [onDirty]);
  const valid = lines.every(lineOk) && percentOk(discount) && validUntil !== '';

  // Lines whose price only the API knows (just added, list price) count as zero until saved.
  const priced = useMemo(() => {
    try {
      return priceQuote(lines.map((l) => ({
        quantity: decimal(l.quantity) || '0', unitPrice: decimal(l.unitPrice) || (l.listPrice ?? '0'), listPrice: l.listPrice, discountPercent: decimal(l.discount) || '0', taxPercent: l.taxPercent,
      })), decimal(discount) || '0', quote.currency);
    } catch {
      return null;
    }
  }, [lines, discount, quote.currency]);

  const set = (key: string, patch: Partial<DraftLine>): void => { setLines((all) => all.map((l) => (l.key === key ? { ...l, ...patch } : l))); };

  function run(): void {
    setError(null);
    save.mutateAsync({
      quote,
      draft: {
        discountPercent: decimal(discount), validUntil, intro, terms,
        lines: lines.map((l) => ({ productId: l.productId, quantity: decimal(l.quantity), ...(l.unitPrice.trim() ? { unitPrice: decimal(l.unitPrice) } : {}), discountPercent: decimal(l.discount), description: l.description })),
      },
    }).then(
      () => { toast({ kind: 'success', title: t('quote.saved') }); },
      (e: unknown) => {
        if (e instanceof ApiError && e.status === 412) {
          toast({ kind: 'error', title: t('quote.conflict') });
          onConflict();
        } else setError(errorText(e));
      },
    );
  }

  return (
    <form method="post" onSubmit={(e) => { e.preventDefault(); if (valid) run(); }} className="flex min-w-0 flex-col gap-4" data-testid="quote-editor">
      {error ? <Alert kind="error">{error}</Alert> : null}
      <Section title={t('quote.lines')}>
        {lines.length === 0 ? <p className="m-0 text-sm text-fg-muted">{t('quote.noLines')}</p> : null}
        <ul className="m-0 flex list-none flex-col gap-3 p-0" data-testid="quote-lines">
          {lines.map((l, i) => (
            <li key={l.key} className="flex flex-col gap-2 border-b border-line pb-3" data-testid="quote-line">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-semibold">{l.label}</span>
                <span className="text-sm tabular-nums">{priced?.lines[i] ? quoteMoney(priced.lines[i].net, quote.currency) : ''}</span>
                <IconButton size="sm" label={`${t('quote.removeLine')}: ${l.label}`} onClick={() => { setLines((all) => all.filter((x) => x.key !== l.key)); }}><Trash2 aria-hidden size={14} /></IconButton>
              </div>
              <div className="grid items-start gap-2 sm:grid-cols-3">
                <Field label={`${t('quote.qty')} (${l.unit})`}><Input inputMode="decimal" value={l.quantity} onChange={(e) => { set(l.key, { quantity: e.target.value }); }} /></Field>
                <Field label={t('quote.unitPrice')} hint={l.listPrice ? t('quote.listPrice', { price: quoteMoney(l.listPrice, quote.currency) }) : t('quote.noListPrice')}>
                  <Input inputMode="decimal" value={l.unitPrice} placeholder={l.listPrice ?? t('quote.useListPrice')} onChange={(e) => { set(l.key, { unitPrice: e.target.value }); }} />
                </Field>
                <Field label={t('quote.lineDiscount')}><Input inputMode="decimal" value={l.discount} onChange={(e) => { set(l.key, { discount: e.target.value }); }} /></Field>
              </div>
            </li>
          ))}
        </ul>
        <div className="mt-3 max-w-md">
          <div>
            <Combobox
              aria-label={t('quote.addProduct')}
              value={null}
              options={found.map((p) => ({ value: p.id, label: `${p.name} (${p.sku})` }))}
              onSearch={setTerm}
              placeholder={t('quote.addProduct')}
              searchPlaceholder={t('quote.searchProduct')}
              emptyText={t('common.noResults')}
              onValueChange={(id) => {
                const p = found.find((x) => x.id === id);
                if (!p) return;
                seq.current += 1;
                const rate = taxes.data?.data.find((x) => x.id === p.taxRateId)?.rate ?? '0';
                setLines((all) => [...all, { key: `n${String(seq.current)}`, productId: p.id, label: `${p.name} (${p.sku})`, unit: p.unit, quantity: '1', unitPrice: '', listPrice: null, discount: '0', taxPercent: rate, description: '' }]);
              }}
            />
          </div>
        </div>
        {priced ? <div className="mt-4"><Sums p={priced} currency={quote.currency} /></div> : null}
        {!dirty && Number(c.approvalPercent) > 0 ? <p className="m-0 mt-3 text-sm text-fg-muted" data-testid="quote-approval">{t('quote.approvalNeed', { percent: String(Number(c.approvalPercent)) })}</p> : null}
      </Section>
      <Section title={t('quote.one')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('quote.validUntil')}><Input type="date" value={validUntil} onChange={(e) => { setValidUntil(e.target.value); }} required /></Field>
          <Field label={t('quote.discountAll')}><Input inputMode="decimal" value={discount} onChange={(e) => { setDiscount(e.target.value); }} /></Field>
        </div>
        <div className="mt-3 flex flex-col gap-3">
          <Field label={t('quote.intro')}><Textarea value={intro} onChange={(e) => { setIntro(e.target.value); }} maxLength={4000} rows={3} /></Field>
          <Field label={t('quote.terms')}><Textarea value={terms} onChange={(e) => { setTerms(e.target.value); }} maxLength={8000} rows={4} /></Field>
        </div>
      </Section>
      <div className="flex flex-wrap items-center justify-end gap-3">
        <span className="text-sm text-fg-muted" role="status">{valid ? (dirty ? t('quote.unsaved') : '') : t('quote.invalid')}</span>
        <Button type="submit" disabled={!dirty || !valid} loading={save.isPending} data-testid="quote-save">{t('quote.save')}</Button>
      </div>
    </form>
  );
}

/** Read-only content (submitted, sent, or a reader without the right to edit). */
export function QuoteContent({ quote }: { quote: Quote }) {
  const c = quote.content;
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="quote-content">
      <Section title={t('quote.lines')}>
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={t('quote.lines')}>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-fg-muted">
                <th scope="col" className="py-2 pr-3 font-semibold">{t('quote.product')}</th>
                <th scope="col" className="py-2 pr-3 text-right font-semibold">{t('quote.qty')}</th>
                <th scope="col" className="py-2 pr-3 text-right font-semibold">{t('quote.unitPrice')}</th>
                <th scope="col" className="py-2 pr-3 text-right font-semibold">{t('quote.lineDiscount')}</th>
                <th scope="col" className="py-2 text-right font-semibold">{t('quote.lineNet')}</th>
              </tr>
            </thead>
            <tbody>
              {c.lines.map((l, i) => (
                <tr key={`${l.productId}${String(i)}`} className="border-b border-line">
                  <td className="py-2 pr-3">{l.name} ({l.sku})</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{l.quantity} {l.unit}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{quoteMoney(l.unitPrice, quote.currency)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{Number(l.discountPercent) > 0 ? l.discountPercent : ''}</td>
                  <td className="py-2 text-right tabular-nums">{quoteMoney(l.net, quote.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4"><Sums p={{ lines: [], totals: c.totals, taxes: c.taxes, approvalPercent: c.approvalPercent }} currency={quote.currency} /></div>
      </Section>
      <Section title={t('quote.one')}>
        <p className="m-0 text-sm">{t('quote.validUntil')}: {formatDate(`${c.validUntil}T12:00:00`)}</p>
        {c.intro ? <p className="mb-0 mt-3 whitespace-pre-wrap text-sm">{c.intro}</p> : null}
        {c.terms ? <><h3 className="mb-1 mt-3 text-sm font-semibold">{t('quote.terms')}</h3><p className="m-0 whitespace-pre-wrap text-sm">{c.terms}</p></> : null}
      </Section>
    </div>
  );
}
