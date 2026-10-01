import {
  DeviceCursor,
  type DeviceMessage,
  type DeviceSnapshot,
  type EventMessage,
  type GatewayConfigInfo,
  type PresenceMessage,
  type PresenceStatus,
  type ReplayMessage,
  type ResumeCursor,
  type SnapshotMessage,
  type StateMessage,
  type StatsMessage,
  type SubscribeRequest,
  type Verdict,
} from '@app/shared';
import { Metrics } from './metrics.ts';
import { SampleRing } from './sampleRing.ts';

export type DisplayStatus = 'online' | 'stale' | 'offline' | 'unknown';

export interface TrailPoint {
  x: number;
  y: number;
}

interface FeedBase {
  /** Unique per client session, for React keys. */
  id: number;
  deviceId: string;
  /** Wall clock of arrival, for display only. */
  receivedWall: number;
  /** Position of the entry's boot for this device; orders entries by (boot, seq). */
  bootOrder: number;
}

export interface EventEntry extends FeedBase {
  kind: 'event';
  msg: EventMessage;
  /** Arrived after a newer message of the same device (D2: inserted at its place, flagged). */
  late: boolean;
  /** Came from the gateway's history inside a snapshot, not from the live stream. */
  historical: boolean;
  fromOldBoot: boolean;
}

/** The gateway could not cover a reconnect gap from its history: events after `afterSeq` may be lost. */
export interface MissingEntry extends FeedBase {
  kind: 'missing';
  afterSeq: number;
}

export type FeedEntry = EventEntry | MissingEntry;

export interface ResumeSummary {
  /** Still waiting for the gateway's answer to our resume. */
  pending: boolean;
  replayed: number;
  snapshots: number;
  incomplete: number;
  /** Events we did not have before, delivered by replays. */
  recoveredEvents: number;
}

export interface DeviceView {
  deviceId: string;
  color: string;
  cursor: DeviceCursor;
  /** Latest accepted state: the target the renderer moves towards. */
  state: StateMessage | null;
  /** performance.now() when `state` was accepted; anchors the chart's time axis between samples. */
  stateAt: number;
  /** Where the marker is drawn; eased towards `state` by the renderer. */
  render: { x: number; y: number } | null;
  /** Renderer must jump to the target instead of easing (after offline, reboot, resync). */
  snapNext: boolean;
  /** performance.now() of the moment the marker re-appeared, for the appear animation. */
  appearedAt: number | null;
  /** Recent positions; `null` marks a break (offline gap or reboot) that must not be bridged by a line. */
  trail: Array<TrailPoint | null>;
  /** Sensor history on the device's own clock. */
  sensor: SampleRing;
  /**
   * Presence per connected gateway that sees this device (T9.7). No entry = that gateway is down
   * or does not hear the device; no entries at all = no path, the status is unknown.
   */
  paths: Map<string, PresenceStatus>;
  /** Gateway that delivered the last accepted message (T9.5). */
  lastVia: string | null;
  /** Gateway each recent message was first accepted from, to tell cross-gateway duplicates apart. */
  acceptedVia: Map<string, string>;
  /** performance.now() of the last accepted *new* message (late events don't count). */
  lastAcceptedAt: number;
  /** Smoothed interval between accepted states; adapts to throttling and stress mode. */
  intervalEmaMs: number;
  bootCount: number;
  /** This device's events ordered by (boot, seq), oldest first. */
  events: FeedEntry[];
  /** performance.now() of the newest accepted alert, for the pulse flash. */
  lastAlertAt: number | null;
  /** Accepted states since the last frame (renderer resets it). */
  statesSinceFrame: number;
  bootOrders: Map<string, number>;
}

const PALETTE = ['#4cc9f0', '#f72585', '#ffd166', '#06d6a0', '#f8961e', '#b388ff', '#90be6d', '#ff6b6b'];
export const TRAIL_MAX = 60;
const DEVICE_EVENTS_MAX = 100;
const FEED_MAX = 300;
const STALE_MIN_MS = 1_500;
const DEFAULT_OFFLINE_AFTER_MS = 5_000;
/** Enough to cover the gap between two gateways' copies of a message (latency + chaos). */
const ACCEPTED_VIA_MAX = 512;
/** Rate requested for the device shown on the chart when its boost is on, unless maxHz is higher. */
export const SELECTED_BOOST_HZ = 30;

