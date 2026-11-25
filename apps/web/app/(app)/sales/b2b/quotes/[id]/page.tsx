'use client';

import { Alert, Badge, Button, EmptyState, ErrorState, RichTextEditor, RichTextView, Skeleton, useToast, type RichTextValue } from '@flexa/ui';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FileQuestion } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { ApiError, requestBlob } from '../../../../../../lib/api';
import { errorText } from '../../../../../../lib/catalog';
import { dateTime } from '../../../../../../lib/format';
import { t } from '../../../../../../lib/i18n';
import { useMentions } from '../../../../../../lib/mentions';
import { QUOTE_TONE, quoteMoney, quotePdfPath, useQuote, useQuoteNote, useQuoteUpdates, useReviseQuote, type Quote } from '../../../../../../lib/quotes';
import { PageContainer } from '../../../../../_components/app-shell';
import { editorLabels, Section } from '../../../../../_components/record-parts';
import { OutcomeDialog, PreviewDialog, SendDialog, SubmitDialog } from '../_parts/dialogs';
import { QuoteContent, QuoteEditor } from '../_parts/editor';

/** Quote page: editor while a draft, read-only afterwards; what may be done next on top. */
export default function QuotePage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuote(id);
  useQuoteUpdates();
  if (q.isLoading) return <PageContainer wide><Skeleton className="mb-4 h-8 w-1/2" /><Skeleton className="h-64" /></PageContainer>;
  if (!q.data) {
    const gone = q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 400);
    return (
      <PageContainer>
        {gone ? (
          <EmptyState icon={FileQuestion} title={t('quote.notFound')} description={t('quote.notFoundBody')} action={<Button asChild variant="secondary" size="sm"><Link href="/sales/b2b/quotes">{t('quote.title')}</Link></Button>} />
        ) : (
          <ErrorState title={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => { void q.refetch(); }} />
        )}
      </PageContainer>
    );
  }
  return <QuoteScreen quote={q.data} />;
}

type Open = 'submit' | 'send' | 'accepted' | 'rejected' | 'preview' | null;

