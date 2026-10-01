import type { IncomingMessage } from 'node:http';
import type { WebSocket, WebSocketServer } from 'ws';
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type DeviceMessage,
  type DeviceSnapshot,
  type GatewayConfigInfo,
  type ResumeRequest,
  type SnapshotMessage,
} from '@app/shared';
import type { DeviceStore, PresenceChange } from '../hub/deviceStore.ts';
import { log } from '../util/log.ts';
import { ClientSession, type SessionLimits, type Subscription } from './session.ts';

export interface ClientHubOptions extends SessionLimits {
  gatewayId: string;
  /** Detects half-open TCP connections whose close frame never arrives. */
  pingIntervalMs: number;
  defaultMaxHz: number | null;
  replayMaxMessages: number;
  replayEventLookbackMs: number;
  configInfo: () => GatewayConfigInfo;
  gatewayStats: () => { stress: boolean; receivedPerSec: number; heapUsedMb: number };
  onStress: (enabled: boolean) => void;
}

/** Finer than any useful maxHz, so a 60 Hz subscription really gets ~60 updates per second. */
const TICK_MS = 10;
const STATS_INTERVAL_MS = 1000;
const MAX_HZ_LIMIT = 1000;

export class ClientHub {
  private readonly sessions = new Map<number, ClientSession>();
  private nextId = 1;
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    wss: WebSocketServer,
    private readonly store: DeviceStore,
    private readonly options: ClientHubOptions,
  ) {
    wss.on('connection', (ws, req) => this.accept(ws, req));
    this.timers.push(setInterval(() => this.tickAll(), TICK_MS));
    this.timers.push(setInterval(() => this.broadcastStats(), STATS_INTERVAL_MS));
    this.timers.push(setInterval(() => this.pingAll(), options.pingIntervalMs));
  }

  get clientCount(): number {
    return this.sessions.size;
  }

  /** Live stream: forwarded as received (duplicates and late messages included, D2), throttled per session (D3). */
  forward(msg: DeviceMessage): void {
    for (const s of this.sessions.values()) s.offer(msg);
  }

  presence(change: PresenceChange): void {
    for (const s of this.sessions.values()) s.offerPresence({ t: 'presence', ...change });
  }

  /** Closes every client socket. `terminate` drops TCP without a close frame (simulates a dead link). */
  dropAll(mode: 'close' | 'terminate'): number {
    const count = this.sessions.size;
    for (const s of this.sessions.values()) {
      if (mode === 'terminate') s.ws.terminate();
      else s.ws.close(4000, 'debug-drop');
    }
    log('hub', `dropped ${count} client(s) (${mode})`);
    return count;
  }

  broadcastStats(): void {
    const g = this.options.gatewayStats();
    for (const s of this.sessions.values()) {
      // A stuck client would only pile them up in its socket buffer.
      if (s.ws.bufferedAmount > this.options.backpressureBytes) continue;
      s.send({
        t: 'stats',
        stress: g.stress,
        gatewayReceivedPerSec: g.receivedPerSec,
        sentPerSec: s.sent.perSecond,
        coalesced: s.coalesced,
        backpressureSkips: s.backpressureSkips,
        resyncs: s.resyncs,
        queueDepth: s.queueDepth,
        bufferedAmount: s.ws.bufferedAmount,
        heapUsedMb: g.heapUsedMb,
      });
    }
  }

  stats() {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      remote: s.remote,
      connectedForMs: Date.now() - s.connectedAt,
      devices: s.subscription.devices === '*' ? '*' : [...s.subscription.devices],
      maxHz: s.subscription.maxHz,
      perDevice: Object.fromEntries(s.subscription.perDevice),
      queueDepth: s.queueDepth,
      slotsFilled: s.slotsFilled,
      bufferedAmount: s.ws.bufferedAmount,
      sentPerSec: s.sent.perSecond,
      sentTotal: s.sent.total,
      coalesced: s.coalesced,
      backpressureSkips: s.backpressureSkips,
      resyncs: s.resyncs,
      awaitingResume: s.awaitingResume,
    }));
  }

  close(): void {
    for (const t of this.timers) clearInterval(t);
  }

  private accept(ws: WebSocket, req: IncomingMessage): void {
    const session = new ClientSession(
      this.nextId++,
      ws,
      req.socket.remoteAddress ?? '?',
      this.options.defaultMaxHz,
      this.options,
    );
    const now = Date.now();

    // Nothing live is sent until the client's `resume`, which gets a snapshot or replay per device.
    session.send({
      t: 'hello',
      serverId: this.options.gatewayId,
      serverTime: now,
      protocol: PROTOCOL_VERSION,
      config: this.options.configInfo(),
    });
    this.sessions.set(session.id, session);
    log('hub', `client #${session.id} connected from ${session.remote} (${this.sessions.size} total)`);

    ws.on('pong', () => {
      session.alive = true;
    });
    ws.on('message', (data) => this.onClientMessage(session, data.toString()));
    ws.on('close', (code) => {
      this.sessions.delete(session.id);
      log('hub', `client #${session.id} disconnected (code ${code}, ${this.sessions.size} left)`);
    });
    ws.on('error', (err) => log('hub', `client #${session.id} error: ${err.message}`));
  }

  private snapshotFor(
    session: ClientSession,
    reason: SnapshotMessage['reason'],
    now: number,
    only?: ReadonlySet<string>,
  ): SnapshotMessage {
    const include = (id: string) => session.wants(id) && (!only || only.has(id));
    return { t: 'snapshot', reason, devices: this.store.snapshot(now, include) };
  }

  private onClientMessage(session: ClientSession, raw: string): void {
    const msg = parseClientMessage(raw);
    if (!msg) {
      log('hub', `client #${session.id} sent an invalid message, ignored: ${raw.slice(0, 120)}`);
      return;
    }
    const now = Date.now();
    switch (msg.t) {
      case 'subscribe': {
        const added = session.setSubscription(toSubscription(msg), this.store.deviceIds());
        if (added.length > 0) session.send(this.snapshotFor(session, 'subscribe', now, new Set(added)));
        break;
      }
      case 'control':
        if (msg.stress !== undefined) this.options.onStress(msg.stress);
        break;
      case 'resume':
        this.resume(session, msg.cursors, now);
        break;
    }
  }

  /**
   * Decided per device (D4), so one rebooted device does not force a snapshot of all.
   * Answered and unblocked in the same tick, so no live message falls between the answer and the stream.
   */
  private resume(session: ClientSession, cursors: ResumeRequest['cursors'], now: number): void {
    const snapshots: DeviceSnapshot[] = [];
    let replays = 0;
    let incomplete = 0;
    for (const deviceId of this.store.deviceIds().sort()) {
      if (!session.wants(deviceId)) continue;
      const plan = this.store.resume(deviceId, cursors[deviceId], now, {
        includeStates: session.hzFor(deviceId) === null || session.subscription.perDevice.has(deviceId),
        maxMessages: this.options.replayMaxMessages,
        eventLookbackMs: this.options.replayEventLookbackMs,
      });
      if (!plan) continue;
      if (plan.kind === 'replay') {
        session.send(plan.replay);
        replays++;
      } else {
        snapshots.push(plan.snapshot);
        if (plan.snapshot.eventsIncomplete) incomplete++;
      }
    }
    const isNew = Object.keys(cursors).length === 0;
    session.send({ t: 'snapshot', reason: isNew ? 'initial' : 'resync', devices: snapshots });
    session.awaitingResume = false;
    log(
      'hub',
      `client #${session.id} resume: ${replays} replay, ${snapshots.length} snapshot` +
        (incomplete > 0 ? ` (${incomplete} with events possibly missing)` : ''),
    );
  }

  private tickAll(): void {
    const now = Date.now();
    for (const s of this.sessions.values()) s.tick(now);
  }

  private pingAll(): void {
    for (const s of this.sessions.values()) {
      if (!s.alive) {
        log('hub', `client #${s.id} missed a pong, terminating`);
        s.ws.terminate();
        continue;
      }
      s.alive = false;
      s.ws.ping();
    }
  }
}

