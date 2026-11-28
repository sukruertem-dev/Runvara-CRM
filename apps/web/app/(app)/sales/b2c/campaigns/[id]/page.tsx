'use client';

import { Alert, Badge, Button, ErrorState, Field, Input, Skeleton, Switch, useToast } from '@flexa/ui';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { CAMPAIGN_TONE, useAddCoupon, useAudience, useCampaign, useCampaignAction, useSendCampaign, useToggleCoupon, type Campaign } from '../../../../../../lib/campaigns';
import { errorText } from '../../../../../../lib/catalog';
import { dateTime, formatDate } from '../../../../../../lib/format';
import { t, tOptional } from '../../../../../../lib/i18n';
import { PageContainer } from '../../../../../_components/app-shell';

// One campaign (B2C-04/06): approval, who it reaches and why not, the message, its coupons.

const day = (d: string): string => formatDate(`${d}T12:00:00`);
const reason = (r: string): string => tOptional(`campaign.reason.${r}`) ?? r;

export default function CampaignPage() {
  const { id } = useParams<{ id: string }>();
  const q = useCampaign(id);
  return (
    <PageContainer>
      {q.isError ? <ErrorState title={errorText(q.error)} retryLabel={t('common.retry')} onRetry={() => { void q.refetch(); }} />
        : !q.data ? <Skeleton className="h-64 w-full" /> : <Body c={q.data} />}
    </PageContainer>
  );
}

function Body({ c }: { c: Campaign }) {
  const act = useCampaignAction(c.id);
  const send = useSendCampaign(c.id);
  const audience = useAudience(c.id, c.message !== null);
  const { toast } = useToast();
  const [error, setError] = useState<string | null>(null);
  const run = (a: 'submit' | 'approve' | 'reject' | 'cancel'): void => {
    setError(null);
    act.mutateAsync(a).then(() => { toast({ kind: 'success', title: t(`campaign.done.${a}`) }); }, (e: unknown) => { setError(errorText(e)); });
  };
  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="m-0 flex-1 font-display text-xl font-bold">{c.name}</h1>
        <Badge tone={CAMPAIGN_TONE[c.status]} data-testid="campaign-status">{t(`campaign.status.${c.status}`)}</Badge>
      </div>
      <p className="m-0 text-sm text-fg-muted">
        {day(c.startsOn)} – {day(c.endsOn)} · {c.discountPercent !== '0' ? t('campaign.discountIs', { percent: c.discountPercent }) : t('campaign.noDiscount')}
        {c.exclusive ? ` · ${t('campaign.exclusive')}` : ''} · {c.createdBy.displayName}{c.approvedBy ? ` · ${t('campaign.approvedBy', { name: c.approvedBy.displayName })}` : ''}
      </p>
      <p className="m-0 text-sm">
        {t('campaign.target')}: {[...c.audienceTags.map((x) => `#${x}`), ...c.audienceRfm.map((s) => t(`rfm.segment.${s}`))].join(', ') || t('campaign.everyone')}
      </p>
      {error ? <Alert kind="error">{error}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        {c.canSubmit ? <Button size="sm" onClick={() => { run('submit'); }} loading={act.isPending} data-testid="campaign-submit">{t('campaign.submit')}</Button> : null}
        {c.canApprove ? <Button size="sm" onClick={() => { run('approve'); }} loading={act.isPending} data-testid="campaign-approve">{t('campaign.approve')}</Button> : null}
        {c.canApprove ? <Button size="sm" variant="secondary" onClick={() => { run('reject'); }} loading={act.isPending}>{t('campaign.reject')}</Button> : null}
        {['draft', 'pending_approval', 'active'].includes(c.status) && (c.canEdit || c.canSend || c.canApprove) ? <Button size="sm" variant="ghost" onClick={() => { run('cancel'); }}>{t('campaign.cancel')}</Button> : null}
      </div>
      {c.message ? (
        <section className="rounded-card border border-line bg-surface p-4" aria-labelledby="cm-title" data-testid="campaign-message">
          <h2 id="cm-title" className="m-0 mb-1 text-base font-semibold">{t('campaign.message')}</h2>
          <p className="m-0 font-medium">{c.message.subject}</p>
          <p className="m-0 mt-1 whitespace-pre-line text-sm">{c.message.body}</p>
          <div className="mt-3 rounded-card bg-subtle p-3 text-sm" data-testid="campaign-audience">
            {c.sentAt ? (
              <p className="m-0">{t('campaign.sentAt', { when: dateTime(c.sentAt), sent: String(c.deliveries.sent) })}{Object.entries(c.deliveries.blocked).map(([r, n]) => ` · ${reason(r)}: ${String(n)}`).join('')}</p>
            ) : audience.data ? (
              <p className="m-0">{t('campaign.reach', { total: String(audience.data.total), reachable: String(audience.data.reachable) })}{Object.entries(audience.data.blocked).map(([r, n]) => ` · ${reason(r)}: ${String(n)}`).join('')}</p>
            ) : <Skeleton className="h-5 w-64" />}
          </div>
          {c.canSend ? (
            <Button className="mt-3" size="sm" loading={send.isPending} data-testid="campaign-send"
              onClick={() => { send.mutateAsync().then((r) => { toast({ kind: 'success', title: t('campaign.sentToast', { sent: String(r.sent) }) }); }, (e: unknown) => { setError(errorText(e)); }); }}>
              {t('campaign.send')}
            </Button>
          ) : null}
        </section>
      ) : null}
      <Coupons c={c} />
    </div>
  );
}

