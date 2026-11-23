'use client';

import { Alert, Badge, Button, Checkbox, Dialog, DialogContent, DialogFooter, EmptyState, ErrorState, Field, IconButton, Input, Select, Skeleton, Switch, Textarea, useToast } from '@flexa/ui';
import { Copy, KeyRound, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '../../../../lib/api';
import { messageForCode } from '../../../../lib/errors';
import { dateTime } from '../../../../lib/format';
import { t } from '../../../../lib/i18n';
import { useCreateSsoProvider, useDeleteSsoProvider, useSsoProviders, useUpdateSsoProvider, type SsoProvider, type SsoProviderPatch } from '../../../../lib/security';
import { PageContainer } from '../../../_components/app-shell';
import { SettingsGate, SettingsHeader } from '../_parts/settings-nav';

// Settings → Single sign-on (TEN-04, docs/p7-plan.md §20–21): OIDC and SAML 2.0 providers.

const DOMAIN = /^[a-z0-9.-]+\.[a-z]{2,}$/;

export default function SsoSettingsPage() {
  return (
    <PageContainer>
      <SettingsGate anyOf={['tenant.config.manage']}>
        <Providers />
      </SettingsGate>
    </PageContainer>
  );
}

function Providers() {
  const list = useSsoProviders();
  const update = useUpdateSsoProvider();
  const remove = useDeleteSsoProvider();
  const toast = useToast();
  const [editing, setEditing] = useState<SsoProvider | 'new' | null>(null);
  const [removing, setRemoving] = useState<SsoProvider | null>(null);
  const fail = (err: unknown) => { toast.toast({ kind: 'error', title: err instanceof ApiError ? messageForCode(err.code) : t('error.fallback') }); };
  const header = <SettingsHeader title={t('sso.title')} lead={t('sso.lead')} actions={<Button onClick={() => { setEditing('new'); }} data-testid="sso-add">{t('sso.add')}</Button>} />;

  if (list.isError) return <>{header}<ErrorState title={t('error.fallback')} retryLabel={t('common.retry')} onRetry={() => { void list.refetch(); }} /></>;
  if (!list.data) return <>{header}<Skeleton className="h-48 w-full" /></>;
  return (
    <>
      {header}
      {list.data.length === 0 ? (
        <EmptyState icon={KeyRound} title={t('sso.empty')} description={t('sso.emptyBody')} />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0" data-testid="sso-providers">
          {list.data.map((p) => (
            <li key={p.id} className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4" data-testid={`sso-${p.id}`}>
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="m-0 font-semibold">{p.name}</p>
                  <p className="m-0 mt-0.5 text-xs text-fg-muted">{p.emailDomains.join(', ')}</p>
                </div>
                <Badge tone="neutral">{t(`sso.kind.${p.kind}`)}</Badge>
                <label className="inline-flex items-center gap-2 text-sm">
                  <Switch
                    checked={p.enabled}
                    aria-label={`${p.name}: ${p.enabled ? t('sso.disable') : t('sso.enable')}`}
                    onCheckedChange={(enabled) => { update.mutate({ id: p.id, patch: { enabled } }, { onError: fail }); }}
                  />
                  <span aria-hidden>{p.enabled ? t('sso.on') : t('sso.off')}</span>
                </label>
                <IconButton size="sm" label={`${t('sso.edit')}: ${p.name}`} onClick={() => { setEditing(p); }}><Pencil aria-hidden size={14} /></IconButton>
                <IconButton size="sm" label={`${t('sso.delete')}: ${p.name}`} onClick={() => { setRemoving(p); }}><Trash2 aria-hidden size={14} /></IconButton>
              </div>
              <ProviderDetails p={p} />
            </li>
          ))}
        </ul>
      )}

      {editing ? <ProviderDialog existing={editing === 'new' ? null : editing} onClose={() => { setEditing(null); }} /> : null}

      <Dialog open={removing !== null} onOpenChange={(o) => { if (!o) setRemoving(null); }}>
        <DialogContent title={t('sso.deleteTitle')} description={t('sso.deleteBody', { name: removing?.name ?? '' })} closeLabel={t('common.close')}>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setRemoving(null); }}>{t('common.cancel')}</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => {
              if (removing) remove.mutate(removing.id, { onSuccess: () => { setRemoving(null); toast.toast({ kind: 'success', title: t('sso.deleted') }); }, onError: fail });
            }}>{t('sso.delete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const toast = useToast();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <dt className="w-44 shrink-0 text-xs text-fg-muted">{label}</dt>
      <dd className="m-0 flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 flex-1 break-all font-mono text-xs">{value}</span>
        <IconButton size="sm" label={`${t('common.copy')}: ${label}`} onClick={() => {
          navigator.clipboard.writeText(value).then(() => { toast.toast({ kind: 'success', title: t('sso.copied') }); }, () => undefined);
        }}><Copy aria-hidden size={14} /></IconButton>
      </dd>
    </div>
  );
}

