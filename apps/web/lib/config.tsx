'use client';

import type {
  BrandLogoView,
  BrandTokens,
  ConfigEffectiveResponse,
  ConfigHistoryResponse,
  ConfigKeysResponse,
  ConfigLayerView,
  ConfigPreviewResponse,
} from '@flexa/contracts';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import { ApiError, request, requestBlob } from './api';
import { setFormatPrefs } from './format';
import { LOCALE_STORAGE_KEY, setLocale, type Locale } from './i18n';
import { usePreferences, type DensityPref, type ThemePref } from './preferences';

// Layered configuration in the web app (docs/p7-plan.md §4–5): the effective values decide the UI language,
// date and number display, theme and density defaults and the tenant accent colors.

type Out<T extends { _output: unknown }> = T['_output'];

export type EffectiveConfig = Out<typeof ConfigEffectiveResponse>;
export type ConfigLayer = Out<typeof ConfigLayerView>;
export type ConfigHistory = Out<typeof ConfigHistoryResponse>;
export type ConfigVersion = ConfigHistory['data'][number];
export type ConfigPreview = Out<typeof ConfigPreviewResponse>;
export type ConfigKey = Out<typeof ConfigKeysResponse>['data'][number];
export type Brand = Out<typeof BrandTokens>;
export type Scope = 'tenant' | 'user';
type Json = Record<string, unknown>;

export const ck = {
  all: ['config'] as const,
  effective: ['config', 'effective'] as const,
  keys: ['config', 'keys'] as const,
  layer: (key: string, scope: Scope) => ['config', 'layer', key, scope] as const,
  history: (key: string, scope: Scope) => ['config', 'history', key, scope] as const,
  logo: (assetId: string) => ['config', 'logo', assetId] as const,
};

const path = (key: string, scope: Scope, suffix = ''): string => `/v1/config/${encodeURIComponent(key)}${suffix}?scope=${scope}`;

export function useEffectiveConfig() {
  return useQuery({ queryKey: ck.effective, queryFn: () => request<EffectiveConfig>('/v1/config'), staleTime: 300_000 });
}

export function useConfigKeys() {
  return useQuery({ queryKey: ck.keys, queryFn: () => request<Out<typeof ConfigKeysResponse>>('/v1/config/keys'), staleTime: Infinity });
}

export function useConfigLayer(key: string, scope: Scope) {
  return useQuery({ queryKey: ck.layer(key, scope), queryFn: () => request<ConfigLayer>(path(key, scope)) });
}

export function useConfigHistory(key: string, scope: Scope, enabled = true) {
  return useQuery({ queryKey: ck.history(key, scope), queryFn: () => request<ConfigHistory>(path(key, scope, '/history')), enabled });
}

export const previewConfig = (key: string, scope: Scope, value: Json) =>
  request<ConfigPreview>(path(key, scope, '/preview'), { method: 'POST', body: { value } });

/** Every configuration write refreshes all configuration queries (effective values, layers, history). */
function useConfigMutation<A>(fn: (arg: A) => Promise<ConfigLayer>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ck.all }), qc.invalidateQueries({ queryKey: ['tenant'] })]);
    },
  });
}

export function useWriteConfig() {
  return useConfigMutation(({ key, scope, value, version, note }: { key: string; scope: Scope; value: Json; version: number; note?: string }) =>
    request<ConfigLayer>(path(key, scope), { method: 'PUT', body: note ? { value, note } : { value }, ifMatch: version }));
}

export function useRevertConfig() {
  return useConfigMutation(({ key, scope, target, version, note }: { key: string; scope: Scope; target: number; version: number; note?: string }) =>
    request<ConfigLayer>(path(key, scope, '/revert'), { method: 'POST', body: note ? { version: target, note } : { version: target }, ifMatch: version }));
}

export function useRemoveOverride() {
  return useConfigMutation(({ key, version }: { key: string; version: number }) => request<ConfigLayer>(path(key, 'user'), { method: 'DELETE', ifMatch: version }));
}

/**
 * Merges `patch` into the caller's own layer of `key`. Reads the layer first for its version and retries once
 * when another tab wrote in between (412).
 */
export async function saveOwnPreference(qc: QueryClient, key: string, patch: Json): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const layer = await request<ConfigLayer>(path(key, 'user'));
    try {
      await request<ConfigLayer>(path(key, 'user'), { method: 'PUT', body: { value: { ...layer.value, ...patch } }, ifMatch: layer.version });
      await qc.invalidateQueries({ queryKey: ck.all });
      return;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 412 || attempt > 0) throw err;
    }
  }
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export async function uploadLogo(file: File): Promise<Out<typeof BrandLogoView>> {
  return request<Out<typeof BrandLogoView>>('/v1/brand/logo', { method: 'POST', body: { mime: file.type, dataBase64: await fileToBase64(file) } });
}

