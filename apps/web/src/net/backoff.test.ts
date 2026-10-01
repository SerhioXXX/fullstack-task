import { describe, expect, it } from 'vitest';
import { backoffDelay } from './backoff.ts';

const BASE = 500;
const CAP = 10_000;

describe('backoffDelay', () => {
  it('doubles the ceiling per attempt up to the cap', () => {
    const max = () => 1;
    expect([0, 1, 2, 3, 4, 5, 6].map((a) => backoffDelay(a, BASE, CAP, max))).toEqual([
      500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000,
    ]);
  });

  it('jitters over the whole range [0, ceiling] (full jitter)', () => {
    expect(backoffDelay(3, BASE, CAP, () => 0)).toBe(0);
    expect(backoffDelay(3, BASE, CAP, () => 0.5)).toBe(2_000);
  });

  it('stays within bounds for random draws and huge attempt numbers', () => {
    for (let attempt = 0; attempt < 2_000; attempt += 7) {
      const d = backoffDelay(attempt, BASE, CAP);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(Math.min(CAP, BASE * 2 ** attempt));
      expect(Number.isFinite(d)).toBe(true);
    }
  });
});
