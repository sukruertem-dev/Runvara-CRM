'use client';

import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ReactNode } from 'react';
import type { TileDrag } from './tile';

interface Item {
  id: string;
}

function SortableItem<W extends Item>({ widget, render }: { widget: W; render: (w: W, drag: TileDrag) => ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: widget.id });
  return render(widget, {
    ref: setNodeRef,
    style: { transform: CSS.Translate.toString(transform), transition },
    handle: { ...attributes, ...listeners },
    dragging: isDragging,
  });
}

/**
 * The dashboard grid in edit mode: widgets reorder by drag or Space + arrows. Loaded only when editing starts,
 * so the everyday dashboard carries no drag-and-drop code or per-widget measuring.
 */
export function SortableGrid<W extends Item>({ widgets, onChange, render }: { widgets: W[]; onChange: (next: W[]) => void; render: (w: W, drag: TileDrag) => ReactNode }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  function onDragEnd(e: DragEndEvent): void {
    if (!e.over || e.active.id === e.over.id) return;
    onChange(arrayMove(widgets, widgets.findIndex((w) => w.id === e.active.id), widgets.findIndex((w) => w.id === e.over?.id)));
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={widgets.map((w) => w.id)} strategy={rectSortingStrategy}>
        <div className="grid auto-rows-[3.25rem] grid-cols-12 gap-3">
          {widgets.map((w) => (
            <SortableItem key={w.id} widget={w} render={render} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
