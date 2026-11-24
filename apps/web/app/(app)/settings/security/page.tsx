'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { request } from '../../../../lib/api';
import { t } from '../../../../lib/i18n';
import { useAction } from '../../../../lib/use-action';
import { useApp } from '../../../../lib/app-context';
import { PageContainer } from '../../../_components/app-shell';
import { MfaEnrolment } from '../../../_components/mfa-enrol';
import { PasswordChangeForm } from '../../../_components/password-change';
import { Alert, Field, FormMessage, SubmitButton } from '../../../_components/ui';

export default function SecurityPage() {
  const { me } = useApp();
  // Enrolled on this page: the enrolment stays mounted to show the recovery codes once.
  const [enrolledHere, setEnrolledHere] = useState(false);
  const [disabledHere, setDisabledHere] = useState(false);
  // A new enrolment after disabling starts from a fresh form.
  const [round, setRound] = useState(0);
  const [code, setCode] = useState('');
  const [passwordDone, setPasswordDone] = useState(false);
  const disable = useAction();

  const enabled = !disabledHere && (enrolledHere || me.user.mfaEnabled);

  function onDisable(e: FormEvent): void {
    e.preventDefault();
    void disable.run(async () => {
      await request('/v1/me/mfa', { method: 'DELETE', body: { code: code.trim() } });
      setDisabledHere(true);
      setEnrolledHere(false);
      setRound((r) => r + 1);
      setCode('');
    });
  }

  const disableSection = (
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
  );

  return (
    <PageContainer>
      <h1>{t('security.title')}</h1>
      <section className="card" aria-labelledby="mfa-h">
        <h2 id="mfa-h">{t('security.mfa.heading')}</h2>
        {disabledHere ? <Alert kind="success">{t('security.mfa.disabled')}</Alert> : null}
        {enabled && !enrolledHere ? (
          disableSection
        ) : (
          <>
            {enrolledHere ? null : <p>{t('security.mfa.off')}</p>}
            <MfaEnrolment key={round} onEnabled={() => { setEnrolledHere(true); setDisabledHere(false); }}>
              {disableSection}
            </MfaEnrolment>
          </>
        )}
      </section>
      <section className="card" aria-labelledby="pwd-h">
        <h2 id="pwd-h">{t('security.password.heading')}</h2>
        <p className="muted">{t('security.password.lead')}</p>
        {passwordDone ? <Alert kind="success">{t('security.password.done')}</Alert> : null}
        <PasswordChangeForm onDone={() => { setPasswordDone(true); }} />
      </section>
      <p className="links">
        <Link href="/">{t('security.back')}</Link>
      </p>
    </PageContainer>
  );
}
