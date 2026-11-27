'use client';

import { Badge, Select, useToast } from '@flexa/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { request } from '../../lib/api';
import { errorText } from '../../lib/catalog';
import { t } from '../../lib/i18n';
import { rk } from '../../lib/records';
import { recordName, type CrmRecord } from '../(app)/crm/_parts/columns';
import { Section } from './record-parts';

const ROLES = ['decision_maker', 'influencer', 'user', 'approver', 'other'] as const;
type Role = (typeof ROLES)[number];

/** People of an account with their buying role (B2B-01); the role is changed where the contact may be edited. */
export function BuyingRoles({ accountId, contacts }: { accountId: string; contacts: CrmRecord[] }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const save = useMutation({
    mutationFn: (v: { contactId: string; role: Role; isPrimary: boolean }) => request(`/v1/contacts/${v.contactId}/accounts/${accountId}`, { method: 'PUT', body: { role: v.role, isPrimary: v.isPrimary } }),
    onSuccess: () => { toast({ kind: 'success', title: t('buyrole.saved') }); void qc.invalidateQueries({ queryKey: rk.recordLists('contact') }); },
    onError: (e) => { toast({ kind: 'error', title: errorText(e) }); },
  });
  return (
    <Section title={t('buyrole.title')} testId="buying-roles">
      {contacts.length === 0 ? <p className="m-0 text-sm text-fg-muted">{t('crm.noRelated')}</p> : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {contacts.map((c) => {
            const link = ((c['accounts'] as { accountId: string; role: Role; isPrimary: boolean }[] | undefined) ?? []).find((a) => a.accountId === accountId);
            const name = recordName('contact', c);
            return (
              <li key={c.id} className="flex flex-col gap-1">
                <span className="flex items-center gap-2 text-sm">
                  <Link href={`/crm/contact/${c.id}`} className="min-w-0 flex-1 truncate text-fg">{name}</Link>
                  {link?.isPrimary ? <Badge tone="neutral">★</Badge> : null}
                </span>
                <Select aria-label={t('buyrole.of', { name })} value={link?.role ?? 'other'} options={ROLES.map((r) => ({ value: r, label: t(`buyrole.${r}`) }))}
                  onValueChange={(v) => { save.mutate({ contactId: c.id, role: v as Role, isPrimary: link?.isPrimary ?? false }); }} />
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
