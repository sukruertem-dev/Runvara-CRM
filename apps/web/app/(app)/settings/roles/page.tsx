'use client';

import { Alert, Button, cn, Dialog, DialogContent, DialogFooter, ErrorState, Field, focusRing, Input, Popover, PopoverContent, PopoverTrigger, RoleBadge, Select, Skeleton, Textarea, useToast } from '@flexa/ui';
import { History, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ApiError } from '../../../../lib/api';
import { useApp } from '../../../../lib/app-context';
import { dateTime } from '../../../../lib/format';
import { messageForCode } from '../../../../lib/errors';
import { moduleLabel, roleLabel, t } from '../../../../lib/i18n';
import { previewMatrix, useMatrix, useMatrixMutations, useMatrixVersions, type Grant, type MatrixPreview } from '../../../../lib/settings';
import { PageContainer } from '../../../_components/app-shell';
import { ReadOnlyNotice, SettingsGate, SettingsHeader } from '../_parts/settings-nav';

const ROLES = ['admin', 'manager', 'sales_rep', 'call_agent', 'analyst'] as const;
type RoleKey = (typeof ROLES)[number];
const MODES = ['none', 'full', 'read', 'approve', 'request'] as const;
const SCOPES = ['own', 'queue', 'team', 'segment', 'all'] as const;

const cellKey = (role: string, permission: string) => `${role}|${permission}`;
const scopeText = (g: Grant) => (Array.isArray(g.scope) ? g.scope : [g.scope]).map((s) => t(`settings.scope.${s}`)).join(' + ');
const grantText = (g: Grant | null) => (g ? `${t(`settings.mode.${g.mode}`)} · ${scopeText(g)}` : t('settings.mode.none'));

/** The fields a matrix change may carry (MatrixChange is strict); shipped grants can hold descriptive extras. */
function clean(g: Grant): Grant {
  return {
    mode: g.mode,
    scope: g.scope,
    ...(g.policy ? { policy: g.policy } : {}),
    ...(g.constraints ? { constraints: g.constraints } : {}),
    ...(g.resources ? { resources: g.resources } : {}),
  };
}

function GrantEditor({ role, permission, value: raw, onChange }: { role: string; permission: string; value: Grant | null; onChange: (g: Grant | null) => void }) {
  const value = raw ? clean(raw) : null;
  const mode = value?.mode ?? 'none';
  const scope = value ? (Array.isArray(value.scope) ? (value.scope[0] ?? 'all') : value.scope) : 'all';
  return (
    <div className="flex w-64 flex-col gap-3">
      <p className="m-0 text-sm"><span className="font-semibold">{roleLabel(role)}</span> · <code className="text-xs">{permission}</code></p>
      <Field label={t('settings.matrix.mode')}>
        <Select
          value={mode}
          onValueChange={(v) => { onChange(v === 'none' ? null : { ...(value ?? {}), mode: v as Grant['mode'], scope: value?.scope ?? 'all' }); }}
          options={MODES.map((m) => ({ value: m, label: t(`settings.mode.${m}`) }))}
        />
      </Field>
      <Field label={t('settings.matrix.scope')}>
        <Select
          value={scope}
          disabled={mode === 'none'}
          onValueChange={(v) => { if (value) onChange({ ...value, scope: v as Grant['scope'] & string }); }}
          options={SCOPES.map((s) => ({ value: s, label: t(`settings.scope.${s}`) }))}
        />
      </Field>
    </div>
  );
}

