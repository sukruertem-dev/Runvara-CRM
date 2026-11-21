import { Check, ChevronDown, ChevronsUpDown } from 'lucide-react';
import { Command as Cmdk } from 'cmdk';
import { Checkbox as C, Select as S, Switch as Sw, Tabs as Tb, ToggleGroup as TG } from 'radix-ui';
import { forwardRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { cn, focusRing } from '../lib/cn';
import { controlClass } from './input';
import { floatingClass, Popover, PopoverContent, PopoverTrigger } from './overlay';

// ---------------------------------------------------------------- select
export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export const Select = forwardRef<
  HTMLButtonElement,
  {
    value: string | undefined;
    onValueChange: (value: string) => void;
    options: readonly SelectOption[];
    placeholder?: string;
    disabled?: boolean;
    id?: string;
    className?: string;
    'aria-label'?: string;
    'aria-invalid'?: boolean;
    'aria-describedby'?: string;
  }
>(function Select({ value, onValueChange, options, placeholder, disabled, className, ...a11y }, ref) {
  return (
    <S.Root {...(value === undefined ? {} : { value })} onValueChange={onValueChange} {...(disabled === undefined ? {} : { disabled })}>
      <S.Trigger ref={ref} className={cn(controlClass, 'flex h-control items-center justify-between gap-2 text-left', className)} {...a11y}>
        <S.Value {...(placeholder === undefined ? {} : { placeholder })} />
        <S.Icon>
          <ChevronDown aria-hidden size={16} className="text-fg-muted" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content position="popper" sideOffset={4} className={cn(floatingClass, 'max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden p-1')}>
          <S.Viewport>
            {options.map((o) => (
              <S.Item
                key={o.value}
                value={o.value}
                {...(o.disabled === undefined ? {} : { disabled: o.disabled })}
                className="relative flex min-h-8 cursor-default select-none items-center rounded-input py-1.5 pl-7 pr-2 text-sm outline-none data-[highlighted]:bg-subtle data-[disabled]:opacity-50"
              >
                <S.ItemIndicator className="absolute left-2 inline-flex">
                  <Check aria-hidden size={14} />
                </S.ItemIndicator>
                <S.ItemText>{o.label}</S.ItemText>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
});

// ---------------------------------------------------------------- combobox
/** Searchable single select (Popover + cmdk). `onSearch` lets callers fetch options from the API. */
export function Combobox({
  value,
  onValueChange,
  options,
  placeholder,
  searchPlaceholder,
  emptyText,
  onSearch,
  id,
  className,
  'aria-label': ariaLabel,
}: {
  value: string | null;
  onValueChange: (value: string | null) => void;
  options: readonly SelectOption[];
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  onSearch?: (query: string) => void;
  id?: string;
  className?: string;
  'aria-label'?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          className={cn(controlClass, 'flex h-control items-center justify-between gap-2 text-left', className)}
        >
          <span className={cn('truncate', !selected && 'text-fg-muted')}>{selected?.label ?? placeholder}</span>
          <ChevronsUpDown aria-hidden size={16} className="shrink-0 text-fg-muted" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-56 p-0">
        <Cmdk shouldFilter={!onSearch} className="flex flex-col">
          <Cmdk.Input
            placeholder={searchPlaceholder}
            {...(onSearch ? { onValueChange: onSearch } : {})}
            className="h-10 border-b border-line bg-transparent px-3 text-sm text-fg outline-none placeholder:text-fg-muted"
          />
          <Cmdk.List className="max-h-64 overflow-y-auto p-1">
            <Cmdk.Empty className="px-2 py-3 text-sm text-fg-muted">{emptyText}</Cmdk.Empty>
            {options.map((o) => (
              <Cmdk.Item
                key={o.value}
                value={`${o.label} ${o.value}`}
                {...(o.disabled === undefined ? {} : { disabled: o.disabled })}
                onSelect={() => {
                  onValueChange(o.value === value ? null : o.value);
                  setOpen(false);
                }}
                className="flex min-h-8 cursor-default items-center gap-2 rounded-input px-2 py-1.5 text-sm data-[selected=true]:bg-subtle data-[disabled=true]:opacity-50"
              >
                <Check aria-hidden size={14} className={cn(o.value === value ? 'opacity-100' : 'opacity-0')} />
                {o.label}
              </Cmdk.Item>
            ))}
          </Cmdk.List>
        </Cmdk>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------- checkbox, switch
export const Checkbox = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof C.Root>>(function Checkbox({ className, ...props }, ref) {
  return (
    <C.Root
      ref={ref}
      className={cn(
        'inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-line-strong bg-surface',
        'data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-on-primary',
        'data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-on-primary',
        focusRing,
        className,
      )}
      {...props}
    >
      <C.Indicator>
        {props.checked === 'indeterminate' ? <span aria-hidden className="block h-0.5 w-2 bg-current" /> : <Check aria-hidden size={12} strokeWidth={3} />}
      </C.Indicator>
    </C.Root>
  );
});

export const Switch = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof Sw.Root>>(function Switch({ className, ...props }, ref) {
  return (
    <Sw.Root
      ref={ref}
      className={cn(
        'relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full border-2 border-line-strong bg-subtle',
        'data-[state=checked]:border-primary data-[state=checked]:bg-primary disabled:cursor-not-allowed disabled:opacity-50',
        focusRing,
        className,
      )}
      {...props}
    >
      <Sw.Thumb className="block size-4 translate-x-0.5 rounded-full bg-fg transition-transform duration-[var(--motion-base)] ease-flexa data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-on-primary" />
    </Sw.Root>
  );
});

// ---------------------------------------------------------------- tabs
export const Tabs = Tb.Root;

export function TabsList({ children, label, className }: { children: ReactNode; label: string; className?: string }) {
  return (
    <Tb.List aria-label={label} className={cn('flex gap-1 border-b border-line', className)}>
      {children}
    </Tb.List>
  );
}

export const TabsTrigger = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof Tb.Trigger>>(function TabsTrigger({ className, ...props }, ref) {
  return (
    <Tb.Trigger
      ref={ref}
      className={cn(
        '-mb-px inline-flex h-9 items-center gap-1.5 border-b-2 border-transparent px-3 text-sm font-medium text-fg-muted hover:text-fg',
        'data-[state=active]:border-accent data-[state=active]:text-fg',
        focusRing,
        className,
      )}
      {...props}
    />
  );
});

export const TabsContent = Tb.Content;

// ---------------------------------------------------------------- segmented control
/** One-of-many switch (view modes): a radio group with arrow-key movement, unlike tabs it owns no panels. */
export function SegmentedControl<V extends string>({
  value,
  onValueChange,
  options,
  label,
  className,
}: {
  value: V;
  onValueChange: (value: V) => void;
  options: readonly { value: V; label: string; icon?: ReactNode }[];
  label: string;
  className?: string;
}) {
  return (
    <TG.Root
      type="single"
      value={value}
      onValueChange={(v) => {
        if (v) onValueChange(v as V);
      }}
      aria-label={label}
      className={cn('inline-flex rounded-btn border border-line bg-subtle p-0.5', className)}
    >
      {options.map((o) => (
        <TG.Item
          key={o.value}
          value={o.value}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-input px-2.5 text-sm font-medium text-fg-muted hover:text-fg',
            'data-[state=on]:bg-surface data-[state=on]:text-fg data-[state=on]:shadow-card',
            focusRing,
          )}
        >
          {o.icon}
          {o.label}
        </TG.Item>
      ))}
    </TG.Root>
  );
}
