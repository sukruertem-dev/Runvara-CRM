'use client';

import { WEBHOOK_EVENT_GROUPS } from '../../../../lib/event-types';
import { Alert, Badge, Button, Checkbox, Dialog, DialogContent, DialogFooter, EmptyState, ErrorState, Field, IconButton, Input, Skeleton, Switch, useToast } from '@flexa/ui';
import { Copy, History, KeyRound, Plus, RefreshCw, Send, Trash2, Webhook as WebhookIcon } from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '../../../../lib/api';
import { useApp } from '../../../../lib/app-context';
import { messageForCode } from '../../../../lib/errors';
import { dateTime, endOfDayIso } from '../../../../lib/format';
import { t } from '../../../../lib/i18n';
import { useApiKeyMutations, useApiKeys, useDeliveries, useWebhookMutations, useWebhooks, type ApiKey, type Webhook } from '../../../../lib/settings';
import { PageContainer } from '../../../_components/app-shell';
import { ReadOnlyNotice, SettingsGate, SettingsHeader } from '../_parts/settings-nav';

const errText = (e: unknown) => (e instanceof ApiError ? `${messageForCode(e.code)}${e.code === 'VALIDATION_FAILED' || e.code === 'URL_NOT_ALLOWED' ? ` ${e.problem.detail ?? ''}` : ''}`.trim() : t('error.fallback'));

