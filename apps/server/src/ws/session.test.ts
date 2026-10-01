import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { DeviceMessage, EventMessage, ServerMessage, StateMessage } from '@app/shared';
import { ClientSession, type SessionLimits } from './session.ts';

function state(seq: number, deviceId = 'dev-1'): StateMessage {
  return { type: 'state', deviceId, bootId: 'boot', seq, ts: seq, payload: { x: 0, y: 0, sensor: 0, battery: 100 } };
}

function event(seq: number, deviceId = 'dev-1'): EventMessage {
  return { type: 'event', deviceId, bootId: 'boot', seq, ts: seq, payload: { kind: 'alert', severity: 'warning' } };
}

const LIMITS: SessionLimits = { batchIntervalMs: 50, backpressureBytes: 1_000, queueMax: 5 };

/** A live session over a fake socket that records what would be sent. */
function makeSession(maxHz: number | null, limits: Partial<SessionLimits> = {}) {
  const sent: ServerMessage[] = [];
  const ws = { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (data: string) => sent.push(JSON.parse(data)) };
  const session = new ClientSession(1, ws as unknown as WebSocket, 'test', maxHz, { ...LIMITS, ...limits });
  session.awaitingResume = false;
  return { session, sent, ws };
}

function batchedItems(sent: ServerMessage[]): string[] {
  return sent.flatMap((m) => (m.t === 'batch' ? m.items.map(label) : []));
}

function label(m: DeviceMessage): string {
  return `${m.type[0]}${m.seq}`;
}

describe('ClientSession throttling', () => {
  it('keeps only the newest state per device by seq, not by arrival', () => {
    const { session, sent } = makeSession(10);
    session.offer(state(1));
    session.offer(state(3));
    session.offer(state(2)); // late, older than the one waiting
    session.tick(1_000);
    expect(batchedItems(sent)).toEqual(['s3']);
    expect(session.coalesced).toBe(2);
  });

  it('sends a limited device at most maxHz times per second', () => {
    const { session, sent } = makeSession(1);
    for (let t = 0, seq = 0; t < 3_000; t += 10, seq++) {
      session.offer(state(seq));
      session.tick(t);
    }
    // Due at 0, 1000 and 2000 ms, each time with the newest state at that moment.
    expect(batchedItems(sent)).toEqual(['s0', 's100', 's200']);
  });

  it('applies a per-device limit over the session default', () => {
    const { session, sent } = makeSession(1);
    session.subscription = { ...session.subscription, perDevice: new Map([['dev-2', null]]) };
    for (let seq = 0; seq < 5; seq++) {
      session.offer(state(seq, 'dev-1'));
      session.offer(state(seq, 'dev-2'));
    }
    session.tick(1_000);
    // dev-2 has no limit: every state, in order; dev-1: only the newest.
    expect(batchedItems(sent)).toEqual(['s0', 's1', 's2', 's3', 's4', 's4']);
  });

  it('never coalesces or drops events, and sends them before the throttled states', () => {
    const { session, sent } = makeSession(10);
    session.offer(event(1));
    session.offer(state(2));
    session.offer(state(4));
    session.offer(event(3));
    session.tick(1_000);
    expect(batchedItems(sent)).toEqual(['e1', 'e3', 's4']);
  });

  it('keeps presence in order with the events around it', () => {
    const { session, sent } = makeSession(10);
    session.offer(event(1));
    session.offerPresence({ t: 'presence', deviceId: 'dev-1', status: 'offline', lastSeenAgoMs: 5_000 });
    session.offer(event(2));
    session.tick(1_000);
    expect(sent.map((m) => (m.t === 'batch' ? `batch:${m.items.map(label)}` : m.t))).toEqual([
      'batch:e1',
      'presence',
      'batch:e2',
    ]);
  });
});

describe('ClientSession backpressure', () => {
  it('skips ticks while the socket is full and coalesces even unlimited states meanwhile', () => {
    const { session, sent, ws } = makeSession(null);
    ws.bufferedAmount = 5_000;
    session.tick(1_000);
    for (let seq = 0; seq < 50; seq++) session.offer(state(seq));
    session.tick(1_100);
    expect(sent).toEqual([]);
    expect(session.backpressureSkips).toBe(2);

    ws.bufferedAmount = 0;
    session.tick(1_200);
    expect(batchedItems(sent)).toEqual(['s49']);
    expect(session.queueDepth).toBe(0);
  });

  it('turns a queue overflow into resync instead of dropping events silently', () => {
    const { session, sent } = makeSession(10);
    for (let seq = 0; seq < 6; seq++) session.offer(event(seq));
    expect(sent).toEqual([{ t: 'resync' }]);
    expect(session).toMatchObject({ awaitingResume: true, resyncs: 1, queueDepth: 0 });

    // Until the client resumes, nothing is queued or sent.
    session.offer(event(7));
    session.tick(1_000);
    expect(session.queueDepth).toBe(0);
    expect(sent.filter((m) => m.t === 'batch')).toEqual([]);
  });

  it('memory stays bounded: one slot per device however many states arrive', () => {
    const { session, ws } = makeSession(10, { queueMax: 1_000 });
    ws.bufferedAmount = 5_000;
    session.tick(0);
    for (let seq = 0; seq < 100_000; seq++) session.offer(state(seq, `dev-${seq % 8}`));
    expect(session.slotsFilled).toBe(8);
    expect(session.queueDepth).toBe(0);
  });
});

describe('ClientSession subscription', () => {
  it('drops devices outside the subscription and reports newly visible ones', () => {
    const { session, sent } = makeSession(null);
    const added = session.setSubscription(
      { devices: new Set(['dev-2']), maxHz: null, perDevice: new Map() },
      ['dev-1', 'dev-2'],
    );
    expect(added).toEqual([]);
    session.offer(event(1, 'dev-1'));
    session.offer(event(2, 'dev-2'));
    session.tick(1_000);
    expect(sent.flatMap((m) => (m.t === 'batch' ? m.items.map((i) => i.deviceId) : []))).toEqual(['dev-2']);

    const back = session.setSubscription({ devices: '*', maxHz: null, perDevice: new Map() }, ['dev-1', 'dev-2']);
    expect(back).toEqual(['dev-1']);
  });

  it('sends nothing live before the first resume, but keeps the link alive with heartbeats', () => {
    const { session, sent } = makeSession(10);
    session.awaitingResume = true;
    session.offer(event(1));
    session.lastSentAt = 0;
    session.tick(5_000);
    expect(sent.map((m) => m.t)).toEqual(['heartbeat']);
  });
});
