'use client';

import { Alert, Button, Dialog, DialogContent, DialogFooter, Field, Input, Skeleton, Textarea, useToast } from '@flexa/ui';
import { useEffect, useState } from 'react';
import { ApiError, requestBlob } from '../../../../../../lib/api';
import { errorText } from '../../../../../../lib/catalog';
import { t } from '../../../../../../lib/i18n';
import { quotePdfPath, useQuoteOutcome, useSendQuote, useSubmitQuote, type Quote } from '../../../../../../lib/quotes';

export function SubmitDialog({ quote, onClose }: { quote: Quote; onClose: () => void }) {
  const submit = useSubmitQuote();
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  function run(): void {
    setError(null);
    submit.mutateAsync({ id: quote.id, ...(reason.trim() ? { reason: reason.trim() } : {}) }).then(
      (q) => {
        toast({ kind: 'success', title: t(q.status === 'pending_approval' ? 'quote.sentForApproval' : 'quote.submitted') });
        onClose();
      },
      (e: unknown) => {
        const p = e instanceof ApiError ? e.problem : null;
        setError(p?.['reason'] === 'approval_reason_required' ? t('quote.reasonNeeded', { percent: String(Number(p['percent'])) }) : errorText(e));
      },
    );
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={t('quote.submitTitle')} closeLabel={t('common.close')}>
        <form method="post" onSubmit={(e) => { e.preventDefault(); run(); }} className="flex flex-col gap-3" data-testid="quote-submit-dialog">
          {error ? <Alert kind="error">{error}</Alert> : null}
          <p className="m-0 text-sm">{t('quote.submitBody')}</p>
          <Field label={t('quote.reason')}><Textarea value={reason} onChange={(e) => { setReason(e.target.value); }} maxLength={500} rows={3} /></Field>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" loading={submit.isPending} data-testid="quote-submit-save">{t('quote.submit')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function SendDialog({ quote, onClose }: { quote: Quote; onClose: () => void }) {
  const send = useSendQuote();
  const { toast } = useToast();
  const [to, setTo] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const list = to.split(/[,;\s]+/).filter(Boolean);
  function run(): void {
    setError(null);
    send.mutateAsync({ id: quote.id, to: list, message: message.trim() }).then(
      () => { toast({ kind: 'success', title: t('quote.sent') }); onClose(); },
      (e: unknown) => { setError(errorText(e)); },
    );
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={t('quote.sendTitle')} closeLabel={t('common.close')}>
        <form method="post" onSubmit={(e) => { e.preventDefault(); run(); }} className="flex flex-col gap-3" data-testid="quote-send-dialog">
          {error ? <Alert kind="error">{error}</Alert> : null}
          <p className="m-0 text-sm">{t('quote.sendBody')}</p>
          <Field label={t('quote.to')} hint={t('quote.toHint')}><Input value={to} onChange={(e) => { setTo(e.target.value); }} required autoFocus /></Field>
          <Field label={t('quote.message')}><Textarea value={message} onChange={(e) => { setMessage(e.target.value); }} maxLength={2000} rows={4} /></Field>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" loading={send.isPending} disabled={list.length === 0 || list.length > 5} data-testid="quote-send-save">{t('quote.send')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function OutcomeDialog({ quote, outcome, onClose }: { quote: Quote; outcome: 'accepted' | 'rejected'; onClose: () => void }) {
  const save = useQuoteOutcome();
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  function run(): void {
    setError(null);
    save.mutateAsync({ id: quote.id, outcome, ...(reason.trim() ? { reason: reason.trim() } : {}) }).then(
      () => { toast({ kind: 'success', title: t('quote.outcomeSaved') }); onClose(); },
      (e: unknown) => { setError(errorText(e)); },
    );
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={`${t('quote.outcomeTitle')}: ${t(outcome === 'accepted' ? 'quote.accept' : 'quote.reject')}`} closeLabel={t('common.close')}>
        <form method="post" onSubmit={(e) => { e.preventDefault(); run(); }} className="flex flex-col gap-3" data-testid="quote-outcome-dialog">
          {error ? <Alert kind="error">{error}</Alert> : null}
          <Field label={t('quote.outcomeReason')}><Textarea value={reason} onChange={(e) => { setReason(e.target.value); }} maxLength={500} rows={3} /></Field>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" loading={save.isPending} data-testid="quote-outcome-save">{t('common.save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The document as the customer gets it, in the browser's own viewer. */
export function PreviewDialog({ quote, onClose }: { quote: Quote; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const path = quotePdfPath(quote.id, quote.content.version);
  useEffect(() => {
    let current: string | null = null;
    let live = true;
    requestBlob(path).then(
      (b) => {
        if (!live) return;
        current = URL.createObjectURL(b);
        setUrl(current);
      },
      (e: unknown) => { if (live) setError(errorText(e)); },
    );
    return () => {
      live = false;
      if (current) URL.revokeObjectURL(current);
    };
  }, [path]);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={t('quote.previewTitle')} closeLabel={t('common.close')} className="max-w-4xl">
        {error ? <Alert kind="error">{error}</Alert> : url ? <iframe src={url} title={t('quote.previewTitle')} className="h-[70vh] w-full rounded-input border border-line" data-testid="quote-preview-frame" /> : <Skeleton className="h-[70vh] w-full" />}
      </DialogContent>
    </Dialog>
  );
}
