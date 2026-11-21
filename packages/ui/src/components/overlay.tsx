import { X } from 'lucide-react';
import { Dialog as D, DropdownMenu as M, Popover as P, Tooltip as T } from 'radix-ui';
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { cn, focusRing } from '../lib/cn';

/** Floating layers use the glass surface (§10.5.1 §5): raised background, popover shadow, thin border. */
export const floatingClass = cn(
  'z-50 rounded-card border border-line bg-raised text-fg shadow-popover',
  'fx-float',
);

// ---------------------------------------------------------------- dialog
export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({
  title,
  description,
  children,
  closeLabel,
  className,
  wide = false,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  closeLabel: string;
  className?: string;
  wide?: boolean;
}) {
  return (
    <D.Portal>
      <D.Overlay data-slot="overlay" className="fixed inset-0 z-40 bg-overlay" />
      <D.Content
        className={cn(
          floatingClass,
          'fixed left-1/2 top-[12vh] z-50 flex max-h-[80vh] w-[calc(100vw-2rem)] -translate-x-1/2 flex-col p-0',
          wide ? 'max-w-2xl' : 'max-w-md',
          className,
        )}
        {...(description ? {} : { 'aria-describedby': undefined })}
      >
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <D.Title className="font-display text-lg font-bold">{title}</D.Title>
            {description ? <D.Description className="mt-1 text-sm text-fg-muted">{description}</D.Description> : null}
          </div>
          <D.Close aria-label={closeLabel} className={cn('-m-1 rounded-input p-1 text-fg-muted hover:bg-subtle hover:text-fg', focusRing)}>
            <X aria-hidden size={18} />
          </D.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </D.Content>
    </D.Portal>
  );
}

export function DialogFooter({ children }: { children: ReactNode }) {
  return <div className="-mx-5 -mb-4 mt-4 flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{children}</div>;
}

/** Side panel (mobile navigation, quick detail). */
export function SheetContent({
  title,
  children,
  closeLabel,
  side = 'left',
  className,
}: {
  title: string;
  children: ReactNode;
  closeLabel: string;
  side?: 'left' | 'right';
  className?: string;
}) {
  return (
    <D.Portal>
      <D.Overlay data-slot="overlay" className="fixed inset-0 z-40 bg-overlay" />
      <D.Content
        aria-describedby={undefined}
        className={cn(
          'fixed inset-y-0 z-50 flex w-[min(20rem,85vw)] flex-col border-line bg-surface text-fg shadow-popover',
          side === 'left' ? 'left-0 border-r' : 'right-0 border-l',
          className,
        )}
      >
        <D.Title className="sr-only">{title}</D.Title>
        <D.Close aria-label={closeLabel} className={cn('absolute right-3 top-3 z-10 rounded-input p-1 text-fg-muted hover:bg-subtle', focusRing)}>
          <X aria-hidden size={18} />
        </D.Close>
        {children}
      </D.Content>
    </D.Portal>
  );
}

// ---------------------------------------------------------------- popover
export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;
export const PopoverClose = P.Close;

export const PopoverContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof P.Content>>(function PopoverContent(
  { className, sideOffset = 6, align = 'start', ...props },
  ref,
) {
  return (
    <P.Portal>
      <P.Content ref={ref} sideOffset={sideOffset} align={align} className={cn(floatingClass, 'p-3', className)} {...props} />
    </P.Portal>
  );
});

// ---------------------------------------------------------------- tooltip
export const TooltipProvider = T.Provider;

export function Tooltip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content side={side} sideOffset={6} className="z-50 max-w-xs rounded-input bg-fg px-2 py-1 text-xs text-canvas shadow-popover">
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}

// ---------------------------------------------------------------- dropdown menu
export const DropdownMenu = M.Root;
export const DropdownMenuTrigger = M.Trigger;
export const DropdownMenuGroup = M.Group;
export const DropdownMenuRadioGroup = M.RadioGroup;

export const DropdownMenuContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof M.Content>>(function DropdownMenuContent(
  { className, sideOffset = 6, align = 'end', ...props },
  ref,
) {
  return (
    <M.Portal>
      <M.Content ref={ref} sideOffset={sideOffset} align={align} className={cn(floatingClass, 'min-w-48 p-1', className)} {...props} />
    </M.Portal>
  );
});

const itemClass = cn(
  'relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-input px-2 py-1.5 text-sm text-fg outline-none',
  'data-[highlighted]:bg-subtle data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
);

export const DropdownMenuItem = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof M.Item>>(function DropdownMenuItem({ className, ...props }, ref) {
  return <M.Item ref={ref} className={cn(itemClass, className)} {...props} />;
});

export const DropdownMenuRadioItem = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof M.RadioItem>>(function DropdownMenuRadioItem(
  { className, children, ...props },
  ref,
) {
  return (
    <M.RadioItem ref={ref} className={cn(itemClass, 'pl-7', className)} {...props}>
      <M.ItemIndicator className="absolute left-2 inline-flex">
        <span aria-hidden className="size-2 rounded-full bg-accent" />
      </M.ItemIndicator>
      {children}
    </M.RadioItem>
  );
});

export function DropdownMenuLabel({ children }: { children: ReactNode }) {
  return <M.Label className="px-2 py-1.5 text-xs font-medium text-fg-muted">{children}</M.Label>;
}

export function DropdownMenuSeparator() {
  return <M.Separator className="my-1 h-px bg-line" />;
}
