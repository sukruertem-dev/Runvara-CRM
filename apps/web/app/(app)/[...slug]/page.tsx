'use client';

import { Button, EmptyState } from '@flexa/ui';
import { Compass, Hammer } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useApp } from '../../../lib/app-context';
import { t } from '../../../lib/i18n';
import { PageContainer } from '../../_components/app-shell';
import { menuLabel } from '../../_components/shell/sidebar';

/**
 * Menu entries of modules whose screens arrive in later phases (CRM P6b, sales P9, call centre P10 …):
 * the module is on and permitted, so the page says so instead of a bare 404. Anything else is "not found".
 */
export default function PendingOrMissingPage() {
  const pathname = usePathname();
  const { nav } = useApp();
  const item = nav?.menu.find((m) => pathname === m.path || pathname.startsWith(`${m.path}/`));
  const home = (
    <Button asChild variant="secondary" size="sm">
      <Link href="/">{t('page.goHome')}</Link>
    </Button>
  );
  return (
    <PageContainer>
      {item ? (
        <>
          <h1 className="m-0 mb-4 font-display text-xl font-bold">{menuLabel(item)}</h1>
          <EmptyState icon={Hammer} title={t('menu.unavailable')} description={t('menu.unavailableBody')} action={home} />
        </>
      ) : (
        <>
          <h1 className="sr-only">{t('page.notFound')}</h1>
          <EmptyState icon={Compass} title={t('page.notFound')} description={t('page.notFoundBody')} action={home} />
        </>
      )}
    </PageContainer>
  );
}
