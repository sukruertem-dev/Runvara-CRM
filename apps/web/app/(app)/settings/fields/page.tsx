'use client';

import { Alert, Badge, Button, Checkbox, Dialog, DialogContent, DialogFooter, EmptyState, ErrorState, Field, IconButton, Input, SegmentedControl, Select, Skeleton, useToast } from '@flexa/ui';
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, ListPlus, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '../../../../lib/api';
import { useApp } from '../../../../lib/app-context';
import { messageForCode } from '../../../../lib/errors';
import { t } from '../../../../lib/i18n';
import type { Resource } from '../../../../lib/records';
import { labelOf, toKey, useCustomFields, useFieldMutations, type CustomField } from '../../../../lib/settings';
import { PageContainer } from '../../../_components/app-shell';
import { ReadOnlyNotice, SettingsGate, SettingsHeader } from '../_parts/settings-nav';

const RESOURCES: Resource[] = ['task', 'account', 'contact', 'lead', 'opportunity', 'case'];
const TYPES = ['text', 'number', 'date', 'select', 'multi_select', 'user', 'relation', 'formula'] as const;
type FieldType = (typeof TYPES)[number];

interface Option {
  id: string;
  label: string;
  labels: Record<string, string>;
  /** True for options that exist on the server (their id is fixed). */
  stored: boolean;
}

function OptionsEditor({ options, onChange }: { options: Option[]; onChange: (next: Option[]) => void }) {
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend className="mb-1 text-sm font-medium">{t('settings.cf.options')}</legend>
      <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
        {options.map((o, i) => (
          <li key={`${o.id}-${String(i)}`} className="flex items-center gap-2" data-testid="cf-option">
            <Input
              aria-label={t('settings.cf.optionLabel', { n: String(i + 1) })}
              value={o.label}
              maxLength={120}
              onChange={(e) => {
                const label = e.target.value;
                onChange(options.map((x, j) => (j === i ? { ...x, label, ...(x.stored ? {} : { id: toKey(label) || `opt_${String(i + 1)}` }) } : x)));
              }}
            />
            <code className="hidden w-28 truncate text-xs text-fg-muted sm:block">{o.id}</code>
            <IconButton size="sm" label={t('settings.cf.removeOption', { name: o.label || o.id })} onClick={() => { onChange(options.filter((_, j) => j !== i)); }}>
              <Trash2 aria-hidden size={14} />
            </IconButton>
          </li>
        ))}
      </ol>
      <Button
        size="sm"
        variant="secondary"
        className="self-start"
        icon={<ListPlus aria-hidden size={14} />}
        onClick={() => { onChange([...options, { id: `opt_${String(options.length + 1)}`, label: '', labels: {}, stored: false }]); }}
      >
        {t('settings.cf.addOption')}
      </Button>
    </fieldset>
  );
}

const optionsOut = (opts: Option[]) => opts.map((o) => ({ id: o.id, label: { ...o.labels, tr: o.label.trim() || o.id } }));

