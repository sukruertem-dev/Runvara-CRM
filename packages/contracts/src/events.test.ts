import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eventQueueFor, eventShard } from './events';

describe('event shards (ADR-0014 §4)', () => {
  it('puts a tenant on the same shard every time', () => {
    const id = randomUUID();
    expect(eventShard(id, 4)).toBe(eventShard(id, 4));
    expect(eventQueueFor(id, 4)).toMatch(/^events-[0-3]$/);
    expect(eventShard(id, 1)).toBe(0);
  });

  it('spreads tenants over the shards', () => {
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 4000; i += 1) {
      const shard = eventShard(randomUUID(), 4);
      counts[shard] = (counts[shard] ?? 0) + 1;
    }
    for (const c of counts) expect(c).toBeGreaterThan(800);
  });
});
