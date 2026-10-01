import type { DeviceMessage, EventMessage } from '@app/shared';

export interface HistoryEntry {
  msg: DeviceMessage;
  /** Gateway clock; used for age-based trimming and (stage 8) event lookback. */
  receivedAt: number;
  /** Position of the message's boot in this device's boot order. */
  bootRank: number;
}

export interface HistoryLimits {
  maxMessages: number;
  maxAgeMs: number;
}

/**
 * Short per-device history, kept in emission order (boot order, then seq) regardless of
 * arrival order, so a replay can hand out a gap exactly as the device produced it.
 * Only messages accepted by the store's DeviceCursor are recorded.
 */
export class DeviceHistory {
  private readonly entries: HistoryEntry[] = [];
  private readonly bootRanks = new Map<string, number>();
  private highestRank = 0;
  private lowestRank = 0;

  constructor(private readonly limits: HistoryLimits) {}

  get size(): number {
    return this.entries.length;
  }

  /** Call when the store switches this device to a new boot. */
  startBoot(bootId: string): void {
    this.bootRanks.set(bootId, ++this.highestRank);
  }

  add(msg: DeviceMessage, receivedAt: number): void {
    const bootRank = this.rankOf(msg.bootId);
    const entry: HistoryEntry = { msg, receivedAt, bootRank };

    // Late messages are rare and land near the end, so scan backwards from the tail.
    let i = this.entries.length;
    while (i > 0 && compare(this.entries[i - 1]!, entry) > 0) i--;
    this.entries.splice(i, 0, entry);

    this.trim(receivedAt);
  }

  /** Entries in emission order, oldest first. */
  all(): readonly HistoryEntry[] {
    return this.entries;
  }

  /** Last `limit` events of the given boot, oldest first. */
  recentEvents(bootId: string, limit: number): EventMessage[] {
    const out: EventMessage[] = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const m = this.entries[i]!.msg;
      if (m.type === 'event' && m.bootId === bootId) out.push(m);
    }
    return out.reverse();
  }

  private rankOf(bootId: string): number {
    let rank = this.bootRanks.get(bootId);
    if (rank === undefined) {
      // A boot we only learn about from late messages is older than every boot we know.
      rank = --this.lowestRank;
      this.bootRanks.set(bootId, rank);
    }
    return rank;
  }

  private trim(now: number): void {
    const { maxMessages, maxAgeMs } = this.limits;
    let drop = Math.max(0, this.entries.length - maxMessages);
    while (drop < this.entries.length && now - this.entries[drop]!.receivedAt > maxAgeMs) drop++;
    if (drop > 0) this.entries.splice(0, drop);

    if (this.bootRanks.size > 8) {
      const live = new Set(this.entries.map((e) => e.msg.bootId));
      for (const [bootId, rank] of this.bootRanks) {
        if (rank !== this.highestRank && !live.has(bootId)) this.bootRanks.delete(bootId);
      }
    }
  }
}

function compare(a: HistoryEntry, b: HistoryEntry): number {
  return a.bootRank - b.bootRank || a.msg.seq - b.msg.seq;
}
