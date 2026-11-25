'use client';

import { Button, Checkbox, Combobox, ErrorState, Field, Select, Skeleton, useToast } from '@flexa/ui';
import { useMemo, useState } from 'react';
import { useApp } from '../../../../lib/app-context';
import { useConfigKeys, useConfigLayer, type ConfigLayer } from '../../../../lib/config';
import { t, tOptional } from '../../../../lib/i18n';
import { PageContainer } from '../../../_components/app-shell';
import { overridesOf, sameJson, SaveConfigDialog, type PendingChange } from '../_parts/config-parts';
import { ReadOnlyNotice, SettingsGate, SettingsHeader } from '../_parts/settings-nav';

type Json = Record<string, unknown>;
const KEYS = ['locale', 'currency', 'ui', 'notifications.defaults', 'mentions'] as const;
type Key = (typeof KEYS)[number];
const KINDS = ['mention', 'assigned', 'automation', 'approval'] as const;
const CHANNELS = ['in_app', 'email'] as const;

function list(kind: 'timeZone' | 'currency', fallback: string[]): string[] {
  try {
    return Intl.supportedValuesOf(kind);
  } catch {
    return fallback;
  }
}

export default function GeneralSettingsPage() {
  return (
    <PageContainer>
      <SettingsGate anyOf={['tenant.config.read']}>
        <General />
      </SettingsGate>
    </PageContainer>
  );
}

function General() {
  const locale = useConfigLayer('locale', 'tenant');
  const currency = useConfigLayer('currency', 'tenant');
  const ui = useConfigLayer('ui', 'tenant');
  const notif = useConfigLayer('notifications.defaults', 'tenant');
  const mentions = useConfigLayer('mentions', 'tenant');
  const keys = useConfigKeys();
  const all = [locale, currency, ui, notif, mentions, keys];
  const header = <SettingsHeader title={t('config.general.title')} lead={t('config.general.lead')} />;
  if (all.some((q) => q.isError)) return <>{header}<ErrorState title={t('error.fallback')} retryLabel={t('common.retry')} onRetry={() => { for (const q of all) void q.refetch(); }} /></>;
  if (!locale.data || !currency.data || !ui.data || !notif.data || !mentions.data || !keys.data) return <>{header}<Skeleton className="h-64 w-full" /></>;
  const layers: Record<Key, ConfigLayer> = { locale: locale.data, currency: currency.data, ui: ui.data, 'notifications.defaults': notif.data, mentions: mentions.data };
  const defaults = Object.fromEntries(keys.data.data.map((k) => [k.key, k.default])) as Record<string, Json>;
  // Remount when someone saves (new versions): the form starts again from the stored values.
  const stamp = KEYS.map((k) => layers[k].version).join('.');
  return <>{header}<GeneralForm key={stamp} layers={layers} defaults={defaults} /></>;
}

