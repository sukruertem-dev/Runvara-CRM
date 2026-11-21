'use client';

import {
  Button,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandLoading,
  Combobox,
  DatePicker,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  Kbd,
  ModuleIcon,
  Select,
  useToast,
} from '@flexa/ui';
import { useQuery } from '@tanstack/react-query';
import { CheckSquare, Clock, CloudOff, Home, Keyboard, Moon, Plus, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, request } from '../../../lib/api';
import { useApp } from '../../../lib/app-context';
import { messageForCode } from '../../../lib/errors';
import { endOfDayIso } from '../../../lib/format';
import { useHotkeys } from '../../../lib/hotkeys';
import { t } from '../../../lib/i18n';
import { usePreferences } from '../../../lib/preferences';
import { qk } from '../../../lib/query';
import { useRealtime } from '../../../lib/realtime';
import { readRecent, type RecentItem } from '../../../lib/recent';
import { rqlString, useCreateTask, useDirectorySearch, type TaskPage } from '../../../lib/tasks';
import { menuLabel } from './sidebar';
import { useShell } from './shell-context';

/** Offline / reconnecting strip (Faz 6 "çevrimdışı/bağlantı kopması göstergesi"). */
export function ConnectionBanner() {
  const { state } = useRealtime();
  const [online, setOnline] = useState(true);
  useEffect(() => {
    setOnline(navigator.onLine);
    const up = (): void => {
      setOnline(true);
    };
    const down = (): void => {
      setOnline(false);
    };
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  if (online && state !== 'offline' && state !== 'reconnecting') return null;
  const offline = !online || state === 'offline';
  return (
    <div role="status" className="flex items-center gap-2 border-b border-line bg-warning-soft px-4 py-1.5 text-sm text-warning" data-testid="connection-banner">
      {offline ? <CloudOff aria-hidden size={15} /> : <RefreshCw aria-hidden size={15} className="animate-spin motion-reduce:animate-none" />}
      {offline ? t('shell.offline') : t('shell.reconnecting')}
    </div>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => {
      setV(value);
    }, ms);
    return () => {
      window.clearTimeout(id);
    };
  }, [value, ms]);
  return v;
}

