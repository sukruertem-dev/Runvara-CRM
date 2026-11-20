'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { request, setAccessToken, type AccessToken } from '../../lib/api';
import { roleLabel, t } from '../../lib/i18n';
import { useAction } from '../../lib/use-action';
import { useRequireSession } from '../../lib/use-session';
import { AuthLayout, FormMessage } from '../_components/ui';

export default function SelectTenantPage() {
  const router = useRouter();
  const { me } = useRequireSession();
  const { pending, errors, run } = useAction();
  const [chosen, setChosen] = useState<string | null>(null);

  function choose(tenantId: string): void {
    setChosen(tenantId);
    void run(async () => {
      const res = await request<AccessToken>('/v1/auth/tenant', { method: 'POST', body: { tenantId } });
      setAccessToken(res.accessToken);
      router.push('/');
    });
  }

  return (
    <AuthLayout title={t('tenant.title')} lead={me && me.tenants.length > 0 ? t('tenant.lead') : undefined}>
      <FormMessage message={errors.form} />
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
              <button type="button" className="tenant-card" disabled={pending} aria-busy={pending && chosen === tenant.id} onClick={() => { choose(tenant.id); }}>
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
