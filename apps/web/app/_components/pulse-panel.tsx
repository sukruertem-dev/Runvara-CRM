'use client';

import { Alert, Badge } from '@flexa/ui';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePulse } from '../../lib/forecast';
import { dateTime, relativeTime } from '../../lib/format';
import { t } from '../../lib/i18n';
import { useRealtimeEvent } from '../../lib/realtime';
import { Section } from './record-parts';

/** Last touch, the untouched warning and the next step of a B2B opportunity (TRK-05, docs/p9-plan.md §19–20). */
export function PulsePanel({ opportunityId, open }: { opportunityId: string; open: boolean }) {
  const pulse = usePulse(opportunityId);
  const qc = useQueryClient();
  useRealtimeEvent((e) => {
    if (e.type.startsWith('task.') || e.type.startsWith('opportunity.') || e.type.startsWith('comment.')) void qc.invalidateQueries({ queryKey: ['forecast', 'pulse', opportunityId] });
  });
  const p = pulse.data;
  if (!p) return null;
  return (
    <Section title={t('pulse.title')} testId="pulse-panel">
      <div className="flex flex-col gap-2 text-sm">
        {p.stale ? <Alert kind="warning">{t('pulse.staleBody', { days: String(p.idleDays) })}</Alert> : null}
        <p className="m-0 text-fg-muted">{t('pulse.lastTouch', { when: relativeTime(p.lastTouchedAt) })}</p>
        {p.nextStep ? (
          <p className="m-0" data-testid="pulse-next">
            <span className="font-semibold">{t('pulse.nextLabel')}</span>{' '}
            <Link href={`/tasks/${p.nextStep.id}`}>{p.nextStep.title}</Link>
            {p.nextStep.dueAt ? <span className="text-fg-muted"> · {dateTime(p.nextStep.dueAt)}</span> : null}
          </p>
        ) : open ? (
          <p className="m-0 flex flex-wrap items-center gap-2" data-testid="pulse-next">
            <Badge tone={p.requireNextStep ? 'warning' : 'neutral'}>{t('pulse.noNext')}</Badge>
            {p.requireNextStep ? <span className="text-fg-muted">{t('pulse.required')}</span> : null}
          </p>
        ) : null}
      </div>
    </Section>
  );
}