function ProviderDetails({ p }: { p: SsoProvider }) {
  if (p.kind === 'oidc') {
    return (
      <dl className="m-0 flex flex-col gap-1">
        <CopyRow label={t('sso.field.issuer')} value={p.issuer ?? ''} />
        <CopyRow label={t('sso.field.clientId')} value={p.clientId ?? ''} />
        <CopyRow label={t('sso.oidc.redirect')} value={p.redirectUri ?? ''} />
      </dl>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <dl className="m-0 flex flex-col gap-1">
        <CopyRow label={t('sso.field.idpEntityId')} value={p.idpEntityId ?? ''} />
        <CopyRow label={t('sso.field.idpSsoUrl')} value={p.idpSsoUrl ?? ''} />
      </dl>
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs">
        {p.certificates.map((c) => (
          <li key={c.fingerprint} className="flex flex-wrap items-center gap-2">
            <span>{t('sso.cert', { subject: c.subject, date: dateTime(c.notAfter) })}</span>
            {c.expired ? <Badge tone="danger">{t('sso.cert.expired')}</Badge> : null}
          </li>
        ))}
      </ul>
      {p.sp ? (
        <div className="rounded-input border border-line bg-subtle p-3" data-testid="sso-sp">
          <p className="m-0 mb-2 text-sm font-semibold">{t('sso.sp.title')}</p>
          <dl className="m-0 flex flex-col gap-1">
            <CopyRow label={t('sso.sp.entityId')} value={p.sp.entityId} />
            <CopyRow label={t('sso.sp.acs')} value={p.sp.acsUrl} />
            <CopyRow label={t('sso.sp.metadata')} value={p.sp.metadataUrl} />
          </dl>
        </div>
      ) : null}
    </div>
  );
}

function ProviderDialog({ existing, onClose }: { existing: SsoProvider | null; onClose: () => void }) {
  const create = useCreateSsoProvider();
  const update = useUpdateSsoProvider();
  const toast = useToast();
  const [kind, setKind] = useState<'oidc' | 'saml'>(existing?.kind ?? 'saml');
  const [name, setName] = useState(existing?.name ?? '');
  const [domains, setDomains] = useState(existing?.emailDomains.join(', ') ?? '');
  const [jit, setJit] = useState(existing?.jitEnabled ?? false);
  const [issuer, setIssuer] = useState(existing?.issuer ?? '');
  const [clientId, setClientId] = useState(existing?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [entityId, setEntityId] = useState(existing?.idpEntityId ?? '');
  const [ssoUrl, setSsoUrl] = useState(existing?.idpSsoUrl ?? '');
  const [cert1, setCert1] = useState('');
  const [cert2, setCert2] = useState('');
  const [error, setError] = useState<string | null>(null);

  const domainList = domains.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  const domainsOk = domainList.length > 0 && domainList.every((d) => DOMAIN.test(d));
  const certs = [cert1, cert2].map((c) => c.trim()).filter(Boolean);

  async function submit(): Promise<void> {
    setError(null);
    if (!domainsOk) {
      setError(t('sso.domainsInvalid'));
      return;
    }
    try {
      if (existing) {
        const patch: SsoProviderPatch = { name: name.trim(), emailDomains: domainList, jitEnabled: jit };
        if (existing.kind === 'oidc' && clientSecret) patch.clientSecret = clientSecret;
        if (existing.kind === 'saml') {
          patch.idpEntityId = entityId.trim();
          patch.idpSsoUrl = ssoUrl.trim();
          if (certs.length > 0) patch.idpCerts = certs;
        }
        await update.mutateAsync({ id: existing.id, patch });
        toast.toast({ kind: 'success', title: t('sso.saved') });
      } else if (kind === 'oidc') {
        await create.mutateAsync({ kind, name: name.trim(), emailDomains: domainList, jitEnabled: jit, issuer: issuer.trim(), clientId: clientId.trim(), clientSecret });
        toast.toast({ kind: 'success', title: t('sso.created') });
      } else {
        await create.mutateAsync({ kind, name: name.trim(), emailDomains: domainList, jitEnabled: jit, idpEntityId: entityId.trim(), idpSsoUrl: ssoUrl.trim(), idpCerts: certs });
        toast.toast({ kind: 'success', title: t('sso.created') });
      }
      onClose();
    } catch (e) {
      const detail = e instanceof ApiError && e.code === 'VALIDATION_FAILED' ? e.fieldErrors.map((f) => `${f.path}: ${f.message}`).join(' ') : '';
      setError(e instanceof ApiError ? `${messageForCode(e.code)} ${detail}`.trim() : t('error.fallback'));
    }
  }

  const k = existing?.kind ?? kind;
  const ready = name.trim() !== '' && domains.trim() !== '' && (k === 'oidc'
    ? issuer.trim() !== '' && clientId.trim() !== '' && (existing !== null || clientSecret !== '')
    : entityId.trim() !== '' && ssoUrl.trim() !== '' && (existing !== null || certs.length > 0));

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={existing ? t('sso.editTitle') : t('sso.addTitle')} closeLabel={t('common.close')} wide>
        <form method="post" onSubmit={(e) => { e.preventDefault(); void submit(); }} className="flex flex-col gap-3" data-testid="sso-dialog">
          {error ? <Alert kind="error">{error}</Alert> : null}
          {existing ? null : (
            <Field label={t('sso.field.kind')}>
              <Select value={kind} onValueChange={(v) => { setKind(v as 'oidc' | 'saml'); }} options={(['saml', 'oidc'] as const).map((x) => ({ value: x, label: t(`sso.kind.${x}`) }))} />
            </Field>
          )}
          <Field label={t('sso.field.name')}>
            <Input value={name} onChange={(e) => { setName(e.target.value); }} maxLength={80} required autoFocus />
          </Field>
          <Field label={t('sso.field.domains')}>
            <Input value={domains} onChange={(e) => { setDomains(e.target.value); }} placeholder="firma.com.tr" required />
          </Field>
          {k === 'oidc' ? (
            <>
              <Field label={t('sso.field.issuer')}>
                <Input type="url" value={issuer} disabled={existing !== null} onChange={(e) => { setIssuer(e.target.value); }} required />
              </Field>
              <Field label={t('sso.field.clientId')}>
                <Input value={clientId} disabled={existing !== null} onChange={(e) => { setClientId(e.target.value); }} required />
              </Field>
              <Field label={t('sso.field.clientSecret')} hint={existing ? t('sso.field.clientSecretKeep') : undefined}>
                <Input type="password" autoComplete="off" value={clientSecret} onChange={(e) => { setClientSecret(e.target.value); }} required={existing === null} />
              </Field>
            </>
          ) : (
            <>
              <Field label={t('sso.field.idpEntityId')}>
                <Input value={entityId} onChange={(e) => { setEntityId(e.target.value); }} required />
              </Field>
              <Field label={t('sso.field.idpSsoUrl')}>
                <Input type="url" value={ssoUrl} onChange={(e) => { setSsoUrl(e.target.value); }} placeholder="https://" required />
              </Field>
              <Field label={t('sso.field.idpCert')} hint={existing ? t('sso.field.certKeep') : undefined}>
                <Textarea value={cert1} onChange={(e) => { setCert1(e.target.value); }} rows={5} className="font-mono text-xs" placeholder="-----BEGIN CERTIFICATE-----" required={existing === null} />
              </Field>
              <Field label={t('sso.field.idpCert2')}>
                <Textarea value={cert2} onChange={(e) => { setCert2(e.target.value); }} rows={3} className="font-mono text-xs" placeholder="-----BEGIN CERTIFICATE-----" />
              </Field>
            </>
          )}
          <label className="inline-flex items-center gap-2 text-sm"><Checkbox checked={jit} onCheckedChange={(v) => { setJit(v === true); }} />{t('sso.field.jit')}</label>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" loading={create.isPending || update.isPending} disabled={!ready} data-testid="sso-save">{existing ? t('settings.save') : t('sso.add')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
