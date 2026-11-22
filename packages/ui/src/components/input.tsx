import { CircleAlert } from 'lucide-react';
import { cloneElement, forwardRef, isValidElement, useId, type InputHTMLAttributes, type ReactElement, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { cn, focusRing } from '../lib/cn';

export const controlClass = cn(
  'block w-full rounded-input border border-line-strong bg-surface px-3 text-sm text-fg placeholder:text-fg-muted',
  'disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-danger',
  focusRing,
);

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(controlClass, 'h-control', className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(controlClass, 'min-h-20 py-2', className)} {...props} />;
});

interface ControlA11y {
  id?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}

/** Label + control + hint + error, wired with ids. The error is shown with an icon and text, never colour alone. */
export function Field({
  label,
  hint,
  error,
  children,
  className,
  hideLabel = false,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null | undefined;
  children: ReactElement<ControlA11y>;
  className?: string;
  hideLabel?: boolean;
}) {
  const auto = useId();
  const id = children.props.id ?? auto;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const control = isValidElement(children)
    ? cloneElement(children, {
        id,
        ...(error ? { 'aria-invalid': true } : {}),
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
      })
    : children;
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={id} className={cn('text-sm font-medium text-fg', hideLabel && 'sr-only')}>
        {label}
      </label>
      {control}
      {hint ? (
        <p id={hintId} className="text-xs text-fg-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="flex items-start gap-1.5 text-sm text-danger">
          <CircleAlert aria-hidden size={16} className="mt-0.5 shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  );
}
