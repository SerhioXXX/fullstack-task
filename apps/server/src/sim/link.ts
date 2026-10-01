import type { DeviceMessage } from '@app/shared';
import type { DeviceInfo } from './device.ts';

/**
 * Internal protocol between the separate simulator process and the gateways (npm run dev:mesh).
 * The link itself is lossless and ordered; each gateway applies its own latency and chaos after it,
 * like two radio receivers hearing the same devices.
 */
export const SIM_PATH = '/devices';

export interface SimStatus {
  stress: boolean;
  emittedPerSec: number;
  emittedTotal: number;
  devices: DeviceInfo[];
}

export type SimToGateway =
  | { t: 'msg'; m: DeviceMessage }
  /** On connect, on every stress change and once a second. */
  | ({ t: 'status' } & SimStatus)
  | { t: 'deviceResult'; reqId: number; info: DeviceInfo | null };

export type DeviceAction = 'offline' | 'reboot';

export type GatewayToSim =
  | { t: 'stress'; enabled: boolean }
  | { t: 'device'; reqId: number; deviceId: string; action: DeviceAction; durationMs?: number };