/** Cmd/Ctrl+K: navigation, quick actions, recently viewed and a live task search against the API. */
export function CommandPalette() {
  const { paletteOpen, setPaletteOpen, setNewTaskOpen, setHelpOpen } = useShell();
  const { nav, me, can } = useApp();
  const { resolvedTheme, set } = usePreferences();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const term = useDebounced(query.trim(), 200);
  const tenantId = me.tenant?.id ?? '';

  useEffect(() => {
    if (paletteOpen) setRecent(readRecent(tenantId));
    else setQuery('');
  }, [paletteOpen, tenantId]);

  const hasTasks = nav?.menu.some((m) => m.id === 'tasks') ?? false;
  const search = useQuery({
    queryKey: qk.taskSearch(term),
    queryFn: ({ signal }) => request<TaskPage>(`/v1/tasks?${new URLSearchParams({ q: `title ~ ${rqlString(term)}`, limit: '8', sort: '-updated', fields: 'id,title,status' }).toString()}`, { signal }),
    enabled: paletteOpen && hasTasks && term.length >= 2,
  });

  function go(path: string): void {
    setPaletteOpen(false);
    router.push(path);
  }

  return (
    <CommandDialog
      open={paletteOpen}
      onOpenChange={setPaletteOpen}
      title={t('palette.title')}
      placeholder={t('palette.placeholder')}
      value={query}
      onValueChange={setQuery}
      footer={<span>{t('palette.footer')}</span>}
    >
      <CommandEmpty>{search.isFetching ? t('palette.searching') : t('common.noResults')}</CommandEmpty>
      {term.length >= 2 && hasTasks ? (
        <CommandGroup heading={t('palette.tasks')}>
          {search.isFetching && !search.data ? <CommandLoading>{t('palette.searching')}</CommandLoading> : null}
          {search.data?.data.map((task) => (
            <CommandItem key={task.id} value={`task:${task.id} ${task.title ?? ''}`} keywords={[query]} icon={<CheckSquare size={16} />} onSelect={() => { go(`/tasks/${task.id}`); }}>
              {task.title}
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}
      <CommandGroup heading={t('palette.actions')}>
        {hasTasks && can('task.create') ? (
          <CommandItem
            value={t('palette.newTask')}
            icon={<Plus size={16} />}
            hint={<Kbd>C</Kbd>}
            onSelect={() => {
              setPaletteOpen(false);
              setNewTaskOpen(true);
            }}
          >
            {t('palette.newTask')}
          </CommandItem>
        ) : null}
        <CommandItem value={t('palette.toggleTheme')} icon={<Moon size={16} />} onSelect={() => { set({ theme: resolvedTheme === 'dark' ? 'light' : 'dark' }); }}>
          {t('palette.toggleTheme')}
        </CommandItem>
        <CommandItem
          value={t('palette.shortcuts')}
          icon={<Keyboard size={16} />}
          hint={<Kbd>?</Kbd>}
          onSelect={() => {
            setPaletteOpen(false);
            setHelpOpen(true);
          }}
        >
          {t('palette.shortcuts')}
        </CommandItem>
      </CommandGroup>
      {recent.length > 0 && term.length < 2 ? (
        <CommandGroup heading={t('palette.recent')}>
          {recent.map((r) => (
            <CommandItem key={r.id} value={`recent:${r.id} ${r.title}`} icon={<Clock size={16} />} onSelect={() => { go(`/tasks/${r.id}`); }}>
              {r.title}
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}
      <CommandGroup heading={t('palette.navigate')}>
        <CommandItem value={t('nav.home')} icon={<Home size={16} />} onSelect={() => { go('/'); }}>
          {t('nav.home')}
        </CommandItem>
        {nav?.menu.map((item) => (
          <CommandItem key={item.id} value={menuLabel(item)} icon={<ModuleIcon name={item.icon} size={16} />} onSelect={() => { go(item.path); }}>
            {menuLabel(item)}
          </CommandItem>
        ))}
      </CommandGroup>
    </CommandDialog>
  );
}

const SHORTCUTS: { keys: string[]; label: Parameters<typeof t>[0] }[] = [
  { keys: ['Ctrl', 'K'], label: 'kbd.palette' },
  { keys: ['/'], label: 'kbd.search' },
  { keys: ['C'], label: 'kbd.newTask' },
  { keys: ['J'], label: 'kbd.next' },
  { keys: ['K'], label: 'kbd.prev' },
  { keys: ['Enter'], label: 'kbd.open' },
  { keys: ['X'], label: 'kbd.select' },
  { keys: ['1', '2', '3'], label: 'kbd.views' },
  { keys: ['?'], label: 'kbd.help' },
];

export function ShortcutHelp() {
  const { helpOpen, setHelpOpen } = useShell();
  return (
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
      <DialogContent title={t('kbd.title')} closeLabel={t('common.close')}>
        <dl className="m-0 grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-2.5 text-sm">
          {SHORTCUTS.map((s) => (
            <div key={s.label} className="contents">
              <dt className="flex gap-1">
                {s.keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </dt>
              <dd className="m-0">{t(s.label)}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}

const PRIORITIES = [0, 1, 2, 3, 4].map((p) => ({ value: String(p), label: t(`tasks.priority.${p as 0 | 1 | 2 | 3 | 4}`) }));

export function NewTaskDialog() {
  const { newTaskOpen, setNewTaskOpen } = useShell();
  const create = useCreateTask();
  const { toast } = useToast();
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState('2');
  const [assignee, setAssignee] = useState<string | null>(null);
  const [due, setDue] = useState<string | null>(null);
  const [peopleQuery, setPeopleQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const people = useDirectorySearch(useDebounced(peopleQuery, 200));

  useEffect(() => {
    if (!newTaskOpen) {
      setTitle('');
      setPriority('2');
      setAssignee(null);
      setDue(null);
      setError(null);
    }
  }, [newTaskOpen]);

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (!title.trim()) {
      setError(messageForCode('VALIDATION_FAILED'));
      return;
    }
    create.mutate(
      { title: title.trim(), priority: Number(priority), assigneeUserId: assignee, dueAt: due ? endOfDayIso(due) : null },
      {
        onSuccess: (task) => {
          setNewTaskOpen(false);
          toast({
            title: t('tasks.created'),
            kind: 'success',
            action: {
              label: task.title ?? '',
              onAction: () => {
                router.push(`/tasks/${task.id}`);
              },
            },
          });
        },
        onError: (err) => {
          setError(err instanceof ApiError ? messageForCode(err.code) : t('error.fallback'));
        },
      },
    );
  }

  return (
    <Dialog open={newTaskOpen} onOpenChange={setNewTaskOpen}>
      <DialogContent title={t('tasks.new')} closeLabel={t('common.close')}>
        <form method="post" onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Field label={t('task.form.title')} error={error}>
            <Input autoFocus value={title} onChange={(e) => { setTitle(e.target.value); }} placeholder={t('task.form.titlePlaceholder')} maxLength={500} required />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('task.form.priority')}>
              <Select value={priority} onValueChange={setPriority} options={PRIORITIES} />
            </Field>
            <Field label={t('task.form.due')}>
              <DatePicker value={due} onChange={setDue} placeholder={t('common.selectDate')} clearLabel={t('common.clearDate')} />
            </Field>
          </div>
          <Field label={t('task.form.assignee')}>
            <Combobox
              value={assignee}
              onValueChange={setAssignee}
              onSearch={setPeopleQuery}
              options={(people.data?.data ?? []).map((u) => ({ value: u.id, label: u.displayName }))}
              placeholder={t('common.unassigned')}
              searchPlaceholder={t('task.form.assigneeSearch')}
              emptyText={t('common.noResults')}
            />
          </Field>
          <DialogFooter>
            <Button variant="secondary" onClick={() => { setNewTaskOpen(false); }}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={create.isPending}>
              {t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Global shortcuts that work on every page of the app. */
export function GlobalHotkeys() {
  const { setPaletteOpen, setNewTaskOpen, setHelpOpen, paletteOpen } = useShell();
  const { can, nav } = useApp();
  const hasTasks = nav?.menu.some((m) => m.id === 'tasks') ?? false;
  useHotkeys([
    { key: 'k', mod: true, allowInInput: true, handler: () => { setPaletteOpen(!paletteOpen); } },
    { key: '/', handler: () => { setPaletteOpen(true); } },
    { key: '?', handler: () => { setHelpOpen(true); } },
    {
      key: 'c',
      handler: () => {
        if (hasTasks && can('task.create')) setNewTaskOpen(true);
      },
    },
  ]);
  return null;
}
