'use client';

import { Button, Field, Input, Select, Skeleton, useToast } from '@flexa/ui';
import { Download, FileUp } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../../../../lib/api';
import { useApp } from '../../../../lib/app-context';
import { messageForCode } from '../../../../lib/errors';
import { t, tOptional } from '../../../../lib/i18n';
import {
  downloadBundle, exportBundle, previewBlueprint, previewImport, useApplyConfig, useBlueprints, type ConflictPolicy, type Plan,
} from '../../../../lib/platform';
import { PageContainer } from '../../../_components/app-shell';
import { ConflictPolicyControl, hasWork, PlanView } from '../_parts/plan-view';
import { SettingsGate, SettingsHeader } from '../_parts/settings-nav';

// Configuration export and import, blueprints (CFG-04/05, docs/p7-plan.md §7 and §11).

export default function TransferPage() {
  return (
    <PageContainer>
      <SettingsGate anyOf={['tenant.config.read']}>
        <Transfer />
      </SettingsGate>
    </PageContainer>
  );
}

function Card({ title, body, children, testId }: { title: string; body: string; children: ReactNode; testId: string }) {
  return (
    <section className="mb-6 rounded-card border border-line bg-surface p-4" aria-label={title} data-testid={testId}>
      <h2 className="m-0 text-base font-semibold">{title}</h2>
      <p className="m-0 mb-3 mt-1 max-w-2xl text-sm text-fg-muted">{body}</p>
      {children}
    </section>
  );
}

const problemText = (err: unknown): string => (err instanceof ApiError ? messageForCode(err.code) : t('error.fallback'));

function Transfer() {
  const { can, tenant } = useApp();
  const toast = useToast();
  const manage = can('tenant.config.manage');
  const [exporting, setExporting] = useState(false);

  const exportNow = async () => {
    setExporting(true);
    try {
      downloadBundle(await exportBundle(), tenant?.slug ?? 'workspace');
      toast.toast({ kind: 'success', title: t('transfer.export.done') });
    } catch (err) {
      toast.toast({ kind: 'error', title: problemText(err) });
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <SettingsHeader title={t('transfer.title')} lead={t('transfer.lead')} />
      <Card title={t('transfer.export.title')} body={t('transfer.export.body')} testId="transfer-export">
        <Button variant="secondary" icon={<Download aria-hidden size={16} />} loading={exporting} onClick={() => { void exportNow(); }}>
          {t('transfer.export.action')}
        </Button>
      </Card>
      {manage ? (
        <>
          <ImportCard />
          <BlueprintCard />
        </>
      ) : null}
    </>
  );
}

/** A dry-run result with the conflict choice, an optional note and the apply button. */
function Review({ plan, onApply, pending, withNote = false }: { plan: Plan; onApply: (policy: ConflictPolicy, note: string) => void; pending: boolean; withNote?: boolean }) {
  const [policy, setPolicy] = useState<ConflictPolicy>('keep');
  const [note, setNote] = useState('');
  return (
    <div className="mt-4 flex flex-col gap-3">
      <PlanView plan={plan} />
      <ConflictPolicyControl plan={plan} value={policy} onChange={setPolicy} />
      {withNote && hasWork(plan, policy) ? (
        <Field label={t('plan.note')}>
          <Input value={note} maxLength={500} onChange={(e) => { setNote(e.target.value); }} />
        </Field>
      ) : null}
      <div>
        <Button disabled={!hasWork(plan, policy)} loading={pending} onClick={() => { onApply(policy, note.trim()); }} data-testid="plan-apply">
          {t('plan.apply')}
        </Button>
      </div>
    </div>
  );
}

function ImportCard() {
  const toast = useToast();
  const apply = useApplyConfig();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; bundle: unknown; plan: Plan } | null>(null);
  const [checking, setChecking] = useState(false);

  const choose = async (f: File) => {
    setChecking(true);
    setFile(null);
    try {
      let bundle: unknown;
      try {
        bundle = JSON.parse(await f.text());
      } catch {
        toast.toast({ kind: 'error', title: t('transfer.import.invalidFile') });
        return;
      }
      setFile({ name: f.name, bundle, plan: await previewImport(bundle) });
    } catch (err) {
      toast.toast({ kind: 'error', title: err instanceof ApiError && err.code === 'VALIDATION_FAILED' ? t('transfer.import.invalidFile') : problemText(err) });
    } finally {
      setChecking(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <Card title={t('transfer.import.title')} body={t('transfer.import.body')} testId="transfer-import">
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        className="sr-only"
        tabIndex={-1}
        aria-label={t('transfer.import.file')}
        data-testid="import-file"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void choose(f); }}
      />
      <Button variant="secondary" icon={<FileUp aria-hidden size={16} />} loading={checking} onClick={() => { input.current?.click(); }}>
        {t('transfer.import.choose')}
      </Button>
      {file ? (
        <>
          <p className="m-0 mt-3 text-sm text-fg-muted">{t('plan.source.file', { name: file.name })}</p>
          <Review
            plan={file.plan}
            withNote
            pending={apply.isPending}
            onApply={(policy, note) => {
              apply.mutate({ kind: 'bundle', bundle: file.bundle, onConflict: policy, ...(note ? { note } : {}) }, {
                onSuccess: (r) => {
                  setFile(null);
                  toast.toast({ kind: 'success', title: t('plan.applied', { create: String(r.plan.summary.create), update: String(r.plan.summary.update) }) });
                },
                onError: (err) => { toast.toast({ kind: 'error', title: problemText(err) }); },
              });
            }}
          />
        </>
      ) : null}
    </Card>
  );
}

function BlueprintCard() {
  const toast = useToast();
  const blueprints = useBlueprints();
  const apply = useApplyConfig();
  const [id, setId] = useState<string>('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [checking, setChecking] = useState(false);
  if (!blueprints.data) return <Skeleton className="mb-6 h-32 w-full" />;
  const options = blueprints.data.data.map((b) => ({ value: b.id, label: tOptional(b.nameKey) ?? b.id }));
  const chosen = id || options[0]?.value || '';

  const preview = async () => {
    setChecking(true);
    try {
      setPlan(await previewBlueprint(chosen));
    } catch (err) {
      toast.toast({ kind: 'error', title: problemText(err) });
    } finally {
      setChecking(false);
    }
  };

  return (
    <Card title={t('transfer.blueprint.title')} body={t('transfer.blueprint.body')} testId="transfer-blueprint">
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-64 max-w-full">
          <Select value={chosen} onValueChange={(v) => { setId(v); setPlan(null); }} options={options} aria-label={t('transfer.blueprint.title')} />
        </div>
        <Button variant="secondary" loading={checking} onClick={() => { void preview(); }}>{t('transfer.blueprint.preview')}</Button>
      </div>
      {plan ? (
        <Review
          plan={plan}
          pending={apply.isPending}
          onApply={(policy) => {
            apply.mutate({ kind: 'blueprint', id: chosen, onConflict: policy }, {
              onSuccess: (r) => {
                setPlan(null);
                toast.toast({ kind: 'success', title: t('plan.applied', { create: String(r.plan.summary.create), update: String(r.plan.summary.update) }) });
              },
              onError: (err) => { toast.toast({ kind: 'error', title: problemText(err) }); },
            });
          }}
        />
      ) : null}
    </Card>
  );
}
