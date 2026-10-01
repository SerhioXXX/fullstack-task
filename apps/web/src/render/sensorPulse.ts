import type { GatewayPool } from '../net/gatewayPool.ts';
import type { DeviceStore } from '../store/deviceStore.ts';
import { CanvasSurface } from './canvasSurface.ts';
import type { FrameLoop } from './frameLoop.ts';

const FLASH_MS = 900;
/** Sensor values mapped onto the green -> amber -> red scale. */
const LOW = 20;
const HIGH = 100;

/**
 * Pulsing live indicator for the selected device: beat rate and colour follow the sensor value,
 * an alert sends out a red shock wave. A silent device stops beating instead of pretending.
 */
export class SensorPulse {
  private readonly surface: CanvasSurface;
  private readonly unsubscribe: () => void;
  private phase = 0;

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
    if (!view?.state) return;

    const cx = width / 2;
    const cy = height / 2;
    const base = Math.min(width, height) * 0.22;
    const status = this.store.statusOf(view, now, this.pool.isOpen);
    const value = view.state.payload.sensor;
    const norm = Math.min(1, Math.max(0, (value - LOW) / (HIGH - LOW)));
    const live = status === 'online';

    if (live) this.phase += (dt / 1000) * (0.6 + norm * 2.4);
    const beat = live ? Math.max(0, Math.sin(this.phase * Math.PI * 2)) ** 3 : 0;
    const color = live ? heat(norm) : '#8a95a3';
    const r = base * (1 + 0.22 * beat);

    if (view.lastAlertAt !== null) {
      const t = (now - view.lastAlertAt) / FLASH_MS;
      if (t < 1) {
        for (const lag of [0, 0.25]) {
          const tt = t - lag;
          if (tt <= 0) continue;
          ctx.strokeStyle = `rgba(255, 107, 107, ${(1 - tt) * 0.9})`;
          ctx.lineWidth = 3 * (1 - tt) + 1;
          ctx.beginPath();
          ctx.arc(cx, cy, base + tt * base * 1.6, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    if (live) {
      const halo = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 2);
      halo.addColorStop(0, withAlpha(color, 0.35 + 0.3 * beat));
      halo.addColorStop(1, withAlpha(color, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 2, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    if (status === 'online' || status === 'stale') {
      ctx.fillStyle = withAlpha(color, status === 'stale' ? 0.35 : 0.9);
      ctx.fill();
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    if (status === 'unknown' || status === 'stale') ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = live ? '#0f1216' : '#8a95a3';
    ctx.font = '600 13px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(status === 'online' || status === 'stale' ? value.toFixed(1) : status, cx, cy);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  };
}

function heat(t: number): string {
  // green (#06d6a0) -> amber (#ffd166) -> red (#ff6b6b)
  const stops: Array<[number, number, number]> = [
    [6, 214, 160],
    [255, 209, 102],
    [255, 107, 107],
  ];
  const seg = t < 0.5 ? 0 : 1;
  const local = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
  const a = stops[seg]!;
  const b = stops[seg + 1]!;
  const c = a.map((v, i) => Math.round(v + (b[i]! - v) * local));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

function withAlpha(color: string, alpha: number): string {
  if (color.startsWith('rgb(')) return color.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`);
  const n = parseInt(color.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
