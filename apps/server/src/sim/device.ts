import { randomUUID } from 'node:crypto';
import { WORLD_SIZE, type DeviceMessage, type EventPayload, type StatePayload } from '@app/shared';
import { exponential, uniform, type Rng } from '../util/random.ts';

export interface DeviceSpec {
  deviceId: string;
  start: { x: number; y: number };
  /** Normal emit interval; 100-200 ms gives 5-10 messages/s. */
  intervalMs: number;
  /** Constant skew of this device's clock; survives reboots (hardware RTC). */
  clockOffsetMs: number;
  sensorBase: number;
}

export interface DeviceTimings {
  offlineEveryMs: number;
  offlineMinMs: number;
  offlineMaxMs: number;
  rebootEveryMs: number;
  rebootPauseMinMs: number;
  rebootPauseMaxMs: number;
  spikeEveryMs: number;
}

export const DEFAULT_TIMINGS: DeviceTimings = {
  offlineEveryMs: 70_000,
  offlineMinMs: 5_000,
  offlineMaxMs: 20_000,
  rebootEveryMs: 150_000,
  rebootPauseMinMs: 1_000,
  rebootPauseMaxMs: 2_500,
  spikeEveryMs: 25_000,
};

export function scaleTimings(t: DeviceTimings, scale: number): DeviceTimings {
  return {
    ...t,
    offlineEveryMs: t.offlineEveryMs * scale,
    rebootEveryMs: t.rebootEveryMs * scale,
    spikeEveryMs: t.spikeEveryMs * scale,
  };
}

export type DeviceLifecycle = 'online' | 'offline' | 'rebooting';

export interface DeviceHooks {
  emit(msg: DeviceMessage): void;
  lifecycle?(deviceId: string, state: DeviceLifecycle, detail: string): void;
}

export interface DeviceInfo {
  deviceId: string;
  lifecycle: DeviceLifecycle;
  bootId: string;
  seq: number;
  battery: number;
  clockOffsetMs: number;
}

/** Messages per second per device in stress mode: 8 devices -> ~1000 msg/s, still >= 500 with a few offline. */
export const STRESS_RATE_PER_DEVICE = 125;
const STRESS_TICK_MS = 10;
const MAX_BURST = 50;
const LOW_BATTERY_THRESHOLD = 20;

export class SimDevice {
  private bootId = randomUUID();
  private seq = 0;
  private lifecycle: DeviceLifecycle = 'online';

  private x: number;
  private y: number;
  private heading: number;
  private readonly speed: number;
  private readonly drainPerSec: number;
  private battery: number;
  private lowBatteryReported = false;
  private spike = 0;
  private readonly sensorPeriodMs: number;

