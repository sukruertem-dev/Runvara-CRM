'use client';

import { Button, ErrorState, Field, Input, Skeleton, Textarea, useToast } from '@flexa/ui';
import { useState } from 'react';
import { useApp } from '../../../../lib/app-context';
import { useConfigKeys, useConfigLayer, type ConfigLayer } from '../../../../lib/config';
import { t } from '../../../../lib/i18n';
import { PageContainer } from '../../../_components/app-shell';
import { overridesOf, sameJson, SaveConfigDialog, type PendingChange } from '../_parts/config-parts';
import { ReadOnlyNotice, SettingsGate, SettingsHeader } from '../_parts/settings-nav';

// Settings → Quote template (docs/p9-plan.md §4): the versioned `sales_b2b.quote_template` key.

const KEY = 'sales_b2b.quote_template';
interface Template { prefix: string; validDays: number; intro: string; terms: string; footer: string }

export default function QuoteTemplatePage() {
  return (
    <PageContainer>
      <SettingsGate anyOf={['tenant.config.read']} module="sales_b2b"><TemplatePage /></SettingsGate>
    </PageContainer>
  );
}

function TemplatePage() {
  const layer = useConfigLayer(KEY, 'tenant');
  const keys = useConfigKeys();
  const header = <SettingsHeader title={t('settings.quotes')} lead={t('quote.lead')} />;
  if (layer.isError || keys.isError) return <>{header}<ErrorState title={t('error.fallback')} retryLabel={t('common.retry')} onRetry={() => { void layer.refetch(); void keys.refetch(); }} /></>;
  if (!layer.data || !keys.data) return <>{header}<Skeleton className="h-48 w-full" /></>;
  return <>{header}<TemplateForm key={layer.data.version} layer={layer.data} defaults={keys.data.data.find((k) => k.key === KEY)?.default ?? {}} /></>;
}

function TemplateForm({ layer, defaults }: { layer: ConfigLayer; defaults: Record<string, unknown> }) {
  const { can } = useApp();
  const { toast } = useToast();
  const readOnly = !can('tenant.config.manage');
  const [draft, setDraft] = useState<Template>(() => layer.effective as unknown as Template);
  const [review, setReview] = useState<PendingChange[] | null>(null);
  const value = overridesOf({ ...draft }, defaults);
  const valid = /^[A-Z0-9]{1,10}$/.test(draft.prefix) && Number.isInteger(draft.validDays) && draft.validDays >= 1 && draft.validDays <= 365;
  const set = (patch: Partial<Template>): void => { setDraft((d) => ({ ...d, ...patch })); };
  return (
    <form method="post" onSubmit={(e) => { e.preventDefault(); setReview([{ key: KEY, scope: 'tenant', value, version: layer.version }]); }} className="rounded-card border border-line bg-surface p-4" data-testid="qtpl-form">
      {readOnly ? <ReadOnlyNotice /> : null}
      <fieldset disabled={readOnly} className="m-0 flex flex-col gap-3 border-0 p-0">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('quote.prefix')} hint={t('quote.prefixHint')}><Input value={draft.prefix} maxLength={10} onChange={(e) => { set({ prefix: e.target.value }); }} data-testid="qtpl-prefix" /></Field>
          <Field label={t('quote.validDays')}><Input type="number" min={1} max={365} value={Number.isNaN(draft.validDays) ? '' : String(draft.validDays)} onChange={(e) => { set({ validDays: e.target.value.trim() === '' ? Number.NaN : Number(e.target.value) }); }} data-testid="qtpl-days" /></Field>
        </div>
        <Field label={t('quote.intro')}><Textarea value={draft.intro} maxLength={4000} rows={3} onChange={(e) => { set({ intro: e.target.value }); }} /></Field>
        <Field label={t('quote.terms')}><Textarea value={draft.terms} maxLength={8000} rows={5} onChange={(e) => { set({ terms: e.target.value }); }} /></Field>
        <Field label={t('quote.footer')}><Input value={draft.footer} maxLength={300} onChange={(e) => { set({ footer: e.target.value }); }} /></Field>
      </fieldset>
      {readOnly ? null : <div className="mt-4 flex justify-end"><Button type="submit" disabled={!valid || sameJson(value, layer.value)} data-testid="qtpl-save">{t('policy.review')}</Button></div>}
      {review ? <SaveConfigDialog changes={review} onClose={() => { setReview(null); }} onSaved={() => { setReview(null); toast({ kind: 'success', title: t('quote.templateSaved') }); }} /> : null}
    </form>
  );
}
