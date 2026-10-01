import { WebSocket } from 'ws';
import {
  HEARTBEAT_IDLE_MS,
  isNewer,
  type DeviceMessage,
  type PresenceMessage,
  type ServerMessage,
  type StateMessage,
} from '@app/shared';
import { RateMeter } from '../util/rate.ts';

export interface SessionLimits {
  batchIntervalMs: number;
  backpressureBytes: number;
  queueMax: number;
}

export interface Subscription {
  devices: ReadonlySet<string> | '*';
  maxHz: number | null;
  perDevice: ReadonlyMap<string, number | null>;
}

type Queued = { kind: 'device'; msg: DeviceMessage } | { kind: 'presence'; msg: PresenceMessage };

interface StateSlot {
  msg: StateMessage | null;
  nextDueAt: number;
}

/**
 * One client connection and its delivery policy (D3):
 * - states of a rate-limited device go to a one-message slot per device (latest wins by (boot, seq),
 *   not by arrival) and leave it at most maxHz times per second;
 * - events, presence and states of unlimited devices go to a bounded FIFO queue, never coalesced;
 * - while the socket buffer is above the threshold nothing is sent and every state coalesces in its slot,
 *   so memory is O(devices + queueMax) however slow the client is;
 * - a full queue is not trimmed silently: it is cleared and the client is told to `resync`.
 */
export class ClientSession {
  readonly connectedAt = Date.now();
  readonly sent = new RateMeter();
  alive = true;
  lastSentAt = Date.now();

  subscription: Subscription;
  coalesced = 0;
  backpressureSkips = 0;
  resyncs = 0;
  /**
   * Live messages are dropped until the client sends `resume`: right after connecting (its answer
   * is computed from the store at that moment) and after a queue overflow.
   */
  awaitingResume = true;

  private queue: Queued[] = [];
  private readonly slots = new Map<string, StateSlot>();
  private backpressured = false;
  private lastBatchAt = 0;

  constructor(
    readonly id: number,
    readonly ws: WebSocket,
    readonly remote: string,
    defaultMaxHz: number | null,
    private readonly limits: SessionLimits,
  ) {
    this.subscription = { devices: '*', maxHz: defaultMaxHz, perDevice: new Map() };
  }

  get queueDepth(): number {
    return this.queue.length;
  }

  get slotsFilled(): number {
    let n = 0;
    for (const slot of this.slots.values()) if (slot.msg) n++;
    return n;
  }

  wants(deviceId: string): boolean {
    return wantsIn(this.subscription, deviceId);
  }

  hzFor(deviceId: string): number | null {
    const override = this.subscription.perDevice.get(deviceId);
    return override === undefined ? this.subscription.maxHz : override;
  }

  send(msg: ServerMessage): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
    this.lastSentAt = Date.now();
  }

  offer(msg: DeviceMessage): void {
    if (this.awaitingResume || !this.wants(msg.deviceId)) return;
    if (msg.type === 'state' && (this.backpressured || this.hzFor(msg.deviceId) !== null)) {
      this.offerState(msg);
    } else {
      this.enqueue({ kind: 'device', msg });
    }
  }

  offerPresence(msg: PresenceMessage): void {
    if (this.awaitingResume || !this.wants(msg.deviceId)) return;
    this.enqueue({ kind: 'presence', msg });
  }

  /** Returns devices that became visible, so the caller can send them a snapshot. */
  setSubscription(next: Subscription, knownDevices: Iterable<string>): string[] {
    const added: string[] = [];
    for (const id of knownDevices) if (!this.wants(id) && wantsIn(next, id)) added.push(id);
    this.subscription = next;
    for (const id of this.slots.keys()) if (!this.wants(id)) this.slots.delete(id);
    this.queue = this.queue.filter((q) => this.wants(q.msg.deviceId));
    return added;
  }

  tick(now: number): void {
    this.backpressured = this.ws.bufferedAmount > this.limits.backpressureBytes;
    if (this.backpressured) {
      this.backpressureSkips++;
      return;
    }

    if (!this.awaitingResume) this.flush(now);
    if (now - this.lastSentAt >= HEARTBEAT_IDLE_MS) this.send({ t: 'heartbeat', serverTime: now });
  }

  private flush(now: number): void {
    const due: StateMessage[] = [];
    for (const [deviceId, slot] of this.slots) {
      if (!slot.msg || now < slot.nextDueAt) continue;
      due.push(slot.msg);
      slot.msg = null;
      // On a shared grid, so devices with the same rate leave in the same batch.
      const hz = this.hzFor(deviceId);
      slot.nextDueAt = hz === null ? 0 : (Math.floor((now * hz) / 1000) + 1) * (1000 / hz);
    }

    const queueDue = this.queue.length > 0 && now - this.lastBatchAt >= this.limits.batchIntervalMs;
    if (due.length === 0 && !queueDue) return;
    this.lastBatchAt = now;

    // Queue first: an event followed by a newer state is the order the device produced them in,
    // and a state never needs to precede an event to be accepted.
    let items: DeviceMessage[] = [];
    for (const q of this.queue) {
      if (q.kind === 'device') {
        items.push(q.msg);
      } else {
        this.sendBatch(items, now);
        items = [];
        this.send(q.msg);
      }
    }
    this.queue = [];
    for (const msg of due) items.push(msg);
    this.sendBatch(items, now);
  }

  private offerState(msg: StateMessage): void {
    let slot = this.slots.get(msg.deviceId);
    if (!slot) {
      slot = { msg: null, nextDueAt: 0 };
      this.slots.set(msg.deviceId, slot);
    }
    if (slot.msg) {
      this.coalesced++;
      if (!isNewer(msg, slot.msg)) return;
    }
    slot.msg = msg;
  }

  private enqueue(item: Queued): void {
    if (this.queue.length >= this.limits.queueMax) {
      this.requestResync();
      return;
    }
    this.queue.push(item);
  }

  private requestResync(): void {
    this.awaitingResume = true;
    this.queue = [];
    for (const slot of this.slots.values()) slot.msg = null;
    this.resyncs++;
    this.send({ t: 'resync' });
  }

  private sendBatch(items: DeviceMessage[], now: number): void {
    if (items.length === 0) return;
    this.send({ t: 'batch', serverTime: now, items });
    this.sent.add(items.length);
  }
}

function wantsIn(sub: Subscription, deviceId: string): boolean {
  return sub.devices === '*' || sub.devices.has(deviceId);
}
