'use client';

import { Alert, Badge, Button, Dialog, DialogContent, DialogFooter, Field, IconButton, Input, Select, Skeleton, Switch, Textarea, useToast } from '@flexa/ui';
import { History, MapPin, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { errorText } from '../../lib/catalog';
import { CHANNELS, SOURCES, useConsentHistory, useCustomer, useDeleteAddress, usePutProfile, useSaveAddress, useSetConsent, type Channel, type Customer } from '../../lib/customers';
import { dateTime } from '../../lib/format';
import { t } from '../../lib/i18n';
import { CustomerOrders, CustomerPrivacy } from './customer-orders';
import { Section } from './record-parts';

// B2C customer on the contact page (B2C-01, B2C-06, docs/p9-plan.md §22–28): profile, addresses, channel consent.

const NONE = 'none';
type Address = Customer['addresses'][number];
type Consent = NonNullable<Customer['consents'][number]['consent']>;

export function CustomerPanels({ contactId }: { contactId: string }) {
  const c = useCustomer(contactId);
  if (c.isError) return null;
  if (!c.data) return <Skeleton className="h-40 w-full" />;
  return (
    <>
      <ConsentPanel customer={c.data} />
      <ProfilePanel key={`p${String(c.data.version)}`} customer={c.data} />
      <CustomerOrders customer={c.data} />
      <AddressPanel customer={c.data} />
      <CustomerPrivacy customer={c.data} />
    </>
  );
}

// ------------------------------------------------------------------ profile
function ProfilePanel({ customer }: { customer: Customer }) {
  const put = usePutProfile(customer.id);
  const { toast } = useToast();
  const [channel, setChannel] = useState<string>(customer.preferredChannel ?? NONE);
  const [language, setLanguage] = useState<string>(customer.language ?? NONE);
  const [tags, setTags] = useState<string[]>(customer.tags);
  const [tag, setTag] = useState('');
  const changed = channel !== (customer.preferredChannel ?? NONE) || language !== (customer.language ?? NONE) || JSON.stringify(tags) !== JSON.stringify(customer.tags);
  const addTag = (): void => {
    const v = tag.trim().replace(/,/g, '').slice(0, 40);
    if (v && !tags.includes(v) && tags.length < 20) setTags([...tags, v]);
    setTag('');
  };
  function save(): void {
    put.mutateAsync({ version: customer.version, body: { preferredChannel: channel === NONE ? null : (channel as Channel), language: language === NONE ? null : (language as 'tr' | 'en'), tags } }).then(
      () => { toast({ kind: 'success', title: t('customer.profileSaved') }); },
      (e: unknown) => { toast({ kind: 'error', title: errorText(e) }); },
    );
  }
  return (
    <Section title={t('customer.profile')} testId="customer-profile">
      <form method="post" className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <fieldset disabled={!customer.canEdit} className="m-0 flex flex-col gap-3 border-0 p-0">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('customer.preferredChannel')}>
              <Select aria-label={t('customer.preferredChannel')} value={channel} onValueChange={setChannel} options={[{ value: NONE, label: '—' }, ...CHANNELS.map((x) => ({ value: x, label: t(`consent.channel.${x}`) }))]} />
            </Field>
            <Field label={t('customer.language')}>
              <Select aria-label={t('customer.language')} value={language} onValueChange={setLanguage} options={[{ value: NONE, label: '—' }, { value: 'tr', label: 'Türkçe' }, { value: 'en', label: 'English' }]} />
            </Field>
          </div>
          <div>
            <p className="m-0 mb-1 text-sm font-medium">{t('customer.tags')}</p>
            <ul className="m-0 mb-2 flex list-none flex-wrap gap-1.5 p-0" data-testid="customer-tags" aria-label={t('customer.tags')}>
              {tags.map((x) => (
                <li key={x}>
                  <Badge tone="accent">
                    {x}
                    {customer.canEdit ? <button type="button" className="ml-1 text-fg-muted" aria-label={t('customer.removeTag', { tag: x })} onClick={() => { setTags(tags.filter((y) => y !== x)); }}>×</button> : null}
                  </Badge>
                </li>
              ))}
              {tags.length === 0 ? <li className="text-sm text-fg-muted">{t('customer.noTags')}</li> : null}
            </ul>
            {customer.canEdit ? (
              <div className="flex gap-2">
                <Input value={tag} maxLength={40} aria-label={t('customer.newTag')} placeholder={t('customer.newTag')} onChange={(e) => { setTag(e.target.value); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }} data-testid="tag-input" />
                <Button type="button" variant="secondary" size="sm" onClick={addTag} disabled={!tag.trim()}>{t('customer.addTag')}</Button>
              </div>
            ) : null}
          </div>
        </fieldset>
        {customer.canEdit ? <div className="flex justify-end"><Button type="submit" size="sm" disabled={!changed} loading={put.isPending} data-testid="profile-save">{t('common.save')}</Button></div> : null}
      </form>
    </Section>
  );
}

