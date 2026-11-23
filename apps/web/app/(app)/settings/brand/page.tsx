'use client';

import tokens from '@flexa/ui/tokens.json';
import { Alert, Badge, Button, ErrorState, Field, Input, Skeleton, useToast } from '@flexa/ui';
import { Check, ImageUp, RotateCcw, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ApiError } from '../../../../lib/api';
import { useApp } from '../../../../lib/app-context';
import { previewConfig, uploadLogo, useConfigLayer, useEffectiveConfig, useLogoUrl, type Brand, type ConfigLayer, type ConfigPreview } from '../../../../lib/config';
import { messageForCode } from '../../../../lib/errors';
import { t } from '../../../../lib/i18n';
import { PageContainer } from '../../../_components/app-shell';
import { SaveConfigDialog, type PendingChange } from '../_parts/config-parts';
import { ReadOnlyNotice, SettingsGate, SettingsHeader } from '../_parts/settings-nav';

const HEX = /^#[0-9A-Fa-f]{6}$/;
const DEFAULT_ACCENT = tokens.color.light.accent;
const LOGO_MAX = 524288;
const LOGO_TYPES = ['image/png', 'image/webp', 'image/svg+xml'];
type Theme = 'light' | 'dark';
type Derivation = NonNullable<ConfigPreview['brand']>;

export default function BrandSettingsPage() {
  return (
    <PageContainer>
      <SettingsGate anyOf={['tenant.config.read']}>
        <BrandScreen />
      </SettingsGate>
    </PageContainer>
  );
}

