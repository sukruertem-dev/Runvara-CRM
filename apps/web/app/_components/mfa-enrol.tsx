'use client';

import { useState, type FormEvent } from 'react';
import { request, type RecoveryCodes, type TotpSetup } from '../../lib/api';
import { t } from '../../lib/i18n';
import { useAction } from '../../lib/use-action';
import { Alert, Field, FormMessage, SubmitButton } from './ui';

/** TOTP enrolment: secret and otpauth URI, confirmation code, then the recovery codes shown once. Used on the
 *  account security page and on the workspace block screen (tenant two-factor policy, P7d). */
export function MfaEnrolment({ onEnabled, children }: { onEnabled?: () => void; children?: React.ReactNode }) {
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const start = useAction();
  const confirm = useAction();

  function onStart(): void {
    void start.run(async () => {
      setSetup(await request<TotpSetup>('/v1/me/mfa/totp/setup', { method: 'POST' }));
      setCode('');
    });
  }

  function onConfirm(e: FormEvent): void {
    e.preventDefault();
    void confirm.run(async () => {
      const res = await request<RecoveryCodes>('/v1/me/mfa/totp/confirm', { method: 'POST', body: { code: code.trim() } });
      setCodes(res.recoveryCodes);
      setSetup(null);
      setCode('');
      onEnabled?.();
    });
  }

  async function copySecret(): Promise<void> {
    if (!setup) return;
    try {
      await navigator.clipboard.writeText(setup.secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (codes) {
    return (
      <div>
        <Alert kind="warning">{t('security.mfa.recovery.warning')}</Alert>
        <h3>{t('security.mfa.recovery.title')}</h3>
        <ul className="codes" data-testid="recovery-codes">
          {codes.map((c) => (
            <li key={c} className="mono">
              {c}
            </li>
          ))}
        </ul>
        {children}
      </div>
    );
  }
  if (!setup) {
    return (
      <>
        <FormMessage message={start.errors.form} />
        <button type="button" className="btn" disabled={start.pending} aria-busy={start.pending} onClick={onStart}>
          {t('security.mfa.enable')}
        </button>
      </>
    );
  }
  return (
    <div>
      <p className="muted">{t('security.mfa.setup.lead')}</p>
      <p>
        <strong>{t('security.mfa.secret')}</strong>
      </p>
      <p>
        <code data-testid="totp-secret">{setup.secret}</code>{' '}
        <button type="button" className="btn btn-secondary btn-small" onClick={() => void copySecret()}>
          {copied ? t('common.copied') : t('common.copy')}
        </button>
      </p>
      <p>
        <strong>{t('security.mfa.uri')}</strong>
      </p>
      <p>
        <code data-testid="totp-uri">{setup.otpauthUri}</code>
      </p>
      <form method="post" onSubmit={onConfirm} noValidate aria-busy={confirm.pending}>
        <FormMessage message={confirm.errors.form} />
        <Field label={t('mfa.code')} name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={code} onChange={(e) => { setCode(e.target.value); }} />
        <SubmitButton pending={confirm.pending} block={false}>
          {t('security.mfa.confirm')}
        </SubmitButton>
      </form>
    </div>
  );
}
