'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, request, type Invitation, type InvitationList } from '../../../lib/api';
import { messageForCode } from '../../../lib/errors';
import { roleLabel, t, type MessageKey } from '../../../lib/i18n';
import { useAction } from '../../../lib/use-action';
import { isAdmin, useRequireSession } from '../../../lib/use-session';
import { AppShell } from '../../_components/app-shell';
import { Alert, Field, FormMessage, SelectField, SubmitButton } from '../../_components/ui';

const ROLES = ['admin', 'manager', 'sales_rep', 'call_agent', 'analyst'] as const;

function statusKey(inv: Invitation): MessageKey {
  if (inv.revokedAt) return 'inv.status.revoked';
  if (inv.acceptedAt) return 'inv.status.accepted';
  if (new Date(inv.expiresAt).getTime() <= Date.now()) return 'inv.status.expired';
  return 'inv.status.pending';
}

export default function InvitationsPage() {
  const { me } = useRequireSession();
  const [items, setItems] = useState<Invitation[]>([]);
  const [email, setEmail] = useState('');
  const [roleKey, setRoleKey] = useState<string>('manager');
  const [sent, setSent] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const create = useAction();
  const revoke = useAction();

  const load = useCallback(async () => {
    try {
      const res = await request<InvitationList>('/v1/invitations');
      setItems(res.data);
    } catch (err) {
      setListError(err instanceof ApiError ? messageForCode(err.code) : t('error.fallback'));
    }
  }, []);

  useEffect(() => {
    if (me && isAdmin(me)) void load();
  }, [me, load]);

  if (!me) {
    return (
      <main className="page">
        <h1 className="sr-only">{t('inv.title')}</h1>
        <p role="status">{t('common.loading')}</p>
      </main>
    );
  }

  if (!isAdmin(me)) {
    return (
      <AppShell me={me}>
        <h1>{t('inv.title')}</h1>
        <Alert kind="error">{t('inv.noAccess')}</Alert>
      </AppShell>
    );
  }

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    setSent(false);
    void create.run(async () => {
      await request('/v1/invitations', { method: 'POST', body: { email, roleKey } });
      setSent(true);
      setEmail('');
      await load();
    });
  }

  function onRevoke(id: string): void {
    void revoke.run(async () => {
      await request(`/v1/invitations/${id}/revoke`, { method: 'POST' });
      await load();
    });
  }

  return (
    <AppShell me={me}>
      <h1>{t('inv.title')}</h1>
      <section className="card" aria-labelledby="inv-new" style={{ marginBottom: '1rem' }}>
        <h2 id="inv-new">{t('inv.form.heading')}</h2>
        {sent ? <Alert kind="success">{t('inv.sent')}</Alert> : null}
        <form onSubmit={onSubmit} noValidate aria-busy={create.pending}>
          <FormMessage message={create.errors.form} />
          <Field label={t('inv.email')} name="email" type="email" autoComplete="off" required value={email} onChange={(e) => { setEmail(e.target.value); }} error={create.errors.fields.email} />
          <SelectField label={t('inv.role')} name="roleKey" value={roleKey} onChange={(e) => { setRoleKey(e.target.value); }}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </SelectField>
          <SubmitButton pending={create.pending} block={false}>
            {t('inv.send')}
          </SubmitButton>
        </form>
      </section>
      <section className="card" aria-labelledby="inv-list">
        <h2 id="inv-list">{t('inv.list.heading')}</h2>
        {listError ? <Alert kind="error">{listError}</Alert> : null}
        <FormMessage message={revoke.errors.form} />
        {items.length === 0 ? (
          <p className="muted">{t('inv.list.empty')}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('inv.col.email')}</th>
                  <th scope="col">{t('inv.col.role')}</th>
                  <th scope="col">{t('inv.col.status')}</th>
                  <th scope="col">{t('inv.col.date')}</th>
                  <th scope="col">{t('inv.col.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((inv) => {
                  const key = statusKey(inv);
                  return (
                    <tr key={inv.id}>
                      <td>{inv.email}</td>
                      <td>{roleLabel(inv.roleKey)}</td>
                      <td>{t(key)}</td>
                      <td>{new Date(inv.createdAt).toLocaleDateString('tr-TR')}</td>
                      <td>
                        {key === 'inv.status.pending' ? (
                          <button
                            type="button"
                            className="btn btn-secondary btn-small"
                            disabled={revoke.pending}
                            aria-label={`${t('inv.revoke')}: ${inv.email}`}
                            onClick={() => { onRevoke(inv.id); }}
                          >
                            {t('inv.revoke')}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </AppShell>
  );
}
