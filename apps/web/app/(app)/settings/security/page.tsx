'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { request, type RecoveryCodes, type TotpSetup } from '../../../../lib/api';
import { t } from '../../../../lib/i18n';
import { useAction } from '../../../../lib/use-action';
import { useApp } from '../../../../lib/app-context';
import { PageContainer } from '../../../_components/app-shell';
import { Alert, Field, FormMessage, SubmitButton } from '../../../_components/ui';

export default function SecurityPage() {
  const { me } = useApp();
  const [enabledOverride, setEnabledOverride] = useState<boolean | null>(null);
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [disabledNotice, setDisabledNotice] = useState(false);
  const start = useAction();
  const confirm = useAction();
  const disable = useAction();


  const enabled = enabledOverride ?? me.user.mfaEnabled;

  function onStart(): void {
    setDisabledNotice(false);
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
      setEnabledOverride(true);
    });
  }

  function onDisable(e: FormEvent): void {
    e.preventDefault();
    void disable.run(async () => {
      await request('/v1/me/mfa', { method: 'DELETE', body: { code: code.trim() } });
      setEnabledOverride(false);
      setCodes(null);
      setCode('');
      setDisabledNotice(true);
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

  return (
    <PageContainer>
      <h1>{t('security.title')}</h1>
      <section className="card" aria-labelledby="mfa-h">
        <h2 id="mfa-h">{t('security.mfa.heading')}</h2>

        {codes ? (
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
          </div>
        ) : null}

        {disabledNotice ? <Alert kind="success">{t('security.mfa.disabled')}</Alert> : null}

        {enabled ? (
          <>
            <p>{t('security.mfa.on')}</p>
            <h3>{t('security.mfa.disable.heading')}</h3>
            <p className="muted">{t('security.mfa.disable.lead')}</p>
            <form method="post" onSubmit={onDisable} noValidate aria-busy={disable.pending}>
              <FormMessage message={disable.errors.form} />
              <Field label={t('mfa.code')} name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={code} onChange={(e) => { setCode(e.target.value); }} />
              <SubmitButton pending={disable.pending} block={false}>
                {t('security.mfa.disable')}
              </SubmitButton>
            </form>
          </>
        ) : (
          <>
            <p>{t('security.mfa.off')}</p>
            {setup ? (
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
            ) : (
              <>
                <FormMessage message={start.errors.form} />
                <button type="button" className="btn" disabled={start.pending} aria-busy={start.pending} onClick={onStart}>
                  {t('security.mfa.enable')}
                </button>
              </>
            )}
          </>
        )}
      </section>
      <p className="links">
        <Link href="/">{t('security.back')}</Link>
      </p>
    </PageContainer>
  );
}
