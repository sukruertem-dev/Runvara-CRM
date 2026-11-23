'use client';

import { Button, cn, EmptyState, focusRing, Skeleton } from '@flexa/ui';
import { ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { t } from '../../lib/i18n';
import { exitSupport } from '../../lib/operator';
import { useRequireSession } from '../../lib/use-session';
import { Brand } from '../_components/ui';

// Platform operator console (TEN-08, docs/p7-plan.md §13, B72): its own area and layout, not the workspace
// shell. The API decides every request (operator mark, second factor); this only shapes the screen.

const NAV = [
  { href: '/operator', label: 'op.nav.tenants' },
  { href: '/operator/support', label: 'op.nav.support' },
] as const;

export default function OperatorLayout({ children }: { children: ReactNode }) {
  const { me } = useRequireSession();
  const pathname = usePathname();
  if (!me) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <p role="status" className="sr-only">{t('common.loading')}</p>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (!me.operator) {
    return <main className="p-6"><EmptyState icon={ShieldAlert} title={t('op.notOperator')} description="" action={<Button asChild variant="secondary"><Link href="/">{t('op.back')}</Link></Button>} /></main>;
  }
  const inSupport = me.tenant?.roles.includes('support') ?? false;
  return (
    <div className="min-h-dvh bg-canvas text-fg">
      <header className="flex flex-wrap items-center gap-4 border-b border-line bg-surface px-4 py-3">
        <Brand context="surface" />
        <span className="rounded-full bg-subtle px-2 py-0.5 text-xs font-semibold">{t('op.title')}</span>
        <nav aria-label={t('op.title')} className="flex gap-1">
          {NAV.map((n) => {
            const active = n.href === '/operator' ? pathname === '/operator' || pathname.startsWith('/operator/tenants') : pathname.startsWith(n.href);
            return (
              <Link key={n.href} href={n.href} aria-current={active ? 'page' : undefined}
                className={cn('rounded-btn px-2.5 py-1.5 text-sm no-underline', active ? 'bg-subtle font-semibold text-fg' : 'text-fg-muted hover:bg-subtle hover:text-fg', focusRing)}>
                {t(n.label)}
              </Link>
            );
          })}
        </nav>
        <span className="ml-auto text-sm text-fg-muted">{me.user.displayName}</span>
        {me.tenants.length > 0 ? <Button asChild size="sm" variant="secondary"><Link href="/">{t('op.back')}</Link></Button> : null}
      </header>
      <main id="main" className="mx-auto max-w-6xl px-4 py-6">
        {inSupport ? (
          <EmptyState icon={ShieldAlert} title={t('op.inSupport')} description="" action={<Button onClick={() => { void exitSupport(); }}>{t('support.banner.exit')}</Button>} />
        ) : children}
      </main>
    </div>
  );
}
