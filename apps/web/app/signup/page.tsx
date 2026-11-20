'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { request } from '../../lib/api';
import { t } from '../../lib/i18n';
import { suggestSlug } from '../../lib/slug';
import { useAction } from '../../lib/use-action';
import { Alert, AuthLayout, Field, FormMessage, SubmitButton } from '../_components/ui';

export default function SignupPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [tenantName, setTenantName] = useState('');
  const [tenantSlug, setTenantSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [done, setDone] = useState(false);
  const { pending, errors, run } = useAction();

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    void run(async () => {
      await request('/v1/auth/signup', {
        method: 'POST',
        auth: false,
        body: { email, password, displayName, tenantName, tenantSlug, locale: 'tr-TR' },
      });
      setDone(true);
    });
  }

  if (done) {
    return (
      <AuthLayout title={t('signup.accepted.title')}>
        <Alert kind="success">{t('signup.accepted.body')}</Alert>
        <div className="links">
          <Link href="/login">{t('login.submit')}</Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t('signup.title')} lead={t('signup.lead')}>
      <form onSubmit={onSubmit} noValidate aria-busy={pending}>
        <FormMessage message={errors.form} />
        <Field label={t('signup.displayName')} name="displayName" autoComplete="name" required value={displayName} onChange={(e) => { setDisplayName(e.target.value); }} error={errors.fields.displayName} />
        <Field label={t('common.email')} name="email" type="email" autoComplete="email" required value={email} onChange={(e) => { setEmail(e.target.value); }} error={errors.fields.email} />
        <Field label={t('common.password')} name="password" type="password" autoComplete="new-password" required value={password} onChange={(e) => { setPassword(e.target.value); }} hint={t('password.hint')} error={errors.fields.password} />
        <Field
          label={t('signup.tenantName')}
          name="tenantName"
          autoComplete="organization"
          required
          value={tenantName}
          onChange={(e) => {
            setTenantName(e.target.value);
            if (!slugTouched) setTenantSlug(suggestSlug(e.target.value));
          }}
          error={errors.fields.tenantName}
        />
        <Field
          label={t('signup.tenantSlug')}
          name="tenantSlug"
          autoComplete="off"
          required
          value={tenantSlug}
          onChange={(e) => {
            setSlugTouched(true);
            setTenantSlug(e.target.value);
          }}
          hint={t('signup.tenantSlugHint')}
          error={errors.fields.tenantSlug}
        />
        <SubmitButton pending={pending}>{t('signup.submit')}</SubmitButton>
      </form>
      <div className="links">
        <span>{t('signup.haveAccount')}</span>
        <Link href="/login">{t('login.submit')}</Link>
      </div>
    </AuthLayout>
  );
}
