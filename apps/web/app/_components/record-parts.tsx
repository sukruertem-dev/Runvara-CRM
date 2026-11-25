'use client';

import type { CommentListResponse, TimelineResponse } from '@flexa/contracts';
import { Avatar, Button, RichTextEditor, RichTextView, Skeleton, Tabs, cn, type RichTextLabels, type RichTextValue } from '@flexa/ui';
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { useAnchor, useFocusAnchor } from '../../lib/anchor';
import { request } from '../../lib/api';
import { dateTime, relativeTime } from '../../lib/format';
import { t, tOptional } from '../../lib/i18n';
import { useMentions } from '../../lib/mentions';
import { useMutationErrorToast } from '../(app)/tasks/_parts/cells';

type Out<T extends { _output: unknown }> = T['_output'];

/** Shown where a link points (the element is focused by script only). */
export const anchorClass = 'scroll-mt-24 rounded-input focus:outline-2 focus:outline-offset-4 focus:outline-accent';

/** Shared building blocks of record pages (tasks and CRM records): sections, field rows, comments, timeline. */
export const editorLabels = (): RichTextLabels => ({
  toolbar: t('editor.toolbar'),
  bold: t('editor.bold'),
  italic: t('editor.italic'),
  heading: t('editor.heading'),
  bulletList: t('editor.bulletList'),
  orderedList: t('editor.orderedList'),
  quote: t('editor.quote'),
  code: t('editor.code'),
});

export function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section className="rounded-card border border-line bg-surface p-4" data-testid={testId}>
      <h2 className="m-0 mb-3 font-display text-sm font-bold text-fg">{title}</h2>
      {children}
    </section>
  );
}

export function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] items-center gap-2 py-1.5 text-sm">
      <span className="text-fg-muted">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/** `path` is the record's API path (`tasks/<id>`, `accounts/<id>` …); `keyOf` names its cached parts. */
export interface RecordRef {
  path: string;
  keyOf: (part: 'timeline' | 'comments') => QueryKey;
}

export function TimelineList({ record, names }: { record: RecordRef; names: Map<string, string> }) {
  const q = useQuery({ queryKey: record.keyOf('timeline'), queryFn: ({ signal }) => request<Out<typeof TimelineResponse>>(`/v1/${record.path}/timeline`, { signal }) });
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

/** Comments, notes and activity of a record; a link to a note opens its tab. */
export function ActivityTabs({ children }: { children: ReactNode }) {
  const anchor = useAnchor();
  const [tab, setTab] = useState('comments');
  const [followed, setFollowed] = useState('');
  if (anchor !== followed) {
    setFollowed(anchor);
    if (anchor.startsWith('note-')) setTab('notes');
    else if (anchor.startsWith('comment-')) setTab('comments');
  }
  return <Tabs value={tab} onValueChange={setTab}>{children}</Tabs>;
}

/** The description editor of a record, with mentions (`path` as in RecordRef). */
export function DescriptionEditor({ path, value, editable = true, onSave }: { path: string; value: RichTextValue['doc'] | null; editable?: boolean; onSave: (patch: { description: RichTextValue['doc'] | null; descriptionText: string | null }) => void }) {
  const docs = useMemo(() => [value], [value]);
  const { config, labelOf } = useMentions(path, 'description', docs);
  const anchor = useAnchor();
  useFocusAnchor(anchor === 'description' ? anchor : '', true);
  return (
    <div id="description" className={anchorClass}>
      <RichTextEditor
        aria-label={t('task.description')}
        value={value}
        editable={editable}
        placeholder={t('task.descriptionPlaceholder')}
        labels={editorLabels()}
        labelOf={labelOf}
        {...(config && editable ? { mentions: config } : {})}
        onBlur={(v) => {
          const empty = v.text.trim() === '';
          if (JSON.stringify(value) !== JSON.stringify(empty ? null : v.doc)) onSave({ description: empty ? null : v.doc, descriptionText: empty ? null : v.text });
        }}
      />
    </div>
  );
}

export function CommentsPanel({ record }: { record: RecordRef }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: record.keyOf('comments'), queryFn: ({ signal }) => request<Out<typeof CommentListResponse>>(`/v1/${record.path}/comments`, { signal }) });
  const onError = useMutationErrorToast();
  const [draft, setDraft] = useState<RichTextValue | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const add = useMutation({
    mutationFn: (body: RichTextValue['doc']) => request(`/v1/${record.path}/comments`, { method: 'POST', body: { body }, idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => {
      setDraft(null);
      setResetKey((k) => k + 1);
      void qc.invalidateQueries({ queryKey: record.keyOf('comments') });
      void qc.invalidateQueries({ queryKey: record.keyOf('timeline') });
    },
    onError,
  });
  const comments = useMemo(() => (q.data?.data ?? []).filter((c) => !c.deleted), [q.data]);
  const docs = useMemo(() => comments.map((c) => c.body), [comments]);
  const { config, labelOf } = useMentions(record.path, 'comment', docs);
  const anchor = useAnchor();
  useFocusAnchor(anchor.startsWith('comment-') ? anchor : '', comments.length > 0);
  return (
    <div className="flex flex-col gap-4">
      {q.isLoading ? (
        <Skeleton className="h-16" />
      ) : comments.length === 0 ? (
        <p className="text-sm text-fg-muted">{t('task.commentsEmpty')}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0" data-testid="comments">
          {comments.map((c) => (
            <li key={c.id} id={`comment-${c.id}`} className={cn('flex gap-3', anchorClass)}>
              <Avatar name={c.author?.displayName ?? '?'} size={28} decorative />
              <div className="min-w-0 flex-1 rounded-input bg-subtle px-3 py-2">
                <p className="m-0 text-xs text-fg-muted">
                  <strong className="text-fg">{c.author?.displayName ?? t('common.unknownUser')}</strong> · {relativeTime(c.createdAt)}
                </p>
                <RichTextView doc={c.body} labelOf={labelOf} className="mt-1" />
              </div>
            </li>
          ))}
        </ul>
      )}
      <form
        method="post"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft && draft.text.trim()) add.mutate(draft.doc);
        }}
        className="flex flex-col gap-2"
      >
        <RichTextEditor key={resetKey} aria-label={t('task.commentPlaceholder')} value={null} onChange={setDraft} placeholder={t('task.commentPlaceholder')} labels={editorLabels()} {...(config ? { mentions: config } : {})} />
        <div className="flex justify-end">
          <Button type="submit" size="sm" loading={add.isPending} disabled={!draft?.text.trim()}>
            {t('task.commentSend')}
          </Button>
        </div>
      </form>
    </div>
  );
}
