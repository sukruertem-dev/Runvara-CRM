import { t } from './i18n';

// Display preferences from the effective configuration (`locale` key, docs/p7-plan.md §4). Set by the config
// layer before the app renders; the defaults match the platform default.
export interface FormatPrefs {
  locale: 'tr-TR' | 'en-US';
  /** IANA zone for displayed timestamps; undefined = the device's zone. */
  timeZone: string | undefined;
  dateFormat: 'dmy' | 'mdy' | 'ymd';
  hour12: boolean;
  /** 1 = Monday, 0 = Sunday. */
  weekStart: 0 | 1;
}

let prefs: FormatPrefs = { locale: 'tr-TR', timeZone: undefined, dateFormat: 'dmy', hour12: false, weekStart: 1 };

export function setFormatPrefs(next: Partial<FormatPrefs>): void {
  prefs = { ...prefs, ...next };
}

export const formatLocale = (): FormatPrefs['locale'] => prefs.locale;
export const weekStartsOn = (): 0 | 1 => prefs.weekStart;

export function formatNumber(n: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(prefs.locale, options).format(n);
}

const zone = (): { timeZone?: string } => (prefs.timeZone ? { timeZone: prefs.timeZone } : {});

/** Numeric date in the configured order: 23.11.2026, 11/23/2026 or 2026-11-23. */
export function formatDate(value: string | Date): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', ...zone() }).formatToParts(d);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const [y, m, day] = [part('year'), part('month'), part('day')];
  return prefs.dateFormat === 'mdy' ? `${m}/${day}/${y}` : prefs.dateFormat === 'ymd' ? `${y}-${m}-${day}` : `${day}.${m}.${y}`;
}

export function formatTime(value: string | Date): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat(prefs.locale, { hour: '2-digit', minute: '2-digit', hour12: prefs.hour12, ...zone() }).format(d);
}

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
          : new Intl.DateTimeFormat(prefs.locale, { day: 'numeric', month: 'short', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) }).format(d);
  return { text, overdue: d.getTime() < now.getTime() && diff < 0 };
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  return `${formatDate(iso)} ${formatTime(iso)}`;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(prefs.locale, { numeric: 'auto' });
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(s, 'second');
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 86_400 * 30) return rtf.format(Math.round(s / 86_400), 'day');
  return formatDate(iso);
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
