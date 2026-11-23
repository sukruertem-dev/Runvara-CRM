'use client';

import { Alert, Badge, Button, Dialog, DialogContent, DialogFooter, EmptyState, ErrorState, Field, Select, Skeleton, Textarea, useToast } from '@flexa/ui';
import { History, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '../../../../lib/api';
import { useApp } from '../../../../lib/app-context';
import { useConfigHistory, useConfigKeys, useRevertConfig, type ConfigVersion } from '../../../../lib/config';
import { messageForCode } from '../../../../lib/errors';
import { dateTime, fmt } from '../../../../lib/format';
import { t } from '../../../../lib/i18n';
import { PageContainer } from '../../../_components/app-shell';
import { keyLabel, PatchList } from '../_parts/config-parts';
import { ReadOnlyNotice, SettingsGate, SettingsHeader } from '../_parts/settings-nav';

export default function ConfigHistoryPage() {
  return (
    <PageContainer>
      <SettingsGate anyOf={['tenant.config.read']}>
        <HistoryScreen />
      </SettingsGate>
    </PageContainer>
  );
}

function HistoryScreen() {
  const keys = useConfigKeys();
  const tenantKeys = keys.data?.data.filter((k) => k.overridableAt.includes('tenant')).map((k) => k.key) ?? [];
  const [key, setKey] = useState('locale');
  const { can } = useApp();
  return (
    <>
      <SettingsHeader title={t('config.history.title')} lead={t('config.history.lead')} />
      {can('tenant.config.manage') ? null : <ReadOnlyNotice />}
      <div className="mb-4 max-w-xs">
        <Field label={t('config.history.key')}>
          <Select value={key} onValueChange={setKey} options={tenantKeys.map((k) => ({ value: k, label: keyLabel(k) }))} data-testid="history-key" />
        </Field>
      </div>
      <Versions key={key} configKey={key} />
    </>
  );
}

function Versions({ configKey }: { configKey: string }) {
  const history = useConfigHistory(configKey, 'tenant');
  const { can } = useApp();
  const [target, setTarget] = useState<ConfigVersion | null>(null);
  if (history.isError) return <ErrorState title={t('error.fallback')} retryLabel={t('common.retry')} onRetry={() => void history.refetch()} />;
  if (!history.data) return <Skeleton className="h-40 w-full" />;
  const { data, current } = history.data;
  if (data.length === 0) return <EmptyState icon={History} title={t('config.history.empty')} description={t('config.history.emptyBody')} />;
  return (
    <>
      <ol className="m-0 flex list-none flex-col gap-3 p-0" data-testid="history-list">
        {data.map((v) => (
          <li key={v.version} className="flex flex-col gap-2 rounded-card border border-line bg-surface p-3" data-testid={`version-${String(v.version)}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold tabular-nums">{fmt('config.history.version', { n: v.version })}</span>
              {v.version === current ? <Badge tone="accent">{t('config.history.current')}</Badge> : null}
              {v.revertedFrom !== null ? <Badge tone="outline">{fmt('config.history.revertedFrom', { n: v.revertedFrom })}</Badge> : null}
              <span className="text-sm text-fg-muted">{`${v.createdBy?.name ?? t('config.history.system')} · ${dateTime(v.createdAt)}`}</span>
              {can('tenant.config.manage') && v.version !== current ? (
                <Button size="sm" variant="secondary" className="ml-auto" icon={<RotateCcw aria-hidden size={14} />} onClick={() => { setTarget(v); }} data-testid={`revert-${String(v.version)}`}>
                  {t('config.history.revert')}
                </Button>
              ) : null}
            </div>
            {v.note ? <p className="m-0 text-sm italic text-fg-muted">{v.note}</p> : null}
            <PatchList configKey={configKey} patch={v.patch} />
          </li>
        ))}
      </ol>
      {target ? <RevertDialog configKey={configKey} target={target} current={current} onClose={() => { setTarget(null); }} /> : null}
    </>
  );
}

function RevertDialog({ configKey, target, current, onClose }: { configKey: string; target: ConfigVersion; current: number; onClose: () => void }) {
  const revert = useRevertConfig();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function apply(): Promise<void> {
    setError(null);
    try {
      await revert.mutateAsync({ key: configKey, scope: 'tenant', target: target.version, version: current, ...(note.trim() ? { note: note.trim() } : {}) });
      toast.toast({ kind: 'success', title: fmt('config.history.reverted', { n: target.version }) });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? messageForCode(e.code) : t('error.fallback'));
    }
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={fmt('config.history.revertTitle', { n: target.version })} description={t('config.history.revertLead')} closeLabel={t('common.close')}>
        <div className="flex flex-col gap-3" data-testid="revert-dialog">
          {error ? <Alert kind="error">{error}</Alert> : null}
          <p className="m-0 text-sm">{t('config.history.revertValue')}</p>
          <pre className="m-0 overflow-x-auto rounded-input bg-subtle p-2 text-xs">{JSON.stringify(target.value, null, 2)}</pre>
          <Field label={t('config.note')} hint={t('config.noteHint')}>
            <Textarea value={note} maxLength={500} rows={2} onChange={(e) => { setNote(e.target.value); }} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={() => void apply()} disabled={revert.isPending} data-testid="revert-apply">{revert.isPending ? t('common.pending') : t('config.history.revert')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
