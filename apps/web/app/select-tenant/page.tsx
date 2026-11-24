'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ApiError, request, setAccessToken, type AccessToken } from '../../lib/api';
import { messageForCode } from '../../lib/errors';
import { roleLabel, t } from '../../lib/i18n';
import { tenantBlockOf, type TenantBlock } from '../../lib/security';
import { useRequireSession } from '../../lib/use-session';
import { AuthLayout, FormMessage } from '../_components/ui';
import { TenantBlockPanel } from './tenant-block';

export default function SelectTenantPage() {
  const router = useRouter();
  const { me } = useRequireSession();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  // The workspace's security policy asked for something first (P7d): resolved on this screen.
  const [blocked, setBlocked] = useState<{ tenant: { id: string; name: string }; block: TenantBlock } | null>(null);

  function choose(tenant: { id: string; name: string }): void {
    setChosen(tenant.id);
    setPending(true);
    setError(null);
    request<AccessToken>('/v1/auth/tenant', { method: 'POST', body: { tenantId: tenant.id } })
      .then((res) => {
        setAccessToken(res.accessToken);
        router.push('/');
      })
      .catch((err: unknown) => {
        const block = tenantBlockOf(err);
        if (block) setBlocked({ tenant, block });
        else setError(err instanceof ApiError ? messageForCode(err.code) : t('error.fallback'));
      })
      .finally(() => { setPending(false); });
  }

  // One workspace only: the person came here because it did not open; try it at once to show why.
  const autoTried = useRef(false);
  const only = me?.tenants.length === 1 ? me.tenants[0] : undefined;
  useEffect(() => {
    if (!only || autoTried.current) return;
    autoTried.current = true;
    choose(only);
    // choose is recreated each render; the ref makes this run once per page.
  }, [only]);

  if (blocked) {
    return (
      <AuthLayout title={t('tenant.title')}>
        <FormMessage message={error} />
        <TenantBlockPanel tenant={blocked.tenant} block={blocked.block} retrying={pending} onRetry={() => { choose(blocked.tenant); }} onBack={() => { setBlocked(null); }} />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t('tenant.title')} lead={me && me.tenants.length > 0 ? t('tenant.lead') : undefined}>
      <FormMessage message={error} />
      {!me ? <p role="status">{t('common.loading')}</p> : null}
      {me && me.tenants.length === 0 ? (
        <div>
          <h2>{t('tenant.empty.title')}</h2>
          <p className="muted">{t('tenant.empty.body')}</p>
        </div>
      ) : null}
      {me && me.tenants.length > 0 ? (
        <ul className="list">
          {me.tenants.map((tenant) => (
            <li key={tenant.id}>
              <button type="button" className="tenant-card" disabled={pending} aria-busy={pending && chosen === tenant.id} onClick={() => { choose(tenant); }}>
                <strong>{tenant.name}</strong>
                <span className="muted">{tenant.slug}</span>
                <span style={{ display: 'block' }}>
                  {tenant.roles.map((r) => (
                    <span key={r} className="badge">
                      {roleLabel(r)}
                    </span>
                  ))}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </AuthLayout>
  );
}
