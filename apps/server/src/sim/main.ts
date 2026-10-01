/**
 * Separate simulator process for `npm run dev:mesh`: the same virtual devices, heard by every
 * connected gateway. In plain `npm run dev` the gateway runs them in-process instead.
 */
import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { config } from '../config.ts';
import { log } from '../util/log.ts';
import { DEFAULT_TIMINGS, scaleTimings } from './device.ts';
import { Fleet } from './fleet.ts';
import { SIM_PATH, type GatewayToSim, type SimToGateway } from './link.ts';

const STATUS_INTERVAL_MS = 1_000;
/** A gateway this far behind is cut off and reconnects, so one stuck gateway can't grow our memory. */
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const NAME = 'sim';

const gateways = new Set<WebSocket>();

function send(ws: WebSocket, msg: SimToGateway): void {
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    log(NAME, 'gateway is not reading, dropping its link');
    ws.terminate();
    return;
  }
  ws.send(JSON.stringify(msg));
}

function broadcast(msg: SimToGateway): void {
  for (const ws of gateways) send(ws, msg);
}

const fleet = new Fleet(config.deviceCount, scaleTimings(DEFAULT_TIMINGS, config.lifecycleScale), {
  emit: (m) => broadcast({ t: 'msg', m }),
  lifecycle: config.debugSim
    ? (deviceId, state, detail) => log(`sim ${deviceId}`, `${state.padEnd(9)} ${detail}`)
    : undefined,
});

function status(): SimToGateway {
  return {
    t: 'status',
    stress: fleet.isStress,
    emittedPerSec: fleet.emitted.perSecond,
    emittedTotal: fleet.emitted.total,
    devices: fleet.info(),
  };
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, role: 'simulator', gateways: gateways.size }));
});

const wss = new WebSocketServer({ server, path: SIM_PATH });
wss.on('connection', (ws, req) => {
  gateways.add(ws);
  log(NAME, `gateway connected from ${req.socket.remoteAddress} (${gateways.size} total)`);
  send(ws, status());

  ws.on('message', (data) => {
    let msg: GatewayToSim;
    try {
      msg = JSON.parse(data.toString()) as GatewayToSim;
    } catch {
      return;
    }
    if (msg.t === 'stress') {
      if (msg.enabled === fleet.isStress) return;
      fleet.setStress(msg.enabled);
      log(NAME, `stress mode ${msg.enabled ? 'on' : 'off'}`);
      broadcast(status());
    } else if (msg.t === 'device') {
      const device = fleet.get(msg.deviceId);
      if (device) {
        if (msg.action === 'offline') device.forceOffline(msg.durationMs ?? 10_000);
        else device.forceReboot();
      }
      send(ws, { t: 'deviceResult', reqId: msg.reqId, info: device?.info() ?? null });
    }
  });
  ws.on('close', () => {
    gateways.delete(ws);
    log(NAME, `gateway disconnected (${gateways.size} left)`);
  });
});

setInterval(() => broadcast(status()), STATUS_INTERVAL_MS);

server.listen(config.simPort, () => {
  log(NAME, `serving ${config.deviceCount} devices on ws://localhost:${config.simPort}${SIM_PATH}`);
  fleet.start();
  if (config.stress) fleet.setStress(true);
});