/** A secret shown once (webhook signing secret, API key) with a copy button. */
function OneTimeSecret({ title, value, onDone }: { title: string; value: string; onDone: () => void }) {
  const { toast } = useToast();
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onDone(); }}>
      <DialogContent title={title} description={t('settings.int.secretOnce')} closeLabel={t('common.close')}>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 break-all rounded-input bg-subtle p-2 text-xs" data-testid="one-time-secret">{value}</code>
          <IconButton
            label={t('common.copy')}
            onClick={() => {
              navigator.clipboard.writeText(value).then(
                () => { toast({ title: t('common.copied'), kind: 'success' }); },
                () => { toast({ title: t('views.linkFailed'), kind: 'error' }); },
              );
            }}
          >
            <Copy aria-hidden size={16} />
          </IconButton>
        </div>
        <DialogFooter><Button onClick={onDone}>{t('settings.int.stored')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EventPicker({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const all = value.includes('*');
  const set = new Set(value);
  const flip = (type: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(type);
    else next.delete(type);
    onChange([...next]);
  };
  return (
    <fieldset className="m-0 border-0 p-0">
      <legend className="mb-1 text-sm font-medium">{t('settings.int.events')}</legend>
      <label className="mb-2 inline-flex items-center gap-2 text-sm"><Checkbox checked={all} onCheckedChange={(v) => { onChange(v === true ? ['*'] : []); }} />{t('settings.int.allEvents')}</label>
      {all ? null : (
        <div className="grid max-h-64 gap-3 overflow-y-auto rounded-input border border-line p-3 sm:grid-cols-2">
          {WEBHOOK_EVENT_GROUPS.map((g, gi) => {
            const wildcard = `${g.types[0]?.split('.')[0] ?? g.group}.*`;
            const recordGroup = gi < 6;
            return (
              <fieldset key={`${g.group}-${String(gi)}`} className="m-0 flex flex-col gap-1 border-0 p-0">
                <legend className="mb-0.5 text-xs font-semibold text-fg-muted">{t(`settings.int.group.${g.group}` as 'settings.int.group.task')}</legend>
                {recordGroup ? (
                  <label className="inline-flex items-center gap-2 text-xs"><Checkbox checked={set.has(wildcard)} onCheckedChange={(v) => { flip(wildcard, v === true); }} /><code>{wildcard}</code></label>
                ) : null}
                {g.types.map((type) => (
                  <label key={type} className="inline-flex items-center gap-2 text-xs">
                    <Checkbox checked={set.has(type) || (recordGroup && set.has(wildcard))} disabled={recordGroup && set.has(wildcard)} onCheckedChange={(v) => { flip(type, v === true); }} />
                    <code>{type}</code>
                  </label>
                ))}
              </fieldset>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}

function WebhookDialog({ hook, onClose, onSecret }: { hook: Webhook | 'new'; onClose: () => void; onSecret: (s: string) => void }) {
  const m = useWebhookMutations();
  const existing = hook === 'new' ? null : hook;
  const [name, setName] = useState(existing?.name ?? '');
  const [url, setUrl] = useState(existing?.url ?? 'https://');
  const [events, setEvents] = useState<string[]>(existing?.eventTypes ?? ['task.created']);
  const [error, setError] = useState<string | null>(null);
  async function submit(): Promise<void> {
    setError(null);
    try {
      if (existing) {
        await m.patch.mutateAsync({ id: existing.id, body: { name: name.trim(), url: url.trim(), eventTypes: events } });
        onClose();
      } else {
        const created = await m.create.mutateAsync({ name: name.trim(), url: url.trim(), eventTypes: events });
        onClose();
        if (created.secret) onSecret(created.secret);
      }
    } catch (e) {
      setError(errText(e));
    }
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={existing ? t('settings.int.editWebhook') : t('settings.int.newWebhook')} closeLabel={t('common.close')} wide>
        <form method="post" onSubmit={(e) => { e.preventDefault(); void submit(); }} className="flex flex-col gap-3" data-testid="webhook-dialog">
          {error ? <Alert kind="error">{error}</Alert> : null}
          <Field label={t('settings.int.name')}><Input value={name} maxLength={120} required onChange={(e) => { setName(e.target.value); }} autoFocus /></Field>
          <Field label={t('settings.int.url')} hint={t('settings.int.urlHint')}><Input type="url" value={url} maxLength={2000} required onChange={(e) => { setUrl(e.target.value); }} /></Field>
          <EventPicker value={events} onChange={setEvents} />
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" loading={m.create.isPending || m.patch.isPending} disabled={!name.trim() || events.length === 0} data-testid="webhook-save">{existing ? t('settings.save') : t('settings.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Deliveries({ hook, onClose }: { hook: Webhook; onClose: () => void }) {
  const q = useDeliveries(hook.id);
  const m = useWebhookMutations();
  const { toast } = useToast();
  const tone = (s: string) => (s === 'succeeded' ? 'success' : s === 'pending' ? 'neutral' : 'danger');
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={t('settings.int.deliveries', { name: hook.name })} closeLabel={t('common.close')} wide>
        {q.data?.data.length ? (
          <ul className="m-0 flex list-none flex-col divide-y divide-line p-0 text-sm">
            {q.data.data.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2 py-2">
                <Badge tone={tone(d.status)}>{t(`settings.int.delivery.${d.status}`)}</Badge>
                <code className="text-xs">{d.eventType}</code>
                <span className="text-fg-muted">{dateTime(d.createdAt)}</span>
                <span className="tabular-nums text-fg-muted">{d.responseStatus ?? '—'} · {t('settings.int.attempts', { count: String(d.attempts) })}</span>
                {d.status === 'failed' || d.status === 'dead' ? (
                  <Button size="sm" variant="ghost" className="ml-auto" icon={<Send aria-hidden size={14} />} onClick={() => { m.redeliver.mutate({ webhookId: hook.id, deliveryId: d.id }, { onSuccess: () => { toast({ title: t('settings.int.redelivered'), kind: 'success' }); }, onError: (e) => { toast({ title: errText(e), kind: 'error' }); } }); }}>
                    {t('settings.int.redeliver')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-sm text-fg-muted">{q.isPending ? t('common.loading') : t('settings.int.noDeliveries')}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Webhooks({ editable }: { editable: boolean }) {
  const q = useWebhooks();
  const m = useWebhookMutations();
  const { toast } = useToast();
  const [editing, setEditing] = useState<Webhook | 'new' | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [history, setHistory] = useState<Webhook | null>(null);
  const [removing, setRemoving] = useState<Webhook | null>(null);
  const fail = (e: unknown) => { toast({ title: errText(e), kind: 'error' }); };
  return (
    <section aria-labelledby="int-webhooks" className="mb-8">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id="int-webhooks" className="m-0 text-base font-semibold">{t('settings.int.webhooks')}</h2>
        {editable ? <Button size="sm" icon={<Plus aria-hidden size={14} />} onClick={() => { setEditing('new'); }} data-testid="webhook-new">{t('settings.int.newWebhook')}</Button> : null}
      </div>
      {q.isPending ? <Skeleton className="h-24 w-full" /> : q.isError ? <ErrorState title={t('error.fallback')} retryLabel={t('common.retry')} onRetry={() => { void q.refetch(); }} /> : q.data.data.length === 0 ? (
        <EmptyState icon={WebhookIcon} title={t('settings.int.noWebhooks')} description={t('settings.int.noWebhooksBody')} />
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-line rounded-card border border-line bg-surface p-0">
          {q.data.data.map((w) => (
            <li key={w.id} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="webhook-row">
              <div className="min-w-0 flex-1">
                <button type="button" className="font-medium text-fg underline-offset-2 hover:underline disabled:no-underline" disabled={!editable} onClick={() => { setEditing(w); }}>{w.name}</button>
                <p className="m-0 mt-0.5 truncate text-xs text-fg-muted">{w.url} · {w.eventTypes.join(', ')}</p>
                {w.disabledReason ? <p className="m-0 mt-0.5 text-xs text-danger">{t('settings.int.autoDisabled', { reason: w.disabledReason })}</p> : null}
              </div>
              <label className="inline-flex items-center gap-2 text-sm">
                <Switch checked={w.enabled} disabled={!editable} aria-label={t('settings.int.toggle', { name: w.name })} onCheckedChange={(enabled) => { m.patch.mutate({ id: w.id, body: { enabled } }, { onError: fail }); }} />
                <span aria-hidden>{w.enabled ? t('settings.enabled') : t('settings.disabled')}</span>
              </label>
              <span className="flex gap-1">
                <IconButton size="sm" label={t('settings.int.deliveries', { name: w.name })} onClick={() => { setHistory(w); }}><History aria-hidden size={14} /></IconButton>
                {editable ? (
                  <>
                    <IconButton size="sm" label={t('settings.int.rotate', { name: w.name })} onClick={() => { m.rotate.mutate(w.id, { onSuccess: (r) => { if (r.secret) setSecret(r.secret); }, onError: fail }); }}><RefreshCw aria-hidden size={14} /></IconButton>
                    <IconButton size="sm" label={t('settings.int.deleteWebhook', { name: w.name })} onClick={() => { setRemoving(w); }}><Trash2 aria-hidden size={14} /></IconButton>
                  </>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {editing ? <WebhookDialog key={editing === 'new' ? 'new' : editing.id} hook={editing} onClose={() => { setEditing(null); }} onSecret={setSecret} /> : null}
      {secret ? <OneTimeSecret title={t('settings.int.secretTitle')} value={secret} onDone={() => { setSecret(null); }} /> : null}
      {history ? <Deliveries hook={history} onClose={() => { setHistory(null); }} /> : null}
      <Dialog open={removing !== null} onOpenChange={(o) => { if (!o) setRemoving(null); }}>
        <DialogContent title={t('settings.int.deleteWebhookTitle')} description={t('settings.int.deleteWebhookBody', { name: removing?.name ?? '' })} closeLabel={t('common.close')}>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setRemoving(null); }}>{t('common.cancel')}</Button>
            <Button variant="danger" loading={m.remove.isPending} onClick={() => { if (removing) m.remove.mutate(removing.id, { onSuccess: () => { setRemoving(null); }, onError: fail }); }}>{t('settings.delete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function NewKey({ onClose, onKey }: { onClose: () => void; onKey: (k: string) => void }) {
  const m = useApiKeyMutations();
  const [name, setName] = useState('');
  const [write, setWrite] = useState(false);
  const [expires, setExpires] = useState('');
  const [rate, setRate] = useState(600);
  const [error, setError] = useState<string | null>(null);
  async function submit(): Promise<void> {
    setError(null);
    try {
      const k = await m.create.mutateAsync({ name: name.trim(), scopes: write ? ['read', 'write'] : ['read'], rateLimitPerMinute: rate, ...(expires ? { expiresAt: endOfDayIso(expires) } : {}) });
      onClose();
      if (k.key) onKey(k.key);
    } catch (e) {
      setError(errText(e));
    }
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={t('settings.int.newKey')} closeLabel={t('common.close')}>
        <form method="post" onSubmit={(e) => { e.preventDefault(); void submit(); }} className="flex flex-col gap-3" data-testid="key-dialog">
          {error ? <Alert kind="error">{error}</Alert> : null}
          <Field label={t('settings.int.name')}><Input value={name} maxLength={120} required autoFocus onChange={(e) => { setName(e.target.value); }} /></Field>
          <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
            <legend className="mb-1 text-sm font-medium">{t('settings.int.scopes')}</legend>
            <label className="inline-flex items-center gap-2 text-sm"><Checkbox checked disabled />{t('settings.int.scope.read')}</label>
            <label className="inline-flex items-center gap-2 text-sm"><Checkbox checked={write} onCheckedChange={(v) => { setWrite(v === true); }} />{t('settings.int.scope.write')}</label>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('settings.int.expires')} hint={t('settings.int.expiresHint')}><Input type="date" value={expires} onChange={(e) => { setExpires(e.target.value); }} /></Field>
            <Field label={t('settings.int.rate')}><Input type="number" min={1} max={100000} value={rate} onChange={(e) => { setRate(Math.max(1, Number(e.target.value) || 1)); }} /></Field>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" loading={m.create.isPending} disabled={!name.trim()} data-testid="key-save">{t('settings.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ApiKeys({ editable }: { editable: boolean }) {
  const q = useApiKeys();
  const m = useApiKeyMutations();
  const { toast } = useToast();
  const [creating, setCreating] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  return (
    <section aria-labelledby="int-keys">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id="int-keys" className="m-0 text-base font-semibold">{t('settings.int.keys')}</h2>
        {editable ? <Button size="sm" icon={<Plus aria-hidden size={14} />} onClick={() => { setCreating(true); }} data-testid="key-new">{t('settings.int.newKey')}</Button> : null}
      </div>
      {q.isPending ? <Skeleton className="h-24 w-full" /> : q.isError ? <ErrorState title={t('error.fallback')} retryLabel={t('common.retry')} onRetry={() => { void q.refetch(); }} /> : q.data.data.length === 0 ? (
        <EmptyState icon={KeyRound} title={t('settings.int.noKeys')} description={t('settings.int.noKeysBody')} />
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-line rounded-card border border-line bg-surface p-0">
          {q.data.data.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="key-row">
              <div className="min-w-0 flex-1">
                <p className="m-0 font-medium">{k.name}</p>
                <p className="m-0 mt-0.5 text-xs text-fg-muted">
                  <code>{k.prefix}…</code> · {k.scopes.map((s) => t(`settings.int.scope.${s}`)).join(', ')} · {t('settings.int.perMinute', { count: String(k.rateLimitPerMinute) })}
                  {k.lastUsedAt ? ` · ${t('settings.int.lastUsed', { at: dateTime(k.lastUsedAt) })}` : ''}
                  {k.expiresAt ? ` · ${t('settings.int.expiresAt', { at: dateTime(k.expiresAt) })}` : ''}
                </p>
              </div>
              {k.revokedAt ? <Badge tone="danger">{t('settings.int.revoked')}</Badge> : editable ? (
                <Button size="sm" variant="danger" onClick={() => { setRevoking(k); }}>{t('settings.int.revoke')}</Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {creating ? <NewKey onClose={() => { setCreating(false); }} onKey={setKey} /> : null}
      {key ? <OneTimeSecret title={t('settings.int.keyTitle')} value={key} onDone={() => { setKey(null); }} /> : null}
      <Dialog open={revoking !== null} onOpenChange={(o) => { if (!o) setRevoking(null); }}>
        <DialogContent title={t('settings.int.revokeTitle')} description={t('settings.int.revokeBody', { name: revoking?.name ?? '' })} closeLabel={t('common.close')}>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setRevoking(null); }}>{t('common.cancel')}</Button>
            <Button variant="danger" loading={m.revoke.isPending} onClick={() => { if (revoking) m.revoke.mutate(revoking.id, { onSuccess: () => { setRevoking(null); }, onError: (e) => { toast({ title: errText(e), kind: 'error' }); } }); }}>{t('settings.int.revoke')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function IntegrationsInner() {
  const { can } = useApp();
  const editable = can('tenant.config.manage');
  return (
    <PageContainer>
      <SettingsHeader title={t('settings.integrations')} lead={t('settings.int.lead')} />
      {editable ? null : <ReadOnlyNotice />}
      <Webhooks editable={editable} />
      {editable ? <ApiKeys editable={editable} /> : null}
    </PageContainer>
  );
}

export default function IntegrationsPage() {
  return (
    <SettingsGate anyOf={['tenant.config.read']} module="api_webhooks">
      <IntegrationsInner />
    </SettingsGate>
  );
}
