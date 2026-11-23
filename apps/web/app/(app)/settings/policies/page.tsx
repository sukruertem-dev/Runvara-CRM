'use client';

import { Alert, Button, Checkbox, ErrorState, Field, Input, Select, Skeleton, useToast } from '@flexa/ui';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useApp } from '../../../../lib/app-context';
import { useConfigKeys, useConfigLayer, type ConfigLayer } from '../../../../lib/config';
import { t } from '../../../../lib/i18n';
import { useSsoProviders } from '../../../../lib/security';
import { PageContainer } from '../../../_components/app-shell';
import { overridesOf, sameJson, SaveConfigDialog, type PendingChange } from '../_parts/config-parts';
import { ReadOnlyNotice, SettingsGate, SettingsHeader } from '../_parts/settings-nav';

// Settings → Security policies (TEN-04, docs/p7-plan.md §18, §21): one versioned `security` key.

interface Policy {
  mfa: { require: 'off' | 'admins' | 'all'; ssoSatisfies: boolean };
  password: { minLength: number; requireMixed: boolean; maxAgeDays: number };
  session: { idleMinutes: number; maxHours: number };
  sso: { required: boolean; adminPasswordFallback: boolean };
}
type Group = keyof Policy;
const GROUPS: readonly Group[] = ['mfa', 'password', 'session', 'sso'];

export default function PoliciesPage() {
  return (
    <PageContainer>
      <SettingsGate anyOf={['tenant.config.read']}>
        <Policies />
      </SettingsGate>
    </PageContainer>
  );
}

function Policies() {
  const { can } = useApp();
  const layer = useConfigLayer('security', 'tenant');
  const keys = useConfigKeys();
  const providers = useSsoProviders(can('tenant.config.manage'));
  const header = <SettingsHeader title={t('policy.title')} lead={t('policy.lead')} />;
  if (layer.isError || keys.isError) return <>{header}<ErrorState title={t('error.fallback')} retryLabel={t('common.retry')} onRetry={() => { void layer.refetch(); void keys.refetch(); }} /></>;
  if (!layer.data || !keys.data) return <>{header}<Skeleton className="h-64 w-full" /></>;
  const defaults = (keys.data.data.find((k) => k.key === 'security')?.default ?? {}) as unknown as Policy;
  const enabledProviders = providers.data ? providers.data.filter((p) => p.enabled).length : null;
  return <>{header}<PolicyForm key={layer.data.version} layer={layer.data} defaults={defaults} enabledProviders={enabledProviders} /></>;
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4" aria-labelledby={id}>
      <h2 id={id} className="m-0 text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Check({ checked, onChange, label, testId }: { checked: boolean; onChange: (v: boolean) => void; label: string; testId?: string }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <Checkbox checked={checked} onCheckedChange={(v) => { onChange(v === true); }} data-testid={testId} />
      {label}
    </label>
  );
}

