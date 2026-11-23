'use client';

import { Badge, Button, EmptyState, ErrorState, Input, Skeleton, useToast } from '@flexa/ui';
import { LifeBuoy } from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '../../../../lib/api';
import { messageForCode } from '../../../../lib/errors';
import { dateTime } from '../../../../lib/format';
import { moduleLabel, t } from '../../../../lib/i18n';
import { GRANT_TONE, useDecideGrant, useSupportGrants, type Grant } from '../../../../lib/operator';
import { PageContainer } from '../../../_components/app-shell';
import { SettingsGate, SettingsHeader } from '../_parts/settings-nav';

// Support access requests of the workspace (TEN-08, docs/p7-plan.md §14): only Admins decide.

export default function SupportAccessPage() {
  return (
    <PageContainer>
      <SettingsGate anyOf={['tenant.config.manage']}>
        <Support />
      </SettingsGate>
    </PageContainer>
  );
}

function Support() {
  const grants = useSupportGrants();
  const header = <SettingsHeader title={t('support.title')} lead={t('support.lead')} />;
  if (grants.isError) return <>{header}<ErrorState title={t('error.fallback')} retryLabel={t('common.retry')} onRetry={() => { void grants.refetch(); }} /></>;
  if (!grants.data) return <>{header}<Skeleton className="h-48 w-full" /></>;
  return (
    <>
      {header}
      {grants.data.data.length === 0 ? (
        <EmptyState icon={LifeBuoy} title={t('support.empty')} description="" />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0" data-testid="support-grants">
          {grants.data.data.map((g) => <GrantCard key={g.id} grant={g} />)}
        </ul>
      )}
    </>
  );
}

function GrantCard({ grant: g }: { grant: Grant }) {
  const decide = useDecideGrant();
  const toast = useToast();
  const [note, setNote] = useState('');
  const act = (action: 'approve' | 'deny' | 'revoke') => {
    decide.mutate({ id: g.id, action, ...(note.trim() ? { note: note.trim() } : {}) }, {
      onSuccess: () => { toast.toast({ kind: 'success', title: t(action === 'approve' ? 'support.approved' : action === 'deny' ? 'support.denied' : 'support.revoked') }); },
      onError: (err) => { toast.toast({ kind: 'error', title: err instanceof ApiError ? messageForCode(err.code) : t('error.fallback') }); },
    });
  };
  return (
    <li className="rounded-card border border-line bg-surface p-4" data-testid={`grant-${g.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="m-0 text-sm font-semibold">{t('support.by', { name: g.operator.name, date: dateTime(g.requestedAt) })}</p>
          <p className="m-0 mt-1 text-sm">{g.reason}</p>
          <p className="m-0 mt-1 text-xs text-fg-muted">
            {t('grant.duration', { minutes: String(g.durationMinutes) })} · {g.modules.length ? g.modules.map(moduleLabel).join(', ') : t('grant.allModules')}
            {g.status === 'approved' && g.validUntil ? ` · ${t('op.grants.until', { date: dateTime(g.validUntil) })}` : ''}
          </p>
        </div>
        <Badge tone={GRANT_TONE[g.status]}>{t(`grant.status.${g.status}`)}</Badge>
      </div>
      {g.status === 'pending' ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="w-72 max-w-full">
            <Input value={note} maxLength={500} placeholder={t('support.note')} aria-label={t('support.note')} onChange={(e) => { setNote(e.target.value); }} />
          </div>
          <Button loading={decide.isPending} onClick={() => { act('approve'); }}>{t('support.approve')}</Button>
          <Button variant="secondary" disabled={decide.isPending} onClick={() => { act('deny'); }}>{t('support.deny')}</Button>
        </div>
      ) : null}
      {g.status === 'approved' ? (
        <div className="mt-3">
          <Button variant="danger" loading={decide.isPending} onClick={() => { act('revoke'); }}>{t('support.revoke')}</Button>
        </div>
      ) : null}
    </li>
  );
}
