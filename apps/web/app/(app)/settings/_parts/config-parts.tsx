'use client';

import { Alert, Button, Dialog, DialogContent, DialogFooter, Field, Skeleton, Textarea } from '@flexa/ui';
import { useEffect, useState } from 'react';
import { ApiError } from '../../../../lib/api';
import { previewConfig, useWriteConfig, type ConfigPreview, type Scope } from '../../../../lib/config';
import { messageForCode } from '../../../../lib/errors';
import { t, tOptional } from '../../../../lib/i18n';

type Json = Record<string, unknown>;
export type PatchOp = ConfigPreview['patch'][number];

export const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Keeps only the properties that differ from the platform default (the layer stores overrides only). */
export function overridesOf(value: Json, defaults: Json): Json {
  return Object.fromEntries(Object.entries(value).filter(([k, v]) => !sameJson(v, defaults[k])));
}

export const keyLabel = (key: string): string => tOptional(`config.key.${key}`) ?? key;
const propLabel = (key: string, path: string): string => {
  const prop = path.split('/').filter(Boolean).join('.');
  return tOptional(`config.prop.${key}.${prop}`) ?? prop;
};

export function valueText(v: unknown): string {
  if (v === null || v === undefined) return t('config.none');
  if (Array.isArray(v)) return v.length ? v.map((x) => tOptional(`config.value.${String(x)}`) ?? String(x)).join(', ') : t('config.none');
  if (typeof v === 'object') return JSON.stringify(v);
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return tOptional(`config.value.${s}`) ?? s;
}

/** JSON Patch as readable rows: what changed, from what (when known) to what. */
export function PatchList({ configKey, patch, before }: { configKey: string; patch: readonly PatchOp[]; before?: Json }) {
  if (patch.length === 0) return <p className="m-0 text-sm text-fg-muted">{t('config.noChange')}</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm" data-testid="patch-list">
      {patch.map((op) => {
        const prop = op.path.split('/').filter(Boolean)[0] ?? '';
        const old = before?.[prop];
        return (
          <li key={`${op.op}${op.path}`} className="flex flex-wrap items-baseline gap-x-2 rounded-input bg-subtle px-2.5 py-1.5">
            <span className="font-semibold">{propLabel(configKey, op.path)}</span>
            <span className="text-xs text-fg-muted">{t(`config.op.${op.op}`)}</span>
            {op.op !== 'add' && old !== undefined ? <span className="text-fg-muted line-through">{valueText(old)}</span> : null}
            {op.op !== 'remove' ? <span>{valueText(op.value)}</span> : <span className="text-fg-muted">{t('config.toDefault')}</span>}
          </li>
        );
      })}
    </ul>
  );
}

export interface PendingChange {
  key: string;
  scope: Scope;
  value: Json;
  version: number;
}

/**
 * The confirmation every configuration change goes through (ADR-0011 §2): the server validates each value
 * and returns the JSON Patch; the admin adds an optional note and applies.
 */
export function SaveConfigDialog({ changes, onClose, onSaved }: { changes: readonly PendingChange[]; onClose: () => void; onSaved: () => void }) {
  const write = useWriteConfig();
  const [previews, setPreviews] = useState<ConfigPreview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    let live = true;
    void Promise.all(changes.map((c) => previewConfig(c.key, c.scope, c.value)))
      .then((p) => { if (live) setPreviews(p); })
      .catch((e: unknown) => { if (live) setError(e instanceof ApiError ? messageForCode(e.code) : t('error.fallback')); });
    return () => { live = false; };
  }, [changes]);

  const invalid = previews?.some((p) => !p.valid) ?? false;
  async function apply(): Promise<void> {
    setError(null);
    try {
      for (const c of changes) {
        await write.mutateAsync({ key: c.key, scope: c.scope, value: c.value, version: c.version, ...(note.trim() ? { note: note.trim() } : {}) });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? `${messageForCode(e.code)}${e.code === 'CONFIG_INVALID' ? ` ${e.problem.detail ?? ''}` : ''}` : t('error.fallback'));
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={t('config.review.title')} description={t('config.review.lead')} closeLabel={t('common.close')}>
        <div className="flex flex-col gap-4" data-testid="config-review">
          {error ? <Alert kind="error">{error}</Alert> : null}
          {previews === null && !error ? <Skeleton className="h-16 w-full" /> : null}
          {previews?.map((p, i) => {
            const c = changes[i];
            if (!c) return null;
            return (
              <section key={c.key} className="flex flex-col gap-2">
                <h3 className="m-0 text-sm font-semibold">{keyLabel(c.key)}</h3>
                {p.valid ? <PatchList configKey={c.key} patch={p.patch} before={p.before} /> : (
                  <Alert kind="error">
                    {p.errors.map((er) => (er.message === 'BRAND_CONTRAST_UNSATISFIABLE' ? messageForCode('BRAND_CONTRAST_UNSATISFIABLE') : `${propLabel(c.key, er.path)}: ${er.message}`)).join(' · ')}
                  </Alert>
                )}
              </section>
            );
          })}
          <Field label={t('config.note')} hint={t('config.noteHint')}>
            <Textarea value={note} maxLength={500} rows={2} onChange={(e) => { setNote(e.target.value); }} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={() => void apply()} disabled={previews === null || invalid || write.isPending} data-testid="config-apply">
            {write.isPending ? t('common.pending') : t('config.apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