/** Object URL of the current logo (fetched with the session; images cannot send the Authorization header). */
export function useLogoUrl(assetId: string | null | undefined) {
  const q = useQuery({
    queryKey: ck.logo(assetId ?? 'none'),
    queryFn: async () => URL.createObjectURL(await requestBlob('/v1/brand/logo')),
    enabled: Boolean(assetId),
    staleTime: Infinity,
  });
  useEffect(() => {
    const url = q.data;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [q.data]);
  return assetId ? q.data : undefined;
}

/** Theme/density change from the shell: applied at once, then stored as the user's own override. */
export function useSetUiPreference(): (patch: { theme?: ThemePref; density?: DensityPref }) => void {
  const qc = useQueryClient();
  const { set } = usePreferences();
  return (patch) => {
    set(patch);
    // The choice stays applied locally even if the save fails (offline); the next change retries.
    void saveOwnPreference(qc, 'ui', patch).catch(() => undefined);
  };
}

// ---------------------------------------------------------------------------------------------------------
// Applying the effective configuration
// ---------------------------------------------------------------------------------------------------------

const BRAND_STYLE_ID = 'fx-brand';
const BRAND_STORAGE_KEY = 'fx.brand';
const ACCENT_TOKENS = ['accent', 'accent-hover', 'accent-soft', 'accent-btn', 'accent-btn-hover'] as const;
const HEX = /^#[0-9A-Fa-f]{6}$/;

/** CSS that overrides the accent tokens with the same selectors as tokens.css (later in the document wins). */
export function brandCss(tokens: Brand | null): string {
  if (!tokens) return '';
  const decl = (p: Record<string, string>): string => ACCENT_TOKENS.filter((k) => HEX.test(p[k] ?? '')).map((k) => `--${k}:${p[k] ?? ''}`).join(';');
  const dark = decl(tokens.dark);
  return `:root{${decl(tokens.light)}}:root[data-theme="dark"]{${dark}}@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${dark}}}`;
}

function setBrandStyle(css: string): void {
  let el = document.getElementById(BRAND_STYLE_ID);
  if (!css) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = BRAND_STYLE_ID;
    document.head.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
}

/** Applies the cached tenant colors before the signed-in app first renders (no purple flash). */
export function restoreStoredBrand(): void {
  try {
    const css = window.localStorage.getItem(BRAND_STORAGE_KEY);
    // Only declarations this module wrote: accent custom properties with hex values.
    if (css && /^[:\w\s[\]="(),;@#-]+\{[\s\S]*\}$/.test(css) && !/[<>\\]|url\(/i.test(css)) setBrandStyle(css);
  } catch {
    // Storage blocked: the colors arrive with the configuration.
  }
}

const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);

/**
 * Applies the effective configuration and re-renders the app when the language changes. The language is set
 * during render (before any child reads a message) so one render pass is enough.
 */
export function ConfigBoundary({ children }: { children: ReactNode }) {
  const config = useEffectiveConfig();
  const prefs = usePreferences();
  const locale = config.data?.data.locale?.value ?? {};
  const ui = config.data?.data.ui?.value;
  const language: Locale = locale.language === 'en' ? 'en' : 'tr';
  if (config.data) {
    setLocale(language);
    setFormatPrefs({
      locale: language === 'en' ? 'en-US' : 'tr-TR',
      timeZone: str(locale.timezone, 'Europe/Istanbul'),
      dateFormat: locale.dateFormat === 'mdy' || locale.dateFormat === 'ymd' ? locale.dateFormat : 'dmy',
      hour12: locale.timeFormat === '12h',
      weekStart: locale.weekStart === 'sunday' ? 0 : 1,
    });
  }

  const tokens = config.data?.brand.tokens ?? null;
  const css = config.data ? brandCss(tokens) : null;
  useEffect(() => {
    if (css === null) return;
    setBrandStyle(css);
    try {
      if (css) window.localStorage.setItem(BRAND_STORAGE_KEY, css);
      else window.localStorage.removeItem(BRAND_STORAGE_KEY);
      window.localStorage.setItem(LOCALE_STORAGE_KEY, language);
    } catch {
      // Private mode: nothing is cached.
    }
    document.documentElement.lang = language;
  }, [css, language]);
  useEffect(() => () => {
    // Leaving the signed-in app (sign-out): sign-in pages use the Flexa colors.
    setBrandStyle('');
    document.documentElement.lang = 'tr';
  }, []);

  // Theme and density: the server value (user override or tenant default) wins whenever it changes.
  const serverTheme = ui ? (str(ui.theme, 'system') as ThemePref) : null;
  const serverDensity = ui ? (str(ui.density, 'comfortable') as DensityPref) : null;
  const fromUser = config.data?.data.ui?.sources.theme === 'user' || config.data?.data.ui?.sources.density === 'user';
  const applied = useRef<string | null>(null);
  const qc = useQueryClient();
  const { set, theme: localTheme, density: localDensity } = prefs;
  useEffect(() => {
    if (!serverTheme || !serverDensity) return;
    const sig = `${serverTheme}|${serverDensity}`;
    if (applied.current === sig) return;
    // Before P7 the choice lived only in this browser (B51): a user with no server override who had picked a
    // theme or density keeps it, and it is stored once as their own override.
    if (applied.current === null && !fromUser && (localTheme !== 'system' || localDensity !== 'comfortable')) {
      applied.current = `${localTheme}|${localDensity}`;
      void saveOwnPreference(qc, 'ui', { theme: localTheme, density: localDensity }).catch(() => undefined);
      return;
    }
    applied.current = sig;
    set({ theme: serverTheme, density: serverDensity });
  }, [serverTheme, serverDensity, set, fromUser, localTheme, localDensity, qc]);

  return <Fragment key={language}>{children}</Fragment>;
}