function MatrixInner() {
  const { can } = useApp();
  const editable = can('authz.matrix.edit');
  const { toast } = useToast();
  const q = useMatrix();
  const versions = useMatrixVersions();
  const m = useMatrixMutations();
  const [filter, setFilter] = useState('');
  const [pending, setPending] = useState<Map<string, Grant | null>>(new Map());
  const [diff, setDiff] = useState<MatrixPreview | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const groups = useMemo(() => {
    const byPerm = new Map<string, { module: string; cells: Map<string, { grant: Grant | null; overridden: boolean }> }>();
    for (const c of q.data?.cells ?? []) {
      const row = byPerm.get(c.permission) ?? { module: c.module, cells: new Map() };
      row.cells.set(c.roleKey, { grant: c.grant, overridden: c.overridden });
      byPerm.set(c.permission, row);
    }
    const f = filter.trim().toLocaleLowerCase('tr-TR');
    const out = new Map<string, string[]>();
    for (const [perm, row] of byPerm) {
      if (f && !perm.includes(f) && !moduleLabel(row.module).toLocaleLowerCase('tr-TR').includes(f)) continue;
      out.set(row.module, [...(out.get(row.module) ?? []), perm]);
    }
    return { byPerm, modules: [...out.entries()] };
  }, [q.data, filter]);

  const changes = [...pending.entries()].map(([k, grant]) => {
    const [roleKey = '', permission = ''] = k.split('|');
    return { roleKey: roleKey as RoleKey, permission, grant };
  });

  async function review(): Promise<void> {
    setError(null);
    try {
      setDiff(await previewMatrix({ changes }));
    } catch (e) {
      setError(e instanceof ApiError ? `${messageForCode(e.code)} ${e.problem.detail ?? ''}`.trim() : t('error.fallback'));
    }
  }

  async function apply(): Promise<void> {
    try {
      await m.apply.mutateAsync({ changes, ...(note.trim() ? { note: note.trim() } : {}) });
      setPending(new Map());
      setDiff(null);
      setNote('');
      toast({ title: t('settings.matrix.applied'), kind: 'success' });
    } catch (e) {
      setDiff(null);
      setError(e instanceof ApiError ? `${messageForCode(e.code)} ${e.problem.detail ?? ''}`.trim() : t('error.fallback'));
    }
  }

  return (
    <PageContainer wide>
      <SettingsHeader
        title={t('settings.roles')}
        lead={t('settings.matrix.lead')}
        actions={<Button variant="secondary" icon={<History aria-hidden size={16} />} onClick={() => { setHistoryOpen(true); }}>{t('settings.matrix.history')}</Button>}
      />
      {editable ? null : <ReadOnlyNotice />}
      {error ? <Alert kind="error" className="mb-4">{error}</Alert> : null}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Field label={t('settings.matrix.search')} hideLabel className="w-72 max-w-full">
          <div className="relative">
            <Search aria-hidden size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-muted" />
            <Input value={filter} onChange={(e) => { setFilter(e.target.value); }} placeholder={t('settings.matrix.search')} className="pl-8" aria-label={t('settings.matrix.search')} />
          </div>
        </Field>
        {q.data ? <span className="text-sm text-fg-muted">{t('settings.matrix.version', { version: String(q.data.version) })}</span> : null}
      </div>
      {q.isPending ? (
        <Skeleton className="h-96 w-full" />
      ) : q.isError ? (
        <ErrorState title={t('error.fallback')} retryLabel={t('common.retry')} onRetry={() => { void q.refetch(); }} />
      ) : (
        <div className="max-h-[65vh] overflow-auto rounded-card border border-line bg-surface">
          <table className="w-full border-collapse text-sm" data-testid="matrix">
            <caption className="sr-only">{t('settings.roles')}</caption>
            <thead className="sticky top-0 z-10 bg-surface">
              <tr>
                <th scope="col" className="sticky left-0 z-20 min-w-64 border-b border-line bg-surface px-3 py-2 text-left font-semibold">{t('settings.matrix.permission')}</th>
                {ROLES.map((r) => (
                  <th key={r} scope="col" className="min-w-36 border-b border-line px-2 py-2 text-left"><RoleBadge role={r} label={roleLabel(r)} /></th>
                ))}
              </tr>
            </thead>
            {groups.modules.map(([module, perms]) => (
              <tbody key={module}>
                <tr>
                  <th scope="colgroup" colSpan={ROLES.length + 1} className="sticky left-0 bg-subtle px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-fg-muted">{moduleLabel(module)}</th>
                </tr>
                {perms.map((perm) => (
                  <tr key={perm} className="border-b border-line last:border-b-0">
                    <th scope="row" className="sticky left-0 bg-surface px-3 py-1.5 text-left font-normal"><code className="text-xs">{perm}</code></th>
                    {ROLES.map((r) => {
                      const k = cellKey(r, perm);
                      const base = groups.byPerm.get(perm)?.cells.get(r);
                      const changed = pending.has(k);
                      const grant = changed ? (pending.get(k) ?? null) : (base?.grant ?? null);
                      const text = grantText(grant);
                      const content = (
                        <span className={cn('inline-flex max-w-full items-center gap-1 truncate rounded-input px-1.5 py-0.5 text-xs', grant ? 'text-fg' : 'text-fg-muted', changed && 'bg-warning-soft font-semibold', !changed && base?.overridden && 'bg-accent-soft')}>
                          {text}
                          {changed ? <span className="sr-only"> ({t('settings.matrix.changed')})</span> : base?.overridden ? <span className="sr-only"> ({t('settings.matrix.overridden')})</span> : null}
                        </span>
                      );
                      return (
                        <td key={r} className="px-2 py-1">
                          {editable ? (
                            <Popover>
                              <PopoverTrigger asChild>
                                <button type="button" className={cn('w-full rounded-input text-left hover:bg-subtle', focusRing)} aria-label={t('settings.matrix.cell', { role: roleLabel(r), permission: perm, grant: text })} data-testid="matrix-cell" data-role={r} data-permission={perm}>
                                  {content}
                                </button>
                              </PopoverTrigger>
                              <PopoverContent align="start" className="p-3">
                                <GrantEditor
                                  role={r}
                                  permission={perm}
                                  value={grant}
                                  onChange={(g) => {
                                    setPending((prev) => {
                                      const next = new Map(prev);
                                      if (JSON.stringify(g) === JSON.stringify(base?.grant ? clean(base.grant) : null)) next.delete(k);
                                      else next.set(k, g);
                                      return next;
                                    });
                                  }}
                                />
                              </PopoverContent>
                            </Popover>
                          ) : (
                            content
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
      {editable && changes.length > 0 ? (
        <div className="sticky bottom-4 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-card border border-line-strong bg-surface p-3 shadow-popover" role="region" aria-label={t('settings.matrix.pending')}>
          <span className="text-sm font-medium" aria-live="polite">{t('settings.matrix.pendingCount', { count: String(changes.length) })}</span>
          <span className="flex gap-2">
            <Button variant="ghost" onClick={() => { setPending(new Map()); }}>{t('settings.discard')}</Button>
            <Button onClick={() => { void review(); }} data-testid="matrix-review">{t('settings.matrix.review')}</Button>
          </span>
        </div>
      ) : null}

      <Dialog open={diff !== null} onOpenChange={(o) => { if (!o) setDiff(null); }}>
        <DialogContent title={t('settings.matrix.reviewTitle')} description={t('settings.matrix.reviewLead')} closeLabel={t('common.close')} wide>
          <table className="w-full text-sm" data-testid="matrix-diff">
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th scope="col" className="py-1">{t('settings.matrix.permission')}</th>
                <th scope="col" className="py-1">{t('settings.matrix.before')}</th>
                <th scope="col" className="py-1">{t('settings.matrix.after')}</th>
              </tr>
            </thead>
            <tbody>
              {diff?.changes.map((c) => (
                <tr key={cellKey(c.roleKey, c.permission)} className="border-t border-line">
                  <td className="py-1.5 pr-2">{roleLabel(c.roleKey)} · <code className="text-xs">{c.permission}</code></td>
                  <td className="py-1.5 pr-2 text-fg-muted">{grantText(c.before)}</td>
                  <td className="py-1.5 font-medium">{grantText(c.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {diff?.changes.length === 0 ? <p className="m-0 text-sm text-fg-muted">{t('settings.matrix.noDiff')}</p> : null}
          <Field label={t('settings.matrix.note')} className="mt-4">
            <Textarea value={note} onChange={(e) => { setNote(e.target.value); }} maxLength={500} rows={2} />
          </Field>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setDiff(null); }}>{t('common.cancel')}</Button>
            <Button loading={m.apply.isPending} disabled={diff?.changes.length === 0} onClick={() => { void apply(); }} data-testid="matrix-apply">{t('settings.matrix.apply')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent title={t('settings.matrix.history')} closeLabel={t('common.close')} wide>
          {versions.data?.data.length ? (
            <ol className="m-0 flex list-none flex-col divide-y divide-line p-0">
              {versions.data.data.map((v, i) => (
                <li key={v.version} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <span className="font-semibold tabular-nums">v{v.version}</span>
                  <span className="text-fg-muted">{dateTime(v.createdAt)}</span>
                  <span className="min-w-0 flex-1 truncate">{v.note ?? t('settings.matrix.overrideCount', { count: String(v.overrideCount) })}</span>
                  {editable && i > 0 ? (
                    <Button size="sm" variant="secondary" loading={m.restore.isPending} onClick={() => { m.restore.mutate(v.version, { onSuccess: () => { setHistoryOpen(false); toast({ title: t('settings.matrix.restored', { version: String(v.version) }), kind: 'success' }); } }); }}>
                      {t('settings.matrix.restore')}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="m-0 text-sm text-fg-muted">{t('settings.matrix.noHistory')}</p>
          )}
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}

export default function RolesPage() {
  return (
    <SettingsGate anyOf={['authz.matrix.read']}>
      <MatrixInner />
    </SettingsGate>
  );
}
