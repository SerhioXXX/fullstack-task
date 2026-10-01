/** Counts events and reports the rate over the last completed one-second window. */
export class RateMeter {
  private windowStart = Date.now();
  private count = 0;
  private lastRate = 0;
  total = 0;

  add(n = 1): void {
    this.roll();
    this.count += n;
    this.total += n;
  }

  get perSecond(): number {
    this.roll();
    return this.lastRate;
  }

  private roll(): void {
    const now = Date.now();
    const elapsed = now - this.windowStart;
    if (elapsed < 1000) return;
    this.lastRate = elapsed < 2000 ? Math.round((this.count * 1000) / elapsed) : 0;
    this.count = 0;
    this.windowStart = now;
  }
}
