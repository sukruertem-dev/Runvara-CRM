'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { request, setAccessToken, type Session } from '../../../lib/api';
import { t } from '../../../lib/i18n';
import { useAction } from '../../../lib/use-action';
import { Alert, AuthLayout, Field, FormMessage, SubmitButton } from '../../_components/ui';

function readMfaToken(): string | null {
  try {
    const raw = sessionStorage.getItem('fx_mfa');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { mfaToken?: unknown };
    return typeof parsed.mfaToken === 'string' ? parsed.mfaToken : null;
  } catch {
    return null;
  }
}

export default function MfaPage() {
  const router = useRouter();
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [missing, setMissing] = useState(false);
  const { pending, errors, run } = useAction();

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    const mfaToken = readMfaToken();
    if (!mfaToken) {
      setMissing(true);
      return;
    }
    void run(async () => {
      const body = recovery ? { mfaToken, recoveryCode: recoveryCode.trim() } : { mfaToken, code: code.trim() };
      const res = await request<Session>('/v1/auth/mfa/verify', { method: 'POST', auth: false, body });
      sessionStorage.removeItem('fx_mfa');
      setAccessToken(res.accessToken);
      router.push(res.next === 'done' ? '/' : '/select-tenant');
    });
  }

  return (
    <AuthLayout title={t('mfa.title')} lead={t('mfa.lead')}>
      {missing ? (
        <Alert kind="error">
          {t('mfa.missing')} <Link href="/login">{t('login.submit')}</Link>
        </Alert>
      ) : null}
      <form onSubmit={onSubmit} noValidate aria-busy={pending}>
        <FormMessage message={errors.form} />
        {recovery ? (
          <Field key="recovery" label={t('mfa.recoveryCode')} name="recoveryCode" autoComplete="off" autoFocus required value={recoveryCode} onChange={(e) => { setRecoveryCode(e.target.value); }} />
        ) : (
          <Field key="code" label={t('mfa.code')} name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6} autoFocus required value={code} onChange={(e) => { setCode(e.target.value); }} />
        )}
        <SubmitButton pending={pending}>{t('mfa.submit')}</SubmitButton>
      </form>
      <div className="links">
        <button
          type="button"
          className="btn btn-secondary btn-small"
          onClick={() => {
            setRecovery((v) => !v);
          }}
        >
          {recovery ? t('mfa.useCode') : t('mfa.useRecovery')}
        </button>
      </div>
    </AuthLayout>
  );
}
