'use client';

import { cn } from '@flexa/ui';
import { CloudOff, Gauge, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useApp } from '../../../lib/app-context';
import { useHotkeys } from '../../../lib/hotkeys';
import { t } from '../../../lib/i18n';
import { useUsage } from '../../../lib/platform';
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

const LEVEL_ORDER = ['ok', 'warning', 'soft', 'hard'] as const;

/** Admins see the most serious quota state of the workspace (TEN-09: 80 % warns, 100 % and 120 % restrict). */
export function QuotaBanner() {
  const { can } = useApp();
  const manage = can('tenant.config.manage');
  const usage = useUsage(manage);
  if (!manage || !usage.data) return null;
  const worst = [...usage.data.dimensions].sort((a, b) => LEVEL_ORDER.indexOf(b.level) - LEVEL_ORDER.indexOf(a.level))[0];
  if (!worst || worst.level === 'ok') return null;
  const level = worst.level;
  return (
    <div role="status" className={cn('flex flex-wrap items-center gap-2 border-b border-line px-4 py-1.5 text-sm', level === 'hard' ? 'bg-danger-soft text-danger' : 'bg-warning-soft text-warning')} data-testid="quota-banner">
      <Gauge aria-hidden size={15} />
      <span>{t(`usage.banner.${level}`, { dimension: t(`usage.dim.${worst.dimension}`) })}</span>
      <Link href="/settings/usage" className="font-semibold text-current underline">{t('usage.banner.link')}</Link>
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
