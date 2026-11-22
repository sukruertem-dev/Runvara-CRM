'use client';

import { PriorityBadge, SegmentBadge, StatusBadge } from '@flexa/ui';
import type { ReactNode } from 'react';
import { dateTime } from '../../../../lib/format';
import { t, type MessageKey } from '../../../../lib/i18n';
import type { CrmResource } from '../../../../lib/records';
import { statusLabel } from '../../../../lib/tasks';
import { priorityLabel } from '../../tasks/_parts/cells';

export type CrmRecord = { id: string; version?: number } & Record<string, unknown>;

export interface Column {
  id: string;
  label: MessageKey;
  /** RQL sort field, when the API can sort on it. */
  sort?: string;
  render: (r: CrmRecord, names: Map<string, string>) => ReactNode;
  width?: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const segment = (v: unknown): ReactNode =>
  v === 'b2b' || v === 'b2c' ? <SegmentBadge segment={v} label={t(`shell.segment.${v}`)} /> : <span className="text-fg-muted">—</span>;
const owner = (r: CrmRecord, names: Map<string, string>): ReactNode => {
  const id = str(r['ownerUserId']);
  return id ? <span className="truncate">{names.get(id) ?? t('common.unknownUser')}</span> : <span className="text-fg-muted">{t('common.unassigned')}</span>;
};
const status = (r: CrmRecord): ReactNode => {
  const s = r['status'] as { category?: 'open' | 'in_progress' | 'closed'; colorToken?: string; label?: Record<string, string> } | undefined;
  return s?.category ? <StatusBadge category={s.category} {...(s.colorToken ? { colorToken: s.colorToken } : {})} label={statusLabel(s.label)} /> : null;
};
const firstPoint = (r: CrmRecord, kind: 'email' | 'phone'): string => {
  const pts = (r['contactPoints'] as { kind?: string; value?: string; isPrimary?: boolean }[] | undefined) ?? [];
  const p = pts.find((x) => x.kind === kind && x.isPrimary) ?? pts.find((x) => x.kind === kind);
  return p?.value ?? '';
};

/** Money as the tenant locale shows it; amounts are decimal strings from the API. */
export function money(amount: unknown, currency: unknown): string {
  const n = Number(amount);
  if (amount === null || amount === undefined || amount === '' || !Number.isFinite(n)) return '';
  try {
    return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: typeof currency === 'string' && currency ? currency : 'TRY', maximumFractionDigits: 0 }).format(n);
  } catch {
    return n.toLocaleString('tr-TR');
  }
}

/** The record's display name (accounts and opportunities: name; people: full name; cases: subject). */
export function recordName(type: CrmResource, r: CrmRecord): string {
  if (type === 'contact' || type === 'lead') return str(r['fullName']) || `${str(r['firstName'])} ${str(r['lastName'])}`.trim();
  if (type === 'case') return str(r['subject']);
  return str(r['name']);
}

export const COLUMNS: Record<CrmResource, Column[]> = {
  account: [
    { id: 'name', label: 'crm.col.name', sort: 'name', render: (r) => recordName('account', r) },
    { id: 'industry', label: 'crm.col.industry', render: (r) => str(r['industry']) },
    { id: 'domain', label: 'crm.col.domain', render: (r) => str(r['domain']) },
    { id: 'segments', label: 'crm.col.segment', render: (r) => <span className="flex gap-1">{((r['segments'] as string[] | undefined) ?? []).map((s) => <span key={s}>{segment(s)}</span>)}</span> },
    { id: 'owner', label: 'crm.col.owner', render: owner },
    { id: 'updated', label: 'crm.col.updated', sort: 'updated', render: (r) => <span className="text-xs text-fg-muted">{dateTime(str(r['updatedAt']))}</span> },
  ],
  contact: [
    { id: 'name', label: 'crm.col.name', sort: 'name', render: (r) => recordName('contact', r) },
    { id: 'title', label: 'crm.col.title', sort: 'title', render: (r) => str(r['title']) },
    { id: 'email', label: 'crm.col.email', render: (r) => firstPoint(r, 'email') },
    { id: 'phone', label: 'crm.col.phone', render: (r) => firstPoint(r, 'phone') },
    { id: 'owner', label: 'crm.col.owner', render: owner },
    { id: 'updated', label: 'crm.col.updated', sort: 'updated', render: (r) => <span className="text-xs text-fg-muted">{dateTime(str(r['updatedAt']))}</span> },
  ],
  lead: [
    { id: 'name', label: 'crm.col.name', sort: 'name', render: (r) => recordName('lead', r) },
    { id: 'company', label: 'crm.col.company', sort: 'company', render: (r) => str(r['company']) },
    { id: 'status', label: 'crm.col.status', sort: 'statusCategory', render: status },
    { id: 'score', label: 'crm.col.score', sort: 'score', render: (r) => <span className="tabular-nums">{str(r['score'])}</span> },
    { id: 'segment', label: 'crm.col.segment', render: (r) => segment(r['segment']) },
    { id: 'owner', label: 'crm.col.owner', render: owner },
  ],
  opportunity: [
    { id: 'name', label: 'crm.col.name', sort: 'name', render: (r) => recordName('opportunity', r) },
    { id: 'status', label: 'crm.col.status', sort: 'statusCategory', render: status },
    { id: 'amount', label: 'crm.col.amount', sort: 'amount', render: (r) => <span className="tabular-nums">{money(r['amount'], r['currency'])}</span> },
    { id: 'probability', label: 'crm.col.probability', sort: 'probability', render: (r) => <span className="tabular-nums">{r['probability'] === undefined ? '' : `%${str(r['probability'])}`}</span> },
    { id: 'expectedClose', label: 'crm.col.expectedClose', sort: 'expectedClose', render: (r) => <span className="text-xs">{str(r['expectedClose'])}</span> },
    { id: 'owner', label: 'crm.col.owner', render: owner },
  ],
  case: [
    { id: 'subject', label: 'crm.col.subject', render: (r) => recordName('case', r) },
    { id: 'status', label: 'crm.col.status', sort: 'statusCategory', render: status },
    { id: 'priority', label: 'crm.col.priority', sort: 'priority', render: (r) => <PriorityBadge priority={Number(r['priority'] ?? 0)} label={priorityLabel(Number(r['priority'] ?? 0))} /> },
    { id: 'channel', label: 'crm.col.channel', render: (r) => str(r['channel']) },
    { id: 'owner', label: 'crm.col.owner', render: owner },
    { id: 'updated', label: 'crm.col.updated', sort: 'updated', render: (r) => <span className="text-xs text-fg-muted">{dateTime(str(r['updatedAt']))}</span> },
  ],
};

export const TYPE_LABEL: Record<CrmResource, MessageKey> = {
  account: 'crm.accounts',
  contact: 'crm.contacts',
  lead: 'crm.leads',
  opportunity: 'crm.opportunities',
  case: 'crm.cases',
};
