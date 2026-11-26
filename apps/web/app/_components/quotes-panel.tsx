'use client';

import { Badge, Button, useToast } from '@flexa/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useApp } from '../../lib/app-context';
import { errorText } from '../../lib/catalog';
import { t } from '../../lib/i18n';
import { QUOTE_TONE, quoteMoney, useCreateQuote, useQuotes, useQuoteUpdates } from '../../lib/quotes';
import { Section } from './record-parts';

/** Quotes of a B2B opportunity (B2B-04). */
export function QuotesPanel({ opportunityId }: { opportunityId: string }) {
  const { nav, can } = useApp();
  const on = nav?.modules.some((m) => m.id === 'sales_b2b') ?? false;
  const list = useQuotes({ opportunityId }, on);
  const create = useCreateQuote();
  const router = useRouter();
  const { toast } = useToast();
  useQuoteUpdates();
  if (!on || !list.data) return null;
  const rows = list.data.pages.flatMap((p) => p.data);
  return (
    <Section title={t('quote.title')} testId="quotes-panel">
      {rows.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">{t('quote.panelEmpty')}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {rows.map((q) => (
            <li key={q.id} className="flex flex-wrap items-center gap-2 text-sm">
              <Link href={`/sales/b2b/quotes/${q.id}`} className="font-semibold text-fg">{q.number}</Link>
              <span className="tabular-nums">{quoteMoney(q.total, q.currency)}</span>
              <Badge tone={QUOTE_TONE[q.status]}>{t(`quote.status.${q.status}`)}</Badge>
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage ? <Button className="mt-2" size="sm" variant="ghost" onClick={() => { void list.fetchNextPage(); }}>{t('quote.more')}</Button> : null}
      {can('sales_b2b.quote.create') ? (
        <Button className="mt-2" size="sm" variant="secondary" loading={create.isPending} data-testid="quote-new" onClick={() => {
          create.mutateAsync(opportunityId).then((q) => { router.push(`/sales/b2b/quotes/${q.id}`); }, (e: unknown) => { toast({ kind: 'error', title: errorText(e) }); });
        }}>{t('quote.new')}</Button>
      ) : null}
    </Section>
  );
}
