'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiError, request, type Navigation, type Tenant } from '../lib/api';
import { messageForCode } from '../lib/errors';
import { moduleLabel, t } from '../lib/i18n';
import { isAdmin, useRequireSession } from '../lib/use-session';
import { AppShell } from './_components/app-shell';
import { Alert } from './_components/ui';

export default function HomePage() {
  const router = useRouter();
  const { me } = useRequireSession();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [nav, setNav] = useState<Navigation | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    if (!me.tenant) {
      router.replace('/select-tenant');
      return;
    }
    const live = { cancelled: false };
    void (async () => {
      try {
        const [tn, nv] = await Promise.all([request<Tenant>('/v1/tenant'), request<Navigation>('/v1/me/navigation')]);
        if (live.cancelled) return;
        setTenant(tn);
        setNav(nv);
      } catch (err) {
        if (live.cancelled) return;
        if (err instanceof ApiError && err.code === 'TENANT_REQUIRED') router.replace('/select-tenant');
        else setError(err instanceof ApiError ? messageForCode(err.code) : t('error.fallback'));
      }
    })();
    return () => {
      live.cancelled = true;
    };
  }, [me, router]);

  if (!me) {
    return (
      <main className="page">
        <h1 className="sr-only">Runvara</h1>
        <p role="status">{t('common.loading')}</p>
      </main>
    );
  }

  return (
    <AppShell me={me}>
      <h1 data-testid="tenant-heading">{tenant?.name ?? me.tenant?.name ?? ''}</h1>
      {error ? <Alert kind="error">{error}</Alert> : null}
      <section className="card" aria-labelledby="modules-h" style={{ marginBottom: '1rem' }}>
        <h2 id="modules-h">{t('home.modules')}</h2>
        {nav && nav.modules.length === 0 ? <p className="muted">{t('home.modules.empty')}</p> : null}
        <ul className="list">
          {nav?.modules.map((m) => (
            <li key={m.id}>{moduleLabel(m.displayNameKey)}</li>
          ))}
        </ul>
      </section>
      <section className="card" aria-labelledby="links-h">
        <h2 id="links-h">{t('home.links')}</h2>
        <ul className="list">
          <li>
            <Link href="/settings/security">{t('home.security')}</Link>
          </li>
          {isAdmin(me) ? (
            <>
              <li>
                <Link href="/settings/invitations">{t('home.invitations')}</Link>
              </li>
              <li>
                <Link href="/settings/modules">{t('home.moduleSettings')}</Link>
              </li>
            </>
          ) : null}
        </ul>
      </section>
    </AppShell>
  );
}