export interface ClientSubscription {
  /** State updates per second per device; null = no limit. */
  maxHz: number | null;
  /** Unsubscribed device ids; empty = all devices. */
  excluded: ReadonlySet<string>;
  /** Ask a higher rate for the selected device, so its chart stays detailed under a low maxHz. */
  boostSelected: boolean;
}

function colorFor(deviceId: string, fallbackIndex: number): string {
  const n = Number(/(\d+)$/.exec(deviceId)?.[1]);
  const index = Number.isFinite(n) && n > 0 ? n - 1 : fallbackIndex;
  return PALETTE[index % PALETTE.length]!;
}

/**
 * Client-side truth, kept outside React. Every message goes through DeviceCursor (D2);
 * the renderer reads this store every frame, React panels poll it at a few Hz.
 */
export class DeviceStore {
  readonly devices = new Map<string, DeviceView>();
  readonly metrics = new Metrics();
  /**
   * All devices' events, newest last, in arrival order. Device clocks differ, so there is no
   * trustworthy cross-device order; within one device the per-device list is authoritative.
   */
  readonly feed: FeedEntry[] = [];
  selectedId: string | null = null;
  serverConfig: GatewayConfigInfo | null = null;
  /** Latest `stats` per connected gateway. */
  readonly serverStats = new Map<string, StatsMessage>();
  /** Outcome of the latest resume per gateway (after a reconnect or a server-side resync). */
  readonly lastResume = new Map<string, ResumeSummary>();
  /** Null until the first hello, which supplies the gateway's default maxHz. */
  subscription: ClientSubscription | null = null;
  /** Called when what we should be subscribed to changes (settings or selection). */
  onSubscriptionChange: (() => void) | null = null;
  /** Bumped whenever the feed changes, so React can skip re-rendering it. */
  feedVersion = 0;
  private nextFeedId = 1;

  get offlineAfterMs(): number {
    return this.serverConfig?.offlineAfterMs ?? DEFAULT_OFFLINE_AFTER_MS;
  }

  setServerConfig(config: GatewayConfigInfo): void {
    this.serverConfig = config;
    this.subscription ??= { maxHz: config.defaultMaxHz, excluded: new Set(), boostSelected: true };
  }

  updateSubscription(patch: Partial<ClientSubscription>): void {
    if (!this.subscription) return;
    this.subscription = { ...this.subscription, ...patch };
    this.onSubscriptionChange?.();
  }

  select(deviceId: string): void {
    if (this.selectedId === deviceId) return;
    this.selectedId = deviceId;
    if (this.subscription?.boostSelected) this.onSubscriptionChange?.();
  }

  isSubscribed(deviceId: string): boolean {
    return !this.subscription?.excluded.has(deviceId);
  }

  /** The rate we asked the gateway for; the stale threshold must allow for it. */
  hzFor(deviceId: string): number | null {
    const sub = this.subscription;
    if (!sub) return this.serverConfig?.defaultMaxHz ?? null;
    if (sub.maxHz !== null && sub.boostSelected && deviceId === this.selectedId) {
      return Math.max(sub.maxHz, SELECTED_BOOST_HZ);
    }
    return sub.maxHz;
  }

  subscribeRequest(): SubscribeRequest | null {
    const sub = this.subscription;
    if (!sub) return null;
    const perDevice: Record<string, number | null> = {};
    if (this.selectedId !== null) {
      const hz = this.hzFor(this.selectedId);
      if (hz !== sub.maxHz) perDevice[this.selectedId] = hz;
    }
    const devices =
      sub.excluded.size === 0 ? '*' : [...this.devices.keys()].filter((id) => !sub.excluded.has(id));
    return { t: 'subscribe', devices, maxHz: sub.maxHz, perDevice };
  }

  /** Cursors for `resume`; marks this gateway's resume as in progress until its final snapshot arrives. */
  beginResume(gateway: string): Record<string, ResumeCursor> {
    const cursors: Record<string, ResumeCursor> = {};
    for (const view of this.devices.values()) {
      const cursor = view.cursor.toResumeCursor();
      if (cursor) cursors[view.deviceId] = cursor;
    }
    // Cursors come from the merged stream, so they are valid for any gateway (T9.6).
    this.lastResume.set(gateway, { pending: true, replayed: 0, snapshots: 0, incomplete: 0, recoveredEvents: 0 });
    return cursors;
  }

