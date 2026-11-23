'use client';

import { Alert, Button, Combobox, ErrorState, Field, Select, Skeleton, useToast } from '@flexa/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { ApiError, request } from '../../../../lib/api';
import { ck, useConfigLayer, type ConfigLayer } from '../../../../lib/config';
import { messageForCode } from '../../../../lib/errors';
import { t, tOptional } from '../../../../lib/i18n';
import { PageContainer } from '../../../_components/app-shell';
import { SettingsHeader } from '../_parts/settings-nav';

// Personal preferences (docs/p7-plan.md §4–5): each field either follows the workspace default or overrides it.
// The user layer keeps only the overrides; "Workspace default" removes the property.

const INHERIT = '__inherit__';
type Json = Record<string, unknown>;
const FIELDS: readonly { key: 'locale' | 'ui'; prop: string; values: readonly string[] }[] = [
  { key: 'ui', prop: 'theme', values: ['system', 'light', 'dark'] },
  { key: 'ui', prop: 'density', values: ['comfortable', 'compact'] },
  { key: 'locale', prop: 'language', values: ['tr', 'en'] },
  { key: 'locale', prop: 'timezone', values: [] },
  { key: 'locale', prop: 'dateFormat', values: ['dmy', 'mdy', 'ymd'] },
  { key: 'locale', prop: 'timeFormat', values: ['24h', '12h'] },
  { key: 'locale', prop: 'weekStart', values: ['monday', 'sunday'] },
];

const label = (v: unknown): string => (typeof v === 'string' ? (tOptional(`config.value.${v}`) ?? v.replaceAll('_', ' ')) : '');

export default function PreferencesPage() {
  const ui = useConfigLayer('ui', 'user');
  const locale = useConfigLayer('locale', 'user');
  const header = <SettingsHeader title={t('prefs.title')} lead={t('prefs.lead')} />;
  return (
    <PageContainer>
      {header}
      {ui.isError || locale.isError ? (
        <ErrorState title={t('error.fallback')} retryLabel={t('common.retry')} onRetry={() => { void ui.refetch(); void locale.refetch(); }} />
      ) : !ui.data || !locale.data ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <PreferencesForm key={`${String(ui.data.version)}.${String(locale.data.version)}`} layers={{ ui: ui.data, locale: locale.data }} />
      )}
    </PageContainer>
  );
}

function PreferencesForm({ layers }: { layers: Record<'ui' | 'locale', ConfigLayer> }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Record<'ui' | 'locale', Json>>({ ui: layers.ui.value, locale: layers.locale.value });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const zones = useMemo(() => {
    try {
      return Intl.supportedValuesOf('timeZone');
    } catch {
      return ['Europe/Istanbul', 'UTC'];
    }
  }, []);

  /** What the field shows when it follows the workspace: the tenant/platform value under the user layer. */
  const inherited = (key: 'ui' | 'locale', prop: string): unknown => {
    const src = layers[key].sources[prop];
    return src === 'user' ? undefined : layers[key].effective[prop];
  };
  const set = (key: 'ui' | 'locale', prop: string, value: string) => {
    setDraft((d) => {
      const rest = Object.fromEntries(Object.entries(d[key]).filter(([k]) => k !== prop));
      return { ...d, [key]: value === INHERIT ? rest : { ...rest, [prop]: value } };
    });
  };
  const changed = (['ui', 'locale'] as const).filter((k) => JSON.stringify(draft[k]) !== JSON.stringify(layers[k].value));

  async function save(): Promise<void> {
    setError(null);
    setSaving(true);
    try {
      for (const key of changed) {
        await request(`/v1/config/${key}?scope=user`, { method: 'PUT', body: { value: draft[key] }, ifMatch: layers[key].version });
      }
      await qc.invalidateQueries({ queryKey: ck.all });
      toast.toast({ kind: 'success', title: t('config.saved') });
    } catch (e) {
      setError(e instanceof ApiError ? messageForCode(e.code) : t('error.fallback'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form method="post" onSubmit={(e) => { e.preventDefault(); void save(); }} className="flex flex-col gap-5" data-testid="prefs-form">
      {error ? <Alert kind="error">{error}</Alert> : null}
      <section className="grid gap-3 rounded-card border border-line bg-surface p-4 sm:grid-cols-2">
        {FIELDS.map((f) => {
          const own = draft[f.key][f.prop];
          const value = typeof own === 'string' ? own : INHERIT;
          const fallback = inherited(f.key, f.prop) ?? layers[f.key].effective[f.prop];
          const inheritLabel = t('prefs.inherit', { value: label(fallback) });
          const name = t(`config.prop.${f.key}.${f.prop}` as Parameters<typeof t>[0]);
          if (f.prop === 'timezone') {
            return (
              <Field key={f.prop} label={name}>
                <Combobox
                  value={value}
                  onValueChange={(v) => { set(f.key, f.prop, v ?? INHERIT); }}
                  options={[{ value: INHERIT, label: inheritLabel }, ...zones.map((z) => ({ value: z, label: z.replaceAll('_', ' ') }))]}
                  placeholder={name}
                  searchPlaceholder={t('config.searchZone')}
                  emptyText={t('config.noMatch')}
                />
              </Field>
            );
          }
          return (
            <Field key={f.prop} label={name}>
              <Select
                value={value}
                onValueChange={(v) => { set(f.key, f.prop, v); }}
                options={[{ value: INHERIT, label: inheritLabel }, ...f.values.map((v) => ({ value: v, label: label(v) }))]}
                data-testid={`pref-${f.prop}`}
              />
            </Field>
          );
        })}
      </section>
      <div className="flex justify-end">
        <Button type="submit" disabled={changed.length === 0 || saving} data-testid="prefs-save">{saving ? t('common.pending') : t('prefs.save')}</Button>
      </div>
    </form>
  );
}
