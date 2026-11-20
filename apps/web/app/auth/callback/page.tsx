'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { bootstrapSession, request, type Me } from '../../../lib/api';
import { t } from '../../../lib/i18n';
import { Alert, AuthLayout } from '../../_components/ui';

export default function OidcCallbackPage() {
  const router = useRouter();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const live = { cancelled: false };
    void (async () => {
      try {
        if (!(await bootstrapSession())) throw new Error('no session');
        const me = await request<Me>('/v1/me');
        if (!live.cancelled) router.replace(me.tenant ? '/' : '/select-tenant');
      } catch {
        if (!live.cancelled) setFailed(true);
      }
    })();
    return () => {
      live.cancelled = true;
    };
  }, [router]);

  return (
    <AuthLayout title={t('callback.title')}>
      {failed ? (
        <>
          <Alert kind="error">{t('callback.failed')}</Alert>
          <Link href="/login">{t('login.submit')}</Link>
        </>
      ) : (
        <p role="status">{t('callback.working')}</p>
      )}
    </AuthLayout>
  );
}
