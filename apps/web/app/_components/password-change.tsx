'use client';

import { useState, type FormEvent } from 'react';
import { ApiError } from '../../lib/api';
import { messageForCode } from '../../lib/errors';
import { t } from '../../lib/i18n';
import { changePassword, passwordReasonText } from '../../lib/security';
import { Field, FormMessage, SubmitButton } from './ui';

/** Password change with the current password. With `tenantId` the new password must also meet that
 *  workspace's rules (the block screen); other sessions end (P7d). */
export function PasswordChangeForm({ tenantId, minLength, onDone }: { tenantId?: string; minLength?: number; onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    setPending(true);
    setFormError(null);
    setFieldError(undefined);
    changePassword({ currentPassword: current, newPassword: next, ...(tenantId ? { tenantId } : {}) })
      .then(() => {
        setCurrent('');
        setNext('');
        onDone();
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.code === 'PASSWORD_POLICY') {
          const rules = err.problem.rules as { minLength?: number } | undefined;
          setFieldError(passwordReasonText(err.reasons, rules?.minLength ?? minLength) || messageForCode(err.code));
        } else {
          setFormError(err instanceof ApiError ? messageForCode(err.code) : t('error.fallback'));
        }
      })
      .finally(() => { setPending(false); });
  }

  return (
    <form method="post" onSubmit={onSubmit} noValidate aria-busy={pending} data-testid="password-change">
      <FormMessage message={formError} />
      <Field label={t('security.password.current')} name="current-password" type="password" autoComplete="current-password" required value={current} onChange={(e) => { setCurrent(e.target.value); }} />
      <Field label={t('security.password.new')} name="new-password" type="password" autoComplete="new-password" required value={next} error={fieldError} onChange={(e) => { setNext(e.target.value); }} />
      <SubmitButton pending={pending} block={false}>
        {t('security.password.submit')}
      </SubmitButton>
    </form>
  );
}
