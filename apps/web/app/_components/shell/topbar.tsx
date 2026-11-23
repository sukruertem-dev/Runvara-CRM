'use client';

import {
  Avatar,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  focusRing,
  IconButton,
  Kbd,
  RoleBadge,
} from '@flexa/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, Layers, LogOut, Menu, Search, ShieldCheck, ShoppingBag, SlidersHorizontal } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { logout } from '../../../lib/api';
import { useApp } from '../../../lib/app-context';
import { useSetUiPreference } from '../../../lib/config';
import { roleLabel, t } from '../../../lib/i18n';
import { usePreferences, type DensityPref, type SegmentPref, type ThemePref } from '../../../lib/preferences';
import { NotificationBell } from './notifications';
import { useShell } from './shell-context';

const SEGMENT_ICON = { all: Layers, b2b: Building2, b2c: ShoppingBag } as const;

/**
 * Segment switcher (ADR-0010 §6): shown only to users who hold both segments in a tenant that sells to both.
 * It narrows every request with X-Segment; it can never widen what the API returns.
 */
function SegmentSwitcher() {
  const { nav } = useApp();
  const { segment, set } = usePreferences();
  const qc = useQueryClient();
  const available = nav?.segments ?? [];
  if (available.length < 2) return null;
  const current: SegmentPref = segment !== 'all' && !available.includes(segment) ? 'all' : segment;
  const Icon = SEGMENT_ICON[current];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm" icon={<Icon aria-hidden size={14} />} aria-label={`${t('shell.segment')}: ${t(`shell.segment.${current}`)}`} data-testid="segment-switcher">
          <span className="hidden sm:inline">{t(`shell.segment.${current}`)}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{t('shell.segment')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={current}
          onValueChange={(v) => {
            set({ segment: v === 'b2b' || v === 'b2c' ? v : 'all' });
            // Everything on screen was fetched for the previous segment.
            void qc.invalidateQueries();
          }}
        >
          {(['all', ...available] as SegmentPref[]).map((s) => {
            const SIcon = SEGMENT_ICON[s];
            return (
              <DropdownMenuRadioItem key={s} value={s}>
                <SIcon aria-hidden size={14} /> {t(`shell.segment.${s}`)}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserMenu() {
  const { me, nav } = useApp();
  const { theme, density } = usePreferences();
  const setUi = useSetUiPreference();
  const router = useRouter();
  const roles = nav?.roles ?? me.tenant?.roles ?? [];

  async function onLogout(): Promise<void> {
    try {
      await logout();
    } catch {
      // The local session is dropped either way.
    }
    router.replace('/login');
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={cn('inline-flex items-center gap-2 rounded-full p-0.5 hover:bg-subtle', focusRing)}>
        <span className="sr-only">{`${t('shell.userMenu')}: ${me.user.displayName}`}</span>
        <Avatar name={me.user.displayName} size={30} decorative />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64">
        <div className="flex flex-col gap-1.5 px-2 py-2">
          <span className="truncate text-sm font-semibold" data-testid="user-name">
            {me.user.displayName}
          </span>
          <span className="truncate text-xs text-fg-muted">{me.user.email}</span>
          <span className="flex flex-wrap gap-1">
            {roles.map((r) => (
              <RoleBadge key={r} role={r} label={roleLabel(r)} />
            ))}
          </span>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t('shell.theme')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={(v) => { setUi({ theme: v as ThemePref }); }}>
          <DropdownMenuRadioItem value="system">{t('shell.theme.system')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">{t('shell.theme.light')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">{t('shell.theme.dark')}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t('shell.density')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={density} onValueChange={(v) => { setUi({ density: v as DensityPref }); }}>
          <DropdownMenuRadioItem value="comfortable">{t('shell.density.comfortable')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="compact">{t('shell.density.compact')}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => { router.push('/settings/preferences'); }} data-testid="menu-preferences">
          <SlidersHorizontal aria-hidden size={14} /> {t('prefs.title')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => { router.push('/settings/security'); }}>
          <ShieldCheck aria-hidden size={14} /> {t('shell.security')}
        </DropdownMenuItem>
        {me.operator ? (
          <DropdownMenuItem onSelect={() => { router.push('/operator'); }} data-testid="menu-operator">
            <Building2 aria-hidden size={14} /> {t('shell.operatorConsole')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => void onLogout()}>
          <LogOut aria-hidden size={14} /> {t('shell.logoutFull')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Topbar() {
  const { setPaletteOpen, setMobileNavOpen } = useShell();
  return (
    <header className="flex h-topbar shrink-0 items-center gap-2 border-b border-line bg-surface px-3 md:px-4">
      <IconButton label={t('nav.open')} className="md:hidden" onClick={() => { setMobileNavOpen(true); }}>
        <Menu aria-hidden size={18} />
      </IconButton>
      <button
        type="button"
        onClick={() => { setPaletteOpen(true); }}
        className={cn('flex h-8 min-w-0 max-w-md flex-1 items-center gap-2 rounded-btn border border-line bg-canvas px-3 text-sm text-fg-muted hover:border-line-strong', focusRing)}
        aria-keyshortcuts="Control+K Meta+K /"
        data-testid="open-palette"
      >
        <Search aria-hidden size={15} />
        <span className="truncate">{t('shell.search')}</span>
        <Kbd className="ml-auto hidden sm:inline-flex" aria-hidden>
          Ctrl K
        </Kbd>
      </button>
      <span className="flex-1" />
      <SegmentSwitcher />
      <NotificationBell />
      <UserMenu />
    </header>
  );
}
