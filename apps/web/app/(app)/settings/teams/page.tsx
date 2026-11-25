'use client';

import { Alert, Badge, Button, Combobox, Dialog, DialogContent, DialogFooter, EmptyState, ErrorState, Field, IconButton, Input, Select, Skeleton, useToast } from '@flexa/ui';
import { Pencil, Star, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { useApp } from '../../../../lib/app-context';
import { errorText, useCreateTeam, useRemoveTeamMember, useSetPrimaryTeam, useSetTeamMember, useTeams, useUpdateTeam, type Team } from '../../../../lib/catalog';
import { t } from '../../../../lib/i18n';
import { useDirectorySearch } from '../../../../lib/tasks';
import { PageContainer } from '../../../_components/app-shell';
import { SettingsGate, SettingsHeader } from '../_parts/settings-nav';

// Settings → Teams (MGR-01, docs/p8-plan.md §4–5). An Admin manages every team; a Manager the members of the
// teams they manage (the API decides).

const NONE = 'none';

export default function TeamsPage() {
  return (
    <PageContainer>
      <SettingsGate anyOf={['teams.manage', 'teams.members.manage']}>
        <Teams />
      </SettingsGate>
    </PageContainer>
  );
}

/** Teams the caller may change members of: all for an Admin, managed teams and their sub-teams otherwise. */
function managedIds(teams: readonly Team[], userId: string): Set<string> {
  const out = new Set(teams.filter((x) => x.members.some((m) => m.userId === userId && m.role === 'manager')).map((x) => x.id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const x of teams) {
      if (x.parentTeamId && out.has(x.parentTeamId) && !out.has(x.id)) {
        out.add(x.id);
        grew = true;
      }
    }
  }
  return out;
}

function Teams() {
  const { me, can } = useApp();
  const list = useTeams();
  const [editing, setEditing] = useState<Team | 'new' | null>(null);
  const admin = can('teams.manage');
  const header = <SettingsHeader title={t('teams.title')} lead={t('teams.lead')} actions={admin ? <Button onClick={() => { setEditing('new'); }} data-testid="team-add">{t('teams.add')}</Button> : null} />;
  if (list.isError) return <>{header}<ErrorState title={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => { void list.refetch(); }} /></>;
  if (!list.data) return <>{header}<Skeleton className="h-48 w-full" /></>;
  const teams = list.data.data;
  const managed = managedIds(teams, me.user.id);
  return (
    <>
      {header}
      {teams.length === 0 ? (
        <EmptyState icon={Users} title={t('teams.empty')} description={t('teams.emptyBody')} />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0" data-testid="team-list">
          {teams.map((team) => (
            <TeamCard key={team.id} team={team} parent={teams.find((x) => x.id === team.parentTeamId)?.name ?? null} admin={admin} canMembers={admin || managed.has(team.id)} onEdit={() => { setEditing(team); }} />
          ))}
        </ul>
      )}
      {editing ? <TeamDialog existing={editing === 'new' ? null : editing} teams={teams} onClose={() => { setEditing(null); }} /> : null}
    </>
  );
}

function TeamCard({ team, parent, admin, canMembers, onEdit }: { team: Team; parent: string | null; admin: boolean; canMembers: boolean; onEdit: () => void }) {
  const setMember = useSetTeamMember();
  const remove = useRemoveTeamMember();
  const primary = useSetPrimaryTeam();
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const fail = (e: unknown) => { toast({ kind: 'error', title: errorText(e) }); };
  return (
    <li className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4" data-testid={`team-${team.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-base font-semibold">{team.name}</h2>
          {parent ? <p className="m-0 text-xs text-fg-muted">{t('teams.under', { name: parent })}</p> : null}
        </div>
        {canMembers ? <Button variant="secondary" size="sm" aria-label={`${t('teams.addMember')}: ${team.name}`} onClick={() => { setAdding(true); }}>{t('teams.addMember')}</Button> : null}
        {admin ? <IconButton size="sm" label={`${t('cat.edit')}: ${team.name}`} onClick={onEdit}><Pencil aria-hidden size={14} /></IconButton> : null}
      </div>
      {team.members.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">{t('teams.noMembers')}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {team.members.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="min-w-40 flex-1 truncate">{m.displayName}</span>
              {m.primary ? <Badge tone="info">{t('teams.primary')}</Badge> : null}
              {admin ? (
                <Select
                  className="w-32"
                  aria-label={`${t('teams.role')}: ${m.displayName}`}
                  value={m.role}
                  onValueChange={(role) => { setMember.mutate({ teamId: team.id, userId: m.userId, role: role as 'member' | 'manager' }, { onError: fail }); }}
                  options={(['member', 'manager'] as const).map((r) => ({ value: r, label: t(`teams.${r}`) }))}
                />
              ) : (
                <Badge tone="neutral">{t(`teams.${m.role}`)}</Badge>
              )}
              {canMembers && !m.primary ? <IconButton size="sm" label={`${t('teams.makePrimary')}: ${m.displayName}`} onClick={() => { primary.mutate({ teamId: team.id, userId: m.userId }, { onError: fail }); }}><Star aria-hidden size={14} /></IconButton> : null}
              {admin || (canMembers && m.role === 'member') ? <IconButton size="sm" label={`${t('teams.remove')}: ${m.displayName}`} onClick={() => { remove.mutate({ teamId: team.id, userId: m.userId }, { onError: fail }); }}><Trash2 aria-hidden size={14} /></IconButton> : null}
            </li>
          ))}
        </ul>
      )}
      {adding ? <MemberDialog team={team} admin={admin} onClose={() => { setAdding(false); }} /> : null}
    </li>
  );
}

