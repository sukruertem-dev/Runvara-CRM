import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn, focusRing } from '../lib/cn';
import { Spinner } from './spinner';

export const buttonVariants = cva(
  [
    'inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-btn border font-semibold',
    'transition-colors duration-[var(--motion-fast)] ease-flexa',
    'disabled:cursor-not-allowed disabled:opacity-60 aria-busy:cursor-progress',
    focusRing,
  ],
  {
    variants: {
      variant: {
        // §10.5.2: primary background in light theme, accent background in dark theme.
        primary: 'border-transparent bg-primary text-on-primary hover:bg-accent-btn-hover dark:bg-accent-btn dark:text-on-accent',
        secondary: 'border-line-strong bg-surface text-fg hover:bg-subtle',
        ghost: 'border-transparent bg-transparent text-fg hover:bg-subtle',
        danger: 'border-danger bg-danger-soft text-danger hover:bg-surface',
      },
      size: {
        sm: 'h-8 px-3 text-sm',
        md: 'h-control px-4 text-sm',
        lg: 'h-11 px-5 text-base',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Renders the child element (e.g. a link) with button styling. */
  asChild?: boolean;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, loading = false, icon, children, disabled, type, ...props },
  ref,
) {
  const classes = cn(buttonVariants({ variant, size }), className);
  if (asChild) {
    return (
      <Slot.Root ref={ref} className={classes} {...props}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={classes}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Spinner size={14} /> : icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonProps, 'icon' | 'children' | 'size'> {
  /** Accessible name; icon-only buttons must have one. */
  label: string;
  children: ReactNode;
  size?: 'sm' | 'md';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, children, className, variant = 'ghost', size = 'md', ...props },
  ref,
) {
  return (
    <Button
      ref={ref}
      variant={variant}
      aria-label={label}
      title={label}
      className={cn('p-0', size === 'sm' ? 'size-8' : 'size-control', className)}
      {...props}
    >
      {children}
    </Button>
  );
});