function QuoteScreen({ quote }: { quote: Quote }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const revise = useReviseQuote();
  const [open, setOpen] = useState<Open>(null);
  const [dirty, setDirty] = useState(false);
  const editing = quote.status === 'draft' && quote.canEdit;
  const c = quote.content;

  function download(version: number): void {
    requestBlob(quotePdfPath(quote.id, version)).then(
      (blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${quote.number}-v${String(version)}.pdf`;
        a.click();
        setTimeout(() => { URL.revokeObjectURL(url); }, 10_000);
      },
      (e: unknown) => { toast({ kind: 'error', title: errorText(e) }); },
    );
  }

  return (
    <PageContainer wide>
      <Button asChild variant="ghost" size="sm" icon={<ArrowLeft aria-hidden size={14} />}><Link href="/sales/b2b/quotes">{t('quote.title')}</Link></Button>
      <div className="mb-4 mt-3 flex flex-wrap items-center gap-3">
        <div className="min-w-48 flex-1">
          <h1 className="m-0 font-display text-2xl font-bold" data-testid="quote-number">{quote.number}</h1>
          <p className="m-0 mt-1 text-sm text-fg-muted">
            <Link href={`/crm/opportunity/${quote.opportunity.id}`}>{quote.opportunity.name}</Link>
            {c.customer.account ? ` · ${c.customer.account}` : ''}{c.customer.contact ? ` · ${c.customer.contact}` : ''} · {t('quote.version', { version: String(c.version) })}
          </p>
        </div>
        <span data-testid="quote-status"><Badge tone={QUOTE_TONE[quote.status]}>{t(`quote.status.${quote.status}`)}</Badge></span>
        <Button variant="secondary" size="sm" onClick={() => { setOpen('preview'); }} disabled={dirty} data-testid="quote-preview">{t('quote.preview')}</Button>
        <Button variant="secondary" size="sm" onClick={() => { download(c.version); }} disabled={dirty}>{t('quote.pdf')}</Button>
        {quote.canEdit && ['approved', 'sent', 'rejected', 'expired'].includes(quote.status) ? (
          <Button variant="secondary" size="sm" loading={revise.isPending} data-testid="quote-revise" onClick={() => {
            revise.mutateAsync(quote.id).then(() => { toast({ kind: 'success', title: t('quote.revised') }); }, (e: unknown) => { toast({ kind: 'error', title: errorText(e) }); });
          }}>{t('quote.revise')}</Button>
        ) : null}
        {editing ? <Button size="sm" disabled={dirty || c.lines.length === 0} onClick={() => { setOpen('submit'); }} data-testid="quote-submit">{t('quote.submit')}</Button> : null}
        {quote.canEdit && quote.status === 'approved' ? <Button size="sm" onClick={() => { setOpen('send'); }} data-testid="quote-send">{t('quote.send')}</Button> : null}
        {quote.canEdit && quote.status === 'sent' ? (
          <>
            <Button size="sm" onClick={() => { setOpen('accepted'); }} data-testid="quote-accept">{t('quote.accept')}</Button>
            <Button size="sm" variant="secondary" onClick={() => { setOpen('rejected'); }}>{t('quote.reject')}</Button>
          </>
        ) : null}
      </div>
      {c.sentAt ? <div className="mb-4"><Alert kind="info">{t('quote.sentInfo', { date: dateTime(c.sentAt), name: c.sentBy?.displayName ?? '', to: c.sentTo.join(', ') })}</Alert></div> : null}
      {quote.outcomeReason ? <p className="mb-4 text-sm">{quote.outcomeReason}</p> : null}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        {editing
          ? <QuoteEditor key={`${String(c.version)}-${String(quote.version)}`} quote={quote} onDirty={setDirty} onConflict={() => { void qc.invalidateQueries({ queryKey: ['quotes'] }); }} />
          : <QuoteContent quote={quote} />}
        <div className="flex min-w-0 flex-col gap-4">
          <Section title={t('quote.versions')}>
            <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="quote-versions">
              {quote.versions.map((v) => (
                <li key={v.version} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="flex-1">{t('quote.version', { version: String(v.version) })} · <span className="tabular-nums">{quoteMoney(v.total, quote.currency)}</span></span>
                  <Button variant="ghost" size="sm" aria-label={`${t('quote.pdf')}: ${t('quote.version', { version: String(v.version) })}`} onClick={() => { download(v.version); }}>PDF</Button>
                </li>
              ))}
            </ul>
          </Section>
          <NotePanel quote={quote} />
        </div>
      </div>
      {open === 'submit' ? <SubmitDialog quote={quote} onClose={() => { setOpen(null); }} /> : null}
      {open === 'send' ? <SendDialog quote={quote} onClose={() => { setOpen(null); }} /> : null}
      {open === 'accepted' || open === 'rejected' ? <OutcomeDialog quote={quote} outcome={open} onClose={() => { setOpen(null); }} /> : null}
      {open === 'preview' ? <PreviewDialog quote={quote} onClose={() => { setOpen(null); }} /> : null}
    </PageContainer>
  );
}

function NotePanel({ quote }: { quote: Quote }) {
  const save = useQuoteNote();
  const { toast } = useToast();
  const docs = useMemo(() => [quote.note], [quote.note]);
  const { config, labelOf } = useMentions(`opportunities/${quote.opportunity.id}`, 'quote', docs);
  const doc = (quote.note ?? null) as RichTextValue['doc'] | null;
  return (
    <Section title={t('quote.note')}>
      <p className="m-0 mb-2 text-xs text-fg-muted">{t('quote.noteHint')}</p>
      {quote.canEdit ? (
        <RichTextEditor aria-label={t('quote.note')} value={doc} placeholder={t('quote.notePlaceholder')} labels={editorLabels()} {...(config ? { mentions: config } : {})}
          onBlur={(v) => {
            const next = v.text.trim() === '' ? null : v.doc;
            if (JSON.stringify(next) === JSON.stringify(doc)) return;
            save.mutateAsync({ id: quote.id, note: next }).then(() => { toast({ kind: 'success', title: t('common.saved') }); }, (e: unknown) => { toast({ kind: 'error', title: errorText(e) }); });
          }} />
      ) : doc ? <RichTextView doc={doc} labelOf={labelOf} /> : null}
    </Section>
  );
}
