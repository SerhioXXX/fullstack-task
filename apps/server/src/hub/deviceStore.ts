import {
  DeviceCursor,
  countVerdict,
  createCounters,
  type DeviceMessage,
  type DeviceSnapshot,
  type EventMessage,
  type PresenceStatus,
  type ReconcileCounters,
  type ReplayMessage,
  type ResumeCursor,
  type StateMessage,
  type Verdict,
} from '@app/shared';
import { DeviceHistory, type HistoryEntry, type HistoryLimits } from './history.ts';

export interface ResumeOptions {
  /** Send every state of the gap, not just the latest (the client charts this device or has no limit). */
  includeStates: boolean;
  maxMessages: number;
  eventLookbackMs: number;
}

export type ResumePlan = { kind: 'replay'; replay: ReplayMessage } | { kind: 'snapshot'; snapshot: DeviceSnapshot };

export interface DeviceStoreOptions {
  offlineAfterMs: number;
  history: HistoryLimits;
  snapshotRecentEvents: number;
}

export interface PresenceChange {
  deviceId: string;
  status: PresenceStatus;
  lastSeenAgoMs: number;
}

interface DeviceRecord {
  deviceId: string;
  cursor: DeviceCursor;
  history: DeviceHistory;
  historyBootId: string | null;
  latest: StateMessage | null;
  /** Gateway clock of the last message that advanced the device; liveness only, never ordering. */
  lastReceivedAt: number;
  status: PresenceStatus;
}

/**
 * Gateway-side truth per device: latest state by (bootId, seq), ordered history and presence.
 * The live stream to clients is forwarded untouched; this store only serves snapshots and replays.
 */
export class DeviceStore {
  private readonly devices = new Map<string, DeviceRecord>();
  readonly counters: ReconcileCounters = createCounters();

  constructor(
    private readonly options: DeviceStoreOptions,
    private readonly onPresence: (change: PresenceChange) => void,
  ) {}

  ingest(msg: DeviceMessage, now: number): Verdict {
    const record = this.record(msg.deviceId);
    const verdict = record.cursor.apply(msg);
    countVerdict(this.counters, verdict);
    if (!verdict.accepted) return verdict;

    if (record.cursor.bootId !== record.historyBootId) {
      record.historyBootId = record.cursor.bootId;
      record.history.startBoot(msg.bootId);
    }
    record.history.add(msg, now);

    // The cursor accepts a state only if it is newer than the current one.
    if (msg.type === 'state') record.latest = msg;

    // Late events are old news: they prove the device was alive earlier, not now.
    if (verdict.kind === 'latest') {
      record.lastReceivedAt = now;
      if (record.status === 'offline') {
        record.status = 'online';
        this.onPresence({ deviceId: record.deviceId, status: 'online', lastSeenAgoMs: 0 });
      }
    }
    return verdict;
  }

  /** Marks silent devices offline; call periodically. */
  checkPresence(now: number): void {
    for (const record of this.devices.values()) {
      if (record.status !== 'online') continue;
      const silentFor = now - record.lastReceivedAt;
      if (silentFor > this.options.offlineAfterMs) {
        record.status = 'offline';
        this.onPresence({ deviceId: record.deviceId, status: 'offline', lastSeenAgoMs: silentFor });
      }
    }
  }

  deviceIds(): string[] {
    return [...this.devices.keys()];
  }

  snapshot(now: number, include: (deviceId: string) => boolean = () => true): DeviceSnapshot[] {
    const out: DeviceSnapshot[] = [];
    for (const record of this.devices.values()) {
      const latest = record.latest;
      if (!latest || !include(record.deviceId)) continue;
      const events = record.history.recentEvents(latest.bootId, this.options.snapshotRecentEvents);
      out.push(this.snapshotOf(record, latest, now, events, false));
    }
    return out.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }

