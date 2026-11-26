'use client';

import { Alert, Badge, Button, Dialog, DialogContent, DialogFooter, Field, Input, Textarea, useToast } from '@flexa/ui';
import { useState } from 'react';
import { useApp } from '../../lib/app-context';
import { useApprovalUpdates, useAskApproval, useSubjectApprovals } from '../../lib/approvals';
import { errorText } from '../../lib/catalog';
import { t } from '../../lib/i18n';
import { Section } from './record-parts';

/** Discount of a B2B opportunity: what is approved, what is pending, and asking for one (B2B-05). */
export function DiscountPanel({ opportunityId }: { opportunityId: string }) {
  const { nav, can } = useApp();
  const on = nav?.modules.some((m) => m.id === 'sales_b2b') ?? false;
  const list = useSubjectApprovals(opportunityId, on);
  useApprovalUpdates();
  const [asking, setAsking] = useState(false);
  if (!on || !list.data) return null;
  const approved = list.data.data.filter((a) => a.state === 'approved' && !a.quote).sort((x, y) => (y.decidedAt ?? '').localeCompare(x.decidedAt ?? ''))[0];
  const pending = list.data.data.find((a) => a.state === 'pending' && !a.quote);
  return (
    <Section title={t('appr.discount')} testId="discount-panel">
      <p className="m-0 text-sm">{approved ? t('appr.discount.current', { percent: String(Number(approved.percent)) }) : t('appr.discount.none')}</p>
      {pending ? (
        <p className="m-0 mt-2 flex flex-wrap items-center gap-2 text-sm">
          <Badge tone="info">{t('appr.state.pending')}</Badge>
          {t('appr.kind.discount', { percent: String(Number(pending.percent)) })} · {t('appr.assigned', { name: pending.assignedTo?.displayName ?? t('appr.anyAdmin') })}
        </p>
      ) : can('sales_b2b.quote.create') ? (
        <Button className="mt-2" size="sm" variant="secondary" onClick={() => { setAsking(true); }} data-testid="discount-ask">{t('appr.discount.ask')}</Button>
      ) : null}
      {asking ? <AskDialog opportunityId={opportunityId} onClose={() => { setAsking(false); }} /> : null}
    </Section>
  );
}

function AskDialog({ opportunityId, onClose }: { opportunityId: string; onClose: () => void }) {
  const ask = useAskApproval();
  const { toast } = useToast();
  const [percent, setPercent] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  function submit(): void {
    setError(null);
    ask.mutateAsync({ kind: 'discount', subject: { type: 'opportunity', id: opportunityId }, percent: percent.trim().replace(',', '.'), reason: reason.trim() }).then(
      (a) => { toast({ kind: 'success', title: t(a.automatic ? 'appr.discount.auto' : 'appr.discount.sent') }); onClose(); },
      (e: unknown) => { setError(errorText(e)); },
    );
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={t('appr.discount.ask')} closeLabel={t('common.close')}>
        <form method="post" onSubmit={(e) => { e.preventDefault(); submit(); }} className="flex flex-col gap-3" data-testid="discount-dialog">
          {error ? <Alert kind="error">{error}</Alert> : null}
          <Field label={t('appr.discount.percent')}><Input inputMode="decimal" value={percent} onChange={(e) => { setPercent(e.target.value); }} required autoFocus /></Field>
          <Field label={t('appr.discount.reason')}><Textarea value={reason} onChange={(e) => { setReason(e.target.value); }} maxLength={500} rows={3} required /></Field>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" loading={ask.isPending} disabled={!percent.trim() || !reason.trim()} data-testid="discount-save">{t('appr.discount.ask')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