function PolicyForm({ layer, defaults, enabledProviders }: { layer: ConfigLayer; defaults: Policy; enabledProviders: number | null }) {
  const { can, me } = useApp();
  const toast = useToast();
  const readOnly = !can('tenant.config.manage');
  const [draft, setDraft] = useState<Policy>(() => layer.effective as unknown as Policy);
  const [review, setReview] = useState<PendingChange[] | null>(null);

  const set = <G extends Group>(group: G, patch: Partial<Policy[G]>) => { setDraft((d) => ({ ...d, [group]: { ...d[group], ...patch } })); };
  const num = (v: string): number => (v.trim() === '' ? Number.NaN : Number(v));

  // A layer stores whole groups: the groups that differ from the platform default.
  const value = overridesOf(draft as unknown as Record<string, unknown>, defaults as unknown as Record<string, unknown>);
  const changed = !sameJson(value, layer.value);
  const warnings: string[] = [];
  if (draft.mfa.require !== 'off' && !me.user.mfaEnabled) warnings.push(t('policy.warn.selfMfa'));
  if (draft.sso.required && enabledProviders === 0) warnings.push(t('policy.warn.noProvider'));

  return (
    <form method="post" onSubmit={(e) => { e.preventDefault(); setReview([{ key: 'security', scope: 'tenant', value, version: layer.version }]); }} data-testid="policy-form">
      {readOnly ? <ReadOnlyNotice /> : null}
      <fieldset disabled={readOnly} className="m-0 flex flex-col gap-6 border-0 p-0">
        <Section id="p-mfa" title={t('policy.mfa.title')}>
          <Field label={t('policy.mfa.require')}>
            <Select
              value={draft.mfa.require}
              disabled={readOnly}
              onValueChange={(v) => { set('mfa', { require: v as Policy['mfa']['require'] }); }}
              options={(['off', 'admins', 'all'] as const).map((v) => ({ value: v, label: t(`config.value.${v}`) }))}
            />
          </Field>
          <Check checked={draft.mfa.ssoSatisfies} onChange={(v) => { set('mfa', { ssoSatisfies: v }); }} label={t('policy.mfa.ssoSatisfies')} />
        </Section>

        <Section id="p-password" title={t('policy.password.title')}>
          <p className="m-0 text-sm text-fg-muted">{t('policy.password.hint')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('policy.password.minLength')}>
              <Input type="number" inputMode="numeric" min={12} max={64} value={Number.isNaN(draft.password.minLength) ? '' : String(draft.password.minLength)} onChange={(e) => { set('password', { minLength: num(e.target.value) }); }} data-testid="policy-min-length" />
            </Field>
            <Field label={t('policy.password.maxAgeDays')}>
              <Input type="number" inputMode="numeric" min={0} max={365} value={Number.isNaN(draft.password.maxAgeDays) ? '' : String(draft.password.maxAgeDays)} onChange={(e) => { set('password', { maxAgeDays: num(e.target.value) }); }} />
            </Field>
          </div>
          <Check checked={draft.password.requireMixed} onChange={(v) => { set('password', { requireMixed: v }); }} label={t('policy.password.requireMixed')} />
        </Section>

        <Section id="p-session" title={t('policy.session.title')}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('policy.session.idleMinutes')}>
              <Input type="number" inputMode="numeric" min={15} max={43_200} value={Number.isNaN(draft.session.idleMinutes) ? '' : String(draft.session.idleMinutes)} onChange={(e) => { set('session', { idleMinutes: num(e.target.value) }); }} />
            </Field>
            <Field label={t('policy.session.maxHours')}>
              <Input type="number" inputMode="numeric" min={1} max={720} value={Number.isNaN(draft.session.maxHours) ? '' : String(draft.session.maxHours)} onChange={(e) => { set('session', { maxHours: num(e.target.value) }); }} />
            </Field>
          </div>
        </Section>

        <Section id="p-sso" title={t('policy.sso.title')}>
          <Check checked={draft.sso.required} onChange={(v) => { set('sso', { required: v }); }} label={t('policy.sso.required')} testId="policy-sso-required" />
          <Check checked={draft.sso.adminPasswordFallback} onChange={(v) => { set('sso', { adminPasswordFallback: v }); }} label={t('policy.sso.adminPasswordFallback')} />
          <p className="m-0 flex flex-wrap items-center gap-3 text-sm text-fg-muted">
            {enabledProviders === null ? null : <span>{t('policy.sso.providers', { count: String(enabledProviders) })}</span>}
            <Link href="/settings/sso">{t('policy.sso.manage')}</Link>
          </p>
        </Section>
      </fieldset>

      {warnings.length > 0 && !readOnly ? (
        <div className="mt-4" data-testid="policy-warnings">
          <Alert kind="warning">
            <strong>{t('policy.warn.title')}</strong>
            <ul className="m-0 pl-4">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            {draft.mfa.require !== 'off' && !me.user.mfaEnabled ? <Link href="/settings/security">{t('policy.goSecurity')}</Link> : null}
          </Alert>
        </div>
      ) : null}

      {readOnly ? null : (
        <div className="mt-6 flex justify-end">
          <Button type="submit" disabled={!changed || warnings.length > 0 || GROUPS.some((g) => Object.values(draft[g]).some((v) => typeof v === 'number' && Number.isNaN(v)))} data-testid="policy-save">
            {t('policy.review')}
          </Button>
        </div>
      )}

      {review ? (
        <SaveConfigDialog
          changes={review}
          onClose={() => { setReview(null); }}
          onSaved={() => { setReview(null); toast.toast({ kind: 'success', title: t('policy.saved') }); }}
        />
      ) : null}
    </form>
  );
}
