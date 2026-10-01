import { WebSocket } from 'ws';
import type { DeviceMessage } from '@app/shared';
import { log } from '../util/log.ts';
import type { DeviceInfo } from './device.ts';
import type { Fleet } from './fleet.ts';
import type { DeviceAction, GatewayToSim, SimStatus, SimToGateway } from './link.ts';

/**
 * Where a gateway's device messages come from: the simulator in its own process (`npm run dev`)
 * or a separate simulator shared by several gateways (`npm run dev:mesh`).
 */
export interface DeviceSource {
  readonly isStress: boolean;
  setStress(enabled: boolean): void;
  /** Resolves to null for an unknown device. */
  deviceAction(deviceId: string, action: DeviceAction, durationMs?: number): Promise<DeviceInfo | null>;
  status(): SimStatus & { linked: boolean };
  start(): void;
}

export interface SourceHooks {
  emit(msg: DeviceMessage): void;
  /** Stress changed, also when another gateway switched it on the shared simulator. */
  stressChanged(enabled: boolean): void;
}

export class LocalSource implements DeviceSource {
  constructor(
    private readonly fleet: Fleet,
    private readonly hooks: Pick<SourceHooks, 'stressChanged'>,
  ) {}

  get isStress(): boolean {
    return this.fleet.isStress;
  }

  setStress(enabled: boolean): void {
    if (enabled === this.fleet.isStress) return;
    this.fleet.setStress(enabled);
    this.hooks.stressChanged(enabled);
  }

  async deviceAction(deviceId: string, action: DeviceAction, durationMs = 10_000): Promise<DeviceInfo | null> {
    const device = this.fleet.get(deviceId);
    if (!device) return null;
    if (action === 'offline') device.forceOffline(durationMs);
    else device.forceReboot();
    return device.info();
  }

  status(): SimStatus & { linked: boolean } {
    return {
      linked: true,
      stress: this.fleet.isStress,
      emittedPerSec: this.fleet.emitted.perSecond,
      emittedTotal: this.fleet.emitted.total,
      devices: this.fleet.info(),
    };
  }

  start(): void {
    this.fleet.start();
  }
}

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5_000;
const ACTION_TIMEOUT_MS = 3_000;

/** WebSocket client of the shared simulator; reconnects forever, devices go offline while it is down. */
export class RemoteSource implements DeviceSource {
  private ws: WebSocket | null = null;
  private last: SimStatus = { stress: false, emittedPerSec: 0, emittedTotal: 0, devices: [] };
  private linked = false;
  private retryMs = RECONNECT_MIN_MS;
  private nextReqId = 1;
  private readonly pending = new Map<number, (info: DeviceInfo | null) => void>();

  constructor(
    private readonly url: string,
    private readonly name: string,
    private readonly hooks: SourceHooks,
  ) {}

  get isStress(): boolean {
    return this.last.stress;
  }

  setStress(enabled: boolean): void {
    // The simulator answers with a status to every gateway, which is when stressChanged fires.
    this.send({ t: 'stress', enabled });
  }

  deviceAction(deviceId: string, action: DeviceAction, durationMs?: number): Promise<DeviceInfo | null> {
    const reqId = this.nextReqId++;
    if (!this.send({ t: 'device', reqId, deviceId, action, durationMs })) {
      return Promise.reject(new Error('simulator is not connected'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error('simulator did not answer'));
      }, ACTION_TIMEOUT_MS);
      this.pending.set(reqId, (info) => {
        clearTimeout(timer);
        resolve(info);
      });
    });
  }

  status(): SimStatus & { linked: boolean } {
    return { ...this.last, linked: this.linked };
  }

  start(): void {
    this.connect();
  }

  private connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on('open', () => {
      this.linked = true;
      this.retryMs = RECONNECT_MIN_MS;
      log(this.name, `linked to simulator ${this.url}`);
    });
    ws.on('message', (data) => this.onMessage(JSON.parse(data.toString()) as SimToGateway));
    ws.on('close', () => {
      if (this.linked) log(this.name, 'simulator link lost, reconnecting');
      this.linked = false;
      this.ws = null;
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(RECONNECT_MAX_MS, this.retryMs * 2);
    });
    // `close` follows every `error`; logging each refused attempt would flood the console.
    ws.on('error', () => {});
  }

  private onMessage(msg: SimToGateway): void {
    switch (msg.t) {
      case 'msg':
        this.hooks.emit(msg.m);
        break;
      case 'status': {
        const { t: _t, ...status } = msg;
        const changed = status.stress !== this.last.stress;
        this.last = status;
        if (changed) this.hooks.stressChanged(status.stress);
        break;
      }
      case 'deviceResult':
        this.pending.get(msg.reqId)?.(msg.info);
        this.pending.delete(msg.reqId);
        break;
    }
  }

  private send(msg: GatewayToSim): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }
}