function FieldDialog({ resource, field, onClose }: { resource: Resource; field: CustomField | 'new'; onClose: () => void }) {
  const m = useFieldMutations(resource);
  const { toast } = useToast();
  const existing = field === 'new' ? null : field;
  const [label, setLabel] = useState(existing ? labelOf(existing.label) : '');
  const [type, setType] = useState<FieldType>(existing?.type ?? 'text');
  const [required, setRequired] = useState(existing?.required ?? false);
  const [indexed, setIndexed] = useState(existing?.indexed ?? false);
  const [relationTarget, setRelationTarget] = useState<Resource>((existing?.relationTarget as Resource | null) ?? 'account');
  const [formula, setFormula] = useState(existing?.formula ?? '');
  const [options, setOptions] = useState<Option[]>(existing?.options.map((o) => ({ id: o.id, label: labelOf(o.label, o.id), labels: o.label, stored: true })) ?? []);
  const [error, setError] = useState<string | null>(null);
  const isSelect = type === 'select' || type === 'multi_select';
  const key = existing?.key ?? `cf_${toKey(label).slice(0, 45)}`;

  async function submit(): Promise<void> {
    setError(null);
    const labels = { ...(existing?.label ?? {}), tr: label.trim() };
    try {
      if (existing) {
        await m.patch.mutateAsync({
          field: existing,
          body: { label: labels, ...(type === 'formula' ? {} : { required }), indexed, ...(isSelect ? { options: optionsOut(options) } : {}) },
        });
      } else {
        await m.create.mutateAsync({
          resourceType: resource, key, type, label: labels, required: type === 'formula' ? false : required, indexed,
          ...(isSelect ? { options: optionsOut(options) } : {}),
          ...(type === 'relation' ? { relationTarget } : {}),
          ...(type === 'formula' ? { formula } : {}),
        });
      }
      toast({ title: t('settings.saved'), kind: 'success' });
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CUSTOM_FIELD_OPTION_IN_USE') {
        setError(t('settings.cf.optionInUse', { id: typeof e.problem.optionId === 'string' ? e.problem.optionId : '', count: typeof e.problem.records === 'number' ? String(e.problem.records) : '' }));
      } else if (e instanceof ApiError && e.code === 'PRECONDITION_FAILED') setError(t('settings.stale'));
      else if (e instanceof ApiError && (e.code === 'FORMULA_INVALID' || e.code === 'CONFLICT')) setError(`${messageForCode(e.code)} ${e.problem.detail ?? ''}`.trim());
      else setError(e instanceof ApiError ? messageForCode(e.code) : t('error.fallback'));
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={existing ? t('settings.cf.edit', { name: labelOf(existing.label) }) : t('settings.cf.create')} closeLabel={t('common.close')} wide>
        <form method="post" onSubmit={(e) => { e.preventDefault(); void submit(); }} className="flex flex-col gap-3" data-testid="cf-dialog">
          {error ? <Alert kind="error">{error}</Alert> : null}
          <Field label={t('settings.cf.label')} hint={t('settings.keyPreview', { key })}>
            <Input value={label} onChange={(e) => { setLabel(e.target.value); }} maxLength={120} required autoFocus />
          </Field>
          <Field label={t('settings.cf.type')} hint={existing ? t('settings.cf.typeFixed') : undefined}>
            <Select value={type} disabled={existing !== null} onValueChange={(v) => { setType(v as FieldType); }} options={TYPES.map((x) => ({ value: x, label: t(`settings.cf.type.${x}`) }))} />
          </Field>
          {type === 'relation' ? (
            <Field label={t('settings.cf.relationTarget')}>
              <Select value={relationTarget} disabled={existing !== null} onValueChange={(v) => { setRelationTarget(v as Resource); }} options={RESOURCES.map((r) => ({ value: r, label: t(`settings.resource.${r}`) }))} />
            </Field>
          ) : null}
          {type === 'formula' ? (
            <Field label={t('settings.cf.formula')} hint={t('settings.cf.formulaHint')}>
              <Input value={formula} disabled={existing !== null} onChange={(e) => { setFormula(e.target.value); }} maxLength={2000} className="font-mono" required />
            </Field>
          ) : null}
          {isSelect ? <OptionsEditor options={options} onChange={setOptions} /> : null}
          <div className="flex flex-wrap gap-4">
            {type === 'formula' ? null : (
              <label className="inline-flex items-center gap-2 text-sm"><Checkbox checked={required} onCheckedChange={(v) => { setRequired(v === true); }} />{t('settings.cf.required')}</label>
            )}
            <label className="inline-flex items-center gap-2 text-sm"><Checkbox checked={indexed} onCheckedChange={(v) => { setIndexed(v === true); }} />{t('settings.cf.indexed')}</label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" loading={m.create.isPending || m.patch.isPending} disabled={!label.trim() || (isSelect && options.length === 0)} data-testid="cf-save">
              {existing ? t('settings.save') : t('settings.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FieldsInner() {
  const { can } = useApp();
  const editable = can('tenant.config.manage');
  const { toast } = useToast();
  const [resource, setResource] = useState<Resource>('task');
  const [editing, setEditing] = useState<CustomField | 'new' | null>(null);
  const q = useCustomFields(resource);
  const m = useFieldMutations(resource);
  const fields = q.data?.data ?? [];
  const active = fields.filter((f) => !f.archived);
  const archived = fields.filter((f) => f.archived);

  const fail = (e: unknown) => { toast({ title: e instanceof ApiError ? messageForCode(e.code) : t('error.fallback'), kind: 'error' }); };
  function reorder(f: CustomField, to: number): void {
    const others = active.filter((x) => x.id !== f.id);
    const after = to === 0 ? null : (others[to - 1]?.id ?? null);
    m.patch.mutate({ field: f, body: { moveAfter: after } }, { onError: fail });
  }

  return (
    <PageContainer>
      <SettingsHeader
        title={t('settings.fields')}
        lead={t('settings.cf.lead')}
        actions={editable ? <Button icon={<Plus aria-hidden size={16} />} onClick={() => { setEditing('new'); }} data-testid="cf-new">{t('settings.cf.create')}</Button> : undefined}
      />
      {editable ? null : <ReadOnlyNotice />}
      <div className="mb-4 overflow-x-auto">
        <SegmentedControl<Resource> label={t('settings.cf.resource')} value={resource} onValueChange={setResource} options={RESOURCES.map((r) => ({ value: r, label: t(`settings.resource.${r}`) }))} />
      </div>
      {q.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : q.isError ? (
        <ErrorState title={t('error.fallback')} retryLabel={t('common.retry')} onRetry={() => { void q.refetch(); }} />
      ) : active.length === 0 && archived.length === 0 ? (
        <EmptyState icon={ListPlus} title={t('settings.cf.empty')} description={t('settings.cf.emptyBody')} />
      ) : (
        <>
          <ol className="m-0 flex list-none flex-col divide-y divide-line rounded-card border border-line bg-surface p-0">
            {active.map((f, i) => (
              <li key={f.id} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="cf-row" data-key={f.key}>
                <div className="min-w-0 flex-1">
                  <p className="m-0 font-medium">{labelOf(f.label, f.key)}</p>
                  <p className="m-0 mt-0.5 text-xs text-fg-muted"><code>{f.key}</code>{f.options.length > 0 ? ` · ${t('settings.cf.optionCount', { count: String(f.options.length) })}` : ''}</p>
                </div>
                <Badge tone="neutral">{t(`settings.cf.type.${f.type}`)}</Badge>
                {f.required ? <Badge tone="info">{t('settings.cf.required')}</Badge> : null}
                {editable ? (
                  <span className="flex items-center gap-1">
                    <IconButton size="sm" label={t('settings.moveUp', { name: labelOf(f.label) })} disabled={i === 0} onClick={() => { reorder(f, i - 1); }}><ArrowUp aria-hidden size={14} /></IconButton>
                    <IconButton size="sm" label={t('settings.moveDown', { name: labelOf(f.label) })} disabled={i === active.length - 1} onClick={() => { reorder(f, i + 1); }}><ArrowDown aria-hidden size={14} /></IconButton>
                    <IconButton size="sm" label={t('settings.cf.edit', { name: labelOf(f.label) })} onClick={() => { setEditing(f); }}><Pencil aria-hidden size={14} /></IconButton>
                    <IconButton
                      size="sm"
                      label={t('settings.cf.archive', { name: labelOf(f.label) })}
                      onClick={() => {
                        m.archive.mutate(f, {
                          onSuccess: () => { toast({ title: t('settings.cf.archived'), action: { label: t('common.undo'), onAction: () => { m.restore.mutate(f, { onError: fail }); } } }); },
                          onError: fail,
                        });
                      }}
                    >
                      <Archive aria-hidden size={14} />
                    </IconButton>
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
          {archived.length > 0 ? (
            <section aria-labelledby="cf-archived" className="mt-6">
              <h2 id="cf-archived" className="m-0 mb-2 text-sm font-semibold text-fg-muted">{t('settings.cf.archivedTitle')}</h2>
              <ul className="m-0 flex list-none flex-col divide-y divide-line rounded-card border border-line p-0">
                {archived.map((f) => (
                  <li key={f.id} className="flex items-center gap-3 px-4 py-2 text-sm text-fg-muted">
                    <span className="flex-1">{labelOf(f.label, f.key)} <code className="text-xs">{f.key}</code></span>
                    {editable ? (
                      <Button size="sm" variant="ghost" icon={<ArchiveRestore aria-hidden size={14} />} onClick={() => { m.restore.mutate(f, { onError: fail }); }}>{t('settings.cf.restore')}</Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
      {editing ? <FieldDialog key={editing === 'new' ? 'new' : editing.id} resource={resource} field={editing} onClose={() => { setEditing(null); }} /> : null}
    </PageContainer>
  );
}

export default function FieldsPage() {
  return (
    <SettingsGate anyOf={['tenant.config.read']}>
      <FieldsInner />
    </SettingsGate>
  );
}
