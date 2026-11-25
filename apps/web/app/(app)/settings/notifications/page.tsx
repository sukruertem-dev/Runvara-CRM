'use client';

import { Alert, Button, Checkbox, ErrorState, Field, Input, Skeleton, Switch, useToast } from '@flexa/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { request } from '../../../../lib/api';
import { errorText } from '../../../../lib/catalog';
import { ck, useConfigLayer, type ConfigLayer } from '../../../../lib/config';
import { t } from '../../../../lib/i18n';
import { disablePush, enablePush, useNotificationPrefs, usePushState, useSetNotificationPrefs, type NotificationPrefs } from '../../../../lib/notifications';
import { usePreferences } from '../../../../lib/preferences';
import { PageContainer } from '../../../_components/app-shell';
import { SettingsHeader } from '../_parts/settings-nav';

// Settings → Notifications (MEN-07, docs/p8-plan.md §20): the person's own channels, quiet hours and this device.

const CHANNELS = ['in_app', 'push', 'email'] as const;

export default function NotificationSettingsPage() {
  const prefs = useNotificationPrefs();
  const quiet = useConfigLayer('notifications.quiet', 'user');
  const header = <SettingsHeader title={t('notifset.title')} lead={t('notifset.lead')} />;
  return (
    <PageContainer>
      {header}
      {prefs.isError || quiet.isError ? (
        <ErrorState title={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => { void prefs.refetch(); void quiet.refetch(); }} />
      ) : !prefs.data || !quiet.data ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="flex flex-col gap-5">
          <Channels key={JSON.stringify(prefs.data.data)} initial={prefs.data.data} />
          <Quiet key={quiet.data.version} layer={quiet.data} />
          <Device />
        </div>
      )}
    </PageContainer>
  );
}

function Card({ id, title, lead, children }: { id: string; title: string; lead?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4" aria-labelledby={id}>
      <div>
        <h2 id={id} className="m-0 text-base font-semibold">{title}</h2>
        {lead ? <p className="m-0 mt-1 text-sm text-fg-muted">{lead}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Channels({ initial }: { initial: NotificationPrefs }) {
  const save = useSetNotificationPrefs();
  const { toast } = useToast();
  const [draft, setDraft] = useState(initial);
  const changed = draft.filter((d) => JSON.stringify(d.channels) !== JSON.stringify(initial.find((x) => x.kind === d.kind)?.channels));
  return (
    <Card id="n-channels" title={t('notifset.channels')} lead={t('notifset.channelsLead')}>
      <form method="post" className="flex flex-col gap-3" onSubmit={(e) => {
        e.preventDefault();
        save.mutateAsync(changed).then(() => { toast({ kind: 'success', title: t('cat.saved') }); }, (err: unknown) => { toast({ kind: 'error', title: errorText(err) }); });
      }}>
        <table className="w-full text-sm" data-testid="channel-table">
          <thead>
            <tr className="text-left text-fg-muted">
              <th scope="col" className="py-1 font-medium">{t('config.notifKind')}</th>
              {CHANNELS.map((c) => <th key={c} scope="col" className="py-1 font-medium">{t(`notifset.channel.${c}`)}</th>)}
            </tr>
          </thead>
          <tbody>
            {draft.map((d) => (
              <tr key={d.kind} className="border-t border-line">
                <th scope="row" className="py-2 text-left font-normal">{t(`notif.kind.${d.kind}`)}</th>
                {CHANNELS.map((c) => (
                  <td key={c} className="py-2">
                    <Checkbox
                      checked={d.channels.includes(c)}
                      aria-label={`${t(`notif.kind.${d.kind}`)}: ${t(`notifset.channel.${c}`)}`}
                      onCheckedChange={(v) => { setDraft((list) => list.map((x) => (x.kind === d.kind ? { ...x, channels: CHANNELS.filter((y) => (y === c ? v === true : x.channels.includes(y))) } : x))); }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex justify-end"><Button type="submit" disabled={changed.length === 0} loading={save.isPending} data-testid="channels-save">{t('common.save')}</Button></div>
      </form>
    </Card>
  );
}

function Quiet({ layer }: { layer: ConfigLayer }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const initial = layer.effective as { enabled: boolean; from: string; to: string };
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const same = JSON.stringify(draft) === JSON.stringify(initial);

  async function save(): Promise<void> {
    setError(null);
    setSaving(true);
    try {
      await request('/v1/config/notifications.quiet?scope=user', { method: 'PUT', body: { value: draft }, ifMatch: layer.version });
      await qc.invalidateQueries({ queryKey: ck.all });
      toast({ kind: 'success', title: t('cat.saved') });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Card id="n-quiet" title={t('notifset.quiet')} lead={t('notifset.quietLead')}>
      <form method="post" className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void save(); }} data-testid="quiet-form">
        {error ? <Alert kind="error">{error}</Alert> : null}
        <label className="inline-flex items-center gap-2 text-sm"><Switch checked={draft.enabled} onCheckedChange={(enabled) => { setDraft({ ...draft, enabled }); }} aria-label={t('notifset.quietOn')} /><span aria-hidden>{t('notifset.quietOn')}</span></label>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('notifset.from')}><Input type="time" value={draft.from} disabled={!draft.enabled} onChange={(e) => { setDraft({ ...draft, from: e.target.value }); }} required /></Field>
          <Field label={t('notifset.to')}><Input type="time" value={draft.to} disabled={!draft.enabled} onChange={(e) => { setDraft({ ...draft, to: e.target.value }); }} required /></Field>
        </div>
        <div className="flex justify-end"><Button type="submit" disabled={same || !draft.from || !draft.to} loading={saving} data-testid="quiet-save">{t('common.save')}</Button></div>
      </form>
    </Card>
  );
}

function Device() {
  const push = usePushState();
  const { doNotDisturb, set } = usePreferences();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const state = push.data?.state;

  async function toggle(): Promise<void> {
    setBusy(true);
    try {
      if (state === 'on') await disablePush();
      else if (push.data?.publicKey) await enablePush(push.data.publicKey);
    } catch (e) {
      toast({ kind: 'error', title: e instanceof Error && e.message === 'denied' ? t('notifset.push.denied') : t('notifset.push.failed') });
    } finally {
      await push.refetch();
      setBusy(false);
    }
  }
  return (
    <Card id="n-device" title={t('notifset.device')} lead={t('notifset.deviceLead')}>
      <label className="inline-flex items-center gap-2 text-sm">
        <Switch checked={doNotDisturb} onCheckedChange={(v) => { set({ doNotDisturb: v }); }} aria-label={t('notifset.dnd')} data-testid="dnd" /><span aria-hidden>{t('notifset.dnd')}</span>
      </label>
      <div className="flex flex-wrap items-center gap-3 text-sm" data-testid="push-device">
        <span className="min-w-40 flex-1">{state ? t(`notifset.push.${state}`) : t('common.loading')}</span>
        {state === 'on' || state === 'off' ? <Button variant="secondary" size="sm" loading={busy} onClick={() => { void toggle(); }}>{t(state === 'on' ? 'notifset.push.disable' : 'notifset.push.enable')}</Button> : null}
      </div>
    </Card>
  );
}
