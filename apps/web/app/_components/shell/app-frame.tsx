'use client';

import { cn, Dialog, SheetContent } from '@flexa/ui';
import { usePathname } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { t } from '../../../lib/i18n';
import { usePreferences } from '../../../lib/preferences';
import { CommandPalette, ConnectionBanner, GlobalHotkeys, NewTaskDialog, ShortcutHelp } from './overlays';
import { useShell } from './shell-context';
import { SidebarContent } from './sidebar';
import { Topbar } from './topbar';

/** Sidebar + top bar + main region. Below 768 px the sidebar becomes a drawer. */
export function AppFrame({ children }: { children: ReactNode }) {
  const { sidebarCollapsed } = usePreferences();
  const { mobileNavOpen, setMobileNavOpen } = useShell();
  const pathname = usePathname();

  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname, setMobileNavOpen]);

  return (
    <div className="flex h-dvh overflow-hidden bg-canvas text-fg">
      <a
        href="#main"
        className="sr-only z-50 rounded-btn bg-surface px-3 py-2 text-fg focus:not-sr-only focus:fixed focus:left-2 focus:top-2"
      >
        {t('nav.skip')}
      </a>
      <aside className={cn('hidden shrink-0 md:block', sidebarCollapsed ? 'w-sidebar-collapsed' : 'w-sidebar')} data-testid="sidebar">
        <SidebarContent collapsed={sidebarCollapsed} />
      </aside>
      <Dialog open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent title={t('nav.primary')} closeLabel={t('common.close')} className="bg-sidebar-bg">
          <SidebarContent
            collapsed={false}
            onNavigate={() => {
              setMobileNavOpen(false);
            }}
          />
        </SheetContent>
      </Dialog>
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <ConnectionBanner />
        <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
          {children}
        </main>
      </div>
      <CommandPalette />
      <ShortcutHelp />
      <NewTaskDialog />
      <GlobalHotkeys />
    </div>
  );
}
