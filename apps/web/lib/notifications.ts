'use client';

import type { NotificationPreferences, NotificationView, PushConfig } from '@flexa/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './api';
import { useEffectiveConfig } from './config';
import { t } from './i18n';
import { usePreferences } from './preferences';

// Notification channels, quiet hours and links (P8d, docs/p8-plan.md §17–20).

type Out<T extends { _output: unknown }> = T['_output'];
export type AppNotification = Out<typeof NotificationView>;
export type NotificationPrefs = Out<typeof NotificationPreferences>['data'];

/** What a notice says in one line. */
export function notificationText(n: AppNotification): string {
  const title = n.title ?? '';
  if (n.record?.type === 'target') return t('notif.targetRisk');
  if (n.source?.type === 'approval_request') return t('notif.approvalAsk', { title });
  if (n.source?.type === 'approval_decision') return t('notif.approvalDone', { title });
  return n.title ?? n.message ?? '';
}

/** The in-app address of a record. */
export function recordPath(type: string, id: string): string | null {
  if (type === 'task') return `/tasks/${id}`;
  return ['account', 'contact', 'lead', 'opportunity', 'case'].includes(type) ? `/crm/${type}/${id}` : null;
}

/** `/r/{type}/{id}#place` (the address notices and e-mails carry) as the page itself; other links as they are. */
export function appLink(link: string | null): string | null {
  const m = link ? /^\/r\/([a-z]+)\/([0-9a-f-]{36})(#.*)?$/.exec(link) : null;
  if (!m) return link;
  const path = recordPath(m[1] ?? '', m[2] ?? '');
  return path ? `${path}${m[3] ?? ''}` : null;
}

/** Same rule as the server's isQuiet (packages/config): HH:MM compared in the person's time zone. */
export function quietAt(q: { enabled?: unknown; from?: unknown; to?: unknown } | undefined, hhmm: string): boolean {
  if (q?.enabled !== true || typeof q.from !== 'string' || typeof q.to !== 'string' || q.from === q.to) return false;
  return q.from < q.to ? hhmm >= q.from && hhmm < q.to : hhmm >= q.from || hhmm < q.to;
}

/** Interruptions off now: quiet hours, or switched off on this device (calls do so in P10, MEN-12). */
export function useInterruption(): { silent: () => boolean } {
  const config = useEffectiveConfig();
  const { doNotDisturb } = usePreferences();
  const quiet = config.data?.data['notifications.quiet']?.value;
  const zone = config.data?.data['locale']?.value['timezone'];
  return {
    silent: () => {
      if (doNotDisturb) return true;
      const now = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(typeof zone === 'string' ? { timeZone: zone } : {}) }).format(new Date());
      return quietAt(quiet, now);
    },
  };
}

// ---------------------------------------------------------------- preferences
const PREFS = ['notification-preferences'] as const;
export function useNotificationPrefs() {
  return useQuery({ queryKey: PREFS, queryFn: () => request<Out<typeof NotificationPreferences>>('/v1/notifications/preferences') });
}
export function useSetNotificationPrefs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (preferences: NotificationPrefs) => request('/v1/notifications/preferences', { method: 'PUT', body: { preferences } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: PREFS }),
  });
}

// ---------------------------------------------------------------- web push on this device
export type PushState = 'unsupported' | 'unconfigured' | 'denied' | 'off' | 'on';

export const pushSupported = (): boolean => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export function usePushState() {
  return useQuery({
    queryKey: ['push-state'],
    queryFn: async (): Promise<{ state: PushState; publicKey: string | null }> => {
      const { publicKey } = await request<Out<typeof PushConfig>>('/v1/push/config');
      if (!publicKey) return { state: 'unconfigured', publicKey };
      if (!pushSupported()) return { state: 'unsupported', publicKey };
      if (Notification.permission === 'denied') return { state: 'denied', publicKey };
      return { state: (await currentSubscription()) ? 'on' : 'off', publicKey };
    },
    staleTime: 0,
  });
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const raw = atob(base64url.replaceAll('-', '+').replaceAll('_', '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** Asks the browser, registers the worker and tells the API. Rejects when the person says no. */
export async function enablePush(publicKey: string): Promise<void> {
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('denied');
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  const json = sub.toJSON();
  await request('/v1/push/subscriptions', { method: 'POST', body: { endpoint: json.endpoint, keys: { p256dh: json.keys?.['p256dh'], auth: json.keys?.['auth'] } } });
}

/** Also before signing out, so the next person at this computer gets nothing. */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await request('/v1/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
  await sub.unsubscribe();
}
