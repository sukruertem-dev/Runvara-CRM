'use client';

import { Alert, Button, Checkbox, Dialog, DialogContent, DialogFooter, ErrorState, Field, IconButton, Input, Select, Skeleton, useToast } from '@flexa/ui';
import { ArrowDown, ArrowLeft, ArrowUp, Plus, Save, Trash2, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../../../../lib/api';
import { useApp } from '../../../../../lib/app-context';
import { messageForCode } from '../../../../../lib/errors';
import { roleLabel, t } from '../../../../../lib/i18n';
import { usePipelines } from '../../../../../lib/records';
import { previewWorkflow, sk, useSaveWorkflow, useWorkflows, type Workflow, type WorkflowPreview } from '../../../../../lib/settings';
import { PageContainer } from '../../../../_components/app-shell';
import { ReadOnlyNotice, SettingsGate } from '../../_parts/settings-nav';
import { COLOR_TOKENS, fromWorkflow, problemsOf, rekeyStatus, rekeyTransition, toBody, uniqueKey, type Category, type Draft, type DraftStatus, type DraftTransition, type Problem } from '../_parts/draft';
import { WorkflowDiagram } from '../_parts/workflow-diagram';

const ROLES = ['admin', 'manager', 'sales_rep', 'call_agent', 'analyst'] as const;

function problemText(p: Problem): string {
  switch (p.kind) {
    case 'initial': return p.count === 0 ? t('settings.wf.problem.noInitial') : t('settings.wf.problem.manyInitial');
    case 'unreachable': return t('settings.wf.problem.unreachable', { name: p.label });
    case 'noTransitions': return t('settings.wf.problem.noTransitions');
    case 'tooFew': return t('settings.wf.problem.tooFew');
    case 'emptyName': return t('settings.wf.problem.emptyName');
    case 'duplicateTransition': return t('settings.wf.problem.duplicateTransition', { name: p.label });
    case 'selfTransition': return t('settings.wf.problem.selfTransition', { name: p.label });
  }
}

function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

type Kind = { kind: string } & Record<string, unknown>;
const has = (list: unknown[], kind: string) => list.some((x) => (x as Kind).kind === kind);
const toggle = (list: unknown[], kind: string, on: boolean, value: Kind = { kind }) => (on ? (has(list, kind) ? list : [...list, value]) : list.filter((x) => (x as Kind).kind !== kind));

function Editor({ wf }: { wf: Workflow }) {
  const { can } = useApp();
  const editable = can('tenant.config.manage');
  const { toast } = useToast();
  const isOpp = wf.resourceType === 'opportunity';
  const pipelines = usePipelines(isOpp);
  const probabilities = useMemo(() => {
    const stages = pipelines.data?.data.find((p) => p.workflowId === wf.id)?.stages ?? [];
    return new Map(stages.map((s) => [s.id, s.probability]));
  }, [pipelines.data, wf.id]);
  const initial = useMemo(() => fromWorkflow(wf, isOpp ? probabilities : undefined), [wf, isOpp, probabilities]);
  const [draft, setDraft] = useState<Draft>(initial);
  useEffect(() => { setDraft(initial); }, [initial]);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<WorkflowPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const save = useSaveWorkflow();
  const qc = useQueryClient();
  const rowRefs = useRef(new Map<string, HTMLInputElement>());

  const problems = problemsOf(draft);
  const dirty = JSON.stringify(toBody(draft, {}, isOpp)) !== JSON.stringify(toBody(initial, {}, isOpp));
  const statusOptions = draft.statuses.map((s) => ({ value: s.key, label: s.label || s.key }));

  const setStatus = (key: string, patch: Partial<DraftStatus>) => {
    setDraft((d) => ({
      ...d,
      statuses: d.statuses.map((s) => (s.key === key ? { ...s, ...patch } : patch.isInitial ? { ...s, isInitial: false } : s)),
    }));
  };
  const setTransition = (i: number, patch: Partial<DraftTransition>) => {
    setDraft((d) => ({ ...d, transitions: d.transitions.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
  };

  function addStatus(): void {
    const key = uniqueKey(t('settings.wf.newStatus'), draft.statuses.map((s) => s.key), 'status');
    setDraft((d) => ({ ...d, statuses: [...d.statuses, { uid: crypto.randomUUID(), key, label: t('settings.wf.newStatus'), labels: {}, category: 'in_progress', colorToken: 'info', isInitial: false, wipLimit: null, ...(isOpp ? { probability: 0 } : {}) }] }));
    setSelected(key);
    requestAnimationFrame(() => rowRefs.current.get(key)?.select());
  }

  function removeStatus(key: string): void {
    setDraft((d) => ({ ...d, statuses: d.statuses.filter((s) => s.key !== key), transitions: d.transitions.filter((x) => x.from !== key && x.to !== key) }));
    if (selected === key) setSelected(null);
  }

  function addTransition(): void {
    const first = draft.statuses[0]?.key ?? null;
    const second = draft.statuses[1]?.key ?? first ?? '';
    const from = selected ?? first;
    const to = draft.statuses.find((s) => s.key !== from)?.key ?? second;
    const key = uniqueKey(t('settings.wf.newTransition'), draft.transitions.map((x) => x.key), 'move');
    setDraft((d) => ({ ...d, transitions: [...d.transitions, { uid: crypto.randomUUID(), fresh: true, key, label: t('settings.wf.newTransition'), labels: {}, from, to, conditions: [], validators: [], postFunctions: [] }] }));
  }

  async function submit(map: Record<string, string>): Promise<void> {
    setError(null);
    try {
      const body = toBody(draft, map, isOpp);
      const p = await previewWorkflow(wf.id, body);
      if (!p.applicable) {
        setMapping(Object.fromEntries(p.removed.filter((r) => r.records > 0).map((r) => [r.statusId, map[r.statusId] ?? draft.statuses[0]?.key ?? ''])));
        setPreview(p);
        return;
      }
      await save.mutateAsync({ id: wf.id, version: wf.version, body });
      setPreview(null);
      toast({ title: t('settings.saved'), kind: 'success' });
    } catch (e) {
      setPreview(null);
      if (e instanceof ApiError && e.code === 'PRECONDITION_FAILED') {
        setError(t('settings.stale'));
        void qc.invalidateQueries({ queryKey: sk.workflows });
      }
      else if (e instanceof ApiError && e.code === 'WORKFLOW_INVALID') setError(`${messageForCode(e.code)} ${e.problem.detail ?? ''}`.trim());
      else setError(e instanceof ApiError ? messageForCode(e.code) : t('error.fallback'));
    }
  }

  return (
    <PageContainer wide>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-2">
          <Link href="/settings/workflows" className="inline-flex items-center gap-1 text-sm text-fg-muted no-underline hover:text-fg">
            <ArrowLeft aria-hidden size={14} /> {t('settings.workflows')}
          </Link>
          <h1 className="m-0 font-display text-xl font-bold" data-testid="wf-title">{draft.name || wf.name}</h1>
          <p className="m-0 text-sm text-fg-muted">{t(`settings.resource.${wf.resourceType}` as 'settings.resource.task')} · <code>{wf.key}</code></p>
        </div>
        {editable ? (
          <div className="flex gap-2">
            <Button variant="ghost" icon={<Undo2 aria-hidden size={16} />} disabled={!dirty} onClick={() => { setDraft(initial); setError(null); }}>{t('settings.discard')}</Button>
            <Button icon={<Save aria-hidden size={16} />} loading={save.isPending} disabled={!dirty || problems.length > 0} onClick={() => { void submit({}); }} data-testid="wf-save">{t('settings.save')}</Button>
          </div>
        ) : null}
      </div>
      {editable ? null : <ReadOnlyNotice />}
      {error ? <Alert kind="error" className="mb-4">{error}</Alert> : null}
      {problems.length > 0 ? (
        <Alert kind="warning" className="mb-4">
          <ul className="m-0 pl-4" data-testid="wf-problems">
            {problems.map((p) => <li key={`${p.kind}-${'label' in p ? p.label : ''}`}>{problemText(p)}</li>)}
          </ul>
        </Alert>
      ) : null}

      <WorkflowDiagram statuses={draft.statuses} transitions={draft.transitions} selected={selected} onSelect={(k) => { setSelected(k); rowRefs.current.get(k)?.focus(); }} />

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <section aria-labelledby="wf-statuses" className="min-w-0">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 id="wf-statuses" className="m-0 text-base font-semibold">{t('settings.wf.statuses')}</h2>
            {editable ? <Button size="sm" variant="secondary" icon={<Plus aria-hidden size={14} />} onClick={addStatus} data-testid="wf-add-status">{t('settings.wf.addStatus')}</Button> : null}
          </div>
          {editable ? <Field label={t('settings.wf.name')} className="mb-3"><Input value={draft.name} maxLength={120} onChange={(e) => { setDraft((d) => ({ ...d, name: e.target.value })); }} /></Field> : null}
          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            {draft.statuses.map((s, i) => (
              <li key={s.uid} data-testid="wf-status-row" data-key={s.key} className={`rounded-card border p-3 ${selected === s.key ? 'border-accent' : 'border-line'} bg-surface`}>
                <div className="flex flex-wrap items-end gap-2">
                  <Field label={t('settings.wf.statusName')} className="min-w-40 flex-1">
                    <Input
                      ref={(el) => { if (el) rowRefs.current.set(s.key, el); else rowRefs.current.delete(s.key); }}
                      value={s.label}
                      maxLength={120}
                      disabled={!editable}
                      onFocus={() => { setSelected(s.key); }}
                      onChange={(e) => { setStatus(s.key, { label: e.target.value }); }}
                      onBlur={() => {
                        const before = s.key;
                        setDraft((d) => {
                          const next = rekeyStatus(d, before);
                          const renamed = next.statuses.find((x) => x.uid === s.uid)?.key;
                          if (renamed && renamed !== before) setSelected((cur) => (cur === before ? renamed : cur));
                          return next;
                        });
                      }}
                    />
                  </Field>
                  <Field label={t('settings.wf.category')} className="w-36">
                    <Select value={s.category} disabled={!editable} onValueChange={(v) => { setStatus(s.key, { category: v as Category }); }} options={(['open', 'in_progress', 'closed'] as const).map((c) => ({ value: c, label: t(`settings.wf.category.${c}`) }))} />
                  </Field>
                  <Field label={t('settings.wf.color')} className="w-32">
                    <Select value={s.colorToken} disabled={!editable} onValueChange={(v) => { setStatus(s.key, { colorToken: v }); }} options={COLOR_TOKENS.map((c) => ({ value: c, label: t(`settings.color.${c}`) }))} />
                  </Field>
                  <Field label={t('settings.wf.wip')} className="w-24">
                    <Input type="number" min={1} max={1000} inputMode="numeric" value={s.wipLimit ?? ''} disabled={!editable} onChange={(e) => { setStatus(s.key, { wipLimit: e.target.value === '' ? null : Math.max(1, Math.min(1000, Number(e.target.value))) }); }} />
                  </Field>
                  {isOpp ? (
                    <Field label={t('settings.wf.probability')} className="w-24">
                      <Input type="number" min={0} max={100} inputMode="numeric" value={s.probability ?? 0} disabled={!editable} onChange={(e) => { setStatus(s.key, { probability: Math.max(0, Math.min(100, Number(e.target.value) || 0)) }); }} />
                    </Field>
                  ) : null}
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input type="radio" name="wf-initial" checked={s.isInitial} disabled={!editable} onChange={() => { setStatus(s.key, { isInitial: true }); }} className="size-4 accent-[var(--accent)]" />
                    {t('settings.wf.initialStatus')}
                  </label>
                  <span className="flex items-center gap-1">
                    <code className="mr-2 text-xs text-fg-muted">{s.key}</code>
                    {editable ? (
                      <>
                        <IconButton size="sm" label={t('settings.moveUp', { name: s.label })} disabled={i === 0} onClick={() => { setDraft((d) => ({ ...d, statuses: move(d.statuses, i, i - 1) })); }}><ArrowUp aria-hidden size={14} /></IconButton>
                        <IconButton size="sm" label={t('settings.moveDown', { name: s.label })} disabled={i === draft.statuses.length - 1} onClick={() => { setDraft((d) => ({ ...d, statuses: move(d.statuses, i, i + 1) })); }}><ArrowDown aria-hidden size={14} /></IconButton>
                        <IconButton size="sm" label={t('settings.wf.removeStatus', { name: s.label })} disabled={draft.statuses.length <= 2} onClick={() => { removeStatus(s.key); }}><Trash2 aria-hidden size={14} /></IconButton>
                      </>
                    ) : null}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="wf-transitions" className="min-w-0">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 id="wf-transitions" className="m-0 text-base font-semibold">{t('settings.wf.transitions')}</h2>
            {editable ? <Button size="sm" variant="secondary" icon={<Plus aria-hidden size={14} />} onClick={addTransition} data-testid="wf-add-transition">{t('settings.wf.addTransition')}</Button> : null}
          </div>
          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            {draft.transitions.map((x, i) => (
              <li key={x.uid} data-testid="wf-transition-row" className={`rounded-card border bg-surface p-3 ${selected !== null && (x.from === selected || x.to === selected) ? 'border-accent' : 'border-line'}`}>
                <div className="flex flex-wrap items-end gap-2">
                  <Field label={t('settings.wf.transitionName')} className="min-w-36 flex-1">
                    <Input value={x.label} maxLength={120} disabled={!editable} onChange={(e) => { setTransition(i, { label: e.target.value }); }} onBlur={() => { setDraft((d) => rekeyTransition(d, i)); }} />
                  </Field>
                  <Field label={t('settings.wf.from')} className="w-40">
                    <Select value={x.from ?? '*'} disabled={!editable} onValueChange={(v) => { setTransition(i, { from: v === '*' ? null : v }); }} options={[{ value: '*', label: t('settings.wf.fromAny') }, ...statusOptions]} />
                  </Field>
                  <Field label={t('settings.wf.to')} className="w-40">
                    <Select value={x.to} disabled={!editable} onValueChange={(v) => { setTransition(i, { to: v }); }} options={statusOptions} />
                  </Field>
                  {editable ? <IconButton size="sm" label={t('settings.wf.removeTransition', { name: x.label })} onClick={() => { setDraft((d) => ({ ...d, transitions: d.transitions.filter((_, j) => j !== i) })); }}><Trash2 aria-hidden size={14} /></IconButton> : null}
                </div>
                <details className="mt-2 text-sm">
                  <summary className="cursor-pointer text-fg-muted">{t('settings.wf.rules', { count: String(x.conditions.length + x.validators.length + x.postFunctions.length) })}</summary>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
                      <legend className="mb-1 text-xs font-semibold text-fg-muted">{t('settings.wf.validators')}</legend>
                      {wf.resourceType === 'task' ? (
                        <>
                          <label className="inline-flex items-center gap-2"><Checkbox disabled={!editable} checked={has(x.validators, 'subtasks_closed')} onCheckedChange={(v) => { setTransition(i, { validators: toggle(x.validators, 'subtasks_closed', v === true) }); }} />{t('settings.wf.v.subtasks')}</label>
                          <label className="inline-flex items-center gap-2"><Checkbox disabled={!editable} checked={has(x.validators, 'no_open_blockers')} onCheckedChange={(v) => { setTransition(i, { validators: toggle(x.validators, 'no_open_blockers', v === true) }); }} />{t('settings.wf.v.blockers')}</label>
                        </>
                      ) : null}
                      <label className="inline-flex items-center gap-2"><Checkbox disabled={!editable} checked={has(x.conditions, 'is_owner')} onCheckedChange={(v) => { setTransition(i, { conditions: toggle(x.conditions, 'is_owner', v === true) }); }} />{t('settings.wf.c.owner')}</label>
                      {wf.resourceType === 'task' ? (
                        <label className="inline-flex items-center gap-2"><Checkbox disabled={!editable} checked={has(x.postFunctions, 'assign_to_actor')} onCheckedChange={(v) => { setTransition(i, { postFunctions: toggle(x.postFunctions, 'assign_to_actor', v === true) }); }} />{t('settings.wf.p.assignActor')}</label>
                      ) : null}
                    </fieldset>
                    <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
                      <legend className="mb-1 text-xs font-semibold text-fg-muted">{t('settings.wf.c.roles')}</legend>
                      {ROLES.map((r) => {
                        const cond = x.conditions.find((c) => (c as Kind).kind === 'role') as { kind: 'role'; anyOf: string[] } | undefined;
                        const on = cond?.anyOf.includes(r) ?? false;
                        return (
                          <label key={r} className="inline-flex items-center gap-2">
                            <Checkbox
                              disabled={!editable}
                              checked={on}
                              onCheckedChange={(v) => {
                                const roles = new Set(cond?.anyOf ?? []);
                                if (v === true) roles.add(r);
                                else roles.delete(r);
                                const rest = x.conditions.filter((c) => (c as Kind).kind !== 'role');
                                setTransition(i, { conditions: roles.size > 0 ? [...rest, { kind: 'role', anyOf: [...roles] }] : rest });
                              }}
                            />
                            {roleLabel(r)}
                          </label>
                        );
                      })}
                    </fieldset>
                  </div>
                </details>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <Dialog open={preview !== null} onOpenChange={(o) => { if (!o) setPreview(null); }}>
        <DialogContent title={t('settings.wf.mapTitle')} description={t('settings.wf.mapLead')} closeLabel={t('common.close')}>
          <div className="flex flex-col gap-3" data-testid="wf-mapping">
            {preview?.removed.filter((r) => r.records > 0).map((r) => (
              <Field key={r.statusId} label={t('settings.wf.mapRow', { name: labelOfRemoved(wf, r.statusId) ?? r.key, count: String(r.records) })}>
                <Select value={mapping[r.statusId]} onValueChange={(v) => { setMapping((m) => ({ ...m, [r.statusId]: v })); }} options={statusOptions} />
              </Field>
            ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setPreview(null); }}>{t('common.cancel')}</Button>
            <Button loading={save.isPending} onClick={() => { void submit(mapping); }} data-testid="wf-map-confirm">{t('settings.wf.mapConfirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}

function labelOfRemoved(wf: Workflow, id: string): string | undefined {
  const s = wf.statuses.find((x) => x.id === id);
  return s ? (s.label.tr ?? s.label.en ?? s.key) : undefined;
}

export default function WorkflowEditorPage() {
  const { id } = useParams<{ id: string }>();
  const q = useWorkflows();
  const wf = q.data?.data.find((w) => w.id === id);
  return (
    <SettingsGate anyOf={['tenant.config.read']}>
      {q.isPending ? (
        <PageContainer wide><Skeleton className="h-80 w-full" /></PageContainer>
      ) : q.isError || !wf ? (
        <PageContainer><ErrorState title={t('page.notFound')} retryLabel={t('common.retry')} onRetry={() => { void q.refetch(); }} /></PageContainer>
      ) : (
        <Editor wf={wf} />
      )}
    </SettingsGate>
  );
}
