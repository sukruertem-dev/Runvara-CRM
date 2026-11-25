'use client';

import { EmptyState, Skeleton } from '@flexa/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { request } from '../../../../lib/api';
import { t } from '../../../../lib/i18n';
import { appLink, type AppNotification } from '../../../../lib/notifications';
import { qk } from '../../../../lib/query';
import { PageContainer } from '../../../_components/app-shell';

/** Opens a notice by its id (push messages): marks it read and goes where it leads, with the rights of now. */
export default function NotificationLinkPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [gone, setGone] = useState(false);
  useEffect(() => {
    const live = { cancelled: false };
    void (async () => {
      try {
        const n = await request<AppNotification>(`/v1/notifications/${encodeURIComponent(id)}`);
        if (!n.readAt) {
          await request(`/v1/notifications/${n.id}/read`, { method: 'POST' });
          void qc.invalidateQueries({ queryKey: qk.notifications });
        }
        const href = appLink(n.link);
        if (live.cancelled) return;
        if (href) router.replace(href);
        else setGone(true);
      } catch {
        if (!live.cancelled) setGone(true);
      }
    })();
    return () => { live.cancelled = true; };
  }, [id, qc, router]);
  return (
    <PageContainer>
      <h1 className="sr-only">{t('notif.title')}</h1>
      {gone ? <EmptyState icon={Lock} title={t('notif.gone')} description={t('notif.goneBody')} /> : <Skeleton className="h-64 w-full" />}
    </PageContainer>
  );
}