// ------------------------------------------------------------------ addresses
function AddressPanel({ customer }: { customer: Customer }) {
  const del = useDeleteAddress(customer.id);
  const { toast } = useToast();
  const [editing, setEditing] = useState<Address | 'new' | null>(null);
  return (
    <Section title={t('customer.addresses')} testId="customer-addresses">
      {customer.addresses.length === 0 ? <p className="m-0 text-sm text-fg-muted">{t('customer.noAddresses')}</p> : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {customer.addresses.map((a) => (
            <li key={a.id} className="flex items-start gap-2 text-sm">
              <MapPin aria-hidden size={16} className="mt-0.5 shrink-0 text-fg-muted" />
              <div className="min-w-0 flex-1">
                <p className="m-0 font-medium">{a.label || t('customer.address')}{a.isDefault ? <> <Badge tone="info">{t('customer.default')}</Badge></> : null}</p>
                <p className="m-0 text-fg-muted">{[a.recipient, a.line1, a.line2, [a.district, a.city].filter(Boolean).join(' / '), [a.postalCode, a.country].filter(Boolean).join(' ')].filter(Boolean).join(', ')}</p>
              </div>
              {customer.canEdit ? (
                <>
                  <IconButton size="sm" label={t('customer.editAddress', { label: a.label || a.city })} onClick={() => { setEditing(a); }}><Pencil aria-hidden size={14} /></IconButton>
                  <IconButton size="sm" label={t('customer.deleteAddress', { label: a.label || a.city })}
                    onClick={() => { del.mutateAsync(a.id).then(() => { toast({ kind: 'success', title: t('customer.addressDeleted') }); }, (e: unknown) => { toast({ kind: 'error', title: errorText(e) }); }); }}>
                    <Trash2 aria-hidden size={14} />
                  </IconButton>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {customer.canEdit ? <Button className="mt-3" size="sm" variant="secondary" icon={<Plus aria-hidden size={16} />} onClick={() => { setEditing('new'); }} data-testid="address-new">{t('customer.addAddress')}</Button> : null}
      {editing ? <AddressDialog customerId={customer.id} address={editing === 'new' ? null : editing} onClose={() => { setEditing(null); }} /> : null}
    </Section>
  );
}

function AddressDialog({ customerId, address, onClose }: { customerId: string; address: Address | null; onClose: () => void }) {
  const save = useSaveAddress(customerId);
  const { toast } = useToast();
  const [v, setV] = useState({
    label: address?.label ?? '', recipient: address?.recipient ?? '', line1: address?.line1 ?? '', line2: address?.line2 ?? '', district: address?.district ?? '',
    city: address?.city ?? '', postalCode: address?.postalCode ?? '', country: address?.country ?? 'TR', isDefault: address?.isDefault ?? false,
  });
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof v>): void => { setV((x) => ({ ...x, ...patch })); };
  const valid = v.line1.trim() !== '' && v.city.trim() !== '' && /^[A-Z]{2}$/.test(v.country);
  function run(): void {
    setError(null);
    save.mutateAsync({ ...(address ? { addressId: address.id } : {}), body: v }).then(
      () => { toast({ kind: 'success', title: t('customer.addressSaved') }); onClose(); },
      (e: unknown) => { setError(errorText(e)); },
    );
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={address ? t('customer.editAddress', { label: address.label || address.city }) : t('customer.addAddress')} closeLabel={t('common.close')}>
        <form method="post" className="flex flex-col gap-3" data-testid="address-dialog" onSubmit={(e) => { e.preventDefault(); run(); }}>
          {error ? <Alert kind="error">{error}</Alert> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('customer.addressLabel')}><Input value={v.label} maxLength={40} onChange={(e) => { set({ label: e.target.value }); }} /></Field>
            <Field label={t('customer.recipient')}><Input value={v.recipient} maxLength={200} onChange={(e) => { set({ recipient: e.target.value }); }} /></Field>
          </div>
          <Field label={t('customer.line1')}><Input value={v.line1} maxLength={300} required onChange={(e) => { set({ line1: e.target.value }); }} /></Field>
          <Field label={t('customer.line2')}><Input value={v.line2} maxLength={300} onChange={(e) => { set({ line2: e.target.value }); }} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('customer.district')}><Input value={v.district} maxLength={120} onChange={(e) => { set({ district: e.target.value }); }} /></Field>
            <Field label={t('customer.city')}><Input value={v.city} maxLength={120} required onChange={(e) => { set({ city: e.target.value }); }} /></Field>
            <Field label={t('customer.postalCode')}><Input value={v.postalCode} maxLength={20} onChange={(e) => { set({ postalCode: e.target.value }); }} /></Field>
            <Field label={t('customer.country')}><Input value={v.country} maxLength={2} onChange={(e) => { set({ country: e.target.value.toUpperCase() }); }} /></Field>
          </div>
          <label className="inline-flex items-center gap-2 text-sm"><Switch checked={v.isDefault} onCheckedChange={(x) => { set({ isDefault: x }); }} aria-label={t('customer.makeDefault')} />{t('customer.makeDefault')}</label>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" loading={save.isPending} disabled={!valid} data-testid="address-save">{t('common.save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ consent
function ConsentPanel({ customer }: { customer: Customer }) {
  const [editing, setEditing] = useState<Channel | null>(null);
  const [history, setHistory] = useState(false);
  if (customer.consents.length === 0) return null;
  return (
    <Section title={t('consent.title')} testId="consent-panel">
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {customer.consents.map(({ channel, consent }) => (
          <li key={channel} className="flex flex-wrap items-center gap-2 text-sm" data-testid={`consent-${channel}`}>
            <span className="min-w-20 font-medium">{t(`consent.channel.${channel}`)}</span>
            <Badge tone={consent?.status === 'granted' ? 'success' : consent ? 'danger' : 'neutral'}>{t(consent ? `consent.status.${consent.status}` : 'consent.none')}</Badge>
            {consent ? <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">{t(`consent.source.${consent.source}`)} · {dateTime(consent.occurredAt)}</span> : <span className="flex-1" />}
            {customer.canManageConsent ? <Button size="sm" variant="ghost" onClick={() => { setEditing(channel); }} aria-label={t('consent.recordFor', { channel: t(`consent.channel.${channel}`) })}>{t('consent.record')}</Button> : null}
          </li>
        ))}
      </ul>
      <Button className="mt-3" size="sm" variant="ghost" icon={<History aria-hidden size={16} />} onClick={() => { setHistory(true); }} data-testid="consent-history-open">{t('consent.history')}</Button>
      {editing ? <ConsentDialog customerId={customer.id} channel={editing} current={customer.consents.find((c) => c.channel === editing)?.consent ?? null} onClose={() => { setEditing(null); }} /> : null}
      {history ? <HistoryDialog customerId={customer.id} onClose={() => { setHistory(false); }} /> : null}
    </Section>
  );
}

/** Local `YYYY-MM-DDTHH:mm` for a datetime-local input. */
const localNow = (): string => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

function ConsentDialog({ customerId, channel, current, onClose }: { customerId: string; channel: Channel; current: Consent | null; onClose: () => void }) {
  const set = useSetConsent(customerId);
  const { toast } = useToast();
  const [status, setStatus] = useState<'granted' | 'withdrawn'>(current?.status === 'granted' ? 'withdrawn' : 'granted');
  const [source, setSource] = useState<(typeof SOURCES)[number]>('phone');
  const [evidence, setEvidence] = useState('');
  const [externalRef, setExternalRef] = useState('');
  const [when, setWhen] = useState(localNow);
  const [error, setError] = useState<string | null>(null);
  const name = t(`consent.channel.${channel}`);
  function run(): void {
    setError(null);
    set.mutateAsync({ channel, status, source, evidence: evidence.trim(), externalRef: externalRef.trim() || null, occurredAt: new Date(when).toISOString() }).then(
      () => { toast({ kind: 'success', title: t('consent.saved') }); onClose(); },
      (e: unknown) => { setError(errorText(e)); },
    );
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={t('consent.recordFor', { channel: name })} closeLabel={t('common.close')}>
        <form method="post" className="flex flex-col gap-3" data-testid="consent-dialog" onSubmit={(e) => { e.preventDefault(); run(); }}>
          {error ? <Alert kind="error">{error}</Alert> : null}
          <Field label={t('consent.state')}>
            <Select aria-label={t('consent.state')} value={status} onValueChange={(v) => { setStatus(v as 'granted' | 'withdrawn'); }}
              options={[{ value: 'granted', label: t('consent.status.granted') }, { value: 'withdrawn', label: t('consent.status.withdrawn') }]} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('consent.sourceLabel')}>
              <Select aria-label={t('consent.sourceLabel')} value={source} onValueChange={(v) => { setSource(v as (typeof SOURCES)[number]); }} options={SOURCES.map((s) => ({ value: s, label: t(`consent.source.${s}`) }))} />
            </Field>
            <Field label={t('consent.when')}><Input type="datetime-local" value={when} max={localNow()} onChange={(e) => { setWhen(e.target.value); }} required /></Field>
          </div>
          <Field label={t('consent.evidence')} hint={t('consent.evidenceHint')}><Textarea value={evidence} maxLength={500} rows={2} onChange={(e) => { setEvidence(e.target.value); }} /></Field>
          <Field label={t('consent.externalRef')}><Input value={externalRef} maxLength={200} onChange={(e) => { setExternalRef(e.target.value); }} /></Field>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" loading={set.isPending} disabled={!when} data-testid="consent-save">{t('common.save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function HistoryDialog({ customerId, onClose }: { customerId: string; onClose: () => void }) {
  const h = useConsentHistory(customerId, true);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={t('consent.history')} closeLabel={t('common.close')}>
        {h.isError ? <Alert kind="error">{errorText(h.error)}</Alert> : !h.data ? <Skeleton className="h-24 w-full" />
          : h.data.data.length === 0 ? <p className="m-0 text-sm text-fg-muted">{t('consent.noHistory')}</p> : (
            <ol className="m-0 flex list-none flex-col gap-2 p-0" data-testid="consent-history">
              {h.data.data.map((e) => (
                <li key={e.id} className="rounded-card border border-line p-2 text-sm">
                  <p className="m-0"><span className="font-medium">{t(`consent.channel.${e.channel}`)}</span> · {t(`consent.status.${e.status}`)} · {t(`consent.source.${e.source}`)}</p>
                  <p className="m-0 text-xs text-fg-muted">{dateTime(e.occurredAt)} · {e.recordedBy?.displayName ?? '—'}{e.externalRef ? ` · ${e.externalRef}` : ''}</p>
                  {e.evidence ? <p className="m-0 mt-1 text-xs">{e.evidence}</p> : null}
                </li>
              ))}
            </ol>
          )}
      </DialogContent>
    </Dialog>
  );
}
