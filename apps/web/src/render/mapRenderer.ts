import { WORLD_SIZE } from '@app/shared';
import type { GatewayPool } from '../net/gatewayPool.ts';
import type { FrameLoop } from './frameLoop.ts';
import { TRAIL_MAX, type DeviceStore, type DeviceView, type DisplayStatus } from '../store/deviceStore.ts';

/** Time constant of the easing towards the latest position; ~one message interval. */
const EASE_TAU_MS = 120;
const APPEAR_MS = 600;
const MARKER_R = 7;
const HIT_R = 16;
const PAD = 24;

interface Viewport {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Draws the device map in a requestAnimationFrame loop. Frame rate follows the display, not
 * the message rate: however many states arrive between two frames, only the latest is drawn.
 */
export class MapRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly unsubscribe: () => void;
  private viewport: Viewport = { scale: 1, offsetX: 0, offsetY: 0 };
  private cssWidth = 0;
  private cssHeight = 0;
  private readonly resizeObserver: ResizeObserver;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly store: DeviceStore,
    private readonly pool: GatewayPool,
    loop: FrameLoop,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas not supported');
    this.ctx = ctx;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    canvas.addEventListener('click', this.onClick);
    this.unsubscribe = loop.add(this.frame);
  }

  destroy(): void {
    this.unsubscribe();
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('click', this.onClick);
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const side = Math.max(1, Math.min(rect.width, rect.height) - PAD * 2);
    this.viewport = {
      scale: side / WORLD_SIZE,
      offsetX: (rect.width - side) / 2,
      offsetY: (rect.height - side) / 2,
    };
  }

  private toScreen(x: number, y: number): [number, number] {
    const v = this.viewport;
    return [v.offsetX + x * v.scale, v.offsetY + y * v.scale];
  }

  private readonly frame = (now: number, dt: number): void => {
    const connected = this.pool.isOpen;
    for (const view of this.store.devices.values()) this.advance(view, dt, now);
    this.draw(now, connected);
  };

  private advance(view: DeviceView, dt: number, now: number): void {
    if (view.statesSinceFrame > 1) this.store.metrics.coalesced += view.statesSinceFrame - 1;
    view.statesSinceFrame = 0;

    const target = view.state?.payload;
    if (!target) return;

    if (view.render === null || view.snapNext) {
      if (view.render !== null) view.appearedAt = now;
      view.render = { x: target.x, y: target.y };
      view.snapNext = false;
      this.pushTrail(view);
      return;
    }

    // Easing only smooths between two real samples; it never extrapolates past the latest one.
    const k = 1 - Math.exp(-dt / EASE_TAU_MS);
    view.render.x += (target.x - view.render.x) * k;
    view.render.y += (target.y - view.render.y) * k;
    this.pushTrail(view);
  }

  private pushTrail(view: DeviceView): void {
    const r = view.render!;
    const last = view.trail[view.trail.length - 1];
    if (last && Math.hypot(last.x - r.x, last.y - r.y) < 4) return;
    view.trail.push({ x: r.x, y: r.y });
    if (view.trail.length > TRAIL_MAX) view.trail.splice(0, view.trail.length - TRAIL_MAX);
  }

  private draw(now: number, connected: boolean): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    this.drawGrid();

    ctx.save();
    if (!connected) ctx.globalAlpha = 0.35;
    for (const view of this.store.devices.values()) {
      if (!view.render) continue;
      const status = this.store.statusOf(view, now, connected);
      this.drawTrail(view, status);
    }
    for (const view of this.store.devices.values()) {
      if (!view.render) continue;
      const status = this.store.statusOf(view, now, connected);
      this.drawMarker(view, status, now);
    }
    ctx.restore();
  }

  private drawGrid(): void {
    const ctx = this.ctx;
    const [x0, y0] = this.toScreen(0, 0);
    const [x1, y1] = this.toScreen(WORLD_SIZE, WORLD_SIZE);
    ctx.fillStyle = '#12171d';
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = '#1e2630';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 10; i++) {
      const [gx] = this.toScreen((WORLD_SIZE / 10) * i, 0);
      const [, gy] = this.toScreen(0, (WORLD_SIZE / 10) * i);
      ctx.moveTo(gx + 0.5, y0);
      ctx.lineTo(gx + 0.5, y1);
      ctx.moveTo(x0, gy + 0.5);
      ctx.lineTo(x1, gy + 0.5);
    }
    ctx.stroke();
    ctx.strokeStyle = '#2c3845';
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
  }

  private drawTrail(view: DeviceView, status: DisplayStatus): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = status === 'offline' || status === 'unknown' ? '#5a6573' : view.color;
    ctx.globalAlpha *= status === 'online' ? 0.45 : 0.2;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let penDown = false;
    for (const p of view.trail) {
      if (p === null) {
        penDown = false;
        continue;
      }
      const [sx, sy] = this.toScreen(p.x, p.y);
      if (penDown) ctx.lineTo(sx, sy);
      else ctx.moveTo(sx, sy);
      penDown = true;
    }
    if (penDown && view.render) {
      const [sx, sy] = this.toScreen(view.render.x, view.render.y);
      ctx.lineTo(sx, sy);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawMarker(view: DeviceView, status: DisplayStatus, now: number): void {
    const ctx = this.ctx;
    const [x, y] = this.toScreen(view.render!.x, view.render!.y);
    const selected = this.store.selectedId === view.deviceId;
    const silentS = Math.max(0, (now - view.lastAcceptedAt) / 1000);

    if (view.appearedAt !== null) {
      const t = (now - view.appearedAt) / APPEAR_MS;
      if (t >= 1) view.appearedAt = null;
      else if (status === 'online' || status === 'stale') {
        ctx.save();
        ctx.strokeStyle = view.color;
        ctx.globalAlpha *= 1 - t;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, MARKER_R + t * 22, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    if (selected) {
      ctx.save();
      ctx.strokeStyle = '#ffffff';
      ctx.globalAlpha *= 0.8;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, MARKER_R + 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, MARKER_R, 0, Math.PI * 2);
    let label = view.deviceId;
    switch (status) {
      case 'online':
        ctx.fillStyle = view.color;
        ctx.fill();
        ctx.strokeStyle = '#0f1216';
        ctx.stroke();
        break;
      case 'stale':
        ctx.globalAlpha *= 0.55;
        ctx.fillStyle = view.color;
        ctx.fill();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = '#e6e6e6';
        ctx.stroke();
        label += ` · ${silentS.toFixed(1)}s ago`;
        break;
      case 'offline': {
        ctx.strokeStyle = '#8a95a3';
        ctx.stroke();
        const d = MARKER_R * 0.55;
        ctx.beginPath();
        ctx.moveTo(x - d, y - d);
        ctx.lineTo(x + d, y + d);
        ctx.moveTo(x + d, y - d);
        ctx.lineTo(x - d, y + d);
        ctx.stroke();
        label += ` · offline ${Math.round(silentS)}s`;
        break;
      }
      case 'unknown':
        ctx.strokeStyle = '#8a95a3';
        ctx.setLineDash([2, 3]);
        ctx.stroke();
        label += ' · ?';
        break;
    }
    ctx.restore();
    if (this.pool.isMulti && (status === 'online' || status === 'stale')) {
      label += ` · via ${this.store.viaOf(view).join('+')}`;
    }

    ctx.save();
    ctx.font = '11px ui-monospace, SFMono-Regular, Consolas, monospace';
    ctx.fillStyle = status === 'online' ? '#d8dee9' : '#8a95a3';
    const width = ctx.measureText(label).width;
    const fitsRight = x + MARKER_R + 5 + width <= this.cssWidth - 4;
    ctx.fillText(label, fitsRight ? x + MARKER_R + 5 : x - MARKER_R - 5 - width, y + 4);
    ctx.restore();
  }

  private readonly onClick = (event: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    let best: string | null = null;
    let bestDist = HIT_R;
    for (const view of this.store.devices.values()) {
      if (!view.render) continue;
      const [x, y] = this.toScreen(view.render.x, view.render.y);
      const d = Math.hypot(px - x, py - y);
      if (d < bestDist) {
        bestDist = d;
        best = view.deviceId;
      }
    }
    if (best) this.store.select(best);
  };
}
