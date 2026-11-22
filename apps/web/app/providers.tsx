'use client';

import { ToastProvider, TooltipProvider } from '@flexa/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { useState, type ReactNode } from 'react';
import { t } from '../lib/i18n';
import { PreferencesProvider } from '../lib/preferences';
import { createQueryClient } from '../lib/query';

/** App-wide providers: server-state cache, preferences (theme, density, segment), tooltips, toasts, motion. */
export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(createQueryClient);
  return (
    <QueryClientProvider client={client}>
      <PreferencesProvider>
        <MotionConfig reducedMotion="user">
          <TooltipProvider delayDuration={400}>
            <ToastProvider closeLabel={t('common.close')} regionLabel={t('common.notifications')}>
              {children}
            </ToastProvider>
          </TooltipProvider>
        </MotionConfig>
      </PreferencesProvider>
    </QueryClientProvider>
  );
}
