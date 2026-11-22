import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { Toast as T } from 'radix-ui';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn, focusRing } from '../lib/cn';

export type ToastKind = 'info' | 'success' | 'error';

export interface ToastInput {
  title: string;
  description?: string;
  kind?: ToastKind;
  /** e.g. "Undo". The toast stays open longer when it carries an action. */
  action?: { label: string; onAction: () => void };
  durationMs?: number;
}

interface ToastItem extends ToastInput {
  id: number;
  open: boolean;
}

interface ToastApi {
  toast: (input: ToastInput) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const ICON: Record<ToastKind, typeof Info> = { info: Info, success: CircleCheck, error: CircleAlert };
const TONE: Record<ToastKind, string> = { info: 'text-info', success: 'text-success', error: 'text-danger' };

/** Toasts are announced politely (errors assertively) by Radix; the region is reachable with F8. */
export function ToastProvider({ children, closeLabel, regionLabel }: { children: ReactNode; closeLabel: string; regionLabel: string }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems((list) => list.map((t) => (t.id === id ? { ...t, open: false } : t)));
    window.setTimeout(() => {
      setItems((list) => list.filter((t) => t.id !== id));
    }, 400);
  }, []);

  const toast = useCallback((input: ToastInput) => {
    seq.current += 1;
    const id = seq.current;
    setItems((list) => [...list.slice(-3), { ...input, id, open: true }]);
    return id;
  }, []);

  const api = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      <T.Provider swipeDirection="right" label={regionLabel}>
        {children}
        {items.map((item) => {
          const kind = item.kind ?? 'info';
          const Icon = ICON[kind];
          return (
            <T.Root
              key={item.id}
              open={item.open}
              onOpenChange={(open) => {
                if (!open) dismiss(item.id);
              }}
              type={kind === 'error' ? 'foreground' : 'background'}
              duration={item.durationMs ?? (item.action ? 8000 : 5000)}
              className="fx-float flex w-full items-start gap-3 rounded-card border border-line bg-raised p-3 pr-2 text-fg shadow-popover"
              data-testid="toast"
            >
              <Icon aria-hidden size={18} className={cn('mt-0.5 shrink-0', TONE[kind])} />
              <div className="min-w-0 flex-1">
                <T.Title className="text-sm font-semibold">{item.title}</T.Title>
                {item.description ? <T.Description className="mt-0.5 text-sm text-fg-muted">{item.description}</T.Description> : null}
              </div>
              {item.action ? (
                <T.Action
                  altText={item.action.label}
                  onClick={item.action.onAction}
                  className={cn('h-8 shrink-0 rounded-btn border border-line-strong px-3 text-sm font-semibold hover:bg-subtle', focusRing)}
                >
                  {item.action.label}
                </T.Action>
              ) : null}
              <T.Close aria-label={closeLabel} className={cn('rounded-input p-1 text-fg-muted hover:bg-subtle hover:text-fg', focusRing)}>
                <X aria-hidden size={16} />
              </T.Close>
            </T.Root>
          );
        })}
        <T.Viewport className="fixed bottom-0 right-0 z-[60] flex w-full max-w-sm flex-col gap-2 p-4 outline-none" />
      </T.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
