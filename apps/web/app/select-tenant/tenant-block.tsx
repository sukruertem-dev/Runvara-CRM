'use client';

import { useState, type FormEvent } from 'react';
import { ApiError } from '../../lib/api';
import { messageForCode } from '../../lib/errors';
import { t } from '../../lib/i18n';
import { stepUp, type TenantBlock } from '../../lib/security';
import { MfaEnrolment } from '../_components/mfa-enrol';
import { PasswordChangeForm } from '../_components/password-change';
import { Field, FormMessage, SubmitButton } from '../_components/ui';

/** What the workspace's security policy asks before it opens (P7d §19), resolved in place; `onRetry`
 *  selects the workspace again once the person has done it. */
export function TenantBlockPanel({ tenant, block, onRetry, onBack, retrying }: {
  tenant: { id: string; name: string };
  block: TenantBlock;
  onRetry: () => void;
  onBack: () => void;
  retrying: boolean;
}) {
  return (
    <section aria-labelledby="block-h" data-testid="tenant-block">
      <h2 id="block-h">{t('block.title', { tenant: tenant.name })}</h2>
      {block.code === 'TENANT_MFA_REQUIRED' ? (
        block.enrolled ? <StepUp onDone={onRetry} /> : (
          <>
            <p className="muted">{t('block.mfa.enrol')}</p>
            <MfaEnrolment>
              <button type="button" className="btn" disabled={retrying} aria-busy={retrying} onClick={onRetry}>{t('block.continue')}</button>
            </MfaEnrolment>
          </>
        )
      ) : null}
      {block.code === 'PASSWORD_CHANGE_REQUIRED' ? (
        <>
          <p className="muted">{t('block.password')}</p>
          <ul>
            <li>{t('block.password.min', { min: String(block.rules.minLength) })}</li>
            {block.rules.requireMixed ? <li>{t('block.password.mixed')}</li> : null}
            {block.reasons.includes('expired') ? <li>{t('reason.expired')}</li> : null}
          </ul>
          <PasswordChangeForm tenantId={tenant.id} minLength={block.rules.minLength} onDone={onRetry} />
        </>
      ) : null}
      {block.code === 'TENANT_SSO_REQUIRED' ? (
        <>
          <p className="muted">{t('block.sso')}</p>
          <ul className="list">
            {block.providers.map((p) => (
              <li key={p.id}>
                <a className="btn btn-block" href={p.startUrl}>{t('login.sso.with', { name: p.name })}</a>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="links">
        <button type="button" className="btn btn-secondary btn-small" onClick={onBack}>{t('block.back')}</button>
      </p>
    </section>
  );
}

/** A second factor for a session opened without one (the account is already enrolled). */
function StepUp({ onDone }: { onDone: () => void }) {
  const [recovery, setRecovery] = useState(false);
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    setPending(true);
    setError(null);
    stepUp(recovery ? { recoveryCode: value.trim() } : { code: value.trim() })
      .then(onDone)
      .catch((err: unknown) => { setError(err instanceof ApiError ? messageForCode(err.code) : t('error.fallback')); })
      .finally(() => { setPending(false); });
  }

  return (
    <>
      <p className="muted">{t('block.mfa.stepUp')}</p>
      <form method="post" onSubmit={onSubmit} noValidate aria-busy={pending}>
        <FormMessage message={error} />
        {recovery ? (
          <Field label={t('mfa.recoveryCode')} name="recovery" autoComplete="off" required value={value} onChange={(e) => { setValue(e.target.value); }} />
        ) : (
          <Field label={t('mfa.code')} name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={value} onChange={(e) => { setValue(e.target.value); }} />
        )}
        <SubmitButton pending={pending}>{t('mfa.submit')}</SubmitButton>
      </form>
      <p className="links">
        <button type="button" className="btn btn-secondary btn-small" onClick={() => { setRecovery((r) => !r); setValue(''); }}>
          {recovery ? t('mfa.useCode') : t('mfa.useRecovery')}
        </button>
      </p>
    </>
  );
}
