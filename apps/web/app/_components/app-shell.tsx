'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { logout, type Me } from '../../lib/api';
import { t } from '../../lib/i18n';
import { Brand } from './ui';

export function AppShell({ me, children, wide = false }: { me: Me; children: ReactNode; wide?: boolean }) {
  const router = useRouter();

  async function onLogout(): Promise<void> {
    try {
      await logout();
    } catch {
      // The local session is dropped either way.
    }
    router.replace('/login');
  }

  return (
    <>
      <header className="topbar">
        <Link href="/" aria-label="Flexa">
          <Brand context="surface" />
        </Link>
        <nav aria-label={t('shell.nav')} style={{ display: 'contents' }}>
          {me.tenant ? (
            <span>
              <span className="muted">{t('shell.tenant')}: </span>
              <strong data-testid="tenant-name">{me.tenant.name}</strong>
            </span>
          ) : null}
          {me.tenants.length > 1 ? <Link href="/select-tenant">{t('shell.switch')}</Link> : null}
        </nav>
        <span className="spacer" />
        <span data-testid="user-name">{me.user.displayName}</span>
        <button type="button" className="btn btn-secondary btn-small" onClick={() => void onLogout()}>
          {t('shell.logout')}
        </button>
      </header>
      <main className="page" style={wide ? { maxWidth: 1200 } : undefined}>
        {children}
      </main>
    </>
  );
}
