'use client';

import {
  Alert,
  Avatar,
  Button,
  Combobox,
  DatePicker,
  Dialog,
  DialogContent,
  DialogFooter,
  EmptyState,
  ErrorState,
  Input,
  RichTextEditor,
  Skeleton,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
  type RichTextLabels,
  type RichTextValue,
} from '@flexa/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FileQuestion, Link2, RefreshCw, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ApiError, request } from '../../../../lib/api';
import { useApp } from '../../../../lib/app-context';
import { dateTime, endOfDayIso, isoToDate, relativeTime } from '../../../../lib/format';
import { t, tOptional } from '../../../../lib/i18n';
import { qk } from '../../../../lib/query';
import { useRealtimeEvent } from '../../../../lib/realtime';
import { forgetRecent, pushRecent } from '../../../../lib/recent';
import {
  restoreTasks,
  statusLabel,
  useDeleteTasks,
  useDirectory,
  useDirectorySearch,
  useTask,
  useTaskPart,
  useTaskWorkflow,
  useUpdateTask,
  type Comments,
  type Dependencies,
  type Subtasks,
  type Task,
  type TaskPatchBody,
  type Timeline,
} from '../../../../lib/tasks';
import { PageContainer } from '../../../_components/app-shell';
import { PriorityCell, StatusCell, useMutationErrorToast } from '../_parts/cells';