  private lastTickAt = 0;
  private emitBudget = 0;
  private resumeAt = 0;
  private nextOfflineAt = 0;
  private nextRebootAt = 0;
  private nextSpikeAt = 0;
  private stress = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly spec: DeviceSpec,
    private readonly timings: DeviceTimings,
    private readonly hooks: DeviceHooks,
    private readonly rng: Rng = Math.random,
  ) {
    this.x = spec.start.x;
    this.y = spec.start.y;
    this.heading = rng() * Math.PI * 2;
    this.speed = uniform(rng, 20, 60);
    this.drainPerSec = uniform(rng, 0.08, 0.25);
    this.battery = uniform(rng, 50, 100);
    this.sensorPeriodMs = uniform(rng, 6_000, 14_000);
  }

  get deviceId(): string {
    return this.spec.deviceId;
  }

  info(): DeviceInfo {
    return {
      deviceId: this.spec.deviceId,
      lifecycle: this.lifecycle,
      bootId: this.bootId,
      seq: this.seq,
      battery: Math.round(this.battery * 10) / 10,
      clockOffsetMs: this.spec.clockOffsetMs,
    };
  }

  start(): void {
    const now = Date.now();
    this.lastTickAt = now;
    this.nextOfflineAt = now + exponential(this.rng, this.timings.offlineEveryMs);
    this.nextRebootAt = now + exponential(this.rng, this.timings.rebootEveryMs);
    this.nextSpikeAt = now + exponential(this.rng, this.timings.spikeEveryMs);
    this.schedule(uniform(this.rng, 0, this.spec.intervalMs));
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  setStress(on: boolean): void {
    if (this.stress === on) return;
    this.stress = on;
    this.emitBudget = 0;
    this.stop();
    this.schedule(0);
  }

  forceOffline(durationMs: number): void {
    this.goOffline(Date.now(), durationMs);
  }

  forceReboot(): void {
    this.beginReboot(Date.now());
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(this.tick, delayMs);
  }

  private readonly tick = (): void => {
    const now = Date.now();
    const dt = now - this.lastTickAt;
    this.lastTickAt = now;

    this.advancePhysics(dt);
    this.advanceLifecycle(now);

    if (this.lifecycle === 'online') {
      this.maybeSpike(now);
      if (this.stress) {
        this.emitBudget += (dt * STRESS_RATE_PER_DEVICE) / 1000;
        const n = Math.min(MAX_BURST, Math.floor(this.emitBudget));
        this.emitBudget -= n;
        const spacing = n > 1 ? dt / n : 0;
        for (let i = 0; i < n; i++) this.emitState(now - (n - 1 - i) * spacing);
      } else {
        this.emitState(now);
      }
    }

    const interval = this.stress ? STRESS_TICK_MS : this.spec.intervalMs * uniform(this.rng, 0.85, 1.15);
    this.schedule(interval);
  };

  /** Keeps moving while offline, so a device that comes back appears somewhere else. */
  private advancePhysics(dtMs: number): void {
    const dt = Math.min(dtMs, 1000) / 1000;
    this.heading += (this.rng() - 0.5) * 1.5 * dt;
    this.x += Math.cos(this.heading) * this.speed * dt;
    this.y += Math.sin(this.heading) * this.speed * dt;
    if (this.x < 0 || this.x > WORLD_SIZE) {
      this.heading = Math.PI - this.heading;
      this.x = Math.min(WORLD_SIZE, Math.max(0, this.x));
    }
    if (this.y < 0 || this.y > WORLD_SIZE) {
      this.heading = -this.heading;
      this.y = Math.min(WORLD_SIZE, Math.max(0, this.y));
    }

    this.spike *= Math.exp(-dtMs / 1500);

    this.battery -= this.drainPerSec * (dtMs / 1000);
    if (this.battery <= 3) {
      this.battery = 100;
      this.lowBatteryReported = false;
      this.hooks.lifecycle?.(this.deviceId, this.lifecycle, 'battery swapped');
    }
  }

  private advanceLifecycle(now: number): void {
    if (this.lifecycle === 'offline' && now >= this.resumeAt) {
      this.lifecycle = 'online';
      this.nextOfflineAt = now + exponential(this.rng, this.timings.offlineEveryMs);
      this.nextSpikeAt = now + exponential(this.rng, this.timings.spikeEveryMs);
      this.hooks.lifecycle?.(this.deviceId, 'online', `back online, continues seq ${this.seq}`);
      return;
    }
    if (this.lifecycle === 'rebooting' && now >= this.resumeAt) {
      this.bootId = randomUUID();
      this.seq = 0;
      this.lifecycle = 'online';
      this.lowBatteryReported = false;
      this.nextRebootAt = now + exponential(this.rng, this.timings.rebootEveryMs);
      this.nextSpikeAt = now + exponential(this.rng, this.timings.spikeEveryMs);
      this.hooks.lifecycle?.(this.deviceId, 'online', `booted ${this.bootId.slice(0, 8)}, seq reset to 0`);
      this.emitEvent(now, { kind: 'rebooted', severity: 'info', message: 'Device rebooted' });
      return;
    }
    if (this.lifecycle !== 'online') return;

    if (now >= this.nextRebootAt) {
      this.beginReboot(now);
    } else if (now >= this.nextOfflineAt) {
      this.goOffline(now, uniform(this.rng, this.timings.offlineMinMs, this.timings.offlineMaxMs));
    }
  }

  private goOffline(now: number, durationMs: number): void {
    if (this.lifecycle !== 'online') return;
    this.lifecycle = 'offline';
    this.resumeAt = now + durationMs;
    this.hooks.lifecycle?.(this.deviceId, 'offline', `silent for ${Math.round(durationMs / 1000)} s`);
  }

  private beginReboot(now: number): void {
    if (this.lifecycle === 'rebooting') return;
    this.lifecycle = 'rebooting';
    this.resumeAt = now + uniform(this.rng, this.timings.rebootPauseMinMs, this.timings.rebootPauseMaxMs);
    this.hooks.lifecycle?.(this.deviceId, 'rebooting', `boot ${this.bootId.slice(0, 8)} ends at seq ${this.seq - 1}`);
  }

  private maybeSpike(now: number): void {
    if (now < this.nextSpikeAt) return;
    this.nextSpikeAt = now + exponential(this.rng, this.timings.spikeEveryMs);
    this.spike = uniform(this.rng, 25, 60);
    const value = Math.round(this.sensorValue(now) * 10) / 10;
    this.emitEvent(now, {
      kind: 'alert',
      severity: this.spike > 45 ? 'critical' : 'warning',
      message: 'Sensor spike',
      value,
    });
  }

  private sensorValue(now: number): number {
    const wave = 15 * Math.sin((2 * Math.PI * now) / this.sensorPeriodMs);
    const noise = (this.rng() - 0.5) * 4;
    return this.spec.sensorBase + wave + noise + this.spike;
  }

  private emitState(realTime: number): void {
    const payload: StatePayload = {
      x: Math.round(this.x * 10) / 10,
      y: Math.round(this.y * 10) / 10,
      sensor: Math.round(this.sensorValue(realTime) * 100) / 100,
      battery: Math.round(this.battery * 10) / 10,
    };
    this.hooks.emit({ type: 'state', ...this.header(realTime), payload });

    if (!this.lowBatteryReported && this.battery <= LOW_BATTERY_THRESHOLD) {
      this.lowBatteryReported = true;
      this.emitEvent(realTime, {
        kind: 'low_battery',
        severity: 'warning',
        message: 'Battery low',
        value: payload.battery,
      });
    }
  }

  private emitEvent(realTime: number, payload: EventPayload): void {
    this.hooks.emit({ type: 'event', ...this.header(realTime), payload });
  }

  private header(realTime: number) {
    return {
      deviceId: this.spec.deviceId,
      bootId: this.bootId,
      seq: this.seq++,
      ts: Math.round(realTime + this.spec.clockOffsetMs),
    };
  }
}
