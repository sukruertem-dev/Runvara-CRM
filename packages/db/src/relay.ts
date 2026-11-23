import pg from 'pg';

// Outbox relay (ADR-0006 §1). Runs as `flexa_relay` (BYPASSRLS, may only read and mark the outbox):
// claims unpublished rows with FOR UPDATE SKIP LOCKED, hands them to `publish` (the queue), and marks them
// published in the same transaction. If publishing fails, nothing is marked and the rows are retried; if the
// process dies after publishing but before commit, the queue de-duplicates by event id (jobId).

export interface OutboxRow {
  id: string;
  tenant_id: string;
  type: string;
  version: number;
  resource_type: string | null;
  resource_id: string | null;
  segment: 'b2b' | 'b2c' | null;
  actor: { type: string; id: string | null; ruleId?: string };
  payload: Record<string, unknown>;
  causation_id: string | null;
  correlation_id: string;
  depth: number;
  occurred_at: Date;
}

export interface Relay {
  /** Publishes up to `batch` events; returns how many were published. */
  relayOnce(publish: (rows: OutboxRow[]) => Promise<void>, batch?: number): Promise<number>;
  /** Calls `onWake` whenever a transaction that wrote events commits (LISTEN outbox). */
  listen(onWake: () => void): Promise<void>;
  close(): Promise<void>;
}

export function createRelay(connectionString: string): Relay {
  const pool = new pg.Pool({ connectionString, max: 2, application_name: 'flexa-relay' });
  // Dropped connections must not crash the worker (see createDb); the outbox keeps every event meanwhile.
  pool.on('error', () => undefined);
  let listener: pg.Client | null = null;
  return {
    async relayOnce(publish, batch = 500) {
      const client = await pool.connect();
      let broken: Error | undefined;
      const onError = (e: Error): void => { broken = e; };
      client.on('error', onError);
      try {
        await client.query('BEGIN');
        const r = await client.query<OutboxRow>(
          `SELECT id, tenant_id, type, version, resource_type, resource_id, segment, actor, payload, causation_id, correlation_id, depth, occurred_at
           FROM outbox_events WHERE published_at IS NULL ORDER BY occurred_at, id LIMIT $1 FOR UPDATE SKIP LOCKED`,
          [batch],
        );
        if (r.rows.length === 0) {
          await client.query('COMMIT');
          return 0;
        }
        try {
          await publish(r.rows);
        } catch (e) {
          await client.query('ROLLBACK');
          await client.query('UPDATE outbox_events SET attempts = attempts + 1 WHERE id = ANY($1)', [r.rows.map((x) => x.id)]).catch(() => undefined);
          throw e;
        }
        await client.query('UPDATE outbox_events SET published_at = now(), attempts = attempts + 1 WHERE id = ANY($1)', [r.rows.map((x) => x.id)]);
        await client.query('COMMIT');
        return r.rows.length;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        client.off('error', onError);
        client.release(broken);
      }
    },
    async listen(onWake) {
      listener = new pg.Client({ connectionString, application_name: 'flexa-relay-listen' });
      // A lost LISTEN connection only removes the wake-up; the loop's fallback poll keeps relaying.
      listener.on('error', () => { listener = null; });
      await listener.connect();
      listener.on('notification', () => { onWake(); });
      await listener.query('LISTEN outbox');
    },
    async close() {
      await listener?.end().catch(() => undefined);
      await pool.end();
    },
  };
}

/** The queue envelope of an outbox row (docs/events.md). */
export function toEnvelope(r: OutboxRow) {
  return {
    id: r.id,
    type: r.type,
    version: r.version,
    tenantId: r.tenant_id,
    occurredAt: new Date(r.occurred_at).toISOString(),
    actor: r.actor,
    resource: r.resource_type && r.resource_id ? { type: r.resource_type, id: r.resource_id, segment: r.segment } : null,
    causationId: r.causation_id,
    correlationId: r.correlation_id,
    depth: r.depth,
    payload: r.payload,
  };
}

/** Runs the relay until stopped: wakes on NOTIFY and polls every `pollMs` as a fallback; drains in batches.
 *  Errors are reported and retried on the next wake (rows stay unpublished, nothing is lost). */
export function startRelayLoop(relay: Relay, publish: (rows: OutboxRow[]) => Promise<void>, opts: { pollMs?: number; onError?: (e: unknown) => void } = {}): { stop(): Promise<void> } {
  // Mutable state shared between overlapping wake-ups (a wake during a drain schedules one more pass).
  const state = { stopped: false, running: false, again: false };
  const pass = async (): Promise<void> => {
    while (!state.stopped && (await relay.relayOnce(publish)) > 0) { /* keep draining */ }
  };
  const drain = async (): Promise<void> => {
    if (state.running) {
      state.again = true;
      return;
    }
    state.running = true;
    try {
      await pass();
      while (state.again && !state.stopped) {
        state.again = false;
        await pass();
      }
    } catch (e) {
      opts.onError?.(e);
    } finally {
      state.running = false;
    }
  };
  const timer = setInterval(() => { void drain(); }, opts.pollMs ?? 1000);
  void relay.listen(() => { void drain(); }).catch((e: unknown) => opts.onError?.(e));
  void drain();
  return {
    async stop() {
      state.stopped = true;
      clearInterval(timer);
      while (state.running) await new Promise((r) => setTimeout(r, 20));
    },
  };
}
