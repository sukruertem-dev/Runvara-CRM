'use client';

import { cn, focusRing } from '@flexa/ui';
import Link from 'next/link';
import { t } from '../../../lib/i18n';
import { PageContainer } from '../../_components/app-shell';
import { SettingsHeader, useSettingsItems } from './_parts/settings-nav';

/** Settings overview: every settings screen this user may open, grouped. */
export default function SettingsHome() {
  const groups = useSettingsItems();
  return (
    <PageContainer>
      <SettingsHeader title={t('settings.title')} lead={t('settings.lead')} />
      <div className="flex flex-col gap-6">
        {groups.map((g) => (
          <section key={g.label} aria-labelledby={`sg-${g.label}`}>
            <h2 id={`sg-${g.label}`} className="m-0 mb-2 text-sm font-semibold text-fg-muted">{t(g.label)}</h2>
            <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">
              {g.items.map((i) => (
                <li key={i.href}>
                  <Link href={i.href} className={cn('block rounded-card border border-line bg-surface p-4 no-underline hover:border-line-strong', focusRing)}>
                    <span className="block font-semibold text-fg">{t(i.label)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </PageContainer>
  );
}
