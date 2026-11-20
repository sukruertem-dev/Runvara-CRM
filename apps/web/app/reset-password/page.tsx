'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { request } from '../../lib/api';
import { t } from '../../lib/i18n';
import { useAction } from '../../lib/use-action';
import { Alert, AuthLayout, Field, FormMessage, SubmitButton } from '../_components/ui';

function ResetInner() {
  const router = useRouter();
  const token = useSearchParams().get('token');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const { pending, errors, run, fail } = useAction();

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    if (password !== confirm) {
      fail({ form: null, fields: { confirm: t('reset.mismatch') } });
      return;
    }
    void run(async () => {
      await request('/v1/auth/password/reset', { method: 'POST', auth: false, body: { token, password } });
      router.push('/login');
    });
  }

  return (
    <AuthLayout title={t('reset.title')}>
      {!token ? <Alert kind="error">{t('reset.noToken')}</Alert> : null}
      <form onSubmit={onSubmit} noValidate aria-busy={pending}>
        <FormMessage message={errors.form} />
        <Field label={t('reset.password')} name="password" type="password" autoComplete="new-password" required value={password} onChange={(e) => { setPassword(e.target.value); }} hint={t('password.hint')} error={errors.fields.password} />
        <Field label={t('reset.confirm')} name="confirm" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => { setConfirm(e.target.value); }} error={errors.fields.confirm} />
        <SubmitButton pending={pending}>{t('reset.submit')}</SubmitButton>
      </form>
    </AuthLayout>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetInner />
    </Suspense>
  );
}
