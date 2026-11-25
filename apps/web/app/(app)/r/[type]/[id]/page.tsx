'use client';

import { EmptyState, Skeleton } from '@flexa/ui';
import { Compass } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { t } from '../../../../../lib/i18n';
import { recordPath } from '../../../../../lib/notifications';
import { PageContainer } from '../../../../_components/app-shell';

/** `/r/{type}/{id}#place`: the stable address of a record in e-mails and notices; leads to its page. */
export default function RecordLinkPage() {
  const { type, id } = useParams<{ type: string; id: string }>();
  const router = useRouter();
  const path = recordPath(type, id);
  useEffect(() => {
    if (path) router.replace(`${path}${window.location.hash}`);
  }, [path, router]);
  return (
    <PageContainer>
      {path ? <Skeleton className="h-64 w-full" /> : <><h1 className="sr-only">{t('page.notFound')}</h1><EmptyState icon={Compass} title={t('page.notFound')} description={t('page.notFoundBody')} /></>}
    </PageContainer>
  );
}
