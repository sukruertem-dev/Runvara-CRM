'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { ApiError, bootstrapSession, request, type AcceptInvitation, type InvitationPreview } from '../../lib/api';
import { messageForCode } from '../../lib/errors';
import { roleLabel, t } from '../../lib/i18n';
import { useAction } from '../../lib/use-action';
import { Alert, AuthLayout, Field, FormMessage, SubmitButton } from '../_components/ui';

function InviteInner() {
  const router = useRouter();
  const token = useSearchParams().get('token');
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const { pending, errors, run } = useAction();

  useEffect(() => {
    if (!token) return;
    const live = { cancelled: false };
    void (async () => {
      try {
        const p = await request<InvitationPreview>('/v1/invitations/preview', { method: 'POST', auth: false, body: { token } });
        if (live.cancelled) return;
        setPreview(p);
        if (p.accountExists) {
          const ok = await bootstrapSession();
          // cancelled may flip while awaiting the session probe
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if (!live.cancelled) setSignedIn(ok);
        }
      } catch (err) {
        if (!live.cancelled) setLoadError(err instanceof ApiError ? messageForCode(err.code) : t('error.fallback'));
      }
    })();
    return () => {
      live.cancelled = true;
    };
  }, [token]);

  function onCreate(e: FormEvent): void {
    e.preventDefault();
    void run(async () => {
      await request<AcceptInvitation>('/v1/invitations/accept', { method: 'POST', auth: false, body: { token, displayName, password } });
      router.push('/login');
    });
  }

  function onAccept(): void {
    void run(async () => {
      await request<AcceptInvitation>('/v1/invitations/accept', { method: 'POST', body: { token } });
      router.push('/select-tenant');
    });
  }

  return (
    <AuthLayout title={t('invite.title')} lead={preview ? t('invite.lead', { tenant: preview.tenantName }) : undefined}>
      {!token ? <Alert kind="error">{t('invite.noToken')}</Alert> : null}
      {loadError ? <Alert kind="error">{loadError}</Alert> : null}
      {token && !preview && !loadError ? <p role="status">{t('common.loading')}</p> : null}
      {preview ? (
        <>
          <dl>
            <dt className="muted">{t('invite.email')}</dt>
            <dd style={{ margin: '0 0 0.75rem' }} data-testid="invite-email">
              {preview.email}
            </dd>
            <dt className="muted">{t('invite.role')}</dt>
            <dd style={{ margin: '0 0 1rem' }}>{roleLabel(preview.roleKey)}</dd>
          </dl>
          <FormMessage message={errors.form} />
          {!preview.accountExists ? (
            <form onSubmit={onCreate} noValidate aria-busy={pending}>
              <Field label={t('invite.displayName')} name="displayName" autoComplete="name" required value={displayName} onChange={(e) => { setDisplayName(e.target.value); }} error={errors.fields.displayName} />
              <Field label={t('common.password')} name="password" type="password" autoComplete="new-password" required value={password} onChange={(e) => { setPassword(e.target.value); }} hint={t('password.hint')} error={errors.fields.password} />
              <SubmitButton pending={pending}>{t('invite.createAccount')}</SubmitButton>
            </form>
          ) : signedIn ? (
            <button type="button" className="btn btn-block" disabled={pending} aria-busy={pending} onClick={onAccept}>
              {t('invite.accept')}
            </button>
          ) : (
            <p>
              {t('invite.signInAs', { email: preview.email })} <Link href="/login">{t('invite.signInLink')}</Link>
            </p>
          )}
        </>
      ) : null}
    </AuthLayout>
  );
}

export default function InvitePage() {
  return (
    <Suspense fallback={null}>
      <InviteInner />
    </Suspense>
  );
}
