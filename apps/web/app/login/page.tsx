'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { request, setAccessToken, type LoginResult } from '../../lib/api';
import { t } from '../../lib/i18n';
import { discoverSso, type SsoDiscovery } from '../../lib/security';
import { useAction } from '../../lib/use-action';
import { Alert, AuthLayout, Field, FormMessage, SubmitButton } from '../_components/ui';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sso, setSso] = useState(false);
  const [providers, setProviders] = useState<SsoDiscovery['providers'] | null>(null);
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

  /** Single sign-on: providers for the e-mail's domain; one provider goes straight to the IdP (P7d). */
  function onSso(e: FormEvent): void {
    e.preventDefault();
    void run(async () => {
      const found = await discoverSso(email);
      const [first] = found.providers;
      if (found.providers.length === 1 && first) {
        window.location.assign(first.startUrl);
        return;
      }
      setProviders(found.providers);
    });
  }

  if (sso) {
    return (
      <AuthLayout title={t('login.sso')} lead={t('login.sso.lead')}>
        <form method="post" onSubmit={onSso} noValidate aria-busy={pending} data-testid="sso-form">
          <FormMessage message={errors.form} />
          <Field label={t('common.email')} name="email" type="email" autoComplete="username" required value={email} error={errors.fields.email} onChange={(e) => { setEmail(e.target.value); setProviders(null); }} />
          <SubmitButton pending={pending}>{t('login.sso.find')}</SubmitButton>
        </form>
        {providers && providers.length === 0 ? <Alert kind="warning">{t('login.sso.none')}</Alert> : null}
        {providers && providers.length > 1 ? (
          <ul className="list">
            {providers.map((p) => (
              <li key={p.id}>
                <a className="btn btn-secondary btn-block" href={p.startUrl}>{t('login.sso.with', { name: p.name })}</a>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="links">
          <button type="button" className="btn btn-secondary btn-small" onClick={() => { setSso(false); setProviders(null); }}>{t('login.sso.back')}</button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t('login.title')} lead={t('login.lead')}>
      <form method="post" onSubmit={onSubmit} noValidate aria-busy={pending}>
        <FormMessage message={errors.form} />
        <Field label={t('common.email')} name="email" type="email" autoComplete="username" required value={email} onChange={(e) => { setEmail(e.target.value); }} />
        <Field label={t('common.password')} name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => { setPassword(e.target.value); }} />
        <SubmitButton pending={pending}>{t('login.submit')}</SubmitButton>
      </form>
      <div className="links">
        <button type="button" className="btn btn-secondary btn-small" onClick={() => { setSso(true); }}>{t('login.sso')}</button>
        <Link href="/forgot-password">{t('login.forgot')}</Link>
        <Link href="/signup">{t('login.create')}</Link>
      </div>
    </AuthLayout>
  );
}
