'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { request } from '../../lib/api';
import { t } from '../../lib/i18n';
import { useAction } from '../../lib/use-action';
import { Alert, AuthLayout, Field, FormMessage, SubmitButton } from '../_components/ui';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const { pending, errors, run } = useAction();

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    void run(async () => {
      await request('/v1/auth/password/forgot', { method: 'POST', auth: false, body: { email } });
      setDone(true);
    });
  }

  return (
    <AuthLayout title={t('forgot.title')} lead={done ? undefined : t('forgot.lead')}>
      {done ? (
        <Alert kind="success">{t('forgot.done')}</Alert>
      ) : (
        <form method="post" onSubmit={onSubmit} noValidate aria-busy={pending}>
          <FormMessage message={errors.form} />
          <Field label={t('common.email')} name="email" type="email" autoComplete="email" required value={email} onChange={(e) => { setEmail(e.target.value); }} error={errors.fields.email} />
          <SubmitButton pending={pending}>{t('forgot.submit')}</SubmitButton>
        </form>
      )}
      <div className="links">
        <Link href="/login">{t('forgot.back')}</Link>
      </div>
    </AuthLayout>
  );
}
