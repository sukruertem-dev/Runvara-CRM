import { t } from './i18n';

const LOCALE = 'tr-TR';

/** Due-date label: today / tomorrow / yesterday or a short date; `overdue` when an open task is past due. */
export function dueLabel(iso: string | null | undefined, now = new Date()): { text: string; overdue: boolean } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const day = (x: Date): number => Math.floor(new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime() / 86_400_000);
  const diff = day(d) - day(now);
  const text =
    diff === 0
      ? t('common.today')
      : diff === 1
        ? t('common.tomorrow')
        : diff === -1
          ? t('common.yesterday')
          : new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) }).format(d);
  return { text, overdue: d.getTime() < now.getTime() && diff < 0 };
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

export function relativeTime(iso: string, now = Date.now()): string {
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(s, 'second');
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 86_400 * 30) return rtf.format(Math.round(s / 86_400), 'day');
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium' }).format(new Date(iso));
}

/** Date-only (YYYY-MM-DD from the picker) → end of that day in the browser's zone, as ISO with offset. */
export function endOfDayIso(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 23, 59, 0).toISOString();
}

export function isoToDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function fmt(key: Parameters<typeof t>[0], vars: Record<string, string | number>): string {
  return t(key, Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, String(v)])));
}
