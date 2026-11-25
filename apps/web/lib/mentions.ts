'use client';

import type { MentionableResponse } from '@flexa/contracts';
import { mentionedIds, type MentionConfig, type MentionItem } from '@flexa/ui';
import { useCallback, useMemo, useRef } from 'react';
import { request } from './api';
import { useApp } from './app-context';
import { useTeams } from './catalog';
import { t } from './i18n';
import { useDirectory } from './tasks';

// Mentions in comments, notes and descriptions (P8c, docs/p8-plan.md §15).

type Found = (typeof MentionableResponse)['_output'];
export type MentionSource = 'comment' | 'note' | 'description';

/** Names of the people and teams mentioned in documents. */
export function useMentionLabels(docs: readonly unknown[]): MentionConfig['labelOf'] {
  const ids = useMemo(() => mentionedIds(docs), [docs]);
  const people = useDirectory(ids.users);
  const teams = useTeams(ids.teams.length > 0);
  return useCallback(
    (kind, id) => {
      if (kind === 'team') return teams.data ? (teams.data.data.find((x) => x.id === id)?.name ?? t('mention.unknownTeam')) : null;
      // The directory answers once for all of them; whoever is missing then has left the workspace.
      return people.get(id) ?? (people.size > 0 ? t('common.unknownUser') : null);
    },
    [people, teams.data],
  );
}

/** Everything the editor needs to mention people on a record; undefined without the right to mention. */
export function useMentions(path: string, source: MentionSource, docs: readonly unknown[]): { config: MentionConfig | undefined; labelOf: MentionConfig['labelOf'] } {
  const { can } = useApp();
  const stored = useMentionLabels(docs);
  // Names of people just picked, before the document is saved and looked up.
  const picked = useRef(new Map<string, string>());
  const labelOf = useCallback<MentionConfig['labelOf']>((kind, id) => picked.current.get(id) ?? stored(kind, id), [stored]);
  const allowed = can('mentions.create');
  const config = useMemo<MentionConfig | undefined>(() => {
    if (!allowed) return undefined;
    return {
      labelOf,
      labels: { list: t('mention.list'), empty: t('mention.empty'), loading: t('common.loading') },
      search: async (query) => {
        const found = await request<Found>(`/v1/${path}/mentionable?${new URLSearchParams({ q: query, source }).toString()}`);
        const items: MentionItem[] = [
          ...found.users.map((u) => ({ kind: 'user' as const, id: u.id, label: u.displayName, hint: u.grantsAccess ? t('mention.grants') : undefined })),
          ...found.teams.map((x) => ({ kind: 'team' as const, id: x.id, label: x.name, hint: t('mention.team', { count: String(x.memberCount) }) })),
        ];
        for (const i of items) picked.current.set(i.id, i.label);
        return items;
      },
    };
  }, [allowed, labelOf, path, source]);
  return { config, labelOf };
}
