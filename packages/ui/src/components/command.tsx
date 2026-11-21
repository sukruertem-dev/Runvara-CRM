import { Command as Cmdk } from 'cmdk';
import { Search } from 'lucide-react';
import { Dialog as D } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { floatingClass } from './overlay';

/** Command palette shell (Cmd/Ctrl+K). Results are supplied by the app; filtering is the caller's choice. */
export function CommandDialog({
  open,
  onOpenChange,
  title,
  placeholder,
  value,
  onValueChange,
  shouldFilter = true,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  placeholder: string;
  value: string;
  onValueChange: (value: string) => void;
  shouldFilter?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay data-slot="overlay" className="fixed inset-0 z-40 bg-overlay" />
        <D.Content
          aria-describedby={undefined}
          className={cn(floatingClass, 'fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 overflow-hidden p-0')}
        >
          <D.Title className="sr-only">{title}</D.Title>
          <Cmdk label={title} shouldFilter={shouldFilter} loop className="flex flex-col">
            <div className="flex items-center gap-2 border-b border-line px-4">
              <Search aria-hidden size={16} className="shrink-0 text-fg-muted" />
              <Cmdk.Input
                value={value}
                onValueChange={onValueChange}
                placeholder={placeholder}
                className="h-12 w-full bg-transparent text-base text-fg outline-none placeholder:text-fg-muted"
              />
            </div>
            <Cmdk.List className="max-h-[min(60vh,420px)] overflow-y-auto p-2">{children}</Cmdk.List>
            {footer ? <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-xs text-fg-muted">{footer}</div> : null}
          </Cmdk>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export function CommandGroup({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <Cmdk.Group
      heading={heading}
      className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-fg-muted"
    >
      {children}
    </Cmdk.Group>
  );
}

export function CommandItem({
  value,
  onSelect,
  icon,
  children,
  hint,
  keywords,
}: {
  value: string;
  onSelect: () => void;
  icon?: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  keywords?: string[];
}) {
  return (
    <Cmdk.Item
      value={value}
      onSelect={onSelect}
      {...(keywords ? { keywords } : {})}
      className="flex min-h-10 cursor-default select-none items-center gap-3 rounded-input px-2 py-2 text-sm text-fg data-[selected=true]:bg-subtle"
    >
      {icon ? <span className="inline-flex shrink-0 text-fg-muted">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint ? <span className="shrink-0 text-xs text-fg-muted">{hint}</span> : null}
    </Cmdk.Item>
  );
}

export function CommandEmpty({ children }: { children: ReactNode }) {
  return <Cmdk.Empty className="px-2 py-6 text-center text-sm text-fg-muted">{children}</Cmdk.Empty>;
}

export function CommandLoading({ children }: { children: ReactNode }) {
  return <Cmdk.Loading className="px-2 py-3 text-sm text-fg-muted">{children}</Cmdk.Loading>;
}
