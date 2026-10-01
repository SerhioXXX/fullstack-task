import { describe, expect, it } from 'vitest';
import type { DeviceMessage, EventMessage, StateMessage } from '@app/shared';
import { DeviceStore, type ResumeOptions, type ResumePlan } from './deviceStore.ts';
import { DeviceHistory } from './history.ts';

const DEVICE = 'dev-1';
const A = 'boot-a';
const B = 'boot-b';

function state(seq: number, bootId = A, ts = 10_000 + seq): StateMessage {
  return { type: 'state', deviceId: DEVICE, bootId, seq, ts, payload: { x: seq, y: 0, sensor: 50, battery: 90 } };
}

function event(seq: number, bootId = A, ts = 10_000 + seq): EventMessage {
  return { type: 'event', deviceId: DEVICE, bootId, seq, ts, payload: { kind: 'alert', severity: 'warning' } };
}

function makeStore(maxMessages = 500, maxAgeMs = 60_000): DeviceStore {
  return new DeviceStore({ offlineAfterMs: 5_000, history: { maxMessages, maxAgeMs }, snapshotRecentEvents: 20 }, () => {});
}

/** Gateway receives message i at i * 1000 ms. */
function feed(store: DeviceStore, msgs: DeviceMessage[], startAt = 0): number {
  let now = startAt;
  for (const m of msgs) {
    store.ingest(m, now);
    now += 1_000;
  }
  return now;
}

const OPTIONS: ResumeOptions = { includeStates: false, maxMessages: 300, eventLookbackMs: 500 };

function seqs(msgs: DeviceMessage[]): string[] {
  return msgs.map((m) => `${m.type[0]}${m.seq}`);
}

function replayOf(plan: ResumePlan | null) {
  expect(plan?.kind).toBe('replay');
  return (plan as Extract<ResumePlan, { kind: 'replay' }>).replay;
}

function snapshotOf(plan: ResumePlan | null) {
  expect(plan?.kind).toBe('snapshot');
  return (plan as Extract<ResumePlan, { kind: 'snapshot' }>).snapshot;
}

// s0 s1 s2 e3 s4 s5 s6 e7 s8 s9
const STREAM = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((s) => (s === 3 || s === 7 ? event(s) : state(s)));

describe('DeviceStore.resume', () => {
  it('replays the events of a gap in history plus the latest state', () => {
    const store = makeStore();
    const now = feed(store, STREAM);
    const replay = replayOf(store.resume(DEVICE, { bootId: A, seq: 4 }, now, OPTIONS));
    expect(seqs(replay.items)).toEqual(['e7', 's9']);
    expect(replay).toMatchObject({ fromSeq: 4, toSeq: 9, statesIncluded: false, bootId: A });
  });

  it('replays every state of the gap when the client charts the device', () => {
    const store = makeStore();
    const now = feed(store, STREAM);
    const replay = replayOf(store.resume(DEVICE, { bootId: A, seq: 4 }, now, { ...OPTIONS, includeStates: true }));
    expect(seqs(replay.items)).toEqual(['s5', 's6', 'e7', 's8', 's9']);
    expect(replay.statesIncluded).toBe(true);
  });

  it('answers an up-to-date cursor with an empty replay', () => {
    const store = makeStore();
    const now = feed(store, STREAM);
    expect(replayOf(store.resume(DEVICE, { bootId: A, seq: 9 }, now, OPTIONS)).items).toEqual([]);
  });

  it('replays a delayed event whose seq is below the cursor (lookback)', () => {
    const store = makeStore();
    // e3 is held up by chaos and reaches the gateway after s5, which the client already has.
    const now = feed(store, [state(0), state(1), state(2), state(4), state(5), event(3)]);
    const replay = replayOf(store.resume(DEVICE, { bootId: A, seq: 5 }, now, OPTIONS));
    expect(seqs(replay.items)).toEqual(['e3']);
  });

  it('falls back to a snapshot with eventsIncomplete when the gap left the history', () => {
    const store = makeStore(5);
    const now = feed(store, Array.from({ length: 20 }, (_, i) => state(i)));
    const snap = snapshotOf(store.resume(DEVICE, { bootId: A, seq: 3 }, now, OPTIONS));
    expect(snap).toMatchObject({ seq: 19, eventsIncomplete: true });
  });

  it('falls back to a snapshot when the replay would exceed maxMessages', () => {
    const store = makeStore();
    const msgs = [state(0), ...Array.from({ length: 8 }, (_, i) => event(i + 1)), state(9)];
    const now = feed(store, msgs);
    const snap = snapshotOf(store.resume(DEVICE, { bootId: A, seq: 0 }, now, { ...OPTIONS, maxMessages: 4 }));
    expect(snap.eventsIncomplete).toBe(true);
    expect(seqs(snap.recentEvents)).toEqual(['e5', 'e6', 'e7', 'e8']);
  });

  it('sends a snapshot on reboot during the gap, complete when both boots are in history', () => {
    const store = makeStore();
    const now = feed(store, [state(0), state(1), state(2), event(3), event(0, B, 20_000), state(1, B, 20_001)]);
    const snap = snapshotOf(store.resume(DEVICE, { bootId: A, seq: 2 }, now, OPTIONS));
    expect(snap).toMatchObject({ bootId: B, seq: 1, eventsIncomplete: false });
    // The tail of the old boot first, then the new boot.
    expect(snap.recentEvents.map((e) => `${e.bootId}:${e.seq}`)).toEqual([`${A}:3`, `${B}:0`]);
  });

  it('marks a reboot snapshot incomplete when the start of the new boot is missing', () => {
    const store = makeStore();
    const now = feed(store, [state(0), state(1), state(5, B, 20_005), state(6, B, 20_006)]);
    expect(snapshotOf(store.resume(DEVICE, { bootId: A, seq: 1 }, now, OPTIONS)).eventsIncomplete).toBe(true);
  });

  it('gives a new client (no cursor) a plain snapshot with recent events', () => {
    const store = makeStore();
    const now = feed(store, STREAM);
    const snap = snapshotOf(store.resume(DEVICE, undefined, now, OPTIONS));
    expect(snap).toMatchObject({ seq: 9, eventsIncomplete: false, status: 'online' });
    expect(seqs(snap.recentEvents)).toEqual(['e3', 'e7']);
  });

  it('knows nothing about a device it never heard', () => {
    expect(makeStore().resume('dev-9', undefined, 0, OPTIONS)).toBeNull();
  });
});

