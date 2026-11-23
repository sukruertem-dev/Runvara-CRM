'use client';

import { Badge, Button, Field, Input, Skeleton, useToast } from '@flexa/ui';
import { Download, FileArchive } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ApiError } from '../../../../lib/api';
import { useApp } from '../../../../lib/app-context';
import { messageForCode } from '../../../../lib/errors';
import { dateTime, formatNumber } from '../../../../lib/format';
import { t } from '../../../../lib/i18n';
import { downloadExport, useDeletion, useDeletionState, useExports, useStartExport } from '../../../../lib/operator';
import { formatBytes } from '../../../../lib/platform';
import { PageContainer } from '../../../_components/app-shell';
import { SettingsGate, SettingsHeader } from '../_parts/settings-nav';

// Data export and workspace deletion (TEN-05, KVKK/GDPR; docs/p7-plan.md §15).

const EXPORT_TONE = { pending: 'neutral', running: 'info', ready: 'success', failed: 'danger', expired: 'neutral' } as const;

export default function DataPage() {
  return (
    <PageContainer>
      <SettingsGate anyOf={['tenant.config.manage']}>
        <Data />
      </SettingsGate>
    </PageContainer>
  );
}

function Card({ title, body, children, testId, danger = false }: { title: string; body: string; children: ReactNode; testId: string; danger?: boolean }) {
  return (
    <section className={`mb-6 rounded-card border bg-surface p-4 ${danger ? 'border-danger' : 'border-line'}`} aria-label={title} data-testid={testId}>
      <h2 className="m-0 text-base font-semibold">{title}</h2>
      <p className="m-0 mb-3 mt-1 max-w-2xl text-sm text-fg-muted">{body}</p>
      {children}
    </section>
  );
}

const problem = (err: unknown): string => (err instanceof ApiError ? messageForCode(err.code) : t('error.fallback'));

function Data() {
  const { can, tenant } = useApp();
  const toast = useToast();
  const exports = useExports();
  const start = useStartExport();
  const deletionState = useDeletionState();
  const deletion = useDeletion();
  const [confirm, setConfirm] = useState('');
  const [reason, setReason] = useState('');
  const slug = tenant?.slug ?? '';
  const busy = exports.data?.data.some((e) => e.status === 'pending' || e.status === 'running') ?? false;

  return (
    <>
      <SettingsHeader title={t('data.title')} lead={t('data.lead')} />
      <Card title={t('data.export.title')} body={t('data.export.body')} testId="data-export">
        <Button icon={<FileArchive aria-hidden size={16} />} loading={start.isPending || busy} onClick={() => {
          start.mutate(undefined, { onSuccess: () => { toast.toast({ kind: 'info', title: t('data.export.started') }); }, onError: (err) => { toast.toast({ kind: 'error', title: problem(err) }); } });
        }}>
          {t('data.export.start')}
        </Button>
        {!exports.data ? <Skeleton className="mt-3 h-16 w-full" /> : exports.data.data.length === 0 ? (
          <p className="m-0 mt-3 text-sm text-fg-muted">{t('data.export.none')}</p>
        ) : (
          <ul className="m-0 mt-3 flex list-none flex-col gap-2 p-0" data-testid="export-list">
            {exports.data.data.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2 rounded-input border border-line px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">{dateTime(e.createdAt)}{e.sizeBytes !== null && e.rowCount !== null ? ` · ${t('data.export.size', { size: formatBytes(e.sizeBytes, formatNumber), rows: formatNumber(e.rowCount) })}` : ''}</span>
                <Badge tone={EXPORT_TONE[e.status]}>{t(`data.export.status.${e.status}`)}</Badge>
                {e.status === 'ready' ? (
                  <Button size="sm" variant="secondary" icon={<Download aria-hidden size={14} />} onClick={() => { downloadExport(e.id).catch((err: unknown) => { toast.toast({ kind: 'error', title: problem(err) }); }); }}>
                    {t('data.export.download')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {can('tenant.modules.manage') ? (
        <Card title={t('data.delete.title')} body={t('data.delete.body', { days: String(deletionState.data?.graceDays ?? 30) })} testId="data-delete" danger>
          <div className="flex max-w-md flex-col gap-3">
            <Field label={t('data.delete.confirm', { slug })}>
              <Input value={confirm} autoComplete="off" onChange={(e) => { setConfirm(e.target.value); }} data-testid="delete-confirm" />
            </Field>
            <Field label={t('data.delete.reason')}>
              <Input value={reason} maxLength={500} onChange={(e) => { setReason(e.target.value); }} />
            </Field>
            <div>
              <Button variant="danger" disabled={confirm.trim().toLowerCase() !== slug.toLowerCase() || !slug} loading={deletion.isPending} onClick={() => {
                deletion.mutateAsync({ action: 'schedule', confirmSlug: confirm.trim(), ...(reason.trim() ? { reason: reason.trim() } : {}) }).then(
                  () => { toast.toast({ kind: 'success', title: t('data.delete.scheduled') }); },
                  (err: unknown) => { toast.toast({ kind: 'error', title: problem(err) }); },
                );
              }} data-testid="delete-schedule">
                {t('data.delete.action')}
              </Button>
            </div>
          </div>
        </Card>
      ) : null}
    </>
  );
}
