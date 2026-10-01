import type { Metrics } from '../store/metrics.ts';

export type FrameCallback = (now: number, dtMs: number) => void;

/**
 * One requestAnimationFrame loop shared by every canvas, so the map, chart and pulse are drawn
 * in the same frame from the same store state, and fps / frame cost are measured in one place.
 */
export class FrameLoop {
  private readonly callbacks = new Set<FrameCallback>();
  private raf = 0;
  private lastAt = performance.now();

  constructor(private readonly metrics: Metrics) {
    this.raf = requestAnimationFrame(this.tick);
  }

  add(cb: FrameCallback): () => void {
    this.callbacks.add(cb);
    return () => this.callbacks.delete(cb);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }

  private readonly tick = (now: number): void => {
    this.raf = requestAnimationFrame(this.tick);
    const dt = Math.min(100, now - this.lastAt);
    this.lastAt = now;
    const started = performance.now();
    for (const cb of this.callbacks) cb(now, dt);
    this.metrics.frame(performance.now() - started);
  };
}