function Coupons({ c }: { c: Campaign }) {
  const add = useAddCoupon(c.id);
  const toggle = useToggleCoupon(c.id);
  const { toast } = useToast();
  const [code, setCode] = useState('');
  const [percent, setPercent] = useState('10');
  const [max, setMax] = useState('');
  const [error, setError] = useState<string | null>(null);
  const writable = c.canEdit || c.canSend || c.status === 'active';
  const valid = /^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/.test(code.trim()) && /^\d{1,3}(\.\d{1,3})?$/.test(percent) && Number(percent) > 0 && Number(percent) <= 100 && (max === '' || /^\d+$/.test(max));
  return (
    <section className="rounded-card border border-line bg-surface p-4" aria-labelledby="cc-title">
      <h2 id="cc-title" className="m-0 mb-2 text-base font-semibold">{t('coupon.title')}</h2>
      {c.coupons.length === 0 ? <p className="m-0 text-sm text-fg-muted">{t('coupon.none')}</p> : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm" data-testid="coupon-list">
          {c.coupons.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-2">
              <span className="font-mono font-semibold">{k.code}</span>
              <span>%{k.discountPercent}</span>
              <span className="flex-1 text-fg-muted">{t('coupon.uses', { uses: String(k.uses), max: k.maxUses === null ? '∞' : String(k.maxUses) })}</span>
              <label className="inline-flex items-center gap-2"><Switch checked={k.active} onCheckedChange={(v) => { toggle.mutate({ id: k.id, active: v }); }} aria-label={t('coupon.activeOf', { code: k.code })} /></label>
            </li>
          ))}
        </ul>
      )}
      {writable && c.status !== 'cancelled' && c.status !== 'ended' ? (
        <form method="post" className="mt-3 grid items-end gap-2 sm:grid-cols-4" onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          add.mutateAsync({ code: code.trim(), discountPercent: percent, maxUses: max === '' ? null : Number(max) }).then(() => { toast({ kind: 'success', title: t('coupon.added') }); setCode(''); }, (x: unknown) => { setError(errorText(x)); });
        }}>
          <Field label={t('coupon.code')}><Input value={code} maxLength={40} onChange={(e) => { setCode(e.target.value.toUpperCase()); }} data-testid="coupon-code" /></Field>
          <Field label={t('coupon.percent')}><Input inputMode="decimal" value={percent} onChange={(e) => { setPercent(e.target.value); }} /></Field>
          <Field label={t('coupon.maxUses')}><Input inputMode="numeric" value={max} onChange={(e) => { setMax(e.target.value); }} /></Field>
          <Button type="submit" size="sm" disabled={!valid} loading={add.isPending} data-testid="coupon-add">{t('coupon.add')}</Button>
          {error ? <div className="sm:col-span-4"><Alert kind="error">{error}</Alert></div> : null}
        </form>
      ) : null}
    </section>
  );
}
