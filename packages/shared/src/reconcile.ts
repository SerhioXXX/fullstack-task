import type { DeviceMessage, ResumeCursor } from './protocol.ts';
import { SeenWindow } from './seenWindow.ts';

export type DropReason = 'duplicate' | 'out_of_order' | 'old_boot' | 'too_old';

export type Verdict =
  | {
      accepted: true;
      /** 'latest': becomes current state / newest event. 'late_event': event older than what we have. */
      kind: 'latest' | 'late_event';
      /** First message of a boot we switched to; the caller should break trails and charts. */
      newBoot: boolean;
      /** Event from a boot that is no longer current. */
      fromOldBoot: boolean;
      /** Number of seq values skipped since the previous highest seq (0 = contiguous). */
      gap: number;
    }
  | { accepted: false; reason: DropReason };

interface BootTrack {
  bootId: string;
  seen: SeenWindow;
  maxTs: number;
}

export interface DeviceCursorOptions {
  windowSize?: number;
  /** How many previous boots are remembered for dedup of their late events. */
  retiredBoots?: number;
}

/**
 * Per-device ordering state. Trusts (bootId, seq) for order; uses the device's own ts
 * only to decide which of two boots is newer. Never uses receive time.
 */
export class DeviceCursor {
  private current: BootTrack | null = null;
  private lastSeqValue = -1;
  private lastStateSeqValue = -1;
  private readonly retired: BootTrack[] = [];
  private readonly windowSize: number;
  private readonly maxRetired: number;

  constructor(
    readonly deviceId: string,
    options: DeviceCursorOptions = {},
  ) {
    this.windowSize = options.windowSize ?? 1024;
    this.maxRetired = options.retiredBoots ?? 4;
  }

  get bootId(): string | null {
    return this.current?.bootId ?? null;
  }

  /** Highest seq accepted in the current boot (state or event), -1 if none. */
  get lastSeq(): number {
    return this.lastSeqValue;
  }

  /** Seq of the state currently considered latest, -1 if none. */
  get lastStateSeq(): number {
    return this.lastStateSeqValue;
  }

  get lastTs(): number {
    return this.current?.maxTs ?? Number.NEGATIVE_INFINITY;
  }

  toResumeCursor(): ResumeCursor | null {
    if (!this.current) return null;
    return { bootId: this.current.bootId, seq: this.lastSeqValue };
  }

  apply(msg: DeviceMessage): Verdict {
    if (msg.deviceId !== this.deviceId) {
      throw new Error(`DeviceCursor(${this.deviceId}) got message for ${msg.deviceId}`);
    }

    if (this.current === null || msg.bootId !== this.current.bootId) {
      const retired = this.retired.find((b) => b.bootId === msg.bootId);
      if (retired) return this.applyToRetired(retired, msg);
      if (this.current !== null && msg.ts <= this.current.maxTs) {
        // Unknown boot that is older than the current one: a late message from a boot we never saw.
        return this.applyToRetired(this.retire(this.newTrack(msg.bootId, msg.ts)), msg);
      }
      return this.switchBoot(msg);
    }

    return this.applyToCurrent(this.current, msg);
  }

  private applyToCurrent(track: BootTrack, msg: DeviceMessage): Verdict {
    const seen = track.seen.check(msg.seq);
    if (seen === 'seen') return { accepted: false, reason: 'duplicate' };
    if (seen === 'too_old') return { accepted: false, reason: 'too_old' };

    if (msg.type === 'state' && msg.seq < this.lastStateSeqValue) {
      track.seen.mark(msg.seq);
      return { accepted: false, reason: 'out_of_order' };
    }

    const gap = msg.seq > this.lastSeqValue ? msg.seq - this.lastSeqValue - 1 : 0;
    const isLatest = msg.seq > this.lastSeqValue;
    track.seen.mark(msg.seq);
    if (msg.ts > track.maxTs) track.maxTs = msg.ts;
    if (isLatest) this.lastSeqValue = msg.seq;
    if (msg.type === 'state') this.lastStateSeqValue = msg.seq;

    return {
      accepted: true,
      kind: msg.type === 'event' && !isLatest ? 'late_event' : 'latest',
      newBoot: false,
      fromOldBoot: false,
      gap,
    };
  }

  private applyToRetired(track: BootTrack, msg: DeviceMessage): Verdict {
    if (msg.type === 'state') return { accepted: false, reason: 'old_boot' };
    const seen = track.seen.check(msg.seq);
    if (seen === 'seen') return { accepted: false, reason: 'duplicate' };
    if (seen === 'too_old') return { accepted: false, reason: 'too_old' };
    track.seen.mark(msg.seq);
    return { accepted: true, kind: 'late_event', newBoot: false, fromOldBoot: true, gap: 0 };
  }

  private switchBoot(msg: DeviceMessage): Verdict {
    const hadPrevious = this.current !== null;
    if (this.current) this.retire(this.current);
    this.current = this.newTrack(msg.bootId, msg.ts);
    this.lastSeqValue = -1;
    this.lastStateSeqValue = -1;
    const verdict = this.applyToCurrent(this.current, msg);
    if (verdict.accepted) {
      // A boot that starts mid-stream (e.g. first contact at seq 500) is not a "gap".
      return { ...verdict, newBoot: hadPrevious, gap: 0 };
    }
    return verdict;
  }

  private newTrack(bootId: string, ts: number): BootTrack {
    return { bootId, seen: new SeenWindow(this.windowSize), maxTs: ts };
  }

  private retire(track: BootTrack): BootTrack {
    this.retired.unshift(track);
    while (this.retired.length > this.maxRetired) this.retired.pop();
    return track;
  }
}

/**
 * Whether `a` should replace `b` as the latest message of the same device, without a cursor:
 * seq within one boot, the device's own ts across boots (D2). Never uses receive time.
 */
export function isNewer(a: DeviceMessage, b: DeviceMessage): boolean {
  return a.bootId === b.bootId ? a.seq > b.seq : a.ts > b.ts;
}

export interface ReconcileCounters {
  accepted: number;
  lateEvents: number;
  newBoots: number;
  gaps: number;
  duplicate: number;
  outOfOrder: number;
  oldBoot: number;
  tooOld: number;
}

export function createCounters(): ReconcileCounters {
  return { accepted: 0, lateEvents: 0, newBoots: 0, gaps: 0, duplicate: 0, outOfOrder: 0, oldBoot: 0, tooOld: 0 };
}

export function countVerdict(counters: ReconcileCounters, verdict: Verdict): void {
  if (verdict.accepted) {
    counters.accepted++;
    if (verdict.kind === 'late_event') counters.lateEvents++;
    if (verdict.newBoot) counters.newBoots++;
    if (verdict.gap > 0) counters.gaps++;
    return;
  }
  switch (verdict.reason) {
    case 'duplicate':
      counters.duplicate++;
      break;
    case 'out_of_order':
      counters.outOfOrder++;
      break;
    case 'old_boot':
      counters.oldBoot++;
      break;
    case 'too_old':
      counters.tooOld++;
      break;
  }
}
