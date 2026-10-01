/**
 * Console WebSocket client for checking the gateway without the web app.
 *   npm run probe                      # ws://localhost:8080/ws, runs until Ctrl+C
 *   npm run probe -- --seconds 10 --url ws://localhost:8081/ws
 */
import { WebSocket } from 'ws';
import { DeviceCursor, countVerdict, createCounters, type ServerMessage } from '@app/shared';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const url = arg('url') ?? 'ws://localhost:8080/ws';
const seconds = Number(arg('seconds') ?? 0);

const cursors = new Map<string, DeviceCursor>();
const counters = createCounters();
let batches = 0;
let items = 0;
let events = 0;

function time(): string {
  return new Date().toISOString().slice(11, 23);
}

const ws = new WebSocket(url);

ws.on('open', () => console.log(`${time()} connected to ${url}`));

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString()) as ServerMessage;
  switch (msg.t) {
    case 'hello':
      console.log(`${time()} hello  server=${msg.serverId} protocol=${msg.protocol} config=${JSON.stringify(msg.config)}`);
      ws.send(JSON.stringify({ t: 'resume', cursors: {} }));
      break;
    case 'snapshot':
      console.log(`${time()} snapshot (${msg.reason}) ${msg.devices.length} device(s):`);
      for (const d of msg.devices) {
        const cursor = new DeviceCursor(d.deviceId);
        cursor.apply({ type: 'state', deviceId: d.deviceId, bootId: d.bootId, seq: d.seq, ts: d.ts, payload: d.state });
        for (const e of d.recentEvents) cursor.apply(e);
        cursors.set(d.deviceId, cursor);
        console.log(
          `    ${d.deviceId} ${d.status.padEnd(7)} boot=${d.bootId.slice(0, 8)} seq=${String(d.seq).padEnd(5)} ` +
            `pos=(${d.state.x.toFixed(0)},${d.state.y.toFixed(0)}) lastSeen=${d.lastSeenAgoMs}ms events=${d.recentEvents.length}`,
        );
      }
      break;
    case 'batch':
      batches++;
      for (const m of msg.items) {
        items++;
        if (m.type === 'event') events++;
        let cursor = cursors.get(m.deviceId);
        if (!cursor) {
          cursor = new DeviceCursor(m.deviceId);
          cursors.set(m.deviceId, cursor);
        }
        countVerdict(counters, cursor.apply(m));
      }
      break;
    case 'presence':
      console.log(`${time()} presence ${msg.deviceId} -> ${msg.status} (silent ${msg.lastSeenAgoMs} ms)`);
      break;
    case 'heartbeat':
    case 'stats':
      break;
    default:
      console.log(`${time()} ${msg.t}`, JSON.stringify(msg));
  }
});

ws.on('close', (code, reason) => {
  console.log(`${time()} closed code=${code} reason="${reason.toString()}"`);
  process.exit(0);
});
ws.on('error', (err) => {
  console.error(`${time()} error: ${err.message}`);
  process.exit(1);
});

const report = setInterval(() => {
  console.log(
    `${time()} 1s: batches=${batches} items=${items} events=${events} | ` +
      `duplicate=${counters.duplicate} outOfOrder=${counters.outOfOrder} lateEvents=${counters.lateEvents} ` +
      `oldBoot=${counters.oldBoot} newBoots=${counters.newBoots}`,
  );
  batches = 0;
  items = 0;
  events = 0;
}, 1000);

if (seconds > 0) {
  setTimeout(() => {
    clearInterval(report);
    ws.close(1000, 'probe done');
  }, seconds * 1000);
}
