'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { request, setAccessToken, type LoginResult } from '../../lib/api';
import { t } from '../../lib/i18n';
import { useAction } from '../../lib/use-action';
import { AuthLayout, Field, FormMessage, SubmitButton } from '../_components/ui';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { pending, errors, run } = useAction();

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    void run(async () => {
      const res = await request<LoginResult>('/v1/auth/login', { method: 'POST', auth: false, body: { email, password } });
      if (res.next === 'mfa') {
        sessionStorage.setItem('fx_mfa', JSON.stringify({ mfaToken: res.mfaToken }));
        router.push('/login/mfa');
        return;
      }
      setAccessToken(res.accessToken);
      router.push(res.next === 'done' ? '/' : '/select-tenant');
    });
  }

  return (
    <AuthLayout title={t('login.title')} lead={t('login.lead')}>
      <form onSubmit={onSubmit} noValidate aria-busy={pending}>
        <FormMessage message={errors.form} />
        <Field label={t('common.email')} name="email" type="email" autoComplete="username" required value={email} onChange={(e) => { setEmail(e.target.value); }} />
        <Field label={t('common.password')} name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => { setPassword(e.target.value); }} />
        <SubmitButton pending={pending}>{t('login.submit')}</SubmitButton>
      </form>
      <div className="links">
        <Link href="/forgot-password">{t('login.forgot')}</Link>
        <Link href="/signup">{t('login.create')}</Link>
      </div>
    </AuthLayout>
  );
}