  /**
   * Per-device answer to a client's resume cursor (D4): replay when the whole gap is still in the
   * history and small enough, otherwise a snapshot that says whether events may be missing.
   */
  resume(deviceId: string, cursor: ResumeCursor | undefined, now: number, options: ResumeOptions): ResumePlan | null {
    const record = this.devices.get(deviceId);
    const latest = record?.latest;
    if (!record || !latest) return null;
    const entries = record.history.all();

    if (!cursor) {
      const events = record.history.recentEvents(latest.bootId, this.options.snapshotRecentEvents);
      return { kind: 'snapshot', snapshot: this.snapshotOf(record, latest, now, events, false) };
    }

    const cursorBoot = entries.filter((e) => e.msg.bootId === cursor.bootId);
    const cursorBootCovered =
      cursorBoot.length > 0 && cursorBoot[0]!.msg.seq <= cursor.seq + 1;
    const tailEvents = eventsAfterCursor(cursorBoot, cursor.seq, options.eventLookbackMs);

    if (cursor.bootId === latest.bootId) {
      const upToDate = latest.seq <= cursor.seq;
      if (upToDate || cursorBootCovered) {
        const replay = buildReplay(cursorBoot, cursor.seq, latest, tailEvents, options);
        if (replay) {
          return {
            kind: 'replay',
            replay: {
              t: 'replay',
              deviceId,
              bootId: latest.bootId,
              fromSeq: cursor.seq,
              toSeq: latest.seq,
              statesIncluded: replay.statesIncluded,
              items: replay.items,
              status: record.status,
              lastSeenAgoMs: now - record.lastReceivedAt,
            },
          };
        }
      }
      const events = tailEvents.slice(-options.maxMessages);
      return { kind: 'snapshot', snapshot: this.snapshotOf(record, latest, now, events, true) };
    }

    // The device rebooted during the gap: the tail of the cursor's boot, then every later boot.
    const cursorRank = cursorBoot[0]?.bootRank;
    const laterBoots = entries.filter((e) =>
      cursorRank === undefined ? e.msg.bootId === latest.bootId : e.bootRank > cursorRank,
    );
    const laterEvents = laterBoots.filter((e) => e.msg.type === 'event').map((e) => e.msg as EventMessage);
    const firstOfLatest = laterBoots.find((e) => e.msg.bootId === latest.bootId);
    const latestBootFromStart = firstOfLatest !== undefined && firstOfLatest.msg.seq === 0;
    const all = [...tailEvents, ...laterEvents];
    const events = all.slice(-options.maxMessages);
    const incomplete = !cursorBootCovered || !latestBootFromStart || events.length < all.length;
    return { kind: 'snapshot', snapshot: this.snapshotOf(record, latest, now, events, incomplete) };
  }

  stats(now: number) {
    return [...this.devices.values()]
      .map((r) => ({
        deviceId: r.deviceId,
        status: r.status,
        bootId: r.cursor.bootId?.slice(0, 8) ?? null,
        lastSeq: r.cursor.lastSeq,
        lastStateSeq: r.cursor.lastStateSeq,
        historySize: r.history.size,
        lastSeenAgoMs: now - r.lastReceivedAt,
      }))
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }

  history(deviceId: string): DeviceHistory | undefined {
    return this.devices.get(deviceId)?.history;
  }

  private snapshotOf(
    record: DeviceRecord,
    latest: StateMessage,
    now: number,
    events: EventMessage[],
    eventsIncomplete: boolean,
  ): DeviceSnapshot {
    return {
      deviceId: record.deviceId,
      bootId: latest.bootId,
      seq: latest.seq,
      ts: latest.ts,
      state: latest.payload,
      status: record.status,
      lastSeenAgoMs: now - record.lastReceivedAt,
      recentEvents: events,
      eventsIncomplete,
    };
  }

  private record(deviceId: string): DeviceRecord {
    let record = this.devices.get(deviceId);
    if (!record) {
      record = {
        deviceId,
        cursor: new DeviceCursor(deviceId),
        history: new DeviceHistory(this.options.history),
        historyBootId: null,
        latest: null,
        lastReceivedAt: 0,
        status: 'online',
      };
      this.devices.set(deviceId, record);
    }
    return record;
  }
}

/**
 * Events of the cursor's boot the client may lack: everything after the cursor, plus those at or
 * below it that reached the gateway shortly before (or after) the cursor's own message - a delayed
 * event can carry a lower seq than messages the client already has. Duplicates are cheap: the
 * client's SeenWindow drops them.
 */
function eventsAfterCursor(boot: readonly HistoryEntry[], cursorSeq: number, lookbackMs: number): EventMessage[] {
  let cursorAt = Number.POSITIVE_INFINITY;
  for (const e of boot) if (e.msg.seq <= cursorSeq) cursorAt = e.receivedAt;
  const from = cursorAt - lookbackMs;
  const out: EventMessage[] = [];
  for (const e of boot) {
    if (e.msg.type === 'event' && (e.msg.seq > cursorSeq || e.receivedAt >= from)) out.push(e.msg);
  }
  return out;
}

function buildReplay(
  boot: readonly HistoryEntry[],
  cursorSeq: number,
  latest: StateMessage,
  events: EventMessage[],
  options: ResumeOptions,
): { items: DeviceMessage[]; statesIncluded: boolean } | null {
  if (options.includeStates) {
    const states = boot.filter((e) => e.msg.type === 'state' && e.msg.seq > cursorSeq).map((e) => e.msg);
    const items = [...events, ...states].sort(bySeq);
    if (items.length <= options.maxMessages) return { items, statesIncluded: true };
  }
  const items: DeviceMessage[] = latest.seq > cursorSeq ? [...events, latest].sort(bySeq) : events;
  return items.length <= options.maxMessages ? { items, statesIncluded: false } : null;
}

function bySeq(a: DeviceMessage, b: DeviceMessage): number {
  return a.seq - b.seq;
}
