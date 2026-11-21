'use client';

import { useEffect, useRef } from 'react';

/** True when the key press belongs to a text field, editor or an open menu/listbox (shortcuts stay quiet). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.closest('[role="menu"], [role="listbox"], [role="dialog"] [cmdk-root]') !== null;
}

/** True when the event target is a control whose own Enter/Space/arrows must keep working. */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('button, a[href], [role="checkbox"], [role="combobox"], [role="tab"], [role="menuitem"]') !== null;
}

export interface Hotkey {
  /** `k`, `?`, `/`, `j` … matched against KeyboardEvent.key (case-insensitive for letters). */
  key: string;
  /** Requires Ctrl (or ⌘ on macOS). */
  mod?: boolean;
  /** Fires even inside text fields (e.g. Ctrl+K). */
  allowInInput?: boolean;
  /** Extra condition checked before the key is consumed (the browser default runs when it returns false). */
  when?: (e: KeyboardEvent) => boolean;
  handler: (e: KeyboardEvent) => void;
}

/** Global single-key shortcuts (§5.5): C new task, / search, J/K navigation, ? help; Ctrl/⌘+K palette. */
export function useHotkeys(keys: readonly Hotkey[], enabled = true): void {
  const ref = useRef(keys);
  ref.current = keys;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing) return;
      const mod = e.ctrlKey || e.metaKey;
      for (const h of ref.current) {
        if (h.key.toLowerCase() !== e.key.toLowerCase()) continue;
        if (Boolean(h.mod) !== mod) continue;
        if (!h.mod && (e.altKey || e.ctrlKey || e.metaKey)) continue;
        if (!h.allowInInput && isTypingTarget(e.target)) continue;
        // An open dialog, popover or menu owns the keyboard; page shortcuts wait until it closes.
        if (!h.allowInInput && document.querySelector('[role="dialog"][data-state="open"], [role="menu"][data-state="open"]')) continue;
        if (h.when && !h.when(e)) continue;
        e.preventDefault();
        h.handler(e);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [enabled]);
}
