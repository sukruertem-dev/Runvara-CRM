'use client';

import { Alert, Badge, Button, Checkbox, Dialog, DialogContent, DialogFooter, EmptyState, ErrorState, Field, Input, Skeleton, Switch, Textarea } from '@flexa/ui';
import { Megaphone } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useApp } from '../../../../../lib/app-context';
import { CAMPAIGN_TONE, RFM_SEGMENTS, useCampaigns, useCreateCampaign } from '../../../../../lib/campaigns';
import { errorText } from '../../../../../lib/catalog';
import { formatDate } from '../../../../../lib/format';
import { t } from '../../../../../lib/i18n';
import { PageContainer } from '../../../../_components/app-shell';

// B2C campaigns (B2C-04, docs/p9-plan.md §47): dates, discount and conflict rule, target, message.

const day = (d: string): string => formatDate(`${d}T12:00:00`);

export default function CampaignsPage() {
  const { can } = useApp();
  const list = useCampaigns();
  const rows = list.data?.data ?? [];
  return (
    <PageContainer>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="m-0 flex-1 font-display text-xl font-bold">{t('campaign.title')}</h1>
        <Button asChild variant="secondary" size="sm"><Link href="/sales/b2c/rfm">{t('rfm.title')}</Link></Button>
        {can('sales_b2c.campaign.manage') ? <NewCampaign /> : null}
      </div>
      {list.isError ? <ErrorState title={errorText(list.error)} retryLabel={t('common.retry')} onRetry={() => { void list.refetch(); }} />
        : !list.data ? <Skeleton className="h-48 w-full" />
          : rows.length === 0 ? <EmptyState icon={Megaphone} title={t('campaign.empty')} description={t('campaign.emptyBody')} /> : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="campaign-list">
              {rows.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-3">
                  <div className="min-w-48 flex-1">
                    <p className="m-0 font-semibold"><Link href={`/sales/b2c/campaigns/${c.id}`}>{c.name}</Link></p>
                    <p className="m-0 mt-0.5 text-xs text-fg-muted">{day(c.startsOn)} – {day(c.endsOn)}{c.discountPercent !== '0' ? ` · %${c.discountPercent}` : ''}{c.exclusive ? ` · ${t('campaign.exclusive')}` : ''}</p>
                  </div>
                  <Badge tone={CAMPAIGN_TONE[c.status]}>{t(`campaign.status.${c.status}`)}</Badge>
                </li>
              ))}
            </ul>
          )}
    </PageContainer>
  );
}

function NewCampaign() {
  const create = useCreateCampaign();
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ name: '', startsOn: today, endsOn: today, discountPercent: '0', exclusive: false, tags: '', rfm: [] as string[], subject: '', body: '' });
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof v>): void => { setV((x) => ({ ...x, ...patch })); };
  const valid = v.name.trim() !== '' && v.startsOn !== '' && v.endsOn >= v.startsOn && /^\d{1,3}(\.\d{1,3})?$/.test(v.discountPercent) && Number(v.discountPercent) <= 100
    && (v.subject.trim() === '') === (v.body.trim() === '');
  function save(): void {
    setError(null);
    create.mutateAsync({
      name: v.name.trim(), startsOn: v.startsOn, endsOn: v.endsOn, discountPercent: v.discountPercent, exclusive: v.exclusive,
      audienceTags: v.tags.split(',').map((x) => x.trim()).filter(Boolean), audienceRfm: v.rfm as (typeof RFM_SEGMENTS)[number][],
      message: v.subject.trim() ? { subject: v.subject.trim(), body: v.body.trim() } : null,
    }).then((c) => { router.push(`/sales/b2c/campaigns/${c.id}`); }, (e: unknown) => { setError(errorText(e)); });
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" onClick={() => { setOpen(true); setError(null); }} data-testid="campaign-new">{t('campaign.new')}</Button>
      <DialogContent title={t('campaign.new')} closeLabel={t('common.close')}>
        <form method="post" className="flex flex-col gap-3" data-testid="campaign-dialog" onSubmit={(e) => { e.preventDefault(); save(); }}>
          {error ? <Alert kind="error">{error}</Alert> : null}
          <Field label={t('campaign.name')}><Input value={v.name} maxLength={200} onChange={(e) => { set({ name: e.target.value }); }} required autoFocus /></Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('campaign.startsOn')}><Input type="date" value={v.startsOn} onChange={(e) => { set({ startsOn: e.target.value }); }} required /></Field>
            <Field label={t('campaign.endsOn')}><Input type="date" value={v.endsOn} min={v.startsOn} onChange={(e) => { set({ endsOn: e.target.value }); }} required /></Field>
            <Field label={t('campaign.discount')}><Input inputMode="decimal" value={v.discountPercent} onChange={(e) => { set({ discountPercent: e.target.value }); }} /></Field>
          </div>
          <label className="inline-flex items-center gap-2 text-sm"><Switch checked={v.exclusive} onCheckedChange={(x) => { set({ exclusive: x }); }} aria-label={t('campaign.exclusiveLabel')} />{t('campaign.exclusiveLabel')}</label>
          <Field label={t('campaign.tags')} hint={t('campaign.tagsHint')}><Input value={v.tags} onChange={(e) => { set({ tags: e.target.value }); }} /></Field>
          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-1 text-sm font-medium">{t('campaign.rfm')}</legend>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {RFM_SEGMENTS.map((s) => (
                <label key={s} className="inline-flex items-center gap-2 text-sm">
                  <Checkbox checked={v.rfm.includes(s)} onCheckedChange={(x) => { set({ rfm: x === true ? [...v.rfm, s] : v.rfm.filter((y) => y !== s) }); }} />
                  {t(`rfm.segment.${s}`)}
                </label>
              ))}
            </div>
          </fieldset>
          <Field label={t('campaign.subject')}><Input value={v.subject} maxLength={200} onChange={(e) => { set({ subject: e.target.value }); }} /></Field>
          <Field label={t('campaign.body')} hint={t('campaign.bodyHint')}><Textarea value={v.body} maxLength={5000} rows={3} onChange={(e) => { set({ body: e.target.value }); }} /></Field>
          <DialogFooter>
            <Button type="submit" loading={create.isPending} disabled={!valid} data-testid="campaign-save">{t('settings.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
