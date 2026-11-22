'use client';

import { Button, ModuleIcon, RoleBadge, SegmentBadge, Skeleton } from '@flexa/ui';
import { ArrowRight, Plus } from 'lucide-react';
import Link from 'next/link';
import { useApp } from '../../lib/app-context';
import { moduleLabel, roleLabel, t } from '../../lib/i18n';
import { PageContainer } from '../_components/app-shell';
import { menuLabel } from '../_components/shell/sidebar';
import { useShell } from '../_components/shell/shell-context';

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

      {/* Bento: menu entries as cards, sized by importance (§10.5.1 §3). */}
      <section aria-labelledby="modules-h">
        <h2 id="modules-h" className="mb-3 font-display text-lg font-bold">
          {t('home.modules')}
        </h2>
        {!nav ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </div>
        ) : nav.menu.length === 0 ? (
          <p className="text-sm text-fg-muted">{t('home.modules.empty')}</p>
        ) : (
          <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3">
            {nav.menu.map((item, i) => (
              <li key={item.id} className={i === 0 ? 'sm:col-span-2' : undefined}>
                <Link
                  href={item.path}
                  className="group flex h-full flex-col gap-3 rounded-card border border-line bg-surface p-4 text-fg no-underline shadow-card transition-colors hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <span className="inline-flex size-9 items-center justify-center rounded-btn bg-accent-soft text-fg">
                    <ModuleIcon name={item.icon} size={18} />
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="font-display text-base font-bold">{menuLabel(item)}</span>
                    <ArrowRight aria-hidden size={16} className="text-fg-muted transition-transform group-hover:translate-x-0.5" />
                  </span>
                  <span className="text-xs text-fg-muted">{moduleLabel(item.module)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </PageContainer>
  );
}
