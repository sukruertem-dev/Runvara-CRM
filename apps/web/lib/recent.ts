'use client';

/** "Recently viewed" for the command palette: kept per browser, per tenant; ids and titles only. */
export interface RecentItem {
  type: 'task';
  id: string;
  title: string;
  at: number;
}

const MAX = 8;
const key = (tenantId: string): string => `fx.recent.${tenantId}`;

export function readRecent(tenantId: string): RecentItem[] {
  try {
    const raw = window.localStorage.getItem(key(tenantId));
    const list = raw ? (JSON.parse(raw) as RecentItem[]) : [];
    return Array.isArray(list) ? list.filter((r) => typeof r.id === 'string' && typeof r.title === 'string').slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export function pushRecent(tenantId: string, item: Omit<RecentItem, 'at'>): void {
  try {
    const list = readRecent(tenantId).filter((r) => r.id !== item.id);
    window.localStorage.setItem(key(tenantId), JSON.stringify([{ ...item, at: Date.now() }, ...list].slice(0, MAX)));
  } catch {
    // Storage unavailable: the palette simply shows no recent items.
  }
}

export function forgetRecent(tenantId: string, id: string): void {
  try {
    window.localStorage.setItem(key(tenantId), JSON.stringify(readRecent(tenantId).filter((r) => r.id !== id)));
  } catch {
    // ignore
  }
}
