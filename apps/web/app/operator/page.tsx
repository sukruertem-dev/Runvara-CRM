'use client';

import { Button, Dialog, DialogContent, DialogFooter, Field, Input, Select, Skeleton, useToast } from '@flexa/ui';
import { Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ApiError } from '../../lib/api';
import { messageForCode } from '../../lib/errors';
import { formatDate, formatNumber } from '../../lib/format';
import { t, tOptional } from '../../lib/i18n';
import { useCreateTenant, useOperatorTenants, type PlanId } from '../../lib/operator';
import { OperatorError, PLAN_IDS, StatusBadge } from './_parts';

// Operator console: every workspace with status, plan and member count (metadata only).

export default function OperatorTenantsPage() {
  const tenants = useOperatorTenants();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const rows = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase('tr-TR');
    return (tenants.data?.data ?? []).filter((x) => !needle || x.name.toLocaleLowerCase('tr-TR').includes(needle) || x.slug.includes(needle));
  }, [tenants.data, q]);

  return (
    <>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="m-0 font-display text-xl font-bold">{t('op.nav.tenants')}</h1>
          <p className="m-0 mt-1 max-w-2xl text-sm text-fg-muted">{t('op.lead')}</p>
        </div>
        <Button icon={<Plus aria-hidden size={16} />} onClick={() => { setCreating(true); }} data-testid="op-create">{t('op.create')}</Button>
      </div>
      {tenants.isError ? <OperatorError error={tenants.error} onRetry={() => { void tenants.refetch(); }} /> : !tenants.data ? <Skeleton className="h-64 w-full" /> : (
        <>
          <div className="mb-3 flex max-w-sm items-center gap-2">
            <Search aria-hidden size={16} className="text-fg-muted" />
            <Input value={q} aria-label={t('op.search')} placeholder={t('op.search')} onChange={(e) => { setQ(e.target.value); }} />
          </div>
          <div className="overflow-x-auto rounded-card border border-line bg-surface">
            <table className="w-full border-collapse text-sm" data-testid="op-tenants">
              <thead className="bg-subtle text-left text-xs text-fg-muted">
                <tr>
                  <th scope="col" className="px-3 py-2 font-semibold">{t('op.col.name')}</th>
                  <th scope="col" className="px-3 py-2 font-semibold">{t('op.col.status')}</th>
                  <th scope="col" className="px-3 py-2 font-semibold">{t('op.col.plan')}</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">{t('op.col.members')}</th>
                  <th scope="col" className="px-3 py-2 font-semibold">{t('op.col.created')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((x) => (
                  <tr key={x.id} className="border-t border-line">
                    <td className="px-3 py-2">
                      <Link href={`/operator/tenants/${x.id}`} className="font-semibold text-fg">{x.name}</Link>
                      <span className="block text-xs text-fg-muted">{x.slug}</span>
                    </td>
                    <td className="px-3 py-2"><StatusBadge status={x.status} /></td>
                    <td className="px-3 py-2">{x.plan ? (tOptional(`plan.${x.plan.id}.name`) ?? x.plan.id) : '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatNumber(x.members)}</td>
                    <td className="px-3 py-2">{formatDate(x.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 ? <p className="m-0 p-4 text-sm text-fg-muted">{t('op.empty')}</p> : null}
          </div>
        </>
      )}
      <CreateDialog open={creating} onClose={() => { setCreating(false); }} />
    </>
  );
}

function CreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateTenant();
  const toast = useToast();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [email, setEmail] = useState('');
  const [plan, setPlan] = useState<PlanId>('trial');
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={t('op.create')} description={t('op.create.hint')} closeLabel={t('common.close')}>
        <form className="flex flex-col gap-3" onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          create.mutate({ name: name.trim(), slug: slug.trim(), adminEmail: email.trim(), plan }, {
            onSuccess: (r) => { toast.toast({ kind: 'success', title: t('op.created', { name: r.name }) }); onClose(); },
            onError: (err) => { setError(err instanceof ApiError ? messageForCode(err.code) : t('error.fallback')); },
          });
        }}>
          <Field label={t('op.create.name')}><Input value={name} required maxLength={120} onChange={(e) => { setName(e.target.value); }} /></Field>
          <Field label={t('op.create.slug')} hint={t('signup.tenantSlugHint')}><Input value={slug} required pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]" onChange={(e) => { setSlug(e.target.value.toLowerCase()); }} /></Field>
          <Field label={t('op.create.email')}><Input type="email" value={email} required onChange={(e) => { setEmail(e.target.value); }} /></Field>
          <Field label={t('op.create.plan')}>
            <Select value={plan} onValueChange={(v) => { setPlan(v as PlanId); }} options={PLAN_IDS.map((p) => ({ value: p, label: tOptional(`plan.${p}.name`) ?? p }))} />
          </Field>
          {error ? <p role="alert" className="m-0 text-sm text-danger">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" loading={create.isPending}>{t('op.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
