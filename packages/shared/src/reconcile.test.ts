import { describe, expect, it } from 'vitest';
import type { DeviceMessage, EventMessage, StateMessage } from './protocol.ts';
import { DeviceCursor, countVerdict, createCounters, isNewer } from './reconcile.ts';

const DEVICE = 'dev-1';
const BOOT_A = 'boot-a';
const BOOT_B = 'boot-b';

function state(seq: number, bootId = BOOT_A, ts = 1_000 + seq): StateMessage {
  return { type: 'state', deviceId: DEVICE, bootId, seq, ts, payload: { x: seq, y: seq, sensor: 50, battery: 90 } };
}

function event(seq: number, bootId = BOOT_A, ts = 1_000 + seq): EventMessage {
  return { type: 'event', deviceId: DEVICE, bootId, seq, ts, payload: { kind: 'alert', severity: 'warning' } };
}

function cursorWith(...msgs: DeviceMessage[]): DeviceCursor {
  const cursor = new DeviceCursor(DEVICE);
  for (const m of msgs) cursor.apply(m);
  return cursor;
}

describe('DeviceCursor', () => {
  it('accepts the first message of a device mid-stream without a gap or a new boot', () => {
    const v = new DeviceCursor(DEVICE).apply(state(500));
    expect(v).toEqual({ accepted: true, kind: 'latest', newBoot: false, fromOldBoot: false, gap: 0 });
  });

  it('drops the same seq twice as duplicate', () => {
    const cursor = cursorWith(state(1));
    expect(cursor.apply(state(1))).toEqual({ accepted: false, reason: 'duplicate' });
    expect(cursor.apply(event(2)).accepted).toBe(true);
    expect(cursor.apply(event(2))).toEqual({ accepted: false, reason: 'duplicate' });
  });

  it('drops an older state after a newer one and keeps the newer as current', () => {
    const cursor = cursorWith(state(5));
    expect(cursor.apply(state(3))).toEqual({ accepted: false, reason: 'out_of_order' });
    expect(cursor.lastStateSeq).toBe(5);
    // Once dropped it is remembered: a chaos duplicate of it is a duplicate, not out of order again.
    expect(cursor.apply(state(3))).toEqual({ accepted: false, reason: 'duplicate' });
  });

  it('accepts a late event and flags it late', () => {
    const cursor = cursorWith(state(5));
    const v = cursor.apply(event(3));
    expect(v).toMatchObject({ accepted: true, kind: 'late_event', fromOldBoot: false });
    expect(cursor.lastSeq).toBe(5);
  });

  it('accepts a state below a newer event as long as it is newer than the shown state', () => {
    // seq is shared by states and events: event 6 does not make state 5 stale.
    const cursor = cursorWith(state(4), event(6));
    expect(cursor.apply(state(5))).toMatchObject({ accepted: true, kind: 'latest' });
    expect(cursor.lastStateSeq).toBe(5);
    expect(cursor.lastSeq).toBe(6);
  });

  it('reports skipped seq values as a gap', () => {
    const cursor = cursorWith(state(1));
    expect(cursor.apply(state(4))).toMatchObject({ accepted: true, gap: 2 });
    expect(cursor.apply(state(5))).toMatchObject({ accepted: true, gap: 0 });
  });

  it('switches to a new boot with a newer ts and restarts seq from 0', () => {
    const cursor = cursorWith(state(100, BOOT_A, 5_000));
    const v = cursor.apply(event(0, BOOT_B, 6_000));
    expect(v).toEqual({ accepted: true, kind: 'latest', newBoot: true, fromOldBoot: false, gap: 0 });
    expect(cursor.bootId).toBe(BOOT_B);
    expect(cursor.lastSeq).toBe(0);
    expect(cursor.apply(state(1, BOOT_B, 6_100))).toMatchObject({ accepted: true, gap: 0 });
  });

  it('drops a late state of the previous boot but keeps its unseen events once', () => {
    const cursor = cursorWith(state(100, BOOT_A, 5_000), state(0, BOOT_B, 6_000));
    expect(cursor.apply(state(101, BOOT_A, 5_100))).toEqual({ accepted: false, reason: 'old_boot' });
    expect(cursor.apply(event(102, BOOT_A, 5_200))).toMatchObject({
      accepted: true,
      kind: 'late_event',
      fromOldBoot: true,
    });
    expect(cursor.apply(event(102, BOOT_A, 5_200))).toEqual({ accepted: false, reason: 'duplicate' });
    // The old boot's duplicates never move the current boot.
    expect(cursor.bootId).toBe(BOOT_B);
  });

  it('treats an unknown boot with an older ts as a past boot, not as a reboot', () => {
    const cursor = cursorWith(state(10, BOOT_B, 9_000));
    expect(cursor.apply(state(50, 'boot-older', 8_000))).toEqual({ accepted: false, reason: 'old_boot' });
    expect(cursor.apply(event(51, 'boot-older', 8_010))).toMatchObject({ accepted: true, fromOldBoot: true });
    expect(cursor.bootId).toBe(BOOT_B);
  });

  it('drops messages that fell out of the dedup window as too_old', () => {
    const cursor = new DeviceCursor(DEVICE, { windowSize: 8 });
    cursor.apply(state(20));
    expect(cursor.apply(event(12))).toEqual({ accepted: false, reason: 'too_old' });
    expect(cursor.apply(event(13))).toMatchObject({ accepted: true, kind: 'late_event' });
  });

  it('exposes a resume cursor of the current boot and its highest seq', () => {
    expect(new DeviceCursor(DEVICE).toResumeCursor()).toBeNull();
    expect(cursorWith(state(3), event(7), state(5)).toResumeCursor()).toEqual({ bootId: BOOT_A, seq: 7 });
  });

  it('rejects messages for another device', () => {
    expect(() => new DeviceCursor('dev-2').apply(state(1))).toThrow();
  });
});

describe('isNewer', () => {
  it('compares seq within a boot and ts across boots', () => {
    expect(isNewer(state(5), state(4))).toBe(true);
    expect(isNewer(state(4), state(5))).toBe(false);
    expect(isNewer(state(0, BOOT_B, 9_000), state(900, BOOT_A, 8_000))).toBe(true);
    expect(isNewer(state(900, BOOT_A, 8_000), state(0, BOOT_B, 9_000))).toBe(false);
  });
});

describe('countVerdict', () => {
  it('counts every verdict kind', () => {
    const counters = createCounters();
    const cursor = new DeviceCursor(DEVICE, { windowSize: 8 });
    for (const m of [state(1), state(1), state(4), state(3), event(2), state(30), event(5), state(0, BOOT_B, 99_999)]) {
      countVerdict(counters, cursor.apply(m));
    }
    countVerdict(counters, cursor.apply(state(31, BOOT_A, 1_031)));
    expect(counters).toEqual({
      accepted: 5,
      lateEvents: 1,
      newBoots: 1,
      gaps: 2,
      duplicate: 1,
      outOfOrder: 1,
      oldBoot: 1,
      tooOld: 1,
    });
  });
});
