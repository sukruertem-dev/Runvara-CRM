'use client';

import { Alert, Badge, Button, Checkbox, Dialog, DialogContent, DialogFooter, EmptyState, ErrorState, Field, IconButton, Input, Select, Skeleton, Switch, useToast } from '@flexa/ui';
import { CalendarClock, Pencil, Plus, Timer, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ApiError } from '../../../../lib/api';
import { useApp } from '../../../../lib/app-context';
import { messageForCode } from '../../../../lib/errors';
import { t } from '../../../../lib/i18n';
import { labelOf, useCalendars, useSlaMutations, useSlaPolicies, useWorkflows, type Calendar, type CalendarInput, type SlaPolicy } from '../../../../lib/settings';
import { FilterBar } from '../../../_components/filter-bar';
import { PageContainer } from '../../../_components/app-shell';
import { ReadOnlyNotice, SettingsGate, SettingsHeader } from '../_parts/settings-nav';

const DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
type Interval = { start: string; end: string };
type SlaResource = 'case' | 'task' | 'lead';
const SLA_RESOURCES: SlaResource[] = ['case', 'task', 'lead'];

const errText = (e: unknown) => (e instanceof ApiError ? `${messageForCode(e.code)} ${e.code === 'SLA_POLICY_INVALID' || e.code === 'CONFLICT' ? (e.problem.detail ?? '') : ''}`.trim() : t('error.fallback'));

/** Minutes as "1 sa 30 dk". */
function duration(min: number | null): string {
  if (min === null) return '—';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return [h ? t('settings.sla.hours', { n: String(h) }) : '', m ? t('settings.sla.minutes', { n: String(m) }) : ''].filter(Boolean).join(' ') || t('settings.sla.minutes', { n: '0' });
}

function timezones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['Europe/Istanbul', 'UTC'];
  }
}

