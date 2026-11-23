'use client';

import { Badge, Button, EmptyState, Skeleton, useToast } from '@flexa/ui';
import { LifeBuoy } from 'lucide-react';
import { ApiError } from '../../../lib/api';
import { messageForCode } from '../../../lib/errors';
import { dateTime } from '../../../lib/format';
import { moduleLabel, t } from '../../../lib/i18n';
import { enterSupport, GRANT_TONE, useCancelGrant, useOperatorGrants } from '../../../lib/operator';
import { OperatorError } from '../_parts';

// The operator's own support requests: open an approved one read-only, withdraw or end it.

export default function OperatorSupportPage() {
  const grants = useOperatorGrants();
  const cancel = useCancelGrant();
  const toast = useToast();
  const fail = (err: unknown) => { toast.toast({ kind: 'error', title: err instanceof ApiError ? messageForCode(err.code) : t('error.fallback') }); };
  return (
    <>
      <h1 className="m-0 mb-5 font-display text-xl font-bold">{t('op.grants.title')}</h1>
      {grants.isError ? <OperatorError error={grants.error} onRetry={() => { void grants.refetch(); }} /> : !grants.data ? <Skeleton className="h-48 w-full" /> : grants.data.data.length === 0 ? (
        <EmptyState icon={LifeBuoy} title={t('op.grants.empty')} description="" />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0" data-testid="op-grants">
          {grants.data.data.map((g) => (
            <li key={g.id} className="flex flex-wrap items-start gap-3 rounded-card border border-line bg-surface p-4" data-testid={`op-grant-${g.id}`}>
              <div className="min-w-0 flex-1">
                <p className="m-0 text-sm font-semibold">{g.reason}</p>
                <p className="m-0 mt-1 text-xs text-fg-muted">
                  {dateTime(g.requestedAt)} · {t('grant.duration', { minutes: String(g.durationMinutes) })} · {g.modules.length ? g.modules.map(moduleLabel).join(', ') : t('grant.allModules')}
                  {g.status === 'approved' && g.validUntil ? ` · ${t('op.grants.until', { date: dateTime(g.validUntil) })}` : ''}
                </p>
              </div>
              <Badge tone={GRANT_TONE[g.status]}>{t(`grant.status.${g.status}`)}</Badge>
              {g.status === 'approved' ? (
                <>
                  <Button size="sm" onClick={() => { enterSupport(g.id).catch(fail); }}>{t('op.grants.enter')}</Button>
                  <Button size="sm" variant="secondary" loading={cancel.isPending} onClick={() => { cancel.mutate(g.id, { onError: fail }); }}>{t('op.grants.end')}</Button>
                </>
              ) : null}
              {g.status === 'pending' ? (
                <Button size="sm" variant="secondary" loading={cancel.isPending} onClick={() => { cancel.mutate(g.id, { onError: fail }); }}>{t('op.grants.cancel')}</Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
