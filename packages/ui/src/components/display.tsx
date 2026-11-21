import { cva, type VariantProps } from 'class-variance-authority';
import {
  ArrowDown,
  ArrowUp,
  Building2,
  ChevronsUp,
  CircleAlert,
  CircleDashed,
  CircleDot,
  CircleCheck,
  Minus,
  RotateCw,
  ShieldCheck,
  ShoppingBag,
  type LucideIcon,
} from 'lucide-react';
import { Avatar as A } from 'radix-ui';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Button } from './button';

// ---------------------------------------------------------------- badge
export const badgeVariants = cva('inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium', {
  variants: {
    tone: {
      neutral: 'border-line bg-subtle text-fg',
      outline: 'border-line-strong bg-transparent text-fg',
      solid: 'border-transparent bg-fg text-canvas',
      accent: 'border-transparent bg-accent-soft text-fg',
      success: 'border-transparent bg-success-soft text-success',
      warning: 'border-transparent bg-warning-soft text-warning',
      danger: 'border-transparent bg-danger-soft text-danger',
      info: 'border-transparent bg-info-soft text-info',
      b2b: 'border-transparent bg-b2b-soft text-fg',
      b2c: 'border-transparent bg-b2c-soft text-fg',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  icon?: LucideIcon;
}

export function Badge({ className, tone, icon: Icon, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {Icon ? <Icon aria-hidden size={12} className="shrink-0" /> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** Segment identity is colour + icon + label (§10.5.1 §2). */
export function SegmentBadge({ segment, label }: { segment: 'b2b' | 'b2c'; label: string }) {
  return (
    <Badge tone={segment} icon={segment === 'b2b' ? Building2 : ShoppingBag} data-segment={segment}>
      {label}
    </Badge>
  );
}

const ROLE_TONE: Record<string, BadgeProps['tone']> = {
  admin: 'solid',
  manager: 'outline',
  sales_rep: 'b2b',
  call_agent: 'b2c',
  analyst: 'neutral',
};

export function RoleBadge({ role, label }: { role: string; label: string }) {
  return (
    <Badge tone={ROLE_TONE[role] ?? 'neutral'} icon={ShieldCheck} data-role={role}>
      {label}
    </Badge>
  );
}

const STATUS_ICON: Record<'open' | 'in_progress' | 'closed', LucideIcon> = { open: CircleDashed, in_progress: CircleDot, closed: CircleCheck };
/** Status colour comes from the workflow's token name (ADR-0019: colour is a token, never hex). */
const STATUS_TONE: Record<string, BadgeProps['tone']> = {
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  info: 'info',
  accent: 'accent',
  primary: 'accent',
  neutral: 'neutral',
  'text-secondary': 'neutral',
};

export function StatusBadge({ category, colorToken, label }: { category: 'open' | 'in_progress' | 'closed'; colorToken?: string; label: string }) {
  const tone = (colorToken ? STATUS_TONE[colorToken] : undefined) ?? (category === 'closed' ? 'success' : category === 'in_progress' ? 'info' : 'neutral');
  return (
    <Badge tone={tone} icon={STATUS_ICON[category]} data-category={category}>
      {label}
    </Badge>
  );
}

const PRIORITY_NONE: { icon: LucideIcon; tone: BadgeProps['tone'] } = { icon: Minus, tone: 'neutral' };
const PRIORITY: { icon: LucideIcon; tone: BadgeProps['tone'] }[] = [
  { icon: Minus, tone: 'neutral' },
  { icon: ArrowDown, tone: 'neutral' },
  { icon: Minus, tone: 'info' },
  { icon: ArrowUp, tone: 'warning' },
  { icon: ChevronsUp, tone: 'danger' },
];

/** Priority 0 (none) … 4 (urgent). */
export function PriorityBadge({ priority, label }: { priority: number; label: string }) {
  const p = PRIORITY[Math.max(0, Math.min(4, priority))] ?? PRIORITY_NONE;
  return (
    <Badge tone={p.tone} icon={p.icon} data-priority={priority}>
      {label}
    </Badge>
  );
}

// ---------------------------------------------------------------- avatar
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '';
  return (first + last).toLocaleUpperCase('tr-TR') || '?';
}

/** `decorative` when the name is already shown or spoken next to it (lists, menus), so it is not read twice. */
export function Avatar({ name, src, size = 28, className, decorative = false }: { name: string; src?: string | null; size?: number; className?: string; decorative?: boolean }) {
  return (
    <A.Root
      className={cn('inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-accent-soft font-semibold text-fg', className)}
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.4)) }}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': name })}
    >
      {src ? <A.Image src={src} alt="" className="size-full object-cover" /> : null}
      <A.Fallback delayMs={src ? 300 : 0}>
        <span aria-hidden>{initials(name)}</span>
      </A.Fallback>
    </A.Root>
  );
}

// ---------------------------------------------------------------- states
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden className={cn('fx-skeleton rounded-input', className)} {...props} />;
}

export function Kbd({ children, className, ...rest }: { children: ReactNode; className?: string } & HTMLAttributes<HTMLElement>) {
  return (
    <kbd {...rest} className={cn('inline-flex h-5 min-w-5 items-center justify-center rounded-[4px] border border-line bg-subtle px-1 font-mono text-[11px] text-fg-muted', className)}>
      {children}
    </kbd>
  );
}

/** Short warm text + at most one action (§10.5.5 "Boş durumlar"). */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 px-6 py-12 text-center', className)}>
      {Icon ? (
        <span className="relative inline-flex size-12 items-center justify-center rounded-full border border-line bg-surface text-fg-muted">
          <Icon aria-hidden size={22} strokeWidth={1.5} />
          <span aria-hidden className="absolute right-1 top-1 size-1.5 rounded-full bg-spark" />
        </span>
      ) : null}
      <div className="max-w-sm">
        <p className="font-display text-base font-bold text-fg">{title}</p>
        {description ? <p className="mt-1 text-sm text-fg-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function ErrorState({
  title,
  description,
  retryLabel,
  onRetry,
  className,
}: {
  title: string;
  description?: string;
  retryLabel?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div role="alert" className={cn('flex flex-col items-center justify-center gap-3 px-6 py-12 text-center', className)}>
      <CircleAlert aria-hidden size={28} className="text-danger" />
      <div className="max-w-sm">
        <p className="font-display text-base font-bold text-fg">{title}</p>
        {description ? <p className="mt-1 text-sm text-fg-muted">{description}</p> : null}
      </div>
      {onRetry && retryLabel ? (
        <Button variant="secondary" size="sm" icon={<RotateCw aria-hidden size={14} />} onClick={onRetry}>
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}

/** Inline alert: icon + text, never colour alone (§10.5.1 §10). */
export function Alert({ kind, children, className }: { kind: 'error' | 'success' | 'warning' | 'info'; children: ReactNode; className?: string }) {
  const tone = { error: 'bg-danger-soft text-danger', success: 'bg-success-soft text-success', warning: 'bg-warning-soft text-warning', info: 'bg-info-soft text-info' }[kind];
  const Icon = kind === 'success' ? CircleCheck : CircleAlert;
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={cn('flex items-start gap-2 rounded-input px-3 py-2 text-sm', tone, className)}>
      <Icon aria-hidden size={16} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
