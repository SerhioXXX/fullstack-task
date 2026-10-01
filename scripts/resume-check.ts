/**
 * Checks that a reconnect loses no events (D4): connects, disconnects for --gap seconds, reconnects
 * with its cursors, then compares every event the gateway received during the run with what reached us.
 *   npm run resume-check                       # 5 s connected, 3 s gap, 4 s after
 *   npm run resume-check -- --gap 70           # gap longer than the history: expect snapshots
 */
import { WebSocket } from 'ws';
import { DeviceCursor, type ClientMessage, type ResumeCursor, type ServerMessage } from '@app/shared';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}

const url = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1]! : 'ws://localhost:8080/ws';
const httpBase = url.replace(/^ws/, 'http').replace(/\/ws$/, '');
const beforeS = arg('before', 5);
const gapS = arg('gap', 3);
const afterS = arg('after', 4);
/** Events the gateway got in the last moments may still be on their way to us. */
const SETTLE_MS = 1500;

const cursors = new Map<string, DeviceCursor>();
const received = new Set<string>();
const incompleteDevices = new Set<string>();
const resumeLog: string[] = [];

function key(bootId: string, seq: number): string {
  return `${bootId.slice(0, 8)}:${seq}`;
}

function cursorOf(deviceId: string): DeviceCursor {
  let c = cursors.get(deviceId);
  if (!c) {
    c = new DeviceCursor(deviceId);
    cursors.set(deviceId, c);
  }
  return c;
}

function apply(msg: Extract<ServerMessage, { t: 'batch' }>['items'][number]): void {
  const verdict = cursorOf(msg.deviceId).apply(msg);
  if (verdict.accepted && msg.type === 'event') received.add(`${msg.deviceId}/${key(msg.bootId, msg.seq)}`);
}

function connect(resume: Record<string, ResumeCursor>, label: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('error', reject);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      switch (msg.t) {
        case 'hello':
          ws.send(JSON.stringify({ t: 'resume', cursors: resume } satisfies ClientMessage));
          break;
        case 'replay':
          resumeLog.push(`${label}: ${msg.deviceId} replay ${msg.items.length} items (${msg.fromSeq}..${msg.toSeq})`);
          for (const m of msg.items) apply(m);
          break;
        case 'snapshot':
          for (const d of msg.devices) {
            if (d.eventsIncomplete) incompleteDevices.add(d.deviceId);
            resumeLog.push(
              `${label}: ${d.deviceId} snapshot (${msg.reason}${d.eventsIncomplete ? ', events may be missing' : ''})`,
            );
            apply({ type: 'state', deviceId: d.deviceId, bootId: d.bootId, seq: d.seq, ts: d.ts, payload: d.state });
            for (const e of d.recentEvents) apply(e);
          }
          resolve(ws);
          break;
        case 'batch':
          for (const m of msg.items) apply(m);
          break;
      }
    });
  });
}

function close(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.once('close', () => resolve());
    ws.close(1000, 'resume-check');
  });
}

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

interface HistoryEntry {
  boot: string;
  seq: number;
  type: string;
  receivedAgoMs: number;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const ws1 = await connect({}, 'connect');
  await sleep(beforeS);
  await close(ws1);
  const resume: Record<string, ResumeCursor> = {};
  for (const [id, c] of cursors) {
    const rc = c.toResumeCursor();
    if (rc) resume[id] = rc;
  }
  console.log(`disconnected for ${gapS} s with cursors for ${Object.keys(resume).length} devices`);
  await sleep(gapS);
  const ws2 = await connect(resume, 'resume');
  await sleep(afterS);
  await close(ws2);
  const checkedAt = Date.now();

  for (const line of resumeLog.filter((l) => l.startsWith('resume'))) console.log(`  ${line}`);

  let expected = 0;
  let missing = 0;
  const ids = [...cursors.keys()].sort();
  for (const id of ids) {
    const history = (await (await fetch(`${httpBase}/debug/history/${id}`)).json()) as { entries: HistoryEntry[] };
    const now = Date.now();
    const lost: string[] = [];
    for (const e of history.entries) {
      if (e.type !== 'event') continue;
      const receivedAt = now - e.receivedAgoMs;
      // Only events the gateway got after our first snapshot and early enough to have reached us.
      if (receivedAt < startedAt + 500 || receivedAt > checkedAt - SETTLE_MS) continue;
      expected++;
      if (!received.has(`${id}/${key(e.boot, e.seq)}`)) lost.push(key(e.boot, e.seq));
    }
    missing += lost.length;
    if (lost.length > 0) {
      const note = incompleteDevices.has(id) ? ' (snapshot said events may be missing)' : '';
      console.log(`  ${id}: ${lost.length} event(s) not received: ${lost.join(', ')}${note}`);
    }
  }
  console.log(`events the gateway received during the run: ${expected}, not delivered: ${missing}`);
  process.exit(missing > 0 && incompleteDevices.size === 0 ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
