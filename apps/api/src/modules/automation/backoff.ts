/** ADR-0006 §3: exponential backoff (2^n s) with full jitter, capped at 15 minutes (events and webhook deliveries). */
export function eventBackoff(attemptsMade: number): number {
  const ceiling = Math.min(2 ** attemptsMade * 1000, 15 * 60 * 1000);
  return Math.floor(Math.random() * ceiling);
}
