'use client';

import { Skeleton } from '@flexa/ui';
import type { ReactNode } from 'react';
import { AppContextProvider, useAppSession } from '../../lib/app-context';
import { ConfigBoundary } from '../../lib/config';
import { t } from '../../lib/i18n';
import { RealtimeProvider } from '../../lib/realtime';
import { AppFrame } from '../_components/shell/app-frame';
import { ShellProvider } from '../_components/shell/shell-context';

/** Every signed-in page: one session bootstrap, one live stream, one shell (no remount on navigation). */
export default function AppLayout({ children }: { children: ReactNode }) {
  const session = useAppSession();
  if (session.status === 'loading') {
    return (
      <div className="flex h-dvh">
        <div className="hidden w-sidebar bg-sidebar-bg md:block" />
        <div className="flex flex-1 flex-col gap-3 p-6">
          <p role="status" className="sr-only">
            {t('common.loading')}
          </p>
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-96 max-w-full" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
      </div>
    );
  }
  return (
    <AppContextProvider me={session.me}>
      <RealtimeProvider enabled>
        <ConfigBoundary>
          <ShellProvider>
            <AppFrame>{children}</AppFrame>
          </ShellProvider>
        </ConfigBoundary>
      </RealtimeProvider>
    </AppContextProvider>
  );
}