  /**
   * The gap was fully in the gateway's history: same path as live messages, so whatever we
   * already had is dropped as duplicate. Counted apart from live verdicts, so the diagnostics
   * keep describing the network, not our own lookback.
   */
  applyReplay(gateway: string, msg: ReplayMessage): void {
    const now = performance.now();
    const view = this.view(msg.deviceId);
    // No frame was drawn during the gap: the marker jumps; the chart line survives only if every state came.
    // A replay that brings nothing new (another gateway kept us current) must not break anything.
    if (msg.items.some((m) => m.type === 'state' && isAhead(view, m))) this.breakTrail(view, !msg.statesIncluded);
    let recovered = 0;
    for (const item of msg.items) {
      const verdict = this.applyMessage(gateway, item, now, true);
      if (verdict.accepted && item.type === 'event') recovered++;
    }
    view.paths.set(gateway, msg.status);
    view.lastAcceptedAt = Math.max(view.lastAcceptedAt, now - msg.lastSeenAgoMs);
    const resume = this.lastResume.get(gateway);
    if (resume) {
      resume.replayed++;
      resume.recoveredEvents += recovered;
    }
  }

  /**
   * Snapshot after (re)connect: we don't know what happened in between, so a device whose
   * snapshot is newer snaps to it with a trail break (D1). Liveness comes from the server's
   * clock-independent `lastSeenAgoMs`, not from how long *we* were disconnected.
   */
  applySnapshot(gateway: string, devices: DeviceSnapshot[], reason: SnapshotMessage['reason']): void {
    const now = performance.now();
    for (const snap of devices) {
      const view = this.view(snap.deviceId);
      const before = view.cursor.toResumeCursor();
      // This gateway's history may not cover our gap, but another gateway was delivering all along.
      if (snap.eventsIncomplete && before && !this.coveredByOther(view, gateway)) this.addMissing(view, before);
      const msg: StateMessage = {
        type: 'state',
        deviceId: snap.deviceId,
        bootId: snap.bootId,
        seq: snap.seq,
        ts: snap.ts,
        payload: snap.state,
      };
      const verdict = view.cursor.apply(msg);
      if (verdict.accepted) {
        this.breakTrail(view);
        if (verdict.newBoot) this.startNewBoot(view, msg.bootId);
        this.setState(view, msg, now - snap.lastSeenAgoMs);
      }
      for (const e of snap.recentEvents) this.applyEvent(view, e, view.cursor.apply(e), true);

      view.paths.set(gateway, snap.status);
      view.lastAcceptedAt = Math.max(view.lastAcceptedAt, now - snap.lastSeenAgoMs);
    }

    // Initial and resync snapshots are the gateway's last word on a resume; 'subscribe' ones are not.
    const resume = this.lastResume.get(gateway);
    if (reason !== 'subscribe' && resume?.pending) {
      resume.pending = false;
      resume.snapshots = devices.length;
      resume.incomplete = devices.filter((d) => d.eventsIncomplete).length;
    }
  }

  applyBatch(gateway: string, items: DeviceMessage[]): void {
    const now = performance.now();
    this.metrics.batches.add();
    this.metrics.messages.add(items.length);
    for (const msg of items) this.applyMessage(gateway, msg, now);
  }

  applyPresence(gateway: string, msg: PresenceMessage): void {
    const view = this.view(msg.deviceId);
    const wasOnline = hasOnlinePath(view);
    view.paths.set(gateway, msg.status);
    if (msg.status === 'offline') {
      // Only when no gateway hears it any more; one gateway losing it is not the device going silent.
      if (!hasOnlinePath(view)) {
        view.lastAcceptedAt = Math.min(view.lastAcceptedAt, performance.now() - msg.lastSeenAgoMs);
      }
    } else if (!wasOnline) {
      // The message that brought it back follows right after; it must not be eased in from the old spot.
      this.breakTrail(view);
    }
  }

  /** The gateway's connection is lost: devices only it could hear have no path left (T9.7). */
  dropGateway(gateway: string): void {
    for (const view of this.devices.values()) view.paths.delete(gateway);
    this.serverStats.delete(gateway);
  }

