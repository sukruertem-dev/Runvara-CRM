'use client';

import { Badge, Button, EmptyState, ErrorState } from '@flexa/ui';
import { KeyRound } from 'lucide-react';
import Link from 'next/link';
import { ApiError } from '../../lib/api';
import { messageForCode } from '../../lib/errors';
import { t } from '../../lib/i18n';

// Shared pieces of the operator console.

export const STATUS_TONE = { trial: 'info', active: 'success', suspended: 'warning', pending_deletion: 'danger', deleted: 'neutral' } as const;

export function StatusBadge({ status }: { status: keyof typeof STATUS_TONE }) {
  return <Badge tone={STATUS_TONE[status]}>{t(`op.status.${status}`)}</Badge>;
}

/** Query error of an operator screen: a missing second factor gets its own explanation. */
export function OperatorError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (error instanceof ApiError && error.code === 'OPERATOR_MFA_REQUIRED') {
    return <EmptyState icon={KeyRound} title={t('op.mfaRequired')} description="" action={<Button asChild variant="secondary"><Link href="/settings/security">{t('op.goSecurity')}</Link></Button>} />;
  }
  return <ErrorState title={error instanceof ApiError ? messageForCode(error.code) : t('error.fallback')} retryLabel={t('common.retry')} onRetry={onRetry} />;
}

export const PLAN_IDS = ['trial', 'starter', 'growth', 'enterprise'] as const;