function CalendarDialog({ calendar, onClose }: { calendar: Calendar | 'new'; onClose: () => void }) {
  const m = useSlaMutations();
  const existing = calendar === 'new' ? null : calendar;
  const [name, setName] = useState(existing?.name ?? '');
  const [tz, setTz] = useState(existing?.timezone ?? 'Europe/Istanbul');
  const [week, setWeek] = useState<Record<number, Interval[]>>(() => {
    const out: Record<number, Interval[]> = {};
    for (const d of DAYS) out[d] = existing ? existing.weeklyHours.filter((h) => h.day === d).map((h) => ({ start: h.start, end: h.end })) : d <= 5 ? [{ start: '09:00', end: '18:00' }] : [];
    return out;
  });
  const [holidays, setHolidays] = useState<{ date: string; name: string }[]>(existing?.holidays.map((h) => ({ date: h.date, name: h.name ?? '' })) ?? []);
  const [error, setError] = useState<string | null>(null);
  const zones = useMemo(timezones, []);

  const setDay = (d: number, list: Interval[]) => { setWeek((w) => ({ ...w, [d]: list })); };
  async function submit(): Promise<void> {
    setError(null);
    const body: CalendarInput = {
      name: name.trim(),
      timezone: tz,
      weeklyHours: DAYS.flatMap((d) => (week[d] ?? []).map((i) => ({ day: d, start: i.start, end: i.end }))),
      holidays: holidays.filter((h) => h.date).map((h) => ({ date: h.date, ...(h.name.trim() ? { name: h.name.trim() } : {}) })),
    };
    if (body.weeklyHours.length === 0) {
      setError(t('settings.sla.noHours'));
      return;
    }
    try {
      await m.saveCalendar.mutateAsync({ id: existing?.id ?? null, body });
      onClose();
    } catch (e) {
      setError(errText(e));
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={existing ? t('settings.sla.editCalendar', { name: existing.name }) : t('settings.sla.newCalendar')} closeLabel={t('common.close')} wide>
        <form method="post" onSubmit={(e) => { e.preventDefault(); void submit(); }} className="flex flex-col gap-4" data-testid="calendar-dialog">
          {error ? <Alert kind="error">{error}</Alert> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('settings.sla.calendarName')}><Input value={name} maxLength={120} required autoFocus onChange={(e) => { setName(e.target.value); }} /></Field>
            <Field label={t('settings.timezone')}><Select value={tz} onValueChange={setTz} options={zones.map((z) => ({ value: z, label: z }))} /></Field>
          </div>
          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-2 text-sm font-medium">{t('settings.sla.weeklyHours')}</legend>
            <ol className="m-0 flex list-none flex-col gap-2 p-0">
              {DAYS.map((d) => {
                const list = week[d] ?? [];
                const open = list.length > 0;
                return (
                  <li key={d} className="flex flex-wrap items-center gap-2" data-testid="calendar-day" data-day={d}>
                    <label className="inline-flex w-32 items-center gap-2 text-sm">
                      <Switch checked={open} onCheckedChange={(v) => { setDay(d, v ? [{ start: '09:00', end: '18:00' }] : []); }} aria-label={t('settings.sla.dayOpen', { day: t(`settings.day.${String(d)}` as 'settings.day.1') })} />
                      {t(`settings.day.${String(d)}` as 'settings.day.1')}
                    </label>
                    {open ? (
                      list.map((iv, i) => (
                        <span key={`${String(d)}-${String(i)}`} className="inline-flex items-center gap-1">
                          <Input type="time" value={iv.start} aria-label={t('settings.sla.from', { day: t(`settings.day.${String(d)}` as 'settings.day.1') })} className="w-28" onChange={(e) => { setDay(d, list.map((x, j) => (j === i ? { ...x, start: e.target.value } : x))); }} />
                          <span aria-hidden>–</span>
                          <Input type="time" value={iv.end === '24:00' ? '23:59' : iv.end} aria-label={t('settings.sla.to', { day: t(`settings.day.${String(d)}` as 'settings.day.1') })} className="w-28" onChange={(e) => { setDay(d, list.map((x, j) => (j === i ? { ...x, end: e.target.value === '23:59' ? '24:00' : e.target.value } : x))); }} />
                          {list.length > 1 ? <IconButton size="sm" label={t('settings.sla.removeInterval')} onClick={() => { setDay(d, list.filter((_, j) => j !== i)); }}><Trash2 aria-hidden size={14} /></IconButton> : null}
                        </span>
                      ))
                    ) : (
                      <span className="text-sm text-fg-muted">{t('settings.sla.closed')}</span>
                    )}
                    {open && list.length < 4 ? (
                      <Button size="sm" variant="ghost" onClick={() => { setDay(d, [...list, { start: '13:00', end: '14:00' }]); }}>{t('settings.sla.addInterval')}</Button>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </fieldset>
          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-2 text-sm font-medium">{t('settings.sla.holidays')}</legend>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {holidays.map((h, i) => (
                <li key={`h-${String(i)}`} className="flex flex-wrap items-center gap-2">
                  <Input type="date" value={h.date} aria-label={t('settings.sla.holidayDate')} className="w-40" onChange={(e) => { setHolidays((l) => l.map((x, j) => (j === i ? { ...x, date: e.target.value } : x))); }} />
                  <Input value={h.name} maxLength={120} aria-label={t('settings.sla.holidayName')} placeholder={t('settings.sla.holidayName')} className="min-w-40 flex-1" onChange={(e) => { setHolidays((l) => l.map((x, j) => (j === i ? { ...x, name: e.target.value } : x))); }} />
                  <IconButton size="sm" label={t('settings.sla.removeHoliday')} onClick={() => { setHolidays((l) => l.filter((_, j) => j !== i)); }}><Trash2 aria-hidden size={14} /></IconButton>
                </li>
              ))}
            </ul>
            <Button size="sm" variant="secondary" className="mt-2" icon={<Plus aria-hidden size={14} />} onClick={() => { setHolidays((l) => [...l, { date: '', name: '' }]); }}>{t('settings.sla.addHoliday')}</Button>
          </fieldset>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" loading={m.saveCalendar.isPending} disabled={!name.trim()} data-testid="calendar-save">{existing ? t('settings.save') : t('settings.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PolicyDialog({ policy, calendars, onClose }: { policy: SlaPolicy | 'new'; calendars: Calendar[]; onClose: () => void }) {
  const m = useSlaMutations();
  const workflows = useWorkflows();
  const existing = policy === 'new' ? null : policy;
  const [name, setName] = useState(existing?.name ?? '');
  const [resource, setResource] = useState<SlaResource>((existing?.resourceType as SlaResource | undefined) ?? 'case');
  const [criteria, setCriteria] = useState(existing?.criteria ?? '');
  const [calendarId, setCalendarId] = useState(existing?.calendarId ?? calendars[0]?.id ?? '');
  const [first, setFirst] = useState<string>(existing?.firstResponseMinutes ? String(existing.firstResponseMinutes) : '60');
  const [resolution, setResolution] = useState<string>(existing?.resolutionMinutes ? String(existing.resolutionMinutes) : '480');
  const [warn, setWarn] = useState(existing?.warnPercent ?? 80);
  const [position, setPosition] = useState(existing?.position ?? 0);
  const [pause, setPause] = useState<string[]>(existing?.pauseStatuses ?? []);
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const statuses = workflows.data?.data.find((w) => w.resourceType === resource && w.isDefault)?.statuses ?? [];
  const minutes = (s: string) => (s.trim() === '' ? null : Math.max(1, Math.round(Number(s))));

  async function submit(): Promise<void> {
    setError(null);
    const f = minutes(first);
    const r = minutes(resolution);
    if (f === null && r === null) {
      setError(t('settings.sla.needTarget'));
      return;
    }
    try {
      if (existing) {
        await m.patchPolicy.mutateAsync({ policy: existing, body: { name: name.trim(), criteria, calendarId, firstResponseMinutes: f, resolutionMinutes: r, warnPercent: warn, position, pauseStatuses: pause, enabled } });
      } else {
        await m.createPolicy.mutateAsync({ name: name.trim(), resourceType: resource, criteria, calendarId, ...(f ? { firstResponseMinutes: f } : {}), ...(r ? { resolutionMinutes: r } : {}), warnPercent: warn, position, pauseStatuses: pause, enabled });
      }
      onClose();
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'PRECONDITION_FAILED' ? t('settings.stale') : errText(e));
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={existing ? t('settings.sla.editPolicy', { name: existing.name }) : t('settings.sla.newPolicy')} closeLabel={t('common.close')} wide>
        <form method="post" onSubmit={(e) => { e.preventDefault(); void submit(); }} className="flex flex-col gap-3" data-testid="policy-dialog">
          {error ? <Alert kind="error">{error}</Alert> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('settings.sla.policyName')}><Input value={name} maxLength={120} required autoFocus onChange={(e) => { setName(e.target.value); }} /></Field>
            <Field label={t('settings.rule.resource')} hint={existing ? t('settings.sla.resourceFixed') : undefined}>
              <Select value={resource} disabled={existing !== null} onValueChange={(v) => { setResource(v as SlaResource); setCriteria(''); setPause([]); }} options={SLA_RESOURCES.map((r) => ({ value: r, label: t(`settings.resource.${r}`) }))} />
            </Field>
          </div>
          <div>
            <p className="m-0 mb-1 text-sm font-medium">{t('settings.sla.criteria')}</p>
            <FilterBar key={resource} resource={resource} value={criteria} onChange={setCriteria} />
            <p className="m-0 mt-1 text-xs text-fg-muted">{criteria ? t('settings.sla.criteriaSet') : t('settings.sla.criteriaAll')}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('settings.sla.calendar')}><Select value={calendarId || undefined} onValueChange={setCalendarId} options={calendars.map((c) => ({ value: c.id, label: c.name }))} placeholder={t('settings.sla.pickCalendar')} /></Field>
            <Field label={t('settings.sla.position')} hint={t('settings.sla.positionHint')}><Input type="number" min={0} max={10000} value={position} onChange={(e) => { setPosition(Math.max(0, Number(e.target.value) || 0)); }} /></Field>
            <Field label={t('settings.sla.firstResponseMin')} hint={duration(minutes(first))}><Input type="number" min={1} max={525600} value={first} onChange={(e) => { setFirst(e.target.value); }} /></Field>
            <Field label={t('settings.sla.resolutionMin')} hint={duration(minutes(resolution))}><Input type="number" min={1} max={525600} value={resolution} onChange={(e) => { setResolution(e.target.value); }} /></Field>
            <Field label={t('settings.sla.warnPercent')} hint={t('settings.sla.warnHint')}><Input type="number" min={1} max={99} value={warn} onChange={(e) => { setWarn(Math.min(99, Math.max(1, Number(e.target.value) || 80))); }} /></Field>
          </div>
          {statuses.length > 0 ? (
            <fieldset className="m-0 border-0 p-0">
              <legend className="mb-1 text-sm font-medium">{t('settings.sla.pause')}</legend>
              <div className="flex flex-wrap gap-3">
                {statuses.map((s) => (
                  <label key={s.id} className="inline-flex items-center gap-2 text-sm">
                    <Checkbox checked={pause.includes(s.key)} onCheckedChange={(v) => { setPause((p) => (v === true ? [...p, s.key] : p.filter((k) => k !== s.key))); }} />
                    {labelOf(s.label, s.key)}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          <label className="inline-flex items-center gap-2 text-sm"><Switch checked={enabled} onCheckedChange={setEnabled} />{t('settings.enabled')}</label>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" loading={m.createPolicy.isPending || m.patchPolicy.isPending} disabled={!name.trim() || !calendarId} data-testid="policy-save">{existing ? t('settings.save') : t('settings.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SlaInner() {
  const { can } = useApp();
  const editable = can('tenant.config.manage');
  const { toast } = useToast();
  const cals = useCalendars();
  const pols = useSlaPolicies();
  const m = useSlaMutations();
  const [cal, setCal] = useState<Calendar | 'new' | null>(null);
  const [pol, setPol] = useState<SlaPolicy | 'new' | null>(null);
  const calendars = cals.data?.data ?? [];
  const calName = new Map(calendars.map((c) => [c.id, c.name]));
  const hoursText = (c: Calendar) => DAYS.filter((d) => c.weeklyHours.some((h) => h.day === d)).map((d) => t(`settings.dayShort.${String(d)}` as 'settings.dayShort.1')).join(' ');

  return (
    <PageContainer>
      <SettingsHeader title={t('settings.sla')} lead={t('settings.sla.lead')} />
      {editable ? null : <ReadOnlyNotice />}
      <section aria-labelledby="sla-calendars" className="mb-8">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 id="sla-calendars" className="m-0 text-base font-semibold">{t('settings.sla.calendars')}</h2>
          {editable ? <Button size="sm" icon={<Plus aria-hidden size={14} />} onClick={() => { setCal('new'); }} data-testid="calendar-new">{t('settings.sla.newCalendar')}</Button> : null}
        </div>
        {cals.isPending ? <Skeleton className="h-20 w-full" /> : cals.isError ? <ErrorState title={t('error.fallback')} retryLabel={t('common.retry')} onRetry={() => { void cals.refetch(); }} /> : calendars.length === 0 ? (
          <EmptyState icon={CalendarClock} title={t('settings.sla.noCalendars')} description={t('settings.sla.noCalendarsBody')} />
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-line rounded-card border border-line bg-surface p-0">
            {calendars.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="calendar-row">
                <div className="min-w-0 flex-1">
                  <p className="m-0 font-medium">{c.name}</p>
                  <p className="m-0 mt-0.5 text-xs text-fg-muted">{c.timezone} · {hoursText(c)} · {t('settings.sla.holidayCount', { count: String(c.holidays.length) })}</p>
                </div>
                {editable ? <IconButton size="sm" label={t('settings.sla.editCalendar', { name: c.name })} onClick={() => { setCal(c); }}><Pencil aria-hidden size={14} /></IconButton> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="sla-policies">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 id="sla-policies" className="m-0 text-base font-semibold">{t('settings.sla.policies')}</h2>
          {editable ? <Button size="sm" icon={<Plus aria-hidden size={14} />} disabled={calendars.length === 0} onClick={() => { setPol('new'); }} data-testid="policy-new">{t('settings.sla.newPolicy')}</Button> : null}
        </div>
        {pols.isPending ? <Skeleton className="h-20 w-full" /> : pols.isError ? <ErrorState title={t('error.fallback')} retryLabel={t('common.retry')} onRetry={() => { void pols.refetch(); }} /> : pols.data.data.length === 0 ? (
          <EmptyState icon={Timer} title={t('settings.sla.noPolicies')} description={calendars.length === 0 ? t('settings.sla.calendarFirst') : t('settings.sla.noPoliciesBody')} />
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-line rounded-card border border-line bg-surface p-0">
            {pols.data.data.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="policy-row">
                <div className="min-w-0 flex-1">
                  <p className="m-0 font-medium">{p.name}</p>
                  <p className="m-0 mt-0.5 text-xs text-fg-muted">
                    {t(`settings.resource.${p.resourceType}` as 'settings.resource.case')} · {t('settings.sla.firstResponse')}: {duration(p.firstResponseMinutes)} · {t('settings.sla.resolution')}: {duration(p.resolutionMinutes)} · {calName.get(p.calendarId) ?? ''}
                    {p.criteria ? <> · <code>{p.criteria}</code></> : null}
                  </p>
                </div>
                <Badge tone="neutral">#{p.position}</Badge>
                <label className="inline-flex items-center gap-2 text-sm">
                  <Switch
                    checked={p.enabled}
                    disabled={!editable}
                    aria-label={t('settings.sla.toggle', { name: p.name })}
                    onCheckedChange={(enabled) => { m.patchPolicy.mutate({ policy: p, body: { enabled } }, { onError: (e) => { toast({ title: errText(e), kind: 'error' }); } }); }}
                  />
                  <span aria-hidden>{p.enabled ? t('settings.enabled') : t('settings.disabled')}</span>
                </label>
                {editable ? <IconButton size="sm" label={t('settings.sla.editPolicy', { name: p.name })} onClick={() => { setPol(p); }}><Pencil aria-hidden size={14} /></IconButton> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      {cal ? <CalendarDialog key={cal === 'new' ? 'new' : cal.id} calendar={cal} onClose={() => { setCal(null); }} /> : null}
      {pol ? <PolicyDialog key={pol === 'new' ? 'new' : pol.id} policy={pol} calendars={calendars} onClose={() => { setPol(null); }} /> : null}
    </PageContainer>
  );
}

export default function SlaPage() {
  return (
    <SettingsGate anyOf={['tenant.config.read']} module="automation_sla">
      <SlaInner />
    </SettingsGate>
  );
}
