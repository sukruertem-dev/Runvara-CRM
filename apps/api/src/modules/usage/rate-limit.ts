import type { Redis } from 'ioredis';

// Noisy-neighbour protection for the API (TEN-10, ADR-0014 §4): a token bucket per tenant and one per user,
// sized by the plan (requests per minute; a full bucket allows a burst of one minute's budget). Both are
// checked and charged in one Lua call, so concurrent API instances cannot overspend a bucket, and the same
// call counts the request for usage metering. Redis time is used, never the API host's clock.

const SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local function level(key, cap)
  local b = redis.call('HMGET', key, 'tokens', 'ts')
  local tokens = tonumber(b[1])
  local ts = tonumber(b[2])
  if tokens == nil then return cap end
  return math.min(cap, tokens + (now - ts) * cap / 60000)
end
local tcap = tonumber(ARGV[1])
local ucap = tonumber(ARGV[2])
local tl = level(KEYS[1], tcap)
local ul = level(KEYS[2], ucap)
if tl < 1 or ul < 1 then
  local need = math.max(tl < 1 and (1 - tl) * 60000 / tcap or 0, ul < 1 and (1 - ul) * 60000 / ucap or 0)
  return {0, math.ceil(need)}
end
redis.call('HSET', KEYS[1], 'tokens', tl - 1, 'ts', now)
redis.call('PEXPIRE', KEYS[1], 120000)
redis.call('HSET', KEYS[2], 'tokens', ul - 1, 'ts', now)
redis.call('PEXPIRE', KEYS[2], 120000)
redis.call('HINCRBY', KEYS[3], 'api_requests', 1)
redis.call('EXPIRE', KEYS[3], 259200)
redis.call('SADD', KEYS[4], ARGV[3])
return {1, 0}`;

export const usageKey = (tenantId: string, day: string): string => `usage:${tenantId}:${day}`;
export const USAGE_PENDING = 'usage:pending';
export const today = (d = new Date()): string => d.toISOString().slice(0, 10);

export class TenantRateLimiter {
  constructor(private readonly redis: Redis) {}

  /** Charges one request; `retryAfterMs` > 0 when either bucket is empty (nothing is charged then). */
  async take(tenantId: string, userId: string, tenantRpm: number, userRpm: number): Promise<{ allowed: boolean; retryAfterMs: number }> {
    const day = today();
    const r = (await this.redis.eval(
      SCRIPT, 4,
      `rl:tenant:${tenantId}`, `rl:user:${tenantId}:${userId}`, usageKey(tenantId, day), USAGE_PENDING,
      Math.max(1, tenantRpm), Math.max(1, userRpm), `${tenantId}|${day}`,
    )) as [number, number];
    return { allowed: r[0] === 1, retryAfterMs: r[1] };
  }
}