function BrandScreen() {
  const layer = useConfigLayer('brand', 'tenant');
  const header = <SettingsHeader title={t('config.brand.title')} lead={t('config.brand.lead')} />;
  if (layer.isError) return <>{header}<ErrorState title={t('error.fallback')} retryLabel={t('common.retry')} onRetry={() => void layer.refetch()} /></>;
  if (!layer.data) return <>{header}<Skeleton className="h-72 w-full" /></>;
  return <>{header}<BrandForm key={layer.data.version} layer={layer.data} /></>;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Overrides kept at the tenant layer: only what differs from the platform default (both null). */
function brandValue(accent: string | null, logoAssetId: string | null): Record<string, unknown> {
  return { ...(accent ? { accent: accent.toUpperCase() } : {}), ...(logoAssetId ? { logoAssetId } : {}) };
}

function BrandForm({ layer }: { layer: ConfigLayer }) {
  const { can } = useApp();
  const toast = useToast();
  const readOnly = !can('tenant.config.manage');
  const savedAccent = str(layer.effective.accent);
  const logoId = str(layer.effective.logoAssetId);
  const [hex, setHex] = useState(savedAccent ?? DEFAULT_ACCENT);
  const [derivation, setDerivation] = useState<Derivation | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [review, setReview] = useState<PendingChange[] | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const effective = useEffectiveConfig();
  const logoUrl = useLogoUrl(effective.data?.brand.logo?.assetId ?? null);

  const valid = HEX.test(hex);
  useEffect(() => {
    if (!valid) return;
    let live = true;
    const timer = window.setTimeout(() => {
      previewConfig('brand', 'tenant', brandValue(hex, logoId))
        .then((p) => { if (live) { setDerivation(p.brand); setPreviewError(null); } })
        .catch((e: unknown) => { if (live) setPreviewError(e instanceof ApiError ? messageForCode(e.code) : t('error.fallback')); });
    }, 250);
    return () => { live = false; window.clearTimeout(timer); };
  }, [hex, valid, logoId]);

  const shown = valid ? derivation : null;
  const accentChanged = valid && hex.toUpperCase() !== (savedAccent ?? DEFAULT_ACCENT).toUpperCase();
  const change = (accent: string | null, logo: string | null): PendingChange[] => [{ key: 'brand', scope: 'tenant', value: brandValue(accent && accent.toUpperCase() !== DEFAULT_ACCENT ? accent : null, logo), version: layer.version }];

  async function onFile(file: File | undefined): Promise<void> {
    setLogoError(null);
    if (!file) return;
    if (!LOGO_TYPES.includes(file.type)) {
      setLogoError(t('config.brand.logoType'));
      return;
    }
    if (file.size > LOGO_MAX) {
      setLogoError(t('config.brand.logoSize'));
      return;
    }
    setUploading(true);
    try {
      const up = await uploadLogo(file);
      setReview(change(savedAccent, up.assetId));
    } catch (e) {
      setLogoError(e instanceof ApiError ? messageForCode(e.code) : t('error.fallback'));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div className="flex flex-col gap-6" data-testid="brand-form">
      {readOnly ? <ReadOnlyNotice /> : null}

      <section className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4" aria-labelledby="b-accent">
        <div>
          <h2 id="b-accent" className="m-0 text-base font-semibold">{t('config.brand.accent')}</h2>
          <p className="m-0 mt-1 text-sm text-fg-muted">{t('config.brand.accentHint')}</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('config.brand.picker')}>
            <input
              type="color"
              value={valid ? hex.toLowerCase() : DEFAULT_ACCENT.toLowerCase()}
              onChange={(e) => { setHex(e.target.value.toUpperCase()); }}
              disabled={readOnly}
              className="h-9 w-14 cursor-pointer rounded-input border border-line-strong bg-surface p-0.5 disabled:cursor-not-allowed"
              data-testid="brand-picker"
            />
          </Field>
          <Field label={t('config.brand.hex')} error={valid ? null : t('config.brand.hexInvalid')}>
            <Input value={hex} maxLength={7} onChange={(e) => { setHex(e.target.value.trim()); }} disabled={readOnly} className="w-32 font-mono" data-testid="brand-hex" />
          </Field>
          {!readOnly && savedAccent ? (
            <Button variant="ghost" icon={<RotateCcw aria-hidden size={14} />} onClick={() => { setHex(DEFAULT_ACCENT); }}>{t('config.brand.reset')}</Button>
          ) : null}
        </div>

        {previewError ? <Alert kind="error">{previewError}</Alert> : null}
        {shown && !shown.ok ? <Alert kind="error">{t('config.brand.unsatisfiable')}</Alert> : null}
        {shown?.ok && shown.adjusted ? <Alert kind="info">{t('config.brand.adjusted')}</Alert> : null}

        {shown?.tokens ? (
          <div className="grid gap-3 md:grid-cols-2" data-testid="brand-preview">
            <Swatches input={shown.input} tokens={shown.tokens} />
            <div className="grid gap-3 sm:grid-cols-2 md:col-span-2">
              <Sample theme="light" tokens={shown.tokens} />
              <Sample theme="dark" tokens={shown.tokens} />
            </div>
          </div>
        ) : null}
        {shown ? <Checks derivation={shown} /> : null}

        {readOnly ? null : (
          <div className="flex justify-end">
            <Button onClick={() => { setReview(change(hex, logoId)); }} disabled={!accentChanged || !shown?.ok} data-testid="brand-save">
              {t('config.review.open')}
            </Button>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4" aria-labelledby="b-logo">
        <div>
          <h2 id="b-logo" className="m-0 text-base font-semibold">{t('config.brand.logo')}</h2>
          <p className="m-0 mt-1 text-sm text-fg-muted">{t('config.brand.logoHint')}</p>
        </div>
        {logoError ? <Alert kind="error">{logoError}</Alert> : null}
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex h-16 w-40 items-center justify-center rounded-input border border-dashed border-line-strong bg-canvas p-2">
            {logoUrl ? <img src={logoUrl} alt={t('config.brand.logoAlt')} className="size-full object-contain" data-testid="brand-logo" /> : <span className="text-xs text-fg-muted">{t('config.brand.noLogo')}</span>}
          </div>
          {readOnly ? null : (
            <div className="flex flex-wrap gap-2">
              <input ref={fileRef} type="file" accept={LOGO_TYPES.join(',')} className="sr-only" id="logo-file" aria-label={t('config.brand.upload')} tabIndex={-1} onChange={(e) => void onFile(e.target.files?.[0])} data-testid="logo-file" />
              <Button variant="secondary" icon={<ImageUp aria-hidden size={14} />} onClick={() => fileRef.current?.click()} disabled={uploading}>
                {uploading ? t('common.pending') : t('config.brand.upload')}
              </Button>
              {logoId ? (
                <Button variant="ghost" icon={<Trash2 aria-hidden size={14} />} onClick={() => { setReview(change(savedAccent, null)); }}>{t('config.brand.removeLogo')}</Button>
              ) : null}
            </div>
          )}
        </div>
      </section>

      {review ? (
        <SaveConfigDialog
          changes={review}
          onClose={() => { setReview(null); }}
          onSaved={() => { setReview(null); toast.toast({ kind: 'success', title: t('config.saved') }); }}
        />
      ) : null}
    </div>
  );
}

function Swatches({ input, tokens: derived }: { input: string; tokens: Brand }) {
  const items: { label: string; color: string; testId: string }[] = [
    { label: t('config.brand.original'), color: input, testId: 'swatch-original' },
    { label: t('config.brand.lightAccent'), color: derived.light.accent, testId: 'swatch-light' },
    { label: t('config.brand.darkAccent'), color: derived.dark.accent, testId: 'swatch-dark' },
    { label: t('config.brand.button'), color: derived.light['accent-btn'], testId: 'swatch-button' },
  ];
  return (
    <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-4 md:col-span-2">
      {items.map((s) => (
        <li key={s.testId} className="flex items-center gap-2 rounded-input border border-line p-2">
          <span aria-hidden className="size-8 shrink-0 rounded-input border border-line" style={{ backgroundColor: s.color }} />
          <span className="min-w-0 text-xs">
            <span className="block font-medium">{s.label}</span>
            <span className="font-mono text-fg-muted" data-testid={s.testId}>{s.color}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A small piece of the app in one theme, painted with the derived tokens (CSS variables on the wrapper). */
function Sample({ theme, tokens: derived }: { theme: Theme; tokens: Brand }) {
  const palette: Record<string, string> = { ...tokens.color[theme], ...derived[theme] };
  const style = Object.fromEntries(Object.entries(palette).map(([k, v]) => [`--${k}`, v])) as CSSProperties;
  return (
    <div style={style} className="flex flex-col gap-3 rounded-card border border-line bg-canvas p-3 text-fg" data-testid={`brand-sample-${theme}`}>
      <p className="m-0 text-xs font-semibold uppercase tracking-wide text-fg-muted">{theme === 'light' ? t('config.brand.lightTheme') : t('config.brand.darkTheme')}</p>
      <div className="flex flex-col gap-2 rounded-input bg-surface p-3">
        <span className="text-sm">
          {t('config.brand.sampleText')} <span className="font-medium text-accent underline">{t('config.brand.sampleLink')}</span>
        </span>
        <span className="rounded-input bg-accent-soft px-2 py-1 text-sm text-accent">{t('config.brand.sampleSelected')}</span>
        <span className="inline-flex w-fit items-center rounded-btn bg-accent-btn px-3 py-1.5 text-sm font-semibold text-on-accent">{t('config.brand.sampleButton')}</span>
      </div>
    </div>
  );
}

function Checks({ derivation }: { derivation: Derivation }) {
  return (
    <details className="rounded-input border border-line">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
        {t('config.brand.checks')}{' '}
        <Badge tone={derivation.checks.every((c) => c.pass) ? 'success' : 'danger'}>
          {`${String(derivation.checks.filter((c) => c.pass).length)}/${String(derivation.checks.length)}`}
        </Badge>
      </summary>
      <table className="w-full text-sm" data-testid="brand-checks">
        <thead>
          <tr className="text-left text-fg-muted">
            <th scope="col" className="px-3 py-1 font-medium">{t('config.brand.theme')}</th>
            <th scope="col" className="px-3 py-1 font-medium">{t('config.brand.pair')}</th>
            <th scope="col" className="px-3 py-1 text-right font-medium">{t('config.brand.ratio')}</th>
            <th scope="col" className="px-3 py-1 font-medium"><span className="sr-only">{t('config.brand.result')}</span></th>
          </tr>
        </thead>
        <tbody>
          {derivation.checks.map((c, i) => (
            <tr key={`${c.theme}${c.fg}${c.bg}${String(i)}`} className="border-t border-line">
              <td className="px-3 py-1.5">{c.theme === 'light' ? t('config.brand.lightTheme') : t('config.brand.darkTheme')}</td>
              <td className="px-3 py-1.5 font-mono text-xs">{`${c.fg} / ${c.bg}`}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{`${c.ratio.toFixed(2)} : 1 (≥ ${String(c.min)})`}</td>
              <td className="px-3 py-1.5">
                {c.pass ? <Check aria-label={t('config.brand.pass')} size={14} className="text-success" /> : <X aria-label={t('config.brand.fail')} size={14} className="text-danger" />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
