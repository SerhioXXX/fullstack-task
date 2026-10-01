/**
 * A client that stops reading its socket for long stretches, to show that the gateway's memory
 * per slow client stays bounded (D3): states coalesce in slots, the queue is capped, overflow -> resync.
 *   npm run slow-client                                  # unlimited maxHz, stress on, 8 s paused / 2 s reading
 *   npm run slow-client -- --pause 5 --read 1 --seconds 120 --max-hz 10 --no-stress
 */
import { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '@app/shared';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const url = arg('url') ?? 'ws://localhost:8080/ws';
const httpBase = url.replace(/^ws/, 'http').replace(/\/ws$/, '');
// A pause longer than WS_PING_INTERVAL_MS gets the client terminated for a missed pong, which is also correct.
const pauseS = Number(arg('pause') ?? 8);
const readS = Number(arg('read') ?? 2);
const seconds = Number(arg('seconds') ?? 60);
const maxHzArg = arg('max-hz');
const maxHz = maxHzArg === undefined || maxHzArg === 'none' ? null : Number(maxHzArg);
const stress = !process.argv.includes('--no-stress');

interface ClientStats {
  id: number;
  maxHz: number | null;
  queueDepth: number;
  slotsFilled: number;
  bufferedAmount: number;
  coalesced: number;
  backpressureSkips: number;
  resyncs: number;
  awaitingResume: boolean;
}

interface GatewayStats {
  receivedPerSec: number;
  memoryMb: { rss: number; heapUsed: number };
  clients: ClientStats[];
}

let received = 0;
let resyncs = 0;
let paused = false;
let myId: number | null = null;

function time(): string {
  return new Date().toISOString().slice(11, 19);
}

function send(ws: WebSocket, msg: ClientMessage): void {
  ws.send(JSON.stringify(msg));
}

const ws = new WebSocket(url);

ws.on('open', () => console.log(`${time()} connected to ${url}; pause ${pauseS}s / read ${readS}s, maxHz=${maxHz ?? 'none'}`));

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString()) as ServerMessage;
  if (msg.t === 'hello') {
    send(ws, { t: 'subscribe', devices: '*', maxHz });
    send(ws, { t: 'resume', cursors: {} });
    if (stress) send(ws, { t: 'control', stress: true });
  } else if (msg.t === 'batch') {
    received += msg.items.length;
  } else if (msg.t === 'resync') {
    resyncs++;
    send(ws, { t: 'resume', cursors: {} });
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

function cycle(): void {
  paused = !paused;
  if (paused) ws.pause();
  else ws.resume();
  setTimeout(cycle, (paused ? pauseS : readS) * 1000);
}
setTimeout(cycle, 1000);

const report = setInterval(async () => {
  try {
    const stats = (await (await fetch(`${httpBase}/debug/stats`)).json()) as GatewayStats;
    // Our session is the newest one with our maxHz (the web app may be connected too).
    myId ??= stats.clients.filter((c) => c.maxHz === maxHz).at(-1)?.id ?? null;
    const me = stats.clients.find((c) => c.id === myId);
    const session = me
      ? `buffered=${(me.bufferedAmount / 1024).toFixed(0).padStart(5)}KB queue=${String(me.queueDepth).padStart(4)} ` +
        `slots=${me.slotsFilled} coalesced=${me.coalesced} skips=${me.backpressureSkips} resyncs=${me.resyncs}` +
        (me.awaitingResume ? ' awaiting-resume' : '')
      : 'session not found';
    console.log(
      `${time()} ${paused ? 'PAUSED ' : 'reading'} got=${String(received).padStart(5)} | gateway ${stats.receivedPerSec} msg/s ` +
        `heap=${stats.memoryMb.heapUsed}MB rss=${stats.memoryMb.rss}MB | ${session}`,
    );
    received = 0;
  } catch (e) {
    console.log(`${time()} stats unavailable: ${(e as Error).message}`);
  }
}, 1000);

setTimeout(() => {
  clearInterval(report);
  ws.resume();
  if (stress) send(ws, { t: 'control', stress: false });
  console.log(`${time()} done, resyncs received: ${resyncs}`);
  ws.close(1000, 'slow-client done');
}, seconds * 1000);