  /** Gateways currently hearing the device, for "via A+B" labels. */
  viaOf(view: DeviceView): string[] {
    const out: string[] = [];
    for (const [gateway, status] of view.paths) if (status === 'online') out.push(gateway);
    return out.sort();
  }

  /**
   * - unknown: no connected gateway hears the device, or we are not connected at all
   *   (must look different from a silent device)
   * - offline: every gateway that hears it says so, or a local fallback at 2x the threshold
   *   in case a presence was missed
   * - stale:   quieter than ~3 of its usual intervals
   */
  statusOf(view: DeviceView, now: number, connected: boolean): DisplayStatus {
    // Unsubscribed devices are not sent to us, so their silence means nothing.
    if (!connected || !this.isSubscribed(view.deviceId) || view.paths.size === 0) return 'unknown';
    const silentFor = now - view.lastAcceptedAt;
    if (!hasOnlinePath(view) || silentFor > this.offlineAfterMs * 2) return 'offline';
    return silentFor > this.staleAfterMs(view) ? 'stale' : 'online';
  }

  staleAfterMs(view: DeviceView): number {
    const hz = this.hzFor(view.deviceId);
    const throttledInterval = hz === null ? 0 : 1000 / hz;
    return Math.min(this.offlineAfterMs, Math.max(STALE_MIN_MS, view.intervalEmaMs * 3, throttledInterval * 3));
  }

  /** `replay`: part of a resume answer; liveness and intervals come from the replay itself, not from now. */
  private applyMessage(gateway: string, msg: DeviceMessage, now: number, replay = false): Verdict {
    const view = this.view(msg.deviceId);
    const verdict = view.cursor.apply(msg);
    const key = `${msg.bootId}:${msg.seq}`;
    if (!replay) {
      this.metrics.verdict(verdict);
      // Both gateways forward the same device message; the slower copy is a duplicate (T9.8).
      if (!verdict.accepted && verdict.reason === 'duplicate') {
        const first = view.acceptedVia.get(key);
        if (first !== undefined && first !== gateway) this.metrics.crossGatewayDuplicates++;
      }
    }
    if (!verdict.accepted) return verdict;

    view.lastVia = gateway;
    view.acceptedVia.set(key, gateway);
    if (view.acceptedVia.size > ACCEPTED_VIA_MAX) view.acceptedVia.delete(view.acceptedVia.keys().next().value!);

    // The first message of a new boot is usually its `rebooted` event, so this precedes the type switch.
    if (verdict.newBoot) this.startNewBoot(view, msg.bootId);

    if (msg.type === 'event') {
      this.applyEvent(view, msg, verdict);
      if (verdict.kind === 'latest' && !replay) this.touch(view, now, false, gateway);
      return verdict;
    }

    if (replay) {
      this.setState(view, msg, now);
      return verdict;
    }

    // Returning from a silence long enough to be offline: show the jump, don't animate across it (D1).
    if (!verdict.newBoot && now - view.lastAcceptedAt > this.offlineAfterMs) this.breakTrail(view);

    this.setState(view, msg, now);
    view.statesSinceFrame++;
    this.touch(view, now, true, gateway);
    return verdict;
  }

  private setState(view: DeviceView, msg: StateMessage, at: number): void {
    view.state = msg;
    view.stateAt = at;
    view.sensor.push(msg.ts, msg.payload.sensor);
  }

  private touch(view: DeviceView, now: number, isState: boolean, gateway: string): void {
    if (isState && view.lastAcceptedAt > 0) {
      const interval = now - view.lastAcceptedAt;
      if (interval < this.offlineAfterMs) view.intervalEmaMs += (interval - view.intervalEmaMs) * 0.1;
    }
    view.lastAcceptedAt = now;
    // A new message through this gateway proves it hears the device, even before its presence arrives.
    view.paths.set(gateway, 'online');
  }

  private coveredByOther(view: DeviceView, gateway: string): boolean {
    for (const [other, status] of view.paths) {
      if (other !== gateway && status === 'online' && this.lastResume.get(other)?.pending === false) return true;
    }
    return false;
  }

  /** The path of a previous boot says nothing about the new one, so its trail is dropped, not just broken. */
  private startNewBoot(view: DeviceView, bootId: string): void {
    view.bootCount++;
    view.trail.length = 0;
    view.snapNext = true;
    view.bootOrders.set(bootId, view.bootOrders.size === 0 ? 0 : Math.max(...view.bootOrders.values()) + 1);
    if (view.state) view.sensor.pushBreak(view.state.ts);
  }

