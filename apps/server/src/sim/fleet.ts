import { RateMeter } from '../util/rate.ts';
import { SimDevice, type DeviceHooks, type DeviceInfo, type DeviceSpec, type DeviceTimings } from './device.ts';

const SPECS: DeviceSpec[] = [
  { deviceId: 'dev-1', start: { x: 150, y: 200 }, intervalMs: 100, clockOffsetMs: 2_300, sensorBase: 40 },
  { deviceId: 'dev-2', start: { x: 820, y: 180 }, intervalMs: 120, clockOffsetMs: -3_100, sensorBase: 55 },
  { deviceId: 'dev-3', start: { x: 500, y: 500 }, intervalMs: 140, clockOffsetMs: 4_700, sensorBase: 30 },
  { deviceId: 'dev-4', start: { x: 250, y: 780 }, intervalMs: 160, clockOffsetMs: -2_000, sensorBase: 62 },
  { deviceId: 'dev-5', start: { x: 700, y: 650 }, intervalMs: 180, clockOffsetMs: 3_600, sensorBase: 48 },
  { deviceId: 'dev-6', start: { x: 420, y: 120 }, intervalMs: 200, clockOffsetMs: -4_400, sensorBase: 35 },
  { deviceId: 'dev-7', start: { x: 900, y: 880 }, intervalMs: 110, clockOffsetMs: 2_800, sensorBase: 58 },
  { deviceId: 'dev-8', start: { x: 80, y: 520 }, intervalMs: 150, clockOffsetMs: -5_000, sensorBase: 44 },
];

export class Fleet {
  readonly devices: SimDevice[];
  readonly emitted = new RateMeter();
  private stress = false;

  constructor(count: number, timings: DeviceTimings, hooks: DeviceHooks) {
    const counted: DeviceHooks = {
      emit: (msg) => {
        this.emitted.add();
        hooks.emit(msg);
      },
      lifecycle: hooks.lifecycle,
    };
    this.devices = SPECS.slice(0, count).map((spec) => new SimDevice(spec, timings, counted));
  }

  get isStress(): boolean {
    return this.stress;
  }

  start(): void {
    for (const d of this.devices) d.start();
  }

  stop(): void {
    for (const d of this.devices) d.stop();
  }

  setStress(on: boolean): void {
    this.stress = on;
    for (const d of this.devices) d.setStress(on);
  }

  get(deviceId: string): SimDevice | undefined {
    return this.devices.find((d) => d.deviceId === deviceId);
  }

  info(): DeviceInfo[] {
    return this.devices.map((d) => d.info());
  }
}
