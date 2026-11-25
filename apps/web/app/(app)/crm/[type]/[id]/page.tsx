'use client';

import {
  Alert,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  EmptyState,
  ErrorState,
  Input,
  RichTextEditor,
  SegmentBadge,
  Skeleton,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn,
  focusRing,
  useToast,
  type RichTextValue,
} from '@flexa/ui';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FileQuestion, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { ApiError, request } from '../../../../../lib/api';
import { useApp } from '../../../../../lib/app-context';
import { messageForCode } from '../../../../../lib/errors';
import { dateTime } from '../../../../../lib/format';
import { t, type MessageKey } from '../../../../../lib/i18n';
import { useRealtimeEvent } from '../../../../../lib/realtime';
import { PATH, rk, usePipelines, useRecordList, type CrmResource } from '../../../../../lib/records';
import { statusLabel, useDirectory, useWorkflows, type Task, type TaskPage } from '../../../../../lib/tasks';
import { PageContainer } from '../../../../_components/app-shell';
import { DiscountPanel } from '../../../../_components/discount-panel';
import { CommentsPanel, editorLabels, FieldRow, Section, TimelineList, type RecordRef } from '../../../../_components/record-parts';
import { money, recordName, type CrmRecord } from '../../_parts/columns';

const TYPES: CrmResource[] = ['account', 'contact', 'lead', 'opportunity', 'case'];

/** Text fields editable in place, per type (other fields are shown read-only; hidden fields never arrive). */
const EDITABLE: Record<CrmResource, { key: string; label: MessageKey }[]> = {
  account: [
    { key: 'name', label: 'crm.col.name' },
    { key: 'industry', label: 'crm.col.industry' },
    { key: 'domain', label: 'crm.col.domain' },
  ],
  contact: [
    { key: 'firstName', label: 'crm.col.firstName' },
    { key: 'lastName', label: 'crm.col.lastName' },
    { key: 'title', label: 'crm.col.title' },
  ],
  lead: [
    { key: 'company', label: 'crm.col.company' },
    { key: 'title', label: 'crm.col.title' },
  ],
  opportunity: [
    { key: 'name', label: 'crm.col.name' },
    { key: 'amount', label: 'crm.col.amount' },
    { key: 'expectedClose', label: 'crm.col.expectedClose' },
  ],
  case: [{ key: 'subject', label: 'crm.col.subject' }],
};

const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

function EditableField({ record, field, label, onSave }: { record: CrmRecord; field: string; label: string; onSave: (field: string, value: string | null) => void }) {
  const current = text(record[field]);
  const [value, setValue] = useState(current);
  const [focused, setFocused] = useState(false);
  const shown = focused ? value : current;
  return (
    <Input
      aria-label={label}
      value={shown}
      className="h-8"
      type={field === 'expectedClose' ? 'date' : field === 'amount' ? 'number' : 'text'}
      onFocus={() => {
        setValue(current);
        setFocused(true);
      }}
      onChange={(e) => { setValue(e.target.value); }}
      onBlur={() => {
        setFocused(false);
        const next = value.trim();
        if (next !== current) onSave(field, next === '' ? null : next);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setValue(current);
          e.currentTarget.blur();
        }
      }}
      data-testid={`field-${field}`}
    />
  );
}

