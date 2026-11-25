'use client';

import type { NotificationListResponse } from '@flexa/contracts';
import { Avatar, Button, cn, EmptyState, focusRing, IconButton, Popover, PopoverContent, PopoverTrigger, Skeleton, Tabs, TabsList, TabsTrigger, useToast } from '@flexa/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AtSign, Bell, BellOff, CheckCheck, Lock, Settings2, Stamp, UserCheck, Zap } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { request } from '../../../lib/api';
import { relativeTime } from '../../../lib/format';
import { t } from '../../../lib/i18n';
import { appLink, notificationText, useInterruption } from '../../../lib/notifications';
import { qk } from '../../../lib/query';
import { useRealtimeEvent } from '../../../lib/realtime';

type Out<T extends { _output: unknown }> = T['_output'];
type NotificationList = Out<typeof NotificationListResponse>;
type Notification = NotificationList['data'][number];

const KIND_ICON = { mention: AtSign, assigned: UserCheck, automation: Zap, approval: Stamp } as const;

/**
 * Bell + notification centre (§10.5.5): mentions on top via the "Anıldım" filter, unread marked with the
 * spark dot. A new notification over the stream lights the bell's spark.
 */
export function NotificationBell() {
  const qc = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'mention'>('all');
  const [fresh, setFresh] = useState(false);
  const { toast } = useToast();
  const { silent } = useInterruption();
  // Notices already here when the list was last seen; null until the first answer.
  const known = useRef<Set<string> | null>(null);
  const list = useQuery({ queryKey: qk.notifications, queryFn: () => request<NotificationList>('/v1/notifications?limit=50') });

  useRealtimeEvent((e) => {
    if (e.type === 'notification.created' && !silent()) setFresh(true);
  });

  const markRead = useMutation({
    mutationFn: (id: string) => request(`/v1/notifications/${id}/read`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.notifications }),
  });
  const markAll = useMutation({
    mutationFn: () => request('/v1/notifications/read-all', { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.notifications }),
  });

  const unread = list.data?.unreadCount ?? 0;
  const items = (list.data?.data ?? []).filter((n) => filter === 'all' || n.kind === 'mention');
  // Mentions first (§10.5.5), newest first within each group.
  const sorted = [...items].sort((a, b) => Number(b.kind === 'mention') - Number(a.kind === 'mention') || b.createdAt.localeCompare(a.createdAt));

  function openItem(n: Notification): void {
    if (!n.readAt) markRead.mutate(n.id);
    const href = appLink(n.link);
    if (href) {
      setOpen(false);
      router.push(href);
    }
  }

  // A new notice is said once on screen, unless the person asked for quiet or is looking at the list.
  useEffect(() => {
    const rows = list.data?.data;
    if (!rows) return;
    const seen = known.current;
    known.current = new Set(rows.map((n) => n.id));
    if (!seen || open || silent()) return;
    const news = rows.filter((n) => !seen.has(n.id) && !n.readAt && n.accessible);
    for (const n of news.slice(0, 2)) {
      toast({
        kind: 'info',
        title: `${t(`notif.kind.${n.kind}`)}${n.actor?.displayName ? ` · ${n.actor.displayName}` : ''}`,
        description: notificationText(n),
        action: { label: t('notif.openItem'), onAction: () => { openItem(n); } },
      });
    }
    // Only a new answer of the list announces anything.
  }, [list.data]);

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setFresh(false);
      }}
    >
      <PopoverTrigger asChild>
        <IconButton label={unread > 0 ? `${t('notif.open')} (${t('notif.unread', { count: String(unread) })})` : t('notif.open')} className="relative" data-testid="notification-bell">
          <Bell aria-hidden size={18} />
          {unread > 0 ? (
            <span aria-hidden className={cn('absolute right-1.5 top-1.5 size-2 rounded-full bg-spark ring-2 ring-surface', fresh && 'fx-spark')} data-testid="notification-dot" />
          ) : null}
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex max-h-[70vh] w-[min(24rem,calc(100vw-1rem))] flex-col p-0" aria-label={t('notif.title')}>
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <h2 className="m-0 flex-1 font-display text-base font-bold">{t('notif.title')}</h2>
          <Button variant="ghost" size="sm" disabled={unread === 0 || markAll.isPending} onClick={() => { markAll.mutate(); }} icon={<CheckCheck aria-hidden size={14} />}>
            {t('notif.markAll')}
          </Button>
          <IconButton size="sm" label={t('settings.notifications')} asChild>
            <Link href="/settings/notifications" onClick={() => { setOpen(false); }}><Settings2 aria-hidden size={14} /></Link>
          </IconButton>
        </div>
        <Tabs value={filter} onValueChange={(v) => { setFilter(v === 'mention' ? 'mention' : 'all'); }} className="px-4">
          <TabsList label={t('notif.title')}>
            <TabsTrigger value="all" aria-controls="notification-panel">{t('notif.all')}</TabsTrigger>
            <TabsTrigger value="mention" aria-controls="notification-panel">
              <AtSign aria-hidden size={14} /> {t('notif.mentions')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div id="notification-panel" role="tabpanel" aria-label={filter === 'mention' ? t('notif.mentions') : t('notif.all')} className="min-h-0 flex-1 overflow-y-auto p-2">
          {list.isLoading ? (
            <div className="flex flex-col gap-2 p-2">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : sorted.length === 0 ? (
            <EmptyState icon={BellOff} title={t('notif.empty')} description={t('notif.emptyBody')} />
          ) : (
            <div role="list">
            {sorted.map((n) => {
              const Icon = KIND_ICON[n.kind];
              return (
                <div role="listitem" key={n.id}>
                  <button
                    type="button"
                    onClick={() => {
                      openItem(n);
                    }}
                    className={cn('flex w-full items-start gap-3 rounded-input px-2 py-2.5 text-left hover:bg-subtle', focusRing)}
                    data-testid="notification-item"
                  >
                    {n.actor?.displayName ? <Avatar name={n.actor.displayName} size={28} decorative /> : <Icon aria-hidden size={18} className="mt-1 text-fg-muted" />}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-xs text-fg-muted">
                        <Icon aria-hidden size={12} />
                        {t(`notif.kind.${n.kind}`)} · {relativeTime(n.createdAt)}
                      </span>
                      {n.accessible ? (
                        <span className={cn('block truncate text-sm', !n.readAt && 'font-semibold')}>{notificationText(n)}</span>
                      ) : (
                        <span className="flex items-center gap-1 text-sm text-fg-muted">
                          <Lock aria-hidden size={12} /> {t('notif.inaccessible')}
                        </span>
                      )}
                    </span>
                    {!n.readAt ? (
                      <span className="mt-2 size-2 shrink-0 rounded-full bg-spark" aria-label={t('notif.new')} role="img" />
                    ) : null}
                  </button>
                </div>
              );
            })}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
