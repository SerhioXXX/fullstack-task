import { countVerdict, createCounters, type ReconcileCounters, type Verdict } from '@app/shared';

/** Counts over a sliding one-second window, cheap enough to call per message. */
export class RateCounter {
  private windowStart = performance.now();
  private count = 0;
  private rate = 0;
  total = 0;

  add(n = 1): void {
    this.roll();
    this.count += n;
    this.total += n;
  }

  get perSecond(): number {
    this.roll();
    return this.rate;
  }

  private roll(): void {
    const now = performance.now();
    const elapsed = now - this.windowStart;
    if (elapsed < 1000) return;
    this.rate = elapsed < 2000 ? Math.round((this.count * 1000) / elapsed) : 0;
    this.count = 0;
    this.windowStart = now;
  }
}

/** Client-side diagnostics, mutated in place; the overlay polls it. */
export class Metrics {
  readonly messages = new RateCounter();
  readonly batches = new RateCounter();
  readonly frames = new RateCounter();
  readonly reconcile: ReconcileCounters = createCounters();
  /** States accepted as latest but replaced by a newer one before any frame drew them. */
  coalesced = 0;
  /** Duplicates whose first copy came through a different gateway (part of reconcile.duplicate). */
  crossGatewayDuplicates = 0;
  /** Smoothed time spent drawing one frame, ms. */
  frameCostMs = 0;
  /** Largest frame cost in the current second, ms. */
  frameCostMaxMs = 0;
  private frameCostWindow = 0;
  private frameCostWindowStart = performance.now();

  verdict(v: Verdict): void {
    countVerdict(this.reconcile, v);
  }

  frame(costMs: number): void {
    this.frames.add();
    this.frameCostMs += (costMs - this.frameCostMs) * 0.05;
    this.frameCostWindow = Math.max(this.frameCostWindow, costMs);
    const now = performance.now();
    if (now - this.frameCostWindowStart >= 1000) {
      this.frameCostMaxMs = this.frameCostWindow;
      this.frameCostWindow = 0;
      this.frameCostWindowStart = now;
    }
  }
}
