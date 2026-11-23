'use client';

import { cn, Dialog, SheetContent } from '@flexa/ui';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { t } from '../../../lib/i18n';
import { useApp } from '../../../lib/app-context';
import { usePreferences } from '../../../lib/preferences';
import { ConnectionBanner, GlobalHotkeys, QuotaBanner } from './overlays';
import { PendingDeletion, SupportBanner } from './support-parts';
import { useShell } from './shell-context';
import { SidebarContent } from './sidebar';
import { Topbar } from './topbar';

const CommandPalette = dynamic(() => import('./dialogs').then((m) => m.CommandPalette), { ssr: false });
const ShortcutHelp = dynamic(() => import('./dialogs').then((m) => m.ShortcutHelp), { ssr: false });
const NewTaskDialog = dynamic(() => import('./dialogs').then((m) => m.NewTaskDialog), { ssr: false });

/** True from the first time `open` is true: a dialog is loaded on first use and then stays mounted (close animation, state). */
function useOpenedOnce(open: boolean): boolean {
  const [once, setOnce] = useState(open);
  useEffect(() => {
    if (open) setOnce(true);
  }, [open]);
  return once || open;
}

/** Sidebar + top bar + main region. Below 768 px the sidebar becomes a drawer. */
export function AppFrame({ children }: { children: ReactNode }) {
  const { sidebarCollapsed } = usePreferences();
  const { mobileNavOpen, setMobileNavOpen, paletteOpen, newTaskOpen, helpOpen } = useShell();
  const palette = useOpenedOnce(paletteOpen);
  const newTask = useOpenedOnce(newTaskOpen);
  const help = useOpenedOnce(helpOpen);
  const pathname = usePathname();
  const { nav } = useApp();
  // TEN-05: a workspace waiting for deletion shows one screen, whatever the address.
  const pending = nav?.tenantStatus === 'pending_deletion';

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
        <QuotaBanner />
        <SupportBanner />
        <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
          {pending ? <PendingDeletion /> : children}
        </main>
      </div>
      {palette ? <CommandPalette /> : null}
      {help ? <ShortcutHelp /> : null}
      {newTask ? <NewTaskDialog /> : null}
      <GlobalHotkeys />
    </div>
  );
}
