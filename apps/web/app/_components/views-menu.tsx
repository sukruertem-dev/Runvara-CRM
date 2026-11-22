'use client';

import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  Input,
  useToast,
} from '@flexa/ui';
import { Bookmark, BookmarkPlus, Globe, Link2, Lock, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../lib/api';
import { useApp } from '../../lib/app-context';
import { messageForCode } from '../../lib/errors';
import { t } from '../../lib/i18n';
import { useDeleteView, useSaveView, useViews, type Resource, type View, type ViewInput } from '../../lib/records';

export interface ViewState {
  viewType: ViewInput['viewType'];
  query: string;
  sort: string | null;
  config: Record<string, unknown>;
}

/**
 * Saved views of a resource: apply one, save the current filter/sort/view as a new one (private, or for the
 * whole workspace with tenant.config.manage), delete own views, copy a shareable link.
 */
export function ViewsMenu({ resource, current, onApply, activeId }: { resource: Resource; current: ViewState; onApply: (view: View) => void; activeId?: string | null }) {
  const { can } = useApp();
  const views = useViews(resource);
  const save = useSaveView(resource);
  const del = useDeleteView(resource);
  const { toast } = useToast();
  const [dialog, setDialog] = useState(false);
  const [name, setName] = useState('');
  const [workspace, setWorkspace] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = views.data?.data ?? [];
  const active = list.find((v) => v.id === activeId);

  function submit(e: FormEvent): void {
    e.preventDefault();
    save.mutate(
      { resourceType: resource, name: name.trim(), visibility: workspace ? 'workspace' : 'private', viewType: current.viewType, query: current.query, sort: current.sort, config: current.config },
      {
        onSuccess: (v) => {
          setDialog(false);
          setName('');
          toast({ kind: 'success', title: t('views.saved') });
          onApply(v);
        },
        onError: (err) => {
          setError(err instanceof ApiError ? (err.code === 'CONFLICT' ? t('views.duplicate') : messageForCode(err.code)) : t('error.fallback'));
        },
      },
    );
  }

  async function copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast({ kind: 'success', title: t('views.linkCopied') });
    } catch {
      toast({ kind: 'error', title: t('views.linkFailed') });
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" size="sm" icon={<Bookmark aria-hidden size={14} />} data-testid="views-menu">
            <span className="max-w-40 truncate">{active?.name ?? t('views.title')}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel>{t('views.title')}</DropdownMenuLabel>
          {list.length === 0 ? <p className="m-0 px-2 py-1.5 text-sm text-fg-muted">{t('views.empty')}</p> : null}
          {list.map((v) => (
            <DropdownMenuItem
              key={v.id}
              onSelect={() => {
                onApply(v);
              }}
            >
              {v.visibility === 'workspace' ? <Globe aria-hidden size={14} /> : <Lock aria-hidden size={14} />}
              <span className="min-w-0 flex-1 truncate">{v.name}</span>
              <span className="sr-only">{v.visibility === 'workspace' ? t('views.workspace') : t('views.private')}</span>
              {v.mine ? (
                <button
                  type="button"
                  aria-label={t('views.delete', { name: v.name })}
                  className="rounded-input p-0.5 text-fg-muted hover:text-danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    del.mutate(v);
                  }}
                >
                  <Trash2 aria-hidden size={13} />
                </button>
              ) : null}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              setError(null);
              setDialog(true);
            }}
          >
            <BookmarkPlus aria-hidden size={14} /> {t('views.saveCurrent')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void copyLink()}>
            <Link2 aria-hidden size={14} /> {t('views.copyLink')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={dialog} onOpenChange={setDialog}>
        <DialogContent title={t('views.saveCurrent')} description={t('views.saveHint')} closeLabel={t('common.close')}>
          <form method="post" onSubmit={submit} className="flex flex-col gap-4" noValidate>
            <Field label={t('views.name')} error={error}>
              <Input autoFocus value={name} maxLength={120} onChange={(e) => { setName(e.target.value); }} required />
            </Field>
            {can('tenant.config.manage') ? (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={workspace} onCheckedChange={(v) => { setWorkspace(v === true); }} />
                {t('views.shareWorkspace')}
              </label>
            ) : null}
            <DialogFooter>
              <Button variant="secondary" onClick={() => { setDialog(false); }}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" loading={save.isPending} disabled={!name.trim()}>
                {t('common.save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
