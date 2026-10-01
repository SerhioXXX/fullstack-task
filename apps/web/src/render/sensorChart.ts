import type { GatewayPool } from '../net/gatewayPool.ts';
import type { DeviceStore, DeviceView, DisplayStatus } from '../store/deviceStore.ts';
import { CanvasSurface, SEVERITY_COLORS } from './canvasSurface.ts';
import type { FrameLoop } from './frameLoop.ts';

const WINDOW_MS = 30_000;
const TICK_MS = 5_000;
const MIN_SPAN = 10;
const RANGE_TAU_MS = 300;
const PAD = { left: 34, right: 46, top: 10, bottom: 18 };

/**
 * Real-time sensor chart for the selected device. The time axis is the device's own clock
 * (one clock per device, so no offset compensation is needed), advanced between samples by
 * local elapsed time so the chart scrolls smoothly at display rate. Silence shows up as a
 * growing "no data" region instead of a line drawn across it.
 */
export class SensorChart {
  private readonly surface: CanvasSurface;
  private readonly unsubscribe: () => void;
  private lo = 0;
  private hi = 100;
  private rangeFor: string | null = null;
  /** Last anchor per device, so the axis freezes while the gateway connection is lost. */
  private readonly frozenAnchor = new Map<string, number>();

  constructor(
    canvas: HTMLCanvasElement,
    private readonly store: DeviceStore,
    private readonly pool: GatewayPool,
    loop: FrameLoop,
  ) {
    this.surface = new CanvasSurface(canvas);
    this.unsubscribe = loop.add(this.frame);
  }

  destroy(): void {
    this.unsubscribe();
    this.surface.destroy();
  }

  private readonly frame = (now: number, dt: number): void => {
    const { ctx, width, height } = this.surface;
    ctx.clearRect(0, 0, width, height);
    const view = this.store.selectedId ? this.store.devices.get(this.store.selectedId) : undefined;
    if (!view?.state) {
      ctx.fillStyle = '#8a95a3';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText('Select a device on the map', PAD.left, height / 2);
      return;
    }

    const connected = this.pool.isOpen;
    const status = this.store.statusOf(view, now, connected);
    const anchor = this.anchorFor(view, now, connected);
    const from = anchor - WINDOW_MS;

    this.updateRange(view, from, anchor, dt);
    const plot = {
      x0: PAD.left,
      x1: width - PAD.right,
      y0: PAD.top,
      y1: height - PAD.bottom,
    };
    const xOf = (ts: number) => plot.x0 + ((ts - from) / WINDOW_MS) * (plot.x1 - plot.x0);
    const yOf = (v: number) => plot.y1 - ((v - this.lo) / (this.hi - this.lo)) * (plot.y1 - plot.y0);

    this.drawAxes(plot, anchor, xOf, yOf);
    this.drawGap(view, plot, anchor, xOf, now);
    this.drawEvents(view, plot, from, xOf);
    this.drawLine(view, plot, from, status, xOf, yOf);
  };

  private anchorFor(view: DeviceView, now: number, connected: boolean): number {
    const id = view.deviceId;
    if (!connected && this.frozenAnchor.has(id)) return this.frozenAnchor.get(id)!;
    const anchor = view.state!.ts + Math.max(0, now - view.stateAt);
    this.frozenAnchor.set(id, anchor);
    return anchor;
  }

  /** Auto-scales to the visible window, eased so the axis doesn't jump on every spike. */
  private updateRange(view: DeviceView, from: number, to: number, dt: number): void {
    const s = view.sensor;
    let min = Infinity;
    let max = -Infinity;
    for (let i = s.firstIndexFrom(from); i < s.size; i++) {
      const v = s.valueAt(i);
      if (Number.isNaN(v) || s.tsAt(i) > to) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min === Infinity) return;
    const mid = (min + max) / 2;
    const span = Math.max(MIN_SPAN, (max - min) * 1.2);
    const targetLo = mid - span / 2;
    const targetHi = mid + span / 2;

    if (this.rangeFor !== view.deviceId) {
      this.rangeFor = view.deviceId;
      this.lo = targetLo;
      this.hi = targetHi;
      return;
    }
    const k = 1 - Math.exp(-dt / RANGE_TAU_MS);
    // Expanding is immediate so a spike is never clipped; shrinking is eased.
    this.lo = targetLo < this.lo ? targetLo : this.lo + (targetLo - this.lo) * k;
    this.hi = targetHi > this.hi ? targetHi : this.hi + (targetHi - this.hi) * k;
  }

  private drawAxes(
    plot: { x0: number; x1: number; y0: number; y1: number },
    anchor: number,
    xOf: (ts: number) => number,
    yOf: (v: number) => number,
  ): void {
    const ctx = this.surface.ctx;
    ctx.fillStyle = '#10151b';
    ctx.fillRect(plot.x0, plot.y0, plot.x1 - plot.x0, plot.y1 - plot.y0);
    ctx.font = '10px ui-monospace, Consolas, monospace';
    ctx.fillStyle = '#6b7684';
    ctx.strokeStyle = '#1e2630';
    ctx.lineWidth = 1;
    ctx.beginPath();

    const step = niceStep((this.hi - this.lo) / 4);
    for (let v = Math.ceil(this.lo / step) * step; v <= this.hi; v += step) {
      const y = Math.round(yOf(v)) + 0.5;
      ctx.moveTo(plot.x0, y);
      ctx.lineTo(plot.x1, y);
      ctx.fillText(v.toFixed(step < 1 ? 1 : 0).padStart(4), 2, y + 3);
    }
    for (let k = 0; k <= WINDOW_MS / TICK_MS; k++) {
      const x = Math.round(xOf(anchor - k * TICK_MS)) + 0.5;
      ctx.moveTo(x, plot.y0);
      ctx.lineTo(x, plot.y1);
      ctx.fillText(k === 0 ? 'now' : `-${(k * TICK_MS) / 1000}s`, x - 10, plot.y1 + 13);
    }
    ctx.stroke();
  }

