'use client';

import type { NoteListResponse } from '@flexa/contracts';
import { Avatar, Badge, Button, Checkbox, ErrorState, IconButton, RichTextEditor, RichTextView, Skeleton, useToast, type RichTextValue } from '@flexa/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { request } from '../../lib/api';
import { useApp } from '../../lib/app-context';
import { relativeTime } from '../../lib/format';
import { t } from '../../lib/i18n';
import { useMentions } from '../../lib/mentions';
import { useDirectory } from '../../lib/tasks';
import { useMutationErrorToast } from '../(app)/tasks/_parts/cells';
import { editorLabels } from './record-parts';

type Notes = (typeof NoteListResponse)['_output'];

/** Notes of a record, with mentions; a private note is its author's alone and mentions nobody. */
export function NotesPanel({ type, id, path }: { type: string; id: string; path: string }) {
  const { me } = useApp();
  const qc = useQueryClient();
  const { toast } = useToast();
  const onError = useMutationErrorToast();
  const key = useMemo(() => ['notes', type, id] as const, [type, id]);
  const list = useQuery({ queryKey: key, queryFn: ({ signal }) => request<Notes>(`/v1/notes?relatedType=${type}&relatedId=${id}`, { signal }) });
  const notes = useMemo(() => list.data?.data ?? [], [list.data]);
  const names = useDirectory(notes.map((n) => n.authorId));
  const docs = useMemo(() => notes.map((n) => n.body), [notes]);
  const { config, labelOf } = useMentions(path, 'note', docs);
  const [draft, setDraft] = useState<RichTextValue | null>(null);
  const [isPrivate, setPrivate] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const add = useMutation({
    mutationFn: (d: RichTextValue) => request('/v1/notes', { method: 'POST', body: { related: { type, id }, body: d.doc, bodyText: d.text.trim(), visibility: isPrivate ? 'private' : 'standard' }, idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => {
      setDraft(null);
      setPrivate(false);
      setResetKey((k) => k + 1);
      void qc.invalidateQueries({ queryKey: key });
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (noteId: string) => request(`/v1/notes/${noteId}`, { method: 'DELETE' }),
    onSuccess: () => { toast({ kind: 'success', title: t('note.deleted') }); void qc.invalidateQueries({ queryKey: key }); },
    onError,
  });

  return (
    <div className="flex flex-col gap-4">
      {list.isError ? (
        <ErrorState title={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => { void list.refetch(); }} />
      ) : !list.data ? (
        <Skeleton className="h-16" />
      ) : notes.length === 0 ? (
        <p className="text-sm text-fg-muted">{t('note.empty')}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0" data-testid="notes">
          {notes.map((n) => {
            const who = names.get(n.authorId) ?? t('common.unknownUser');
            return (
              <li key={n.id} id={`note-${n.id}`} className="flex gap-3">
                <Avatar name={who} size={28} decorative />
                <div className="min-w-0 flex-1 rounded-input border border-line px-3 py-2">
                  <div className="flex items-center gap-2 text-xs text-fg-muted">
                    <span className="min-w-0 flex-1"><strong className="text-fg">{who}</strong> · {relativeTime(n.createdAt)}</span>
                    {n.visibility === 'private' ? <Badge tone="neutral">{t('note.private')}</Badge> : null}
                    {n.authorId === me.user.id ? <IconButton size="sm" label={t('note.delete')} onClick={() => { remove.mutate(n.id); }}><Trash2 aria-hidden size={14} /></IconButton> : null}
                  </div>
                  {n.body ? <RichTextView doc={n.body} labelOf={labelOf} /> : <p className="m-0 whitespace-pre-wrap text-sm">{n.bodyText}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <form method="post" className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); if (draft?.text.trim()) add.mutate(draft); }}>
        <RichTextEditor key={resetKey} aria-label={t('note.placeholder')} value={null} onChange={setDraft} placeholder={t('note.placeholder')} labels={editorLabels()} {...(config && !isPrivate ? { mentions: config } : {})} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="inline-flex items-center gap-2 text-sm"><Checkbox checked={isPrivate} onCheckedChange={(v) => { setPrivate(v === true); }} />{t('note.onlyMe')}</label>
          <Button type="submit" size="sm" loading={add.isPending} disabled={!draft?.text.trim()}>{t('note.add')}</Button>
        </div>
      </form>
    </div>
  );
}