const EDITOR_LABELS = (): RichTextLabels => ({
  toolbar: t('editor.toolbar'),
  bold: t('editor.bold'),
  italic: t('editor.italic'),
  heading: t('editor.heading'),
  bulletList: t('editor.bulletList'),
  orderedList: t('editor.orderedList'),
  quote: t('editor.quote'),
  code: t('editor.code'),
});

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="rounded-card border border-line bg-surface p-4" data-testid={testId}>
      <h2 className="m-0 mb-3 font-display text-sm font-bold text-fg">{title}</h2>
      {children}
    </section>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] items-center gap-2 py-1.5 text-sm">
      <span className="text-fg-muted">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function TimelineList({ id, names }: { id: string; names: Map<string, string> }) {
  const q = useTaskPart<Timeline>(id, 'timeline');
  if (q.isLoading) return <Skeleton className="h-16" />;
  const items = q.data?.data ?? [];
  if (items.length === 0) return <p className="text-sm text-fg-muted">{t('task.timelineEmpty')}</p>;
  return (
    <ol className="m-0 flex list-none flex-col gap-3 p-0" data-testid="timeline">
      {items.map((ev) => {
        const who = ev.actor?.displayName ?? (ev.actor ? (names.get(ev.actor.id) ?? t('common.unknownUser')) : t('timeline.automation'));
        const changed = Object.keys(ev.diff);
        return (
          <li key={ev.id} className="flex gap-3 text-sm">
            <Avatar name={who} size={24} decorative />
            <div className="min-w-0">
              <p className="m-0">
                <strong className="font-semibold">{who}</strong> {tOptional(`timeline.${ev.kind}`) ?? t('timeline.other')}
                {changed.length > 0 ? <span className="text-fg-muted"> · {changed.join(', ')}</span> : null}
              </p>
              <time className="text-xs text-fg-muted" dateTime={ev.occurredAt} title={dateTime(ev.occurredAt)}>
                {relativeTime(ev.occurredAt)}
              </time>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function CommentsPanel({ id }: { id: string }) {
  const qc = useQueryClient();
  const q = useTaskPart<Comments>(id, 'comments');
  const onError = useMutationErrorToast();
  const [draft, setDraft] = useState<RichTextValue | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const add = useMutation({
    mutationFn: (body: RichTextValue['doc']) => request(`/v1/tasks/${id}/comments`, { method: 'POST', body: { body }, idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => {
      setDraft(null);
      setResetKey((k) => k + 1);
      void qc.invalidateQueries({ queryKey: qk.taskPart(id, 'comments') });
      void qc.invalidateQueries({ queryKey: qk.taskPart(id, 'timeline') });
    },
    onError,
  });
  const comments = (q.data?.data ?? []).filter((c) => !c.deleted);
  return (
    <div className="flex flex-col gap-4">
      {q.isLoading ? (
        <Skeleton className="h-16" />
      ) : comments.length === 0 ? (
        <p className="text-sm text-fg-muted">{t('task.commentsEmpty')}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0" data-testid="comments">
          {comments.map((c) => (
            <li key={c.id} className="flex gap-3">
              <Avatar name={c.author?.displayName ?? '?'} size={28} decorative />
              <div className="min-w-0 flex-1 rounded-input bg-subtle px-3 py-2">
                <p className="m-0 text-xs text-fg-muted">
                  <strong className="text-fg">{c.author?.displayName ?? t('common.unknownUser')}</strong> · {relativeTime(c.createdAt)}
                </p>
                {/* Plain text only: stored rich text is rendered by the editor, never as HTML. */}
                <p className="m-0 mt-1 whitespace-pre-wrap text-sm">{c.bodyText}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form method="post"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft && draft.text.trim()) add.mutate(draft.doc);
        }}
        className="flex flex-col gap-2"
      >
        <RichTextEditor key={resetKey} aria-label={t('task.commentPlaceholder')} value={null} onChange={setDraft} placeholder={t('task.commentPlaceholder')} labels={EDITOR_LABELS()} />
        <div className="flex justify-end">
          <Button type="submit" size="sm" loading={add.isPending} disabled={!draft?.text.trim()}>
            {t('task.commentSend')}
          </Button>
        </div>
      </form>
    </div>
  );
}

function RelatedPanel({ id }: { id: string }) {
  const subtasks = useTaskPart<Subtasks>(id, 'subtasks');
  const deps = useTaskPart<Dependencies>(id, 'dependencies');
  const progress = subtasks.data?.progress;
  return (
    <div className="flex flex-col gap-4">
      <Section title={t('task.subtasks')} testId="subtasks">
        {subtasks.isLoading ? (
          <Skeleton className="h-10" />
        ) : (subtasks.data?.data.length ?? 0) === 0 ? (
          <p className="m-0 text-sm text-fg-muted">{t('task.subtasksEmpty')}</p>
        ) : (
          <>
            {progress ? (
              <div className="mb-3">
                <div className="h-1.5 overflow-hidden rounded-full bg-subtle" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.percent)} aria-label={t('task.subtasks')}>
                  <div className="h-full rounded-full bg-success" style={{ width: `${String(progress.percent)}%` }} />
                </div>
                <p className="m-0 mt-1 text-xs tabular-nums text-fg-muted">{t('task.subtaskProgress', { done: String(progress.closed), total: String(progress.total) })}</p>
              </div>
            ) : null}
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {subtasks.data?.data.map((s) => (
                <li key={s.id} className="flex items-center gap-2 text-sm">
                  {s.status ? <StatusBadge category={s.status.category} colorToken={s.status.colorToken} label={statusLabel(s.status.label)} /> : null}
                  <Link href={`/tasks/${s.id}`} className="min-w-0 truncate text-fg">
                    {s.title}
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>
      <Section title={t('task.dependencies')}>
        {deps.isLoading ? (
          <Skeleton className="h-10" />
        ) : (deps.data?.blockers.length ?? 0) + (deps.data?.blocking.length ?? 0) === 0 ? (
          <p className="m-0 text-sm text-fg-muted">{t('task.dependenciesEmpty')}</p>
        ) : (
          <dl className="m-0 flex flex-col gap-2 text-sm">
            {deps.data && deps.data.blockers.length > 0 ? (
              <div>
                <dt className="text-fg-muted">{t('task.blockedBy')}</dt>
                {deps.data.blockers.map((d) => (
                  <dd key={d.blockerId} className="m-0">
                    <Link href={`/tasks/${d.blockerId}`} className="text-fg">
                      <Link2 aria-hidden size={12} className="mr-1 inline" />
                      {d.blockerId.slice(0, 8)}
                    </Link>
                  </dd>
                ))}
              </div>
            ) : null}
            {deps.data && deps.data.blocking.length > 0 ? (
              <div>
                <dt className="text-fg-muted">{t('task.blocks')}</dt>
                {deps.data.blocking.map((d) => (
                  <dd key={d.blockedId} className="m-0">
                    <Link href={`/tasks/${d.blockedId}`} className="text-fg">
                      <Link2 aria-hidden size={12} className="mr-1 inline" />
                      {d.blockedId.slice(0, 8)}
                    </Link>
                  </dd>
                ))}
              </div>
            ) : null}
          </dl>
        )}
      </Section>
    </div>
  );
}

function AssigneeField({ task, editable, names }: { task: Task; editable: boolean; names: Map<string, string> }) {
  const update = useUpdateTask();
  const onError = useMutationErrorToast();
  const [q, setQ] = useState('');
  const people = useDirectorySearch(q);
  const options = useMemo(() => {
    const list = (people.data?.data ?? []).map((u) => ({ value: u.id, label: u.displayName }));
    if (task.assigneeUserId && !list.some((o) => o.value === task.assigneeUserId)) list.unshift({ value: task.assigneeUserId, label: names.get(task.assigneeUserId) ?? t('common.unknownUser') });
    return list;
  }, [people.data, task.assigneeUserId, names]);
  if (!editable) return <span>{task.assigneeUserId ? (names.get(task.assigneeUserId) ?? t('common.unknownUser')) : t('common.unassigned')}</span>;
  return (
    <Combobox
      aria-label={t('tasks.col.assignee')}
      value={task.assigneeUserId ?? null}
      onValueChange={(v) => { update.mutate({ task, patch: { assigneeUserId: v } }, { onError }); }}
      onSearch={setQ}
      options={options}
      placeholder={t('common.unassigned')}
      searchPlaceholder={t('task.form.assigneeSearch')}
      emptyText={t('common.noResults')}
      className="h-8"
    />
  );
}

export default function TaskDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const qc = useQueryClient();
  const { me, can } = useApp();
  const { toast } = useToast();
  const task = useTask(id);
  const { workflow } = useTaskWorkflow();
  const update = useUpdateTask();
  const del = useDeleteTasks();
  const names = useDirectory(useMemo(() => [task.data?.assigneeUserId, task.data?.createdBy], [task.data]));
  const [title, setTitle] = useState('');
  const [remoteChange, setRemoteChange] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const editable = can('task.update');
  const tenantId = me.tenant?.id ?? '';

  useEffect(() => {
    if (task.data?.title !== undefined) setTitle(task.data.title);
  }, [task.data?.title]);

  useEffect(() => {
    if (task.data?.title) pushRecent(tenantId, { type: 'task', id, title: task.data.title });
  }, [task.data?.title, tenantId, id]);

  useEffect(() => {
    if (task.error instanceof ApiError && task.error.status === 404) forgetRecent(tenantId, id);
  }, [task.error, tenantId, id]);

  // Someone else changed this task: the stream already refetched it; say so (Faz 6 "çakışma uyarısı").
  useRealtimeEvent((e) => {
    if (e.resource?.type === 'task' && e.resource.id === id && e.actor?.id !== me.user.id && !e.type.endsWith('.deleted')) setRemoteChange(true);
  });

  function save(patch: TaskPatchBody): void {
    if (!task.data) return;
    update.mutate(
      { task: task.data, patch },
      {
        onError: (err) => {
          if (err instanceof ApiError && (err.status === 412 || err.code === 'PRECONDITION_FAILED')) setConflict(true);
          else toast({ kind: 'error', title: t('common.saveFailed'), description: err instanceof ApiError ? (tOptional(`error.${err.code}`) ?? t('error.fallback')) : t('error.fallback') });
        },
      },
    );
  }

  function reload(): void {
    setRemoteChange(false);
    setConflict(false);
    void qc.invalidateQueries({ queryKey: qk.task(id) });
    void qc.invalidateQueries({ queryKey: ['tasks', 'part', id] });
  }

  function remove(): void {
    if (!task.data) return;
    const current = task.data;
    del.mutate([current], {
      onSuccess: (results) => {
        setConfirmDelete(false);
        const result = results[0];
        if (!result?.ok) {
          toast({ kind: 'error', title: t('common.saveFailed'), description: tOptional(`error.${result?.code ?? 'UNKNOWN'}`) ?? t('error.fallback') });
          return;
        }
        forgetRecent(tenantId, id);
        router.push('/tasks');
        toast({
          title: t('tasks.deleted'),
          action: {
            label: t('common.undo'),
            onAction: () => {
              void restoreTasks(qc, [current.id]).then(() => {
                toast({ kind: 'success', title: t('tasks.restored') });
              });
            },
          },
        });
      },
    });
  }

  if (task.isLoading) {
    return (
      <PageContainer wide>
        <p role="status" className="sr-only">
          {t('common.loading')}
        </p>
        <Skeleton className="mb-4 h-8 w-2/3" />
        <div className="grid gap-4 lg:grid-cols-[16rem_1fr_18rem]">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </PageContainer>
    );
  }

  if (task.error || !task.data) {
    const notFound = task.error instanceof ApiError && task.error.status === 404;
    return (
      <PageContainer>
        {notFound ? (
          <EmptyState
            icon={FileQuestion}
            title={t('task.notFound')}
            description={t('task.notFoundBody')}
            action={
              <Button asChild variant="secondary" size="sm">
                <Link href="/tasks">{t('task.back')}</Link>
              </Button>
            }
          />
        ) : (
          <ErrorState title={t('common.loadError')} description={t('common.loadErrorBody')} retryLabel={t('common.retry')} onRetry={() => void task.refetch()} />
        )}
      </PageContainer>
    );
  }

  const data = task.data;
  return (
    <PageContainer wide>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm" icon={<ArrowLeft aria-hidden size={14} />}>
          <Link href="/tasks">{t('task.back')}</Link>
        </Button>
        <span className="flex-1" />
        {can('task.delete') ? (
          <Button variant="danger" size="sm" icon={<Trash2 aria-hidden size={14} />} onClick={() => { setConfirmDelete(true); }}>
            {t('common.delete')}
          </Button>
        ) : null}
      </div>

      {remoteChange ? (
        <Alert kind="info" className="mb-4">
          <span className="flex flex-wrap items-center gap-2">
            {t('task.changedRemote')}
            <Button variant="secondary" size="sm" icon={<RefreshCw aria-hidden size={14} />} onClick={reload}>
              {t('task.reload')}
            </Button>
          </span>
        </Alert>
      ) : null}

      <div className="mb-5 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          {editable ? (
            <Input
              aria-label={t('task.form.title')}
              value={title}
              maxLength={500}
              onChange={(e) => { setTitle(e.target.value); }}
              onBlur={() => {
                const next = title.trim();
                if (next && next !== data.title) save({ title: next });
                else setTitle(data.title ?? '');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') {
                  setTitle(data.title ?? '');
                  e.currentTarget.blur();
                }
              }}
              className="h-auto border-transparent bg-transparent px-0 py-1 font-display text-2xl font-bold hover:border-line focus-visible:border-line-strong"
              data-testid="task-detail-title"
            />
          ) : (
            <h1 className="m-0 font-display text-2xl font-bold">{data.title}</h1>
          )}
          {editable ? <h1 className="sr-only">{data.title}</h1> : null}
        </div>
        <StatusCell task={data} workflow={workflow} editable={editable} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)_18rem]">
        <Section title={t('task.fields')} testId="task-fields">
          <FieldRow label={t('tasks.col.status')}>
            <StatusCell task={data} workflow={workflow} editable={editable} />
          </FieldRow>
          <FieldRow label={t('tasks.col.priority')}>
            <PriorityCell task={data} editable={editable} />
          </FieldRow>
          <FieldRow label={t('tasks.col.assignee')}>
            <AssigneeField task={data} editable={editable} names={names} />
          </FieldRow>
          <FieldRow label={t('tasks.col.due')}>
            {editable ? (
              <DatePicker
                aria-label={t('tasks.col.due')}
                value={isoToDate(data.dueAt)}
                onChange={(d) => { save({ dueAt: d ? endOfDayIso(d) : null }); }}
                placeholder={t('common.selectDate')}
                clearLabel={t('common.clearDate')}
              />
            ) : (
              <span>{dateTime(data.dueAt)}</span>
            )}
          </FieldRow>
          <FieldRow label={t('tasks.col.estimate')}>
            {editable ? (
              <Input
                type="number"
                min={0}
                aria-label={t('tasks.col.estimate')}
                defaultValue={data.estimateMinutes ?? ''}
                key={`est-${String(data.version)}`}
                className="h-8"
                onBlur={(e) => {
                  const v = e.target.value === '' ? null : Math.max(0, Math.round(Number(e.target.value)));
                  if (v !== (data.estimateMinutes ?? null) && (v === null || Number.isFinite(v))) save({ estimateMinutes: v });
                }}
              />
            ) : (
              <span>{data.estimateMinutes ?? '—'}</span>
            )}
          </FieldRow>
          <FieldRow label={t('task.createdAt')}>
            <span className="text-xs text-fg-muted">{dateTime(data.createdAt)}</span>
          </FieldRow>
          <FieldRow label={t('task.updatedAt')}>
            <span className="text-xs text-fg-muted">{dateTime(data.updatedAt)}</span>
          </FieldRow>
        </Section>

        <div className="flex min-w-0 flex-col gap-4">
          <Section title={t('task.description')}>
            <RichTextEditor
              aria-label={t('task.description')}
              value={(data.description as RichTextValue['doc'] | null | undefined) ?? null}
              editable={editable}
              placeholder={t('task.descriptionPlaceholder')}
              labels={EDITOR_LABELS()}
              onBlur={(v) => {
                const empty = v.text.trim() === '';
                const before = JSON.stringify(data.description ?? null);
                const after = JSON.stringify(empty ? null : v.doc);
                if (before !== after) save({ description: empty ? null : v.doc, descriptionText: empty ? null : v.text });
              }}
            />
          </Section>
          <section className="rounded-card border border-line bg-surface p-4">
            <Tabs defaultValue="comments">
              <TabsList label={t('task.activity')}>
                <TabsTrigger value="comments">{t('task.comments')}</TabsTrigger>
                <TabsTrigger value="activity">{t('task.activity')}</TabsTrigger>
              </TabsList>
              <TabsContent value="comments" className="pt-4">
                <CommentsPanel id={id} />
              </TabsContent>
              <TabsContent value="activity" className="pt-4">
                <TimelineList id={id} names={names} />
              </TabsContent>
            </Tabs>
          </section>
        </div>

        <RelatedPanel id={id} />
      </div>

      <Dialog open={conflict} onOpenChange={setConflict}>
        <DialogContent title={t('task.conflict.title')} description={t('task.conflict.body')} closeLabel={t('common.close')}>
          <DialogFooter>
            <Button variant="secondary" onClick={() => { setConflict(false); }}>
              {t('common.cancel')}
            </Button>
            <Button icon={<RefreshCw aria-hidden size={14} />} onClick={reload}>
              {t('task.conflict.reload')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent title={t('task.deleteConfirm')} description={t('task.deleteConfirmBody')} closeLabel={t('common.close')}>
          <DialogFooter>
            <Button variant="secondary" onClick={() => { setConfirmDelete(false); }}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" icon={<Trash2 aria-hidden size={14} />} loading={del.isPending} onClick={remove}>
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}