  private drawGap(
    view: DeviceView,
    plot: { x0: number; x1: number; y0: number; y1: number },
    anchor: number,
    xOf: (ts: number) => number,
    now: number,
  ): void {
    const lastTs = view.state!.ts;
    const silentMs = anchor - lastTs;
    if (silentMs < this.store.staleAfterMs(view)) return;
    const ctx = this.surface.ctx;
    const x = Math.max(plot.x0, xOf(lastTs));
    const h = plot.y1 - plot.y0;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, plot.y0, plot.x1 - x, h);
    ctx.clip();
    ctx.fillStyle = 'rgba(138, 149, 163, 0.08)';
    ctx.fillRect(x, plot.y0, plot.x1 - x, h);
    ctx.strokeStyle = 'rgba(138, 149, 163, 0.15)';
    ctx.beginPath();
    // Hatching drifts slowly so a frozen chart (lost connection) is distinguishable from a live silence.
    const offset = this.pool.isOpen ? (now / 60) % 10 : 0;
    for (let hx = x - h + offset; hx < plot.x1; hx += 10) {
      ctx.moveTo(hx, plot.y1);
      ctx.lineTo(hx + h, plot.y0);
    }
    ctx.stroke();
    ctx.fillStyle = '#8a95a3';
    ctx.font = '11px system-ui, sans-serif';
    const label = `no data ${(silentMs / 1000).toFixed(silentMs < 10_000 ? 1 : 0)}s`;
    const w = ctx.measureText(label).width;
    if (plot.x1 - x > w + 8) ctx.fillText(label, plot.x1 - w - 6, plot.y0 + 14);
    ctx.restore();
  }

  private drawEvents(
    view: DeviceView,
    plot: { x0: number; x1: number; y0: number; y1: number },
    from: number,
    xOf: (ts: number) => number,
  ): void {
    const ctx = this.surface.ctx;
    ctx.save();
    ctx.font = '10px system-ui, sans-serif';
    let labelEnd = -Infinity;
    for (const entry of view.events) {
      if (entry.kind !== 'event') continue;
      const e = entry.msg;
      if (e.ts < from || entry.fromOldBoot) continue;
      const x = Math.round(xOf(e.ts)) + 0.5;
      if (x > plot.x1) continue;
      const color = SEVERITY_COLORS[e.payload.severity];
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.7;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, plot.y0 + 8);
      ctx.lineTo(x, plot.y1);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x - 4, plot.y0);
      ctx.lineTo(x + 4, plot.y0);
      ctx.lineTo(x, plot.y0 + 6);
      ctx.fill();
      const label = e.payload.kind === 'low_battery' ? 'battery' : e.payload.kind;
      if (x + 4 < labelEnd) continue;
      ctx.fillText(label, x + 4, plot.y0 + 16);
      labelEnd = x + 4 + ctx.measureText(label).width + 4;
    }
    ctx.restore();
  }

  /**
   * In stress mode the window can hold thousands of samples; when there are more samples than
   * pixel columns, each column is drawn as its min..max span instead of every point.
   */
  private drawLine(
    view: DeviceView,
    plot: { x0: number; x1: number; y0: number; y1: number },
    from: number,
    status: DisplayStatus,
    xOf: (ts: number) => number,
    yOf: (v: number) => number,
  ): void {
    const ctx = this.surface.ctx;
    const s = view.sensor;
    const start = Math.max(0, s.firstIndexFrom(from) - 1);
    const visible = s.size - start;
    const decimate = visible > (plot.x1 - plot.x0) * 1.5;
    const color = status === 'online' ? view.color : '#8a95a3';

    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x0, plot.y0, plot.x1 - plot.x0, plot.y1 - plot.y0);
    ctx.clip();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.75;
    ctx.lineJoin = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = status === 'online' ? 6 : 0;
    ctx.beginPath();

    let penDown = false;
    let col = -1;
    let colMin = 0;
    let colMax = 0;
    const flush = () => {
      if (col < 0) return;
      if (penDown) ctx.lineTo(col, yOf(colMin));
      else ctx.moveTo(col, yOf(colMin));
      ctx.lineTo(col, yOf(colMax));
      penDown = true;
      col = -1;
    };

    for (let i = start; i < s.size; i++) {
      const v = s.valueAt(i);
      if (Number.isNaN(v)) {
        flush();
        penDown = false;
        continue;
      }
      const x = xOf(s.tsAt(i));
      if (!decimate) {
        if (penDown) ctx.lineTo(x, yOf(v));
        else ctx.moveTo(x, yOf(v));
        penDown = true;
        continue;
      }
      const c = Math.round(x);
      if (c !== col) {
        flush();
        col = c;
        colMin = colMax = v;
      } else {
        if (v < colMin) colMin = v;
        if (v > colMax) colMax = v;
      }
    }
    flush();
    ctx.stroke();
    ctx.restore();

    const last = view.state!;
    const lx = xOf(last.ts);
    const ly = yOf(last.payload.sensor);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(Math.min(lx, plot.x1), ly, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '11px ui-monospace, Consolas, monospace';
    ctx.fillText(last.payload.sensor.toFixed(1), plot.x1 + 5, Math.max(plot.y0 + 8, Math.min(plot.y1, ly + 4)));
  }
}

function niceStep(raw: number): number {
  const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  const n = raw / pow;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * pow;
}
