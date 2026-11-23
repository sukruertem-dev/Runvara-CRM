'use client';

import { CloudOff, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useApp } from '../../../lib/app-context';
import { useHotkeys } from '../../../lib/hotkeys';
import { t } from '../../../lib/i18n';
import { useRealtime } from '../../../lib/realtime';
import { useShell } from './shell-context';

export function ConnectionBanner() {
  const { state } = useRealtime();
  const [online, setOnline] = useState(true);
  useEffect(() => {
    setOnline(navigator.onLine);
    const up = (): void => {
      setOnline(true);
    };
    const down = (): void => {
      setOnline(false);
    };
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  if (online && state !== 'offline' && state !== 'reconnecting') return null;
  const offline = !online || state === 'offline';
  return (
    <div role="status" className="flex items-center gap-2 border-b border-line bg-warning-soft px-4 py-1.5 text-sm text-warning" data-testid="connection-banner">
      {offline ? <CloudOff aria-hidden size={15} /> : <RefreshCw aria-hidden size={15} className="animate-spin motion-reduce:animate-none" />}
      {offline ? t('shell.offline') : t('shell.reconnecting')}
    </div>
  );
}

export function GlobalHotkeys() {
  const { setPaletteOpen, setNewTaskOpen, setHelpOpen, paletteOpen } = useShell();
  const { can, nav } = useApp();
  const hasTasks = nav?.menu.some((m) => m.id === 'tasks') ?? false;
  useHotkeys([
    { key: 'k', mod: true, allowInInput: true, handler: () => { setPaletteOpen(!paletteOpen); } },
    { key: '/', handler: () => { setPaletteOpen(true); } },
    { key: '?', handler: () => { setHelpOpen(true); } },
    {
      key: 'c',
      handler: () => {
        if (hasTasks && can('task.create')) setNewTaskOpen(true);
      },
    },
  ]);
  return null;
}
