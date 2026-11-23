'use client';

import { Button, useToast } from '@flexa/ui';
import { Rocket } from 'lucide-react';
import Link from 'next/link';
import { useApp } from '../../../lib/app-context';
import { t } from '../../../lib/i18n';
import { useOnboarding, useSkipOnboarding } from '../../../lib/platform';

/** Home page invitation to the setup wizard while the workspace's onboarding is pending (Admins only). */
export function OnboardingCard() {
  const { can } = useApp();
  const manage = can('tenant.config.manage');
  const state = useOnboarding(manage);
  const skip = useSkipOnboarding();
  const toast = useToast();
  if (!manage || state.data?.status !== 'pending') return null;
  return (
    <section className="mb-6 flex flex-wrap items-center gap-4 rounded-card border border-line bg-accent-soft p-4" aria-labelledby="onboarding-card-h" data-testid="onboarding-card">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-btn bg-surface text-fg">
        <Rocket aria-hidden size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <h2 id="onboarding-card-h" className="m-0 text-base font-semibold">{t('onboarding.cardTitle')}</h2>
        <p className="m-0 mt-1 text-sm text-fg-muted">{t('onboarding.cardBody')}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" loading={skip.isPending} onClick={() => { skip.mutate(undefined, { onSuccess: () => { toast.toast({ kind: 'info', title: t('onboarding.skipped') }); } }); }}>
          {t('onboarding.skip')}
        </Button>
        <Button asChild>
          <Link href="/onboarding">{t('onboarding.start')}</Link>
        </Button>
      </div>
    </section>
  );
}