function toSubscription(msg: Extract<ClientMessage, { t: 'subscribe' }>): Subscription {
  return {
    devices: msg.devices === '*' ? '*' : new Set(msg.devices),
    maxHz: msg.maxHz,
    perDevice: new Map(Object.entries(msg.perDevice ?? {})),
  };
}

function isHz(v: unknown): v is number | null {
  return v === null || (typeof v === 'number' && v > 0 && v <= MAX_HZ_LIMIT);
}

/** Client input is untrusted: anything not matching the protocol is rejected as a whole. */
function parseClientMessage(raw: string): ClientMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof m !== 'object' || m === null) return null;
  const o = m as Record<string, unknown>;
  switch (o.t) {
    case 'subscribe': {
      const devicesOk =
        o.devices === '*' || (Array.isArray(o.devices) && o.devices.every((d) => typeof d === 'string'));
      const perDevice = o.perDevice;
      const perDeviceOk =
        perDevice === undefined ||
        (typeof perDevice === 'object' && perDevice !== null && Object.values(perDevice).every(isHz));
      return devicesOk && isHz(o.maxHz) && perDeviceOk ? (o as unknown as ClientMessage) : null;
    }
    case 'control':
      return o.stress === undefined || typeof o.stress === 'boolean' ? (o as unknown as ClientMessage) : null;
    case 'resume': {
      const cursors = o.cursors;
      const ok =
        typeof cursors === 'object' &&
        cursors !== null &&
        Object.values(cursors).every(
          (c: unknown) =>
            typeof c === 'object' &&
            c !== null &&
            typeof (c as Record<string, unknown>).bootId === 'string' &&
            Number.isInteger((c as Record<string, unknown>).seq),
        );
      return ok ? (o as unknown as ClientMessage) : null;
    }
    default:
      return null;
  }
}
