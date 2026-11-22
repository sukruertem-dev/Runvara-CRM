import { CalendarDays, X } from 'lucide-react';
import { useState } from 'react';
import { DayPicker } from 'react-day-picker';
import { enUS, tr } from 'react-day-picker/locale';
import { cn, focusRing } from '../lib/cn';
import { controlClass } from './input';
import { Popover, PopoverContent, PopoverTrigger } from './overlay';

/** Date-only picker. Values are `YYYY-MM-DD` in the user's calendar; callers convert to their time zone. */
export function DatePicker({
  value,
  onChange,
  placeholder,
  clearLabel,
  locale = 'tr',
  id,
  className,
  'aria-label': ariaLabel,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder: string;
  clearLabel: string;
  locale?: 'tr' | 'en';
  id?: string;
  className?: string;
  'aria-label'?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = value ? fromIsoDate(value) : undefined;
  const fmt = new Intl.DateTimeFormat(locale === 'tr' ? 'tr-TR' : 'en-US', { day: 'numeric', month: 'short', year: 'numeric' });
  return (
    <div className={cn('relative', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" id={id} className={cn(controlClass, 'flex h-control items-center gap-2 pr-8 text-left')}>
            <CalendarDays aria-hidden size={16} className="shrink-0 text-fg-muted" />
            {/* The name starts with the label and contains the visible date (WCAG 2.5.3 label in name). */}
            {ariaLabel ? <span className="sr-only">{`${ariaLabel}: `}</span> : null}
            <span className={cn('truncate', !selected && 'text-fg-muted')}>{selected ? fmt.format(selected) : placeholder}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent className="relative p-3">
          <DayPicker
            mode="single"
            className="fx-calendar"
            locale={locale === 'tr' ? tr : enUS}
            weekStartsOn={1}
            selected={selected}
            {...(selected ? { defaultMonth: selected } : {})}
            onSelect={(d) => {
              onChange(d ? toIsoDate(d) : null);
              setOpen(false);
            }}
            autoFocus
          />
        </PopoverContent>
      </Popover>
      {value ? (
        <button
          type="button"
          aria-label={clearLabel}
          onClick={() => {
            onChange(null);
          }}
          className={cn('absolute right-1.5 top-1/2 -translate-y-1/2 rounded-input p-1 text-fg-muted hover:bg-subtle hover:text-fg', focusRing)}
        >
          <X aria-hidden size={14} />
        </button>
      ) : null}
    </div>
  );
}

export function toIsoDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function fromIsoDate(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}
