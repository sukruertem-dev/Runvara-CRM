'use client';

import { cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger, focusRing, ModuleIcon, Tooltip } from '@flexa/ui';
import { ChevronsUpDown, Home, PanelLeftClose, PanelLeftOpen, Puzzle, Settings2, ShieldCheck, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { request, setAccessToken, type AccessToken } from '../../../lib/api';
import { useApp } from '../../../lib/app-context';
import { useEffectiveConfig, useLogoUrl } from '../../../lib/config';
import { t, tOptional } from '../../../lib/i18n';
import { usePreferences } from '../../../lib/preferences';

export function menuLabel(item: { id: string; labelKey: string }): string {
  return tOptional(`menu.${item.id}`) ?? item.labelKey;
}

function NavLink({ href, icon, label, collapsed, onNavigate, testId, exact = false }: { href: string; icon: ReactNode; label: string; collapsed: boolean; onNavigate?: () => void; testId?: string; exact?: boolean }) {
  const pathname = usePathname();
  const active = href === '/' || exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  const link = (
    <Link
      href={href}
      {...(onNavigate ? { onClick: onNavigate } : {})}
      aria-current={active ? 'page' : undefined}
      data-testid={testId}
      className={cn(
        'flex h-9 items-center gap-3 rounded-btn px-2.5 text-sm font-medium no-underline transition-colors duration-[var(--motion-fast)]',
        active ? 'bg-sidebar-active text-sidebar-on-active' : 'text-sidebar-muted hover:bg-sidebar-text/10 hover:text-sidebar-text',
        collapsed && 'justify-center px-0',
        focusRing,
      )}
    >
      <span className="inline-flex shrink-0">{icon}</span>
      <span className={cn('truncate', collapsed && 'sr-only')}>{label}</span>
    </Link>
  );
  return collapsed ? (
    <Tooltip content={label} side="right">
      {link}
    </Tooltip>
  ) : (
    link
  );
}

function TenantSwitcher({ collapsed }: { collapsed: boolean }) {
  const { me } = useApp();
  const current = me.tenant;
  const others = me.tenants.filter((x) => x.id !== current?.id);
  const config = useEffectiveConfig();
  const logo = useLogoUrl(config.data?.brand.logo?.assetId ?? null);

  async function switchTo(tenantId: string): Promise<void> {
    const res = await request<AccessToken>('/v1/auth/tenant', { method: 'POST', body: { tenantId } });
    setAccessToken(res.accessToken);
    // A full reload drops every cached query and the live stream of the previous tenant.
    window.location.assign('/');
  }

  // The tenant logo sits on a light tile so any logo reads on the dark sidebar; the Flexa mark stays above.
  const mark = logo ? (
    <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-input bg-surface p-0.5">
      <img src={logo} alt="" className="size-full object-contain" data-testid="tenant-logo" />
    </span>
  ) : null;
  const label = (
    <span className={cn('min-w-0 flex-1 text-left', collapsed && 'sr-only')}>
      <span className="block truncate text-sm font-semibold text-sidebar-text" data-testid="tenant-name">
        {current?.name}
      </span>
      <span className="block truncate text-xs text-sidebar-muted" data-testid="tenant-slug">{current?.slug}</span>
    </span>
  );

  if (others.length === 0) {
    return <div className={cn('flex items-center gap-2 px-2.5 py-1.5', collapsed && 'justify-center')}>{mark}{label}</div>;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t('shell.tenantSwitcher')}
        className={cn('flex w-full items-center gap-2 rounded-btn px-2.5 py-1.5 hover:bg-sidebar-text/10', collapsed && 'justify-center', focusRing)}
      >
        {mark}
        {label}
        <ChevronsUpDown aria-hidden size={14} className="shrink-0 text-sidebar-muted" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>{t('shell.tenantSwitcher')}</DropdownMenuLabel>
        {others.map((x) => (
          <DropdownMenuItem key={x.id} onSelect={() => void switchTo(x.id)}>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{x.name}</span>
              <span className="block truncate text-xs text-fg-muted">{x.slug}</span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Module-aware navigation (§10.5.5 "Uygulama kabuğu"): only the menu items the API returned — disabled modules
 * and items without permission never reach the client.
 */
export function SidebarContent({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const { nav, can } = useApp();
  const { set } = usePreferences();
  const iconSize = 18;
  const nav0 = onNavigate ? { onNavigate } : {};
  return (
    <div className="flex h-full flex-col gap-2 bg-sidebar-bg p-2 text-sidebar-text">
      <div className={cn('flex items-center gap-2 px-1.5 pb-1 pt-1.5', collapsed && 'justify-center px-0')}>
        <Link href="/" aria-label="Flexa" className={cn('inline-flex items-center gap-2 rounded-btn no-underline', focusRing)} {...(onNavigate ? { onClick: onNavigate } : {})}>
          <img src="/flexa-symbol.svg" alt="" width={28} height={28} />
          <span className={cn('font-display text-lg font-bold text-sidebar-text', collapsed && 'sr-only')}>Flexa</span>
        </Link>
      </div>
      <TenantSwitcher collapsed={collapsed} />
      <nav aria-label={t('nav.primary')} className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        <NavLink href="/" icon={<Home aria-hidden size={iconSize} />} label={t('nav.home')} collapsed={collapsed} {...nav0} />
        {nav?.menu.map((item) => (
          <NavLink
            key={item.id}
            href={item.path}
            icon={<ModuleIcon name={item.icon} size={iconSize} />}
            label={menuLabel(item)}
            collapsed={collapsed}
            testId={`nav-${item.id}`}
            {...nav0}
          />
        ))}
      </nav>
      <div className="flex flex-col gap-0.5 border-t border-sidebar-text/15 pt-2">
        <NavLink href="/settings/security" icon={<ShieldCheck aria-hidden size={iconSize} />} label={t('shell.security')} collapsed={collapsed} {...nav0} />
        {can('users.manage') ? (
          <NavLink href="/settings/invitations" icon={<UserPlus aria-hidden size={iconSize} />} label={t('home.invitations')} collapsed={collapsed} {...nav0} />
        ) : null}
        {can('tenant.modules.manage') ? (
          <NavLink href="/settings/modules" icon={<Puzzle aria-hidden size={iconSize} />} label={t('home.moduleSettings')} collapsed={collapsed} {...nav0} />
        ) : null}
        {can('tenant.config.read') || can('authz.matrix.read') ? (
          <NavLink href="/settings" exact icon={<Settings2 aria-hidden size={iconSize} />} label={t('settings.title')} collapsed={collapsed} testId="nav-settings" {...nav0} />
        ) : null}
        {onNavigate ? null : (
          <button
            type="button"
            onClick={() => {
              set({ sidebarCollapsed: !collapsed });
            }}
            aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
            className={cn('flex h-9 items-center gap-3 rounded-btn px-2.5 text-sm text-sidebar-muted hover:bg-sidebar-text/10 hover:text-sidebar-text', collapsed && 'justify-center px-0', focusRing)}
          >
            {collapsed ? <PanelLeftOpen aria-hidden size={iconSize} /> : <PanelLeftClose aria-hidden size={iconSize} />}
            <span className={cn(collapsed && 'sr-only')}>{collapsed ? t('nav.expand') : t('nav.collapse')}</span>
          </button>
        )}
      </div>
    </div>
  );
}