  private applyEvent(view: DeviceView, msg: EventMessage, verdict: Verdict, historical = false): void {
    if (!verdict.accepted) return;
    const entry: EventEntry = {
      kind: 'event',
      id: this.nextFeedId++,
      deviceId: view.deviceId,
      msg,
      receivedWall: Date.now(),
      late: !historical && verdict.kind === 'late_event',
      historical,
      fromOldBoot: verdict.fromOldBoot,
      bootOrder: this.bootOrderOf(view, msg.bootId),
    };
    this.insertEntry(view, entry);
    if (msg.payload.kind === 'alert' && !entry.late && !historical) view.lastAlertAt = performance.now();
  }

  /** Placed right after the last message we had, so it reads "something may be lost here". */
  private addMissing(view: DeviceView, before: ResumeCursor): void {
    this.insertEntry(view, {
      kind: 'missing',
      id: this.nextFeedId++,
      deviceId: view.deviceId,
      receivedWall: Date.now(),
      afterSeq: before.seq,
      bootOrder: this.bootOrderOf(view, before.bootId),
    });
  }

  private insertEntry(view: DeviceView, entry: FeedEntry): void {
    // Per-device list in emission order: late events go to their place, not to the end.
    const list = view.events;
    let i = list.length;
    while (i > 0 && compareEntries(list[i - 1]!, entry) > 0) i--;
    list.splice(i, 0, entry);
    if (list.length > DEVICE_EVENTS_MAX) list.splice(0, list.length - DEVICE_EVENTS_MAX);

    this.feed.push(entry);
    if (this.feed.length > FEED_MAX) this.feed.splice(0, this.feed.length - FEED_MAX);
    this.feedVersion++;
  }

  private bootOrderOf(view: DeviceView, bootId: string): number {
    let order = view.bootOrders.get(bootId);
    if (order === undefined) {
      // Only reachable for late events of a boot we never saw as current: it is older than all known.
      order = view.bootOrders.size === 0 ? 0 : Math.min(...view.bootOrders.values()) - 1;
      view.bootOrders.set(bootId, order);
    }
    return order;
  }

  private breakTrail(view: DeviceView, breakChart = true): void {
    view.snapNext = true;
    if (view.trail.length > 0 && view.trail[view.trail.length - 1] !== null) view.trail.push(null);
    if (view.trail.length > TRAIL_MAX) view.trail.splice(0, view.trail.length - TRAIL_MAX);
    if (breakChart && view.state) view.sensor.pushBreak(view.state.ts);
  }

  private view(deviceId: string): DeviceView {
    let view = this.devices.get(deviceId);
    if (!view) {
      view = {
        deviceId,
        color: colorFor(deviceId, this.devices.size),
        cursor: new DeviceCursor(deviceId),
        state: null,
        stateAt: 0,
        render: null,
        snapNext: true,
        appearedAt: null,
        trail: [],
        sensor: new SampleRing(),
        paths: new Map(),
        lastVia: null,
        acceptedVia: new Map(),
        lastAcceptedAt: 0,
        intervalEmaMs: 150,
        bootCount: 0,
        events: [],
        lastAlertAt: null,
        statesSinceFrame: 0,
        bootOrders: new Map(),
      };
      this.devices.set(deviceId, view);
      // The richer sensor view needs a subject from the start.
      if (this.selectedId === null) this.select(deviceId);
    }
    return view;
  }
}

function hasOnlinePath(view: DeviceView): boolean {
  for (const status of view.paths.values()) if (status === 'online') return true;
  return false;
}

/** The state would move the device forward (vs. one we already have from another gateway). */
function isAhead(view: DeviceView, msg: StateMessage): boolean {
  return msg.bootId !== view.cursor.bootId || msg.seq > view.cursor.lastStateSeq;
}

function compareEntries(a: FeedEntry, b: FeedEntry): number {
  return a.bootOrder - b.bootOrder || seqOf(a) - seqOf(b);
}

function seqOf(e: FeedEntry): number {
  return e.kind === 'event' ? e.msg.seq : e.afterSeq + 0.5;
}