function GeneralForm({ layers, defaults }: { layers: Record<Key, ConfigLayer>; defaults: Record<string, Json> }) {
  const { can } = useApp();
  const toast = useToast();
  const readOnly = !can('tenant.config.manage');
  const [draft, setDraft] = useState<Record<Key, Json>>(() => ({
    locale: layers.locale.effective,
    currency: layers.currency.effective,
    ui: layers.ui.effective,
    'notifications.defaults': layers['notifications.defaults'].effective,
    mentions: layers.mentions.effective,
  }));
  const [review, setReview] = useState<PendingChange[] | null>(null);
  const zones = useMemo(() => list('timeZone', ['Europe/Istanbul', 'UTC']).map((z) => ({ value: z, label: z.replaceAll('_', ' ') })), []);
  const currencies = useMemo(() => {
    const names = new Intl.DisplayNames([t('config.intlLocale')], { type: 'currency' });
    return list('currency', ['TRY', 'EUR', 'USD']).map((c) => ({ value: c, label: `${c} · ${names.of(c) ?? c}` }));
  }, []);

  const set = (key: Key, prop: string, value: unknown) => { setDraft((d) => ({ ...d, [key]: { ...d[key], [prop]: value } })); };
  const str = (key: Key, prop: string): string => {
    const v = draft[key][prop];
    return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
  };
  const changes: PendingChange[] = KEYS.flatMap((key) => {
    const value = overridesOf(draft[key], defaults[key] ?? {});
    return sameJson(value, layers[key].value) ? [] : [{ key, scope: 'tenant' as const, value, version: layers[key].version }];
  });
  const channels = (kind: string): string[] => {
    const v = draft['notifications.defaults'][kind];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  };
  const toggle = (kind: string, channel: string, on: boolean) => {
    const next = new Set(channels(kind));
    if (on) next.add(channel);
    else next.delete(channel);
    set('notifications.defaults', kind, CHANNELS.filter((c) => next.has(c)));
  };
  const opts = (values: readonly string[], prefix: string) => values.map((v) => ({ value: v, label: tOptional(`${prefix}.${v}`) ?? v }));

  return (
    <form method="post" onSubmit={(e) => { e.preventDefault(); setReview(changes); }} data-testid="general-form">
      {readOnly ? <ReadOnlyNotice /> : null}
      <fieldset disabled={readOnly} className="m-0 flex flex-col gap-6 border-0 p-0">
        <section className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4" aria-labelledby="g-locale">
          <h2 id="g-locale" className="m-0 text-base font-semibold">{t('config.key.locale')}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('config.prop.locale.language')}>
              <Select value={str('locale', 'language')} onValueChange={(v) => { set('locale', 'language', v); }} options={opts(['tr', 'en'], 'config.value')} disabled={readOnly} />
            </Field>
            <Field label={t('config.prop.locale.timezone')}>
              <Combobox value={str('locale', 'timezone')} onValueChange={(v) => { if (v) set('locale', 'timezone', v); }} options={zones} placeholder={t('config.prop.locale.timezone')} searchPlaceholder={t('config.searchZone')} emptyText={t('config.noMatch')} />
            </Field>
            <Field label={t('config.prop.locale.dateFormat')}>
              <Select value={str('locale', 'dateFormat')} onValueChange={(v) => { set('locale', 'dateFormat', v); }} options={opts(['dmy', 'mdy', 'ymd'], 'config.value')} disabled={readOnly} />
            </Field>
            <Field label={t('config.prop.locale.timeFormat')}>
              <Select value={str('locale', 'timeFormat')} onValueChange={(v) => { set('locale', 'timeFormat', v); }} options={opts(['24h', '12h'], 'config.value')} disabled={readOnly} />
            </Field>
            <Field label={t('config.prop.locale.weekStart')}>
              <Select value={str('locale', 'weekStart')} onValueChange={(v) => { set('locale', 'weekStart', v); }} options={opts(['monday', 'sunday'], 'config.value')} disabled={readOnly} />
            </Field>
          </div>
        </section>

        <section className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4" aria-labelledby="g-currency">
          <h2 id="g-currency" className="m-0 text-base font-semibold">{t('config.key.currency')}</h2>
          <p className="m-0 text-sm text-fg-muted">{t('config.currencyHint')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('config.prop.currency.code')}>
              <Combobox value={str('currency', 'code')} onValueChange={(v) => { if (v) set('currency', 'code', v); }} options={currencies} placeholder={t('config.prop.currency.code')} searchPlaceholder={t('config.searchCurrency')} emptyText={t('config.noMatch')} />
            </Field>
            <Field label={t('config.prop.currency.decimals')}>
              <Select value={str('currency', 'decimals')} onValueChange={(v) => { set('currency', 'decimals', Number(v)); }} options={['0', '1', '2', '3', '4'].map((v) => ({ value: v, label: v }))} disabled={readOnly} />
            </Field>
          </div>
        </section>

        <section className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4" aria-labelledby="g-ui">
          <h2 id="g-ui" className="m-0 text-base font-semibold">{t('config.key.ui')}</h2>
          <p className="m-0 text-sm text-fg-muted">{t('config.uiHint')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('config.prop.ui.theme')}>
              <Select value={str('ui', 'theme')} onValueChange={(v) => { set('ui', 'theme', v); }} options={opts(['system', 'light', 'dark'], 'config.value')} disabled={readOnly} />
            </Field>
            <Field label={t('config.prop.ui.density')}>
              <Select value={str('ui', 'density')} onValueChange={(v) => { set('ui', 'density', v); }} options={opts(['comfortable', 'compact'], 'config.value')} disabled={readOnly} />
            </Field>
          </div>
        </section>

        <section className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4" aria-labelledby="g-notif">
          <h2 id="g-notif" className="m-0 text-base font-semibold">{t('config.key.notifications.defaults')}</h2>
          <p className="m-0 text-sm text-fg-muted">{t('config.notifHint')}</p>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-fg-muted">
                <th scope="col" className="py-1 font-medium">{t('config.notifKind')}</th>
                {CHANNELS.map((c) => <th key={c} scope="col" className="py-1 font-medium">{t(`config.value.${c}`)}</th>)}
              </tr>
            </thead>
            <tbody>
              {KINDS.map((k) => (
                <tr key={k} className="border-t border-line">
                  <th scope="row" className="py-2 text-left font-normal">{t(`config.prop.notifications.defaults.${k}`)}</th>
                  {CHANNELS.map((c) => (
                    <td key={c} className="py-2">
                      <Checkbox
                        checked={channels(k).includes(c)}
                        onCheckedChange={(v) => { toggle(k, c, v === true); }}
                        aria-label={`${t(`config.prop.notifications.defaults.${k}`)}: ${t(`config.value.${c}`)}`}
                        disabled={readOnly}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4" aria-labelledby="g-mentions">
          <h2 id="g-mentions" className="m-0 text-base font-semibold">{t('config.key.mentions')}</h2>
          <p className="m-0 text-sm text-fg-muted">{t('config.mentions.hint')}</p>
          <label className="inline-flex items-center gap-2 text-sm">
            <Checkbox checked={draft.mentions.grantAccess === true} disabled={readOnly} onCheckedChange={(v) => { set('mentions', 'grantAccess', v === true); }} data-testid="mentions-grant" />
            {t('config.prop.mentions.grantAccess')}
          </label>
        </section>
      </fieldset>
      {readOnly ? null : (
        <div className="mt-5 flex justify-end gap-2">
          <Button type="submit" disabled={changes.length === 0} data-testid="general-save">{t('config.review.open')}</Button>
        </div>
      )}
      {review ? (
        <SaveConfigDialog
          changes={review}
          onClose={() => { setReview(null); }}
          onSaved={() => { setReview(null); toast.toast({ kind: 'success', title: t('config.saved') }); }}
        />
      ) : null}
    </form>
  );
}
