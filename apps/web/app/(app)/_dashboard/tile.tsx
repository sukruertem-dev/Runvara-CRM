'use client';

import { cn, focusRing, IconButton } from '@flexa/ui';
import { GripVertical, Minus, MoveHorizontal, MoveVertical, X } from 'lucide-react';
import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { t } from '../../../lib/i18n';

/** What the sortable grid hands a tile in edit mode. */
export interface TileDrag {
  ref: (el: HTMLElement | null) => void;
  style: CSSProperties;
  handle: HTMLAttributes<HTMLButtonElement>;
  dragging: boolean;
}

export interface TileWidget {
  id: string;
  w: number;
  h: number;
  kind: string;
}

/** One dashboard widget frame: title, edit controls (move handle, size, remove) and the widget body. */
export function Tile<W extends TileWidget>({
  widget,
  title,
  editing,
  drag,
  onChange,
  onRemove,
  children,
}: {
  widget: W;
  title: string;
  editing: boolean;
  drag?: TileDrag;
  onChange: (w: W) => void;
  onRemove: () => void;
  children: ReactNode;
}) {
  const size = (dw: number, dh: number): void => {
    onChange({ ...widget, w: Math.max(2, Math.min(12, widget.w + dw)), h: Math.max(2, Math.min(8, widget.h + dh)) });
  };
  return (
    <section
      ref={drag?.ref}
      aria-label={title}
      data-testid="widget"
      data-kind={widget.kind}
      data-w={widget.w}
      style={{ ...drag?.style, gridColumn: `span ${String(widget.w)} / span ${String(widget.w)}`, gridRow: `span ${String(widget.h)} / span ${String(widget.h)}` }}
      className={cn(
        'col-span-12 flex min-h-0 flex-col gap-3 overflow-hidden rounded-card border border-line bg-surface p-4 shadow-card max-md:![grid-column:span_12/span_12]',
        drag?.dragging && 'z-10 opacity-80',
        editing && 'border-dashed border-line-strong',
      )}
    >
      <header className="flex items-center gap-1">
        {editing && drag ? (
          <button type="button" {...drag.handle} aria-label={`${title}: ${t('dash.moveHint')}`} className={cn('-ml-1 cursor-grab rounded-input p-1 text-fg-muted hover:bg-subtle', focusRing)}>
            <GripVertical aria-hidden size={14} />
          </button>
        ) : null}
        <h2 className="m-0 min-w-0 flex-1 truncate text-sm font-semibold text-fg-muted">{title}</h2>
        {editing ? (
          <span className="flex items-center">
            <IconButton size="sm" label={t('dash.narrower', { title })} onClick={() => { size(-1, 0); }} disabled={widget.w <= 2}>
              <Minus aria-hidden size={12} />
            </IconButton>
            <IconButton size="sm" label={t('dash.wider', { title })} onClick={() => { size(1, 0); }} disabled={widget.w >= 12}>
              <MoveHorizontal aria-hidden size={12} />
            </IconButton>
            <IconButton size="sm" label={t('dash.shorter', { title })} onClick={() => { size(0, -1); }} disabled={widget.h <= 2}>
              <Minus aria-hidden size={12} className="rotate-90" />
            </IconButton>
            <IconButton size="sm" label={t('dash.taller', { title })} onClick={() => { size(0, 1); }} disabled={widget.h >= 8}>
              <MoveVertical aria-hidden size={12} />
            </IconButton>
            <IconButton size="sm" label={t('dash.remove', { title })} onClick={onRemove}>
              <X aria-hidden size={12} />
            </IconButton>
          </span>
        ) : null}
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}
