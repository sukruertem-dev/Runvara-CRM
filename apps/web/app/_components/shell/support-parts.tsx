'use client';

import { Button, EmptyState, useToast } from '@flexa/ui';
import { LifeBuoy, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { ApiError } from '../../../lib/api';
import { useApp } from '../../../lib/app-context';
import { messageForCode } from '../../../lib/errors';
import { dateTime, formatDate } from '../../../lib/format';
import { t } from '../../../lib/i18n';
import { downloadExport, exitSupport, useDeletion, useDeletionState, useExports, useStartExport } from '../../../lib/operator';

// Support access and pending deletion in the shell (TEN-05, TEN-08; docs/p7-plan.md §14–15).

/** While support access is active: the operator sees that they are in support mode and can leave; the
 *  workspace Admins see who has access and until when, with a link to end it. */
export function SupportBanner() {
  const { nav } = useApp();
  const toast = useToast();
  const s = nav?.support;
  if (!s) return null;
  const vars = { name: s.operatorName, date: dateTime(s.validUntil) };
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 border-b border-line bg-info-soft px-4 py-1.5 text-sm text-info" data-testid="support-banner">
      <LifeBuoy aria-hidden size={15} />
      <span>{t(s.role === 'operator' ? 'support.banner.operator' : 'support.banner.observed', vars)}</span>
      {s.role === 'operator' ? (
        <Button size="sm" variant="secondary" onClick={() => {
          exitSupport().catch((err: unknown) => { toast.toast({ kind: 'error', title: err instanceof ApiError ? messageForCode(err.code) : t('error.fallback') }); });
        }}>
          {t('support.banner.exit')}
        </Button>
      ) : (
        <Link href="/settings/support" className="font-semibold text-current underline">{t('support.banner.manage')}</Link>
      )}
    </div>
  );
}

/** Shown instead of every screen while the workspace waits for deletion: Admins may cancel or export. */
export function PendingDeletion() {
  const { can } = useApp();
  const admin = can('tenant.modules.manage');
  const state = useDeletionState();
  const exports = useExports(admin);
  const startExport = useStartExport();
  const deletion = useDeletion();
  const toast = useToast();
  const fail = (err: unknown) => { toast.toast({ kind: 'error', title: err instanceof ApiError ? messageForCode(err.code) : t('error.fallback') }); };
  const date = state.data?.deletionScheduledAt ? formatDate(state.data.deletionScheduledAt) : '';
  const ready = exports.data?.data.find((e) => e.status === 'ready');
  const busy = exports.data?.data.some((e) => e.status === 'pending' || e.status === 'running') ?? false;
  return (
    <div className="mx-auto max-w-2xl px-4 py-10" data-testid="pending-deletion">
      <EmptyState
        icon={Trash2}
        title={t('pending.title')}
        description={admin ? t('pending.body', { date }) : t('pending.member')}
        action={admin ? (
          <div className="flex flex-wrap justify-center gap-2">
            <Button loading={deletion.isPending} onClick={() => {
              deletion.mutate({ action: 'cancel' }, { onSuccess: () => { toast.toast({ kind: 'success', title: t('pending.cancelled') }); }, onError: fail });
            }}>
              {t('pending.cancel')}
            </Button>
            {ready ? (
              <Button variant="secondary" onClick={() => { downloadExport(ready.id).catch(fail); }}>{t('data.export.download')}</Button>
            ) : (
              <Button variant="secondary" loading={startExport.isPending || busy} onClick={() => {
                startExport.mutate(undefined, { onSuccess: () => { toast.toast({ kind: 'info', title: t('data.export.started') }); }, onError: fail });
              }}>
                {t('pending.export')}
              </Button>
            )}
          </div>
        ) : undefined}
      />
    </div>
  );
}
