'use client';

import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { openStream, request } from './api';
import { invalidateForEvent } from './query';

/** One SSE message from GET /v1/stream (ADR-0007). Record events carry no field values, only names. */
export interface StreamEvent {
  id: string | null;
  type: string;
  resource?: { type: string; id: string } | null;
  changedFields?: string[];
  actor?: { type: string; id: string | null };
  notificationIds?: string[];
}

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline';

type Listener = (event: StreamEvent) => void;

interface RealtimeApi {
  state: ConnectionState;
  subscribe: (listener: Listener) => () => void;
  /** Bumped when the server asked for a full resync (missed events beyond the replay window). */
  resyncs: number;
}

const Ctx = createContext<RealtimeApi | null>(null);

/** Parses the text/event-stream body; yields complete events (blank-line separated). */
async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ id: string | null; event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let sep = buffer.search(/\r?\n\r?\n/);
    while (sep !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, '');
      let id: string | null = null;
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const val = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'id') id = val;
        else if (field === 'event') event = val;
        else if (field === 'data') data.push(val);
      }
      if (data.length > 0 || event !== 'message') yield { id, event, data: data.join('\n') };
      sep = buffer.search(/\r?\n\r?\n/);
    }
  }
}

/**
 * Keeps one stream per tab. Reconnects with Last-Event-ID and backoff; `resync.required` refetches everything.
 * Every event invalidates the queries it affects, so open lists and detail pages show other users' changes.
 */
export function RealtimeProvider({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const qc = useQueryClient();
  const [state, setState] = useState<ConnectionState>('connecting');
  const [resyncs, setResyncs] = useState(0);
  const listeners = useRef(new Set<Listener>());

  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    const stopped = (): boolean => abort.signal.aborted;
    const online = (): boolean => navigator.onLine;
    let lastId: string | null = null;
    let attempt = 0;
    let wakeOnline: (() => void) | null = null;

    const wait = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const timer = window.setTimeout(resolve, ms);
        wakeOnline = () => {
          window.clearTimeout(timer);
          resolve();
        };
      });

    const onOnline = (): void => {
      wakeOnline?.();
    };
    const onOffline = (): void => {
      setState('offline');
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    void (async () => {
      while (!stopped()) {
        if (!online()) {
          setState('offline');
          await wait(30_000);
          continue;
        }
        try {
          const res = await openStream('/v1/stream', lastId ? { 'last-event-id': lastId } : {}, abort.signal);
          if (!res.body) throw new Error('no stream body');
          if (attempt > 0) void qc.invalidateQueries();
          attempt = 0;
          setState('live');
          for await (const msg of readEvents(res.body)) {
            if (msg.id) lastId = msg.id;
            if (msg.event === 'resync.required') {
              lastId = null;
              setResyncs((n) => n + 1);
              void qc.invalidateQueries();
              continue;
            }
            let parsed: Partial<StreamEvent> = {};
            try {
              parsed = JSON.parse(msg.data) as Partial<StreamEvent>;
            } catch {
              continue;
            }
            const event: StreamEvent = { ...parsed, id: msg.id, type: msg.event };
            invalidateForEvent(qc, event);
            // One in ten notices is acknowledged: the latency people see (MEN-06).
            if (event.type === 'notification.created' && event.id && Math.random() < 0.1) {
              void request('/v1/stream/ack', { method: 'POST', body: { eventId: event.id } }).catch(() => undefined);
            }
            for (const l of listeners.current) l(event);
          }
        } catch {
          // Network error or a closed stream: reconnect below unless the provider unmounted.
        }
        if (stopped()) return;
        attempt += 1;
        setState(online() ? 'reconnecting' : 'offline');
        // 1 s, 2 s, 4 s … capped at 30 s, with jitter so reconnecting tabs spread out.
        await wait(Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5)) * (0.5 + Math.random() / 2));
      }
    })();

    return () => {
      abort.abort();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [enabled, qc]);

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);
  const api = useMemo<RealtimeApi>(() => ({ state, resyncs, subscribe }), [state, resyncs, subscribe]);
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useRealtime(): RealtimeApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useRealtime must be used inside <RealtimeProvider>');
  return ctx;
}

/** Calls `onEvent` for every stream event while mounted. */
export function useRealtimeEvent(onEvent: Listener): void {
  const { subscribe } = useRealtime();
  const ref = useRef(onEvent);
  ref.current = onEvent;
  useEffect(() => subscribe((e) => { ref.current(e); }), [subscribe]);
}
