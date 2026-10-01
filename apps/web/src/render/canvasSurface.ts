/** A canvas kept at device-pixel resolution; drawing happens in CSS pixels. */
export class CanvasSurface {
  readonly ctx: CanvasRenderingContext2D;
  width = 0;
  height = 0;
  private readonly observer: ResizeObserver;

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas not supported');
    this.ctx = ctx;
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    this.resize();
  }

  destroy(): void {
    this.observer.disconnect();
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

export const SEVERITY_COLORS = {
  info: '#4cc9f0',
  warning: '#ffd166',
  critical: '#ff6b6b',
} as const;
