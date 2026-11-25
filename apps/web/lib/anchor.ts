'use client';

import { useEffect, useState } from 'react';

/** The place in a page a link points at (`#comment-…`, `#note-…`, `#description`), following in-page changes. */
export function useAnchor(): string {
  const [anchor, setAnchor] = useState('');
  useEffect(() => {
    const read = (): void => { setAnchor(window.location.hash.slice(1)); };
    read();
    window.addEventListener('hashchange', read);
    return () => { window.removeEventListener('hashchange', read); };
  }, []);
  return anchor;
}

/** Scrolls to the anchored element and focuses it, once it is on the page (`ready`). */
export function useFocusAnchor(anchor: string, ready: boolean): void {
  useEffect(() => {
    if (!anchor || !ready) return;
    const el = document.getElementById(anchor);
    if (!el) return;
    el.tabIndex = -1;
    el.scrollIntoView({ block: 'center' });
    el.focus({ preventScroll: true });
  }, [anchor, ready]);
}
