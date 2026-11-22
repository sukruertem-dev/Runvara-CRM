'use client';

import { Button, RoleBadge, SegmentBadge } from '@flexa/ui';
import { Plus } from 'lucide-react';
import { useApp } from '../../lib/app-context';
import { roleLabel, t } from '../../lib/i18n';
import { PageContainer } from '../_components/app-shell';
import { useShell } from '../_components/shell/shell-context';
import { Dashboard } from './_dashboard/dashboard';

export default function HomePage() {
  const { me, tenant, nav, can } = useApp();
  const { setNewTaskOpen } = useShell();
  const hasTasks = nav?.menu.some((m) => m.id === 'tasks') ?? false;

  return (
    <PageContainer wide>
      <div className="mb-6 flex flex-wrap items-end gap-4">
        <div className="min-w-0 flex-1">
          <p className="m-0 text-sm text-fg-muted">{me.user.displayName}</p>
          <h1 className="m-0 font-display text-2xl font-bold" data-testid="tenant-heading">
            {tenant?.name ?? me.tenant?.name ?? ''}
          </h1>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(nav?.roles ?? []).map((r) => (
              <RoleBadge key={r} role={r} label={roleLabel(r)} />
            ))}
            {(nav?.segments ?? []).map((s) => (
              <SegmentBadge key={s} segment={s} label={t(`shell.segment.${s}`)} />
            ))}
          </div>
        </div>
        {hasTasks && can('task.create') ? (
          <Button icon={<Plus aria-hidden size={16} />} onClick={() => { setNewTaskOpen(true); }}>
            {t('tasks.new')}
          </Button>
        ) : null}
      </div>

      <Dashboard />
    </PageContainer>
  );
}
