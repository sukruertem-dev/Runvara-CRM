// "Do not disturb" hours (MEN-07): evaluated in the person's own time zone.

export interface QuietHours {
  enabled: boolean;
  /** HH:MM; a window that ends before it starts runs past midnight. */
  from: string;
  to: string;
}

const minutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function isQuiet(q: QuietHours, timezone: string, now: Date): boolean {
  if (!q.enabled) return false;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const at = get('hour') * 60 + get('minute');
  const from = minutes(q.from);
  const to = minutes(q.to);
  if (from === to) return false;
  return from < to ? at >= from && at < to : at >= from || at < to;
}
