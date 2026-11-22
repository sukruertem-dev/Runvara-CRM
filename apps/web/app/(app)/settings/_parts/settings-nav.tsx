'use client';

import { cn, EmptyState, focusRing } from '@flexa/ui';
import { Lock, PlugZap } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useApp, type Capability } from '../../../../lib/app-context';
import { t, type MessageKey } from '../../../../lib/i18n';

interface Item {
  href: string;
  label: MessageKey;
  /** Shown when the user holds any of these capabilities (the API decides; this only hides). */
  anyOf?: readonly Capability[];
  module?: string;
}

const GROUPS: readonly { label: MessageKey; items: readonly Item[] }[] = [
  {
    label: 'settings.group.account',
    items: [
      { href: '/settings/security', label: 'shell.security' },
      { href: '/settings/invitations', label: 'home.invitations', anyOf: ['users.manage'] },
      { href: '/settings/modules', label: 'home.moduleSettings', anyOf: ['tenant.modules.manage'] },
    ],
  },
  {
    label: 'settings.group.config',
    items: [
      { href: '/settings/workflows', label: 'settings.workflows', anyOf: ['tenant.config.read'] },
      { href: '/settings/fields', label: 'settings.fields', anyOf: ['tenant.config.read'] },
      { href: '/settings/roles', label: 'settings.roles', anyOf: ['authz.matrix.read'] },
    ],
  },
  {
    label: 'settings.group.automation',
    items: [
      { href: '/settings/automation', label: 'settings.automation', anyOf: ['tenant.config.read'], module: 'automation_sla' },
      { href: '/settings/sla', label: 'settings.sla', anyOf: ['tenant.config.read'], module: 'automation_sla' },
      { href: '/settings/integrations', label: 'settings.integrations', anyOf: ['tenant.config.read'], module: 'api_webhooks' },
    ],
  },
];

export function useSettingsItems() {
  const { can, nav } = useApp();
  const enabled = new Set(nav?.modules.map((m) => m.id) ?? []);
  return GROUPS.map((g) => ({
    label: g.label,
    items: g.items.filter((i) => (!i.anyOf || i.anyOf.some((c) => can(c))) && (!i.module || enabled.has(i.module))),
  })).filter((g) => g.items.length > 0);
}

/** Secondary navigation of the settings area: a column on wide screens, a scrollable row on phones. */
export function SettingsNav() {
  const pathname = usePathname();
  const groups = useSettingsItems();
  return (
    <nav aria-label={t('settings.title')} className="border-b border-line md:w-56 md:shrink-0 md:border-b-0 md:border-r">
      <div className="flex gap-1 overflow-x-auto px-4 py-2 md:flex-col md:gap-4 md:px-3 md:py-5">
        {groups.map((g) => (
          <div key={g.label} className="flex shrink-0 gap-1 md:flex-col">
            <p className="m-0 hidden px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-fg-muted md:block">{t(g.label)}</p>
            {g.items.map((i) => {
              const active = pathname === i.href || pathname.startsWith(`${i.href}/`);
              return (
                <Link
                  key={i.href}
                  href={i.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'whitespace-nowrap rounded-btn px-2.5 py-1.5 text-sm no-underline',
                    active ? 'bg-subtle font-semibold text-fg' : 'text-fg-muted hover:bg-subtle hover:text-fg',
                    focusRing,
                  )}
                >
                  {t(i.label)}
                </Link>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );
}

/**
 * Renders the page only for users holding one of the capabilities (and with the module on); otherwise an
 * explanation. The API enforces the same rules (403 / 404 MODULE_DISABLED); this keeps the screen honest.
 */
export function SettingsGate({ anyOf, module, children }: { anyOf: readonly Capability[]; module?: string; children: ReactNode }) {
  const { can, nav } = useApp();
  if (!nav) return null;
  if (module && !nav.modules.some((m) => m.id === module)) {
    return <EmptyState icon={PlugZap} title={t('settings.moduleOff')} description={t('settings.moduleOffBody')} />;
  }
  if (!anyOf.some((c) => can(c))) return <EmptyState icon={Lock} title={t('settings.noAccess')} description={t('settings.noAccessBody')} />;
  return <>{children}</>;
}

/** Page heading of a settings screen with an optional action area. */
export function SettingsHeader({ title, lead, actions }: { title: string; lead?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="m-0 font-display text-xl font-bold">{title}</h1>
        {lead ? <p className="m-0 mt-1 max-w-2xl text-sm text-fg-muted">{lead}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

/** Notice for users who may read but not change configuration. */
export function ReadOnlyNotice() {
  return <p className="m-0 mb-4 rounded-card border border-line bg-subtle px-3 py-2 text-sm text-fg-muted">{t('settings.readOnly')}</p>;
}
