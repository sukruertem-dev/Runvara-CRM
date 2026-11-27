'use client';

import { Alert, Badge, Button, Dialog, DialogContent, DialogFooter, EmptyState, ErrorState, Field, Input, Select, Skeleton } from '@flexa/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { request } from '../../../../../lib/api';
import { errorText } from '../../../../../lib/catalog';
import { CHANNELS, useCustomers } from '../../../../../lib/customers';
import { t } from '../../../../../lib/i18n';
import { PageContainer } from '../../../../_components/app-shell';

// B2C customers (B2C-01, docs/p9-plan.md §27): search by name, e-mail or phone; by tag; who may be reached on a channel.

const ANY = 'any';

export default function CustomersPage() {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [reachable, setReachable] = useState(ANY);
  useEffect(() => {
    const h = setTimeout(() => { setQ(text.trim()); }, 300);
    return () => { clearTimeout(h); };
  }, [text]);
  const list = useCustomers({ q, tag: tag.trim(), reachable: reachable === ANY ? '' : reachable });
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <PageContainer>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <h1 className="m-0 flex-1 font-display text-xl font-bold">{t('customer.title')}</h1>
        <NewCustomer />
      </div>
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Input type="search" value={text} onChange={(e) => { setText(e.target.value); }} aria-label={t('customer.search')} placeholder={t('customer.search')} data-testid="customer-search" />
        <Input value={tag} maxLength={40} onChange={(e) => { setTag(e.target.value); }} aria-label={t('customer.tagFilter')} placeholder={t('customer.tagFilter')} />
        <Select aria-label={t('customer.reachable')} value={reachable} onValueChange={setReachable}
          options={[{ value: ANY, label: t('customer.reachableAny') }, ...CHANNELS.map((c) => ({ value: c, label: t('customer.reachableBy', { channel: t(`consent.channel.${c}`) }) }))]} />
      </div>
      {list.isError ? <ErrorState title={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => { void list.refetch(); }} />
        : !list.data ? <Skeleton className="h-48 w-full" />
          : rows.length === 0 ? <EmptyState icon={Users} title={t('customer.empty')} description={t('customer.emptyBody')} /> : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="customer-list">
              {rows.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-3">
                  <div className="min-w-48 flex-1">
                    <p className="m-0 font-semibold"><Link href={`/crm/contact/${c.id}`}>{c.fullName}</Link></p>
                    <p className="m-0 mt-0.5 text-xs text-fg-muted">{[c.email, c.phone, c.owner.displayName].filter(Boolean).join(' · ')}</p>
                  </div>
                  {c.tags.map((x) => <Badge key={x} tone="accent">{x}</Badge>)}
                  {c.granted.length ? <span className="text-xs text-fg-muted">{t('customer.consents', { list: c.granted.map((g) => t(`consent.channel.${g}`)).join(', ') })}</span> : null}
                </li>
              ))}
            </ul>
          )}
      {list.hasNextPage ? <Button className="mt-3" variant="secondary" onClick={() => { void list.fetchNextPage(); }}>{t('quote.more')}</Button> : null}
    </PageContainer>
  );
}

/** A B2C customer is a contact with the `b2c` segment; e-mail and phone become its contact points (E.164). */
function NewCustomer() {
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ firstName: '', lastName: '', email: '', phone: '' });
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => request<{ id: string }>('/v1/contacts', {
      method: 'POST', idempotencyKey: crypto.randomUUID(),
      body: {
        firstName: v.firstName.trim(), lastName: v.lastName.trim(), segments: ['b2c'],
        contactPoints: [
          ...(v.email.trim() ? [{ kind: 'email', value: v.email.trim(), isPrimary: true }] : []),
          ...(v.phone.trim() ? [{ kind: 'phone', value: v.phone.trim(), isPrimary: true }] : []),
        ],
      },
    }),
    onSuccess: (c) => { void qc.invalidateQueries({ queryKey: ['customers'] }); router.push(`/crm/contact/${c.id}`); },
    onError: (e) => { setError(errorText(e)); },
  });
  const set = (patch: Partial<typeof v>): void => { setV((x) => ({ ...x, ...patch })); };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" onClick={() => { setOpen(true); setError(null); }} data-testid="customer-new">{t('customer.new')}</Button>
      <DialogContent title={t('customer.new')} closeLabel={t('common.close')}>
        <form method="post" className="flex flex-col gap-3" data-testid="customer-dialog" onSubmit={(e) => { e.preventDefault(); setError(null); create.mutate(); }}>
          {error ? <Alert kind="error">{error}</Alert> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('customer.firstName')}><Input value={v.firstName} maxLength={120} onChange={(e) => { set({ firstName: e.target.value }); }} required autoFocus /></Field>
            <Field label={t('customer.lastName')}><Input value={v.lastName} maxLength={120} onChange={(e) => { set({ lastName: e.target.value }); }} /></Field>
          </div>
          <Field label={t('customer.email')}><Input type="email" value={v.email} maxLength={254} onChange={(e) => { set({ email: e.target.value }); }} /></Field>
          <Field label={t('customer.phone')}><Input type="tel" value={v.phone} maxLength={40} onChange={(e) => { set({ phone: e.target.value }); }} /></Field>
          <DialogFooter>
            <Button type="submit" loading={create.isPending} disabled={!v.firstName.trim()} data-testid="customer-create">{t('settings.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
