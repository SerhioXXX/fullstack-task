/**
 * Fixed-size ring of (device ts, value) samples for the sensor chart. Typed arrays keep it
 * allocation-free at hundreds of samples per second. A NaN value marks a break in the line.
 */
export class SampleRing {
  private readonly ts: Float64Array;
  private readonly values: Float32Array;
  private start = 0;
  private count = 0;

  constructor(readonly capacity = 8192) {
    this.ts = new Float64Array(capacity);
    this.values = new Float32Array(capacity);
  }

  get size(): number {
    return this.count;
  }

  push(ts: number, value: number): void {
    const i = (this.start + this.count) % this.capacity;
    this.ts[i] = ts;
    this.values[i] = value;
    if (this.count < this.capacity) this.count++;
    else this.start = (this.start + 1) % this.capacity;
  }

  /** Breaks the line, e.g. across an offline gap or a reboot. */
  pushBreak(ts: number): void {
    if (this.count > 0 && Number.isNaN(this.valueAt(this.count - 1))) return;
    this.push(ts, Number.NaN);
  }

  tsAt(i: number): number {
    return this.ts[(this.start + i) % this.capacity]!;
  }

  valueAt(i: number): number {
    return this.values[(this.start + i) % this.capacity]!;
  }

  /** Index of the first sample with ts >= `fromTs` (samples are appended in ts order). */
  firstIndexFrom(fromTs: number): number {
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.tsAt(mid) < fromTs) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  clear(): void {
    this.start = 0;
    this.count = 0;
  }
}
