'use client';

import type { NotificationListResponse } from '@flexa/contracts';
import { Avatar, Button, cn, EmptyState, focusRing, IconButton, Popover, PopoverContent, PopoverTrigger, Skeleton, Tabs, TabsList, TabsTrigger } from '@flexa/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AtSign, Bell, BellOff, CheckCheck, Lock, Stamp, UserCheck, Zap } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { request } from '../../../lib/api';
import { relativeTime } from '../../../lib/format';
import { t } from '../../../lib/i18n';
import { qk } from '../../../lib/query';
import { useRealtimeEvent } from '../../../lib/realtime';

type Out<T extends { _output: unknown }> = T['_output'];
type NotificationList = Out<typeof NotificationListResponse>;
type Notification = NotificationList['data'][number];

const KIND_ICON = { mention: AtSign, assigned: UserCheck, automation: Zap, approval: Stamp } as const;

/** In-app route for a notification's record (tasks today; other record pages arrive with their screens). */
function hrefFor(n: Notification): string | null {
  if (!n.accessible || !n.record) return null;
  if (n.kind === 'approval') return '/approvals';
  if (n.record.type === 'target') return '/targets';
  if (n.record.type === 'task') return `/tasks/${n.record.id}`;
  return null;
}

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
  const list = useQuery({ queryKey: qk.notifications, queryFn: () => request<NotificationList>('/v1/notifications?limit=50') });

  useRealtimeEvent((e) => {
    if (e.type === 'notification.created') setFresh(true);
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
    const href = hrefFor(n);
    if (href) {
      setOpen(false);
      router.push(href);
    }
  }

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
        </div>
        <Tabs value={filter} onValueChange={(v) => { setFilter(v === 'mention' ? 'mention' : 'all'); }} className="px-4">
          <TabsList label={t('notif.title')}>
            <TabsTrigger value="all">{t('notif.all')}</TabsTrigger>
            <TabsTrigger value="mention">
              <AtSign aria-hidden size={14} /> {t('notif.mentions')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="min-h-0 flex-1 overflow-y-auto p-2" role="list">
          {list.isLoading ? (
            <div className="flex flex-col gap-2 p-2">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : sorted.length === 0 ? (
            <EmptyState icon={BellOff} title={t('notif.empty')} description={t('notif.emptyBody')} />
          ) : (
            sorted.map((n) => {
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
                        <span className={cn('block truncate text-sm', !n.readAt && 'font-semibold')}>{n.record?.type === 'target' ? t('notif.targetRisk') : n.source?.type === 'approval_request' ? t('notif.approvalAsk', { title: n.title ?? '' }) : n.source?.type === 'approval_decision' ? t('notif.approvalDone', { title: n.title ?? '' }) : (n.title ?? n.message ?? '')}</span>
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
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