function MemberDialog({ team, admin, onClose }: { team: Team; admin: boolean; onClose: () => void }) {
  const setMember = useSetTeamMember();
  const { toast } = useToast();
  const [term, setTerm] = useState('');
  const found = useDirectorySearch(term);
  const [userId, setUserId] = useState<string | null>(null);
  const [role, setRole] = useState<'member' | 'manager'>('member');
  const [error, setError] = useState<string | null>(null);
  const inTeam = new Set(team.members.map((m) => m.userId));

  function add(): void {
    if (!userId) return;
    setError(null);
    setMember.mutateAsync({ teamId: team.id, userId, role }).then(
      () => { toast({ kind: 'success', title: t('cat.saved') }); onClose(); },
      (e: unknown) => { setError(errorText(e)); },
    );
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={`${t('teams.addMember')}: ${team.name}`} closeLabel={t('common.close')}>
        <form method="post" onSubmit={(e) => { e.preventDefault(); add(); }} className="flex flex-col gap-3" data-testid="member-dialog">
          {error ? <Alert kind="error">{error}</Alert> : null}
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">{t('teams.person')}</span>
            <Combobox
              aria-label={t('teams.person')}
              value={userId}
              onValueChange={setUserId}
              options={(found.data?.data ?? []).filter((u) => !inTeam.has(u.id)).map((u) => ({ value: u.id, label: u.displayName }))}
              placeholder={t('teams.pickPerson')}
              searchPlaceholder={t('common.searchPlaceholder')}
              emptyText={t('common.noResults')}
              onSearch={setTerm}
            />
          </div>
          {admin ? <Field label={t('teams.role')}><Select value={role} onValueChange={(v) => { setRole(v as 'member' | 'manager'); }} options={(['member', 'manager'] as const).map((r) => ({ value: r, label: t(`teams.${r}`) }))} /></Field> : null}
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" loading={setMember.isPending} disabled={!userId} data-testid="member-save">{t('teams.addMember')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TeamDialog({ existing, teams, onClose }: { existing: Team | null; teams: readonly Team[]; onClose: () => void }) {
  const create = useCreateTeam();
  const update = useUpdateTeam();
  const { toast } = useToast();
  const [name, setName] = useState(existing?.name ?? '');
  const [parent, setParent] = useState(existing?.parentTeamId ?? NONE);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setError(null);
    const body = { name: name.trim(), parentTeamId: parent === NONE ? null : parent };
    try {
      if (existing) await update.mutateAsync({ id: existing.id, patch: body });
      else await create.mutateAsync(body);
      toast({ kind: 'success', title: t('cat.saved') });
      onClose();
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={existing ? t('teams.editTitle') : t('teams.add')} closeLabel={t('common.close')}>
        <form method="post" onSubmit={(e) => { e.preventDefault(); void submit(); }} className="flex flex-col gap-3" data-testid="team-dialog">
          {error ? <Alert kind="error">{error}</Alert> : null}
          <Field label={t('teams.name')}><Input value={name} onChange={(e) => { setName(e.target.value); }} maxLength={120} required autoFocus /></Field>
          <Field label={t('teams.parent')}><Select value={parent} onValueChange={setParent} options={[{ value: NONE, label: t('teams.noParent') }, ...teams.filter((x) => x.id !== existing?.id).map((x) => ({ value: x.id, label: x.name }))]} /></Field>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" loading={create.isPending || update.isPending} disabled={!name.trim()} data-testid="team-save">{t('common.save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