function StatusMenu({ type, record }: { type: CrmResource; record: CrmRecord }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const workflows = useWorkflows();
  const pipelines = usePipelines(type === 'opportunity');
  const status = record['status'] as { id?: string; category?: 'open' | 'in_progress' | 'closed'; colorToken?: string; label?: Record<string, string> } | undefined;
  const targets =
    type === 'opportunity'
      ? (pipelines.data?.data.find((p) => p.id === record['pipelineId'])?.stages ?? [])
      : (workflows.data?.data.find((w) => w.id === record['workflowId'])?.statuses ?? []);
  const move = useMutation({
    mutationFn: (toStatusId: string) => request<CrmRecord>(`/v1/${PATH[type]}/${record.id}/transition`, { method: 'POST', body: { toStatusId } }),
    onSuccess: (next) => {
      qc.setQueryData(rk.record(type, record.id), next);
      void qc.invalidateQueries({ queryKey: rk.recordPart(type, record.id, 'timeline') });
    },
    onError: (err) => {
      toast({ kind: 'error', title: t('common.saveFailed'), description: err instanceof ApiError ? messageForCode(err.code) : t('error.fallback') });
    },
  });
  if (!status?.category) return null;
  const badge = <StatusBadge category={status.category} {...(status.colorToken ? { colorToken: status.colorToken } : {})} label={statusLabel(status.label)} />;
  const others = targets.filter((s) => s.id !== status.id);
  if (others.length === 0) return badge;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={cn('rounded-full', focusRing)} aria-label={`${t('crm.col.status')}: ${statusLabel(status.label)}`}>
        {badge}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{t('task.transition')}</DropdownMenuLabel>
        {others.map((s) => (
          <DropdownMenuItem key={s.id} onSelect={() => { move.mutate(s.id); }}>
            <StatusBadge category={s.category} colorToken={s.colorToken} label={statusLabel(s.label)} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RelatedLinks({ title, items }: { title: string; items: { href: string; label: string }[] }) {
  return (
    <Section title={title}>
      {items.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">{t('crm.noRelated')}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {items.map((i) => (
            <li key={i.href} className="truncate text-sm">
              <Link href={i.href} className="text-fg">
                {i.label}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** Names of linked accounts (each read with the caller's rights; an unreadable one keeps a generic label). */
function useAccountNames(ids: string[]): Map<string, string> {
  const results = useQueries({
    queries: ids.map((id) => ({ queryKey: rk.record('account', id), queryFn: () => request<CrmRecord>(`/v1/accounts/${id}`), retry: false })),
  });
  return new Map(results.flatMap((r, i) => (r.data && ids[i] ? [[ids[i], recordName('account', r.data)] as const] : [])));
}

function Related({ type, record }: { type: CrmResource; record: CrmRecord }) {
  const tasks = useQuery({
    queryKey: rk.recordPart(type, record.id, 'tasks'),
    queryFn: ({ signal }) => request<TaskPage>(`/v1/${PATH[type]}/${record.id}/tasks?limit=20`, { signal }),
  });
  const contacts = useRecordList<CrmRecord>('contact', useMemo(() => ({ q: `account = "${record.id}"`, limit: '20' }), [record.id]), type === 'account');
  const opps = useRecordList<CrmRecord>('opportunity', useMemo(() => ({ q: `account = "${record.id}"`, limit: '20' }), [record.id]), type === 'account');
  const accountId = text(record['accountId']);
  const contactAccounts = ((record['accounts'] as { accountId?: string; isPrimary?: boolean }[] | undefined) ?? []).filter((a): a is { accountId: string; isPrimary?: boolean } => typeof a.accountId === 'string');
  const accountNames = useAccountNames(useMemo(() => [...new Set([accountId, ...contactAccounts.map((a) => a.accountId)].filter(Boolean))], [accountId, contactAccounts]));
  return (
    <div className="flex flex-col gap-4" data-testid="crm-related">
      {type === 'account' ? (
        <>
          <RelatedLinks title={t('crm.relatedContacts')} items={contacts.rows.map((c) => ({ href: `/crm/contact/${c.id}`, label: recordName('contact', c) }))} />
          <RelatedLinks title={t('crm.relatedOpps')} items={opps.rows.map((o) => ({ href: `/crm/opportunity/${o.id}`, label: `${recordName('opportunity', o)} ${money(o['amount'], o['currency'])}`.trim() }))} />
        </>
      ) : null}
      {accountId ? <RelatedLinks title={t('crm.relatedAccount')} items={[{ href: `/crm/account/${accountId}`, label: accountNames.get(accountId) ?? t('crm.relatedAccount') }]} /> : null}
      {type === 'contact' && contactAccounts.length > 0 ? (
        <RelatedLinks title={t('crm.accounts')} items={contactAccounts.map((a) => ({ href: `/crm/account/${a.accountId}`, label: accountNames.get(a.accountId) ?? t('crm.relatedAccount') }))} />
      ) : null}
      <RelatedLinks title={t('crm.relatedTasks')} items={(tasks.data?.data ?? []).map((x: Task) => ({ href: `/tasks/${x.id}`, label: x.title ?? '' }))} />
    </div>
  );
}

/** Record page of a CRM object: fields left, description + comments + activity centre, related right. */
export default function CrmRecordPage() {
  const params = useParams<{ type: string; id: string }>();
  const type = (TYPES.includes(params.type as CrmResource) ? params.type : 'account') as CrmResource;
  const id = params.id;
  const qc = useQueryClient();
  const { me } = useApp();
  const { toast } = useToast();
  const [remoteChange, setRemoteChange] = useState(false);
  const q = useQuery({ queryKey: rk.record(type, id), queryFn: ({ signal }) => request<CrmRecord>(`/v1/${PATH[type]}/${id}`, { signal }) });
  const names = useDirectory(useMemo(() => [text(q.data?.['ownerUserId']) || null], [q.data]));
  const ref: RecordRef = useMemo(() => ({ path: `${PATH[type]}/${id}`, keyOf: (part) => rk.recordPart(type, id, part) }), [type, id]);

  useRealtimeEvent((e) => {
    if (e.resource?.type === type && e.resource.id === id && e.actor?.id !== me.user.id) setRemoteChange(true);
  });

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => request<CrmRecord>(`/v1/${PATH[type]}/${id}`, { method: 'PATCH', body: patch, ifMatch: q.data?.version ?? 0 }),
    onSuccess: (next) => {
      qc.setQueryData(rk.record(type, id), next);
      void qc.invalidateQueries({ queryKey: rk.recordLists(type) });
      toast({ kind: 'success', title: t('common.saved') });
    },
    onError: (err) => {
      const conflict = err instanceof ApiError && err.status === 412;
      toast({ kind: 'error', title: conflict ? t('task.conflict.title') : t('common.saveFailed'), description: conflict ? t('task.conflict.body') : err instanceof ApiError ? messageForCode(err.code) : t('error.fallback') });
      if (conflict) void q.refetch();
    },
  });

  if (q.isLoading) {
    return (
      <PageContainer wide>
        <Skeleton className="mb-4 h-8 w-1/2" />
        <div className="grid gap-4 lg:grid-cols-[17rem_1fr_18rem]">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </PageContainer>
    );
  }
  if (q.error || !q.data) {
    const notFound = q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 403);
    return (
      <PageContainer>
        {notFound ? (
          <EmptyState icon={FileQuestion} title={t('crm.notFound')} description={t('crm.notFoundBody')} action={<Button asChild variant="secondary" size="sm"><Link href={`/crm?type=${type}`}>{t('crm.back')}</Link></Button>} />
        ) : (
          <ErrorState title={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => void q.refetch()} />
        )}
      </PageContainer>
    );
  }

  const r = q.data;
  const segs = ((r['segments'] as string[] | undefined) ?? (text(r['segment']) ? [text(r['segment'])] : [])).filter((s): s is 'b2b' | 'b2c' => s === 'b2b' || s === 'b2c');
  const ownerId = text(r['ownerUserId']);
  const facts: { label: MessageKey; value: string; key: string }[] = [
    { key: 'probability', label: 'crm.col.probability', value: r['probability'] === undefined ? '' : `%${text(r['probability'])}` },
    { key: 'score', label: 'crm.col.score', value: text(r['score']) },
    { key: 'channel', label: 'crm.col.channel', value: text(r['channel']) },
  ];
  const readOnly = facts.filter((f) => f.key in r && f.value !== '');

  return (
    <PageContainer wide>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm" icon={<ArrowLeft aria-hidden size={14} />}>
          <Link href={`/crm?type=${type}`}>{t('crm.back')}</Link>
        </Button>
      </div>
      {remoteChange ? (
        <Alert kind="info" className="mb-4">
          <span className="flex flex-wrap items-center gap-2">
            {t('task.changedRemote')}
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw aria-hidden size={14} />}
              onClick={() => {
                setRemoteChange(false);
                void q.refetch();
              }}
            >
              {t('task.reload')}
            </Button>
          </span>
        </Alert>
      ) : null}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="m-0 min-w-0 flex-1 truncate font-display text-2xl font-bold" data-testid="crm-title">
          {recordName(type, r)}
        </h1>
        {segs.map((s) => (
          <SegmentBadge key={s} segment={s} label={t(`shell.segment.${s}`)} />
        ))}
        <StatusMenu type={type} record={r} />
      </div>
      <div className="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)_18rem]">
        <Section title={t('crm.fields')} testId="crm-fields">
          {EDITABLE[type]
            .filter((f) => f.key in r)
            .map((f) => (
              <FieldRow key={f.key} label={t(f.label)}>
                <EditableField record={r} field={f.key} label={t(f.label)} onSave={(field, value) => { save.mutate({ [field]: value }); }} />
              </FieldRow>
            ))}
          {readOnly.map((f) => (
            <FieldRow key={f.key} label={t(f.label)}>
              <span className="tabular-nums">{f.value}</span>
            </FieldRow>
          ))}
          <FieldRow label={t('crm.col.owner')}>{ownerId ? (names.get(ownerId) ?? t('common.unknownUser')) : t('common.unassigned')}</FieldRow>
          <FieldRow label={t('task.createdAt')}>
            <span className="text-xs text-fg-muted">{dateTime(text(r['createdAt']))}</span>
          </FieldRow>
          <FieldRow label={t('task.updatedAt')}>
            <span className="text-xs text-fg-muted">{dateTime(text(r['updatedAt']))}</span>
          </FieldRow>
          {Array.isArray(r['contactPoints']) && r['contactPoints'].length > 0 ? (
            <div className="mt-2 border-t border-line pt-2">
              <p className="m-0 mb-1 text-xs font-semibold text-fg-muted">{t('crm.contactPoints')}</p>
              <ul className="m-0 list-none p-0 text-sm">
                {(r['contactPoints'] as { id: string; kind: string; value: string }[]).map((p) => (
                  <li key={p.id} className="truncate">
                    {p.kind === 'email' ? <a href={`mailto:${p.value}`}>{p.value}</a> : <a href={`tel:${p.value}`}>{p.value}</a>}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Section>
        <div className="flex min-w-0 flex-col gap-4">
          {'description' in r ? (
            <Section title={t('task.description')}>
              <RichTextEditor
                aria-label={t('task.description')}
                value={(r['description'] as RichTextValue['doc'] | null) ?? null}
                placeholder={t('task.descriptionPlaceholder')}
                labels={editorLabels()}
                onBlur={(v) => {
                  const empty = v.text.trim() === '';
                  if (JSON.stringify(r['description'] ?? null) !== JSON.stringify(empty ? null : v.doc)) save.mutate({ description: empty ? null : v.doc, descriptionText: empty ? null : v.text });
                }}
              />
            </Section>
          ) : null}
          <section className="rounded-card border border-line bg-surface p-4">
            <Tabs defaultValue="comments">
              <TabsList label={t('task.activity')}>
                <TabsTrigger value="comments">{t('task.comments')}</TabsTrigger>
                <TabsTrigger value="activity">{t('task.activity')}</TabsTrigger>
              </TabsList>
              <TabsContent value="comments" className="pt-4">
                <CommentsPanel record={ref} />
              </TabsContent>
              <TabsContent value="activity" className="pt-4">
                <TimelineList record={ref} names={names} />
              </TabsContent>
            </Tabs>
          </section>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          {type === 'opportunity' && r['segment'] === 'b2b' ? <DiscountPanel opportunityId={r.id} /> : null}
          <Related type={type} record={r} />
        </div>
      </div>
    </PageContainer>
  );
}
