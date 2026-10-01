/**
 * Exponential backoff with "full jitter": uniform in [0, min(cap, base * 2^attempt)].
 * Spreads reconnects of many clients after a gateway restart instead of synchronising them.
 */
export function backoffDelay(attempt: number, baseMs: number, capMs: number, rng: () => number = Math.random): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.min(attempt, 30));
  return Math.round(rng() * ceiling);
}
