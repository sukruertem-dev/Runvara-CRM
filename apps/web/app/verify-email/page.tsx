'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, request } from '../../lib/api';
import { messageForCode } from '../../lib/errors';
import { t } from '../../lib/i18n';
import { useAction } from '../../lib/use-action';
import { Alert, AuthLayout, Field, FormMessage, SubmitButton } from '../_components/ui';

type State = 'working' | 'ok' | 'expired' | 'error' | 'missing';

function VerifyInner() {
  const token = useSearchParams().get('token');
  const [state, setState] = useState<State>(token ? 'working' : 'missing');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [resent, setResent] = useState(false);
  const { pending, errors, run } = useAction();
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    void (async () => {
      try {
        await request('/v1/auth/email/verify', { method: 'POST', auth: false, body: { token } });
        setState('ok');
      } catch (err) {
        if (err instanceof ApiError && (err.status === 410 || err.status === 400)) {
          setState('expired');
        } else {
          setErrorText(err instanceof ApiError ? messageForCode(err.code) : t('error.fallback'));
          setState('error');
        }
      }
    })();
  }, [token]);

  function onResend(e: FormEvent): void {
    e.preventDefault();
    void run(async () => {
      await request('/v1/auth/email/resend', { method: 'POST', auth: false, body: { email } });
      setResent(true);
    });
  }

  return (
    <AuthLayout title={t('verify.title')}>
      {state === 'working' ? <p role="status">{t('verify.working')}</p> : null}
      {state === 'missing' ? <Alert kind="error">{t('verify.noToken')}</Alert> : null}
      {state === 'error' ? <Alert kind="error">{errorText}</Alert> : null}
      {state === 'ok' ? (
        <>
          <Alert kind="success">{t('verify.success')}</Alert>
          <Link className="btn btn-block" href="/login">
            {t('verify.goLogin')}
          </Link>
        </>
      ) : null}
      {state === 'expired' || state === 'missing' ? (
        <>
          {state === 'expired' ? <Alert kind="error">{t('verify.expired')}</Alert> : null}
          {resent ? <Alert kind="success">{t('verify.resent')}</Alert> : null}
          <form method="post" onSubmit={onResend} noValidate aria-busy={pending}>
            <FormMessage message={errors.form} />
            <Field label={t('common.email')} name="email" type="email" autoComplete="email" required value={email} onChange={(e) => { setEmail(e.target.value); }} error={errors.fields.email} />
            <SubmitButton pending={pending}>{t('verify.resend')}</SubmitButton>
          </form>
        </>
      ) : null}
    </AuthLayout>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyInner />
    </Suspense>
  );
}