describe('DeviceStore.ingest', () => {
  it('keeps the newest state by (boot, seq), not by arrival', () => {
    const store = makeStore();
    feed(store, [state(5), state(3)]);
    expect(store.snapshot(10_000)[0]).toMatchObject({ seq: 5 });
  });

  it('reports offline after silence and online again on the next new message', () => {
    const changes: string[] = [];
    const store = new DeviceStore(
      { offlineAfterMs: 5_000, history: { maxMessages: 500, maxAgeMs: 60_000 }, snapshotRecentEvents: 20 },
      (c) => changes.push(c.status),
    );
    store.ingest(state(1), 0);
    store.checkPresence(4_000);
    store.checkPresence(6_000);
    // A duplicate or late event is old news and does not bring it back.
    store.ingest(state(1), 6_500);
    store.ingest(event(0), 6_600);
    expect(changes).toEqual(['offline']);
    store.ingest(state(2), 7_000);
    expect(changes).toEqual(['offline', 'online']);
  });
});

describe('DeviceHistory', () => {
  it('keeps emission order: a late message goes to its place', () => {
    const h = new DeviceHistory({ maxMessages: 10, maxAgeMs: 60_000 });
    h.startBoot(A);
    h.add(state(1), 0);
    h.add(state(3), 1);
    h.add(event(2), 2);
    expect(seqs(h.all().map((e) => e.msg))).toEqual(['s1', 'e2', 's3']);
  });

  it('trims by count and by age, whichever comes first', () => {
    const byCount = new DeviceHistory({ maxMessages: 3, maxAgeMs: 60_000 });
    byCount.startBoot(A);
    for (let s = 0; s < 5; s++) byCount.add(state(s), s);
    expect(seqs(byCount.all().map((e) => e.msg))).toEqual(['s2', 's3', 's4']);

    const byAge = new DeviceHistory({ maxMessages: 100, maxAgeMs: 1_000 });
    byAge.startBoot(A);
    byAge.add(state(0), 0);
    byAge.add(state(1), 500);
    byAge.add(state(2), 1_400);
    expect(seqs(byAge.all().map((e) => e.msg))).toEqual(['s1', 's2']);
  });

  it('orders boots by when they started, and late messages of an unknown boot before them', () => {
    const h = new DeviceHistory({ maxMessages: 10, maxAgeMs: 60_000 });
    h.startBoot(A);
    h.add(state(9), 0);
    h.startBoot(B);
    h.add(state(0, B), 1);
    h.add(event(4, 'boot-older'), 2);
    expect(h.all().map((e) => e.msg.bootId)).toEqual(['boot-older', A, B]);
  });
});
