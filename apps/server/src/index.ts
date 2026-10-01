import http from 'node:http';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION, type DeviceMessage } from '@app/shared';
import { config } from './config.ts';
import { Chaos } from './chaos.ts';
import { IngestLogger } from './debug/ingestLogger.ts';
import { DeviceStore } from './hub/deviceStore.ts';
import { handleDebug } from './http/debug.ts';
import { HttpError, sendJson } from './http/util.ts';
import { DEFAULT_TIMINGS, scaleTimings } from './sim/device.ts';
import { Fleet } from './sim/fleet.ts';
import { LocalSource, RemoteSource, type DeviceSource } from './sim/source.ts';
import { log } from './util/log.ts';
import { RateMeter } from './util/rate.ts';
import { ClientHub } from './ws/clientHub.ts';

const SNAPSHOT_RECENT_EVENTS = 20;
const PRESENCE_CHECK_MS = 500;

if (config.offlineAfterMs <= config.chaos.maxDelayMs + config.linkLatencyMs) {
  log(
    config.gatewayId,
    `WARNING: OFFLINE_AFTER_MS (${config.offlineAfterMs}) <= CHAOS_MAX_DELAY_MS + LINK_LATENCY_MS ` +
      `(${config.chaos.maxDelayMs + config.linkLatencyMs}); presence will flap`,
  );
}
if (config.replayEventLookbackMs <= config.chaos.maxDelayMs) {
  log(
    config.gatewayId,
    `WARNING: REPLAY_EVENT_LOOKBACK_MS (${config.replayEventLookbackMs}) <= CHAOS_MAX_DELAY_MS (${config.chaos.maxDelayMs}); delayed events can be missed on resume`,
  );
}

const received = new RateMeter();
const ingestLogger = config.debugIngest ? new IngestLogger(config.debugIngest) : null;

const store = new DeviceStore(
  {
    offlineAfterMs: config.offlineAfterMs,
    history: { maxMessages: config.historyMaxMessages, maxAgeMs: config.historyMaxAgeMs },
    snapshotRecentEvents: SNAPSHOT_RECENT_EVENTS,
  },
  (change) => {
    hub.presence(change);
    if (config.debugSim) log(`presence ${change.deviceId}`, change.status);
  },
);

/** Gateway ingress: everything that survived the simulated radio link. */
function ingest(msg: DeviceMessage): void {
  received.add();
  ingestLogger?.observe(msg);
  store.ingest(msg, Date.now());
  hub.forward(msg);
}

const chaos = new Chaos<DeviceMessage>(config.chaos, ingest);

/** The radio link: devices outside DEVICE_FILTER are out of range, the rest arrive late and/or via chaos. */
function receive(msg: DeviceMessage): void {
  if (config.deviceFilter && !config.deviceFilter.has(msg.deviceId)) return;
  if (config.linkLatencyMs > 0) setTimeout(() => chaos.push(msg), config.linkLatencyMs);
  else chaos.push(msg);
}

function stressChanged(enabled: boolean): void {
  log(config.gatewayId, `stress mode ${enabled ? 'on' : 'off'}`);
  hub.broadcastStats();
}

const source: DeviceSource = config.simUrl
  ? new RemoteSource(config.simUrl, config.gatewayId, { emit: receive, stressChanged })
  : new LocalSource(
      new Fleet(config.deviceCount, scaleTimings(DEFAULT_TIMINGS, config.lifecycleScale), {
        emit: receive,
        lifecycle: config.debugSim
          ? (deviceId, state, detail) => log(`sim ${deviceId}`, `${state.padEnd(9)} ${detail}`)
          : undefined,
      }),
      { stressChanged },
    );

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  route(req, res).catch((err: unknown) => {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: err.message });
    } else {
      log('http', 'unhandled error', err);
      sendJson(res, 500, { error: 'internal error' });
    }
  });
});

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true, gatewayId: config.gatewayId, protocol: PROTOCOL_VERSION });
    return;
  }

  if (url.pathname.startsWith('/debug/')) {
    const handled = await handleDebug(req, res, url, {
      gatewayId: config.gatewayId,
      source,
      chaos,
      received,
      store,
      hub,
    });
    if (handled) return;
  }

  sendJson(res, 404, { error: 'not found' });
}

const wss = new WebSocketServer({ server, path: '/ws' });
const hub = new ClientHub(wss, store, {
  gatewayId: config.gatewayId,
  batchIntervalMs: config.batchIntervalMs,
  backpressureBytes: config.backpressureBytes,
  queueMax: config.clientQueueMax,
  pingIntervalMs: config.pingIntervalMs,
  defaultMaxHz: config.defaultMaxHz,
  replayMaxMessages: config.replayMaxMessages,
  replayEventLookbackMs: config.replayEventLookbackMs,
  configInfo: () => ({
    offlineAfterMs: config.offlineAfterMs,
    historyMaxMessages: config.historyMaxMessages,
    stress: source.isStress,
    defaultMaxHz: config.defaultMaxHz,
  }),
  gatewayStats: () => ({
    stress: source.isStress,
    receivedPerSec: received.perSecond,
    heapUsedMb: Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10,
  }),
  onStress: (enabled) => source.setStress(enabled),
});

setInterval(() => store.checkPresence(Date.now()), PRESENCE_CHECK_MS);

server.listen(config.port, () => {
  const devices = config.deviceFilter ? [...config.deviceFilter].join(',') : `all ${config.deviceCount}`;
  const from = config.simUrl ? `simulator ${config.simUrl}` : 'in-process simulator';
  const latency = config.linkLatencyMs > 0 ? `, +${config.linkLatencyMs} ms link latency` : '';
  log(config.gatewayId, `listening on http://localhost:${config.port} (ws: /ws); devices: ${devices} from ${from}${latency}`);
  source.start();
  // A shared simulator keeps its own stress state; STRESS only applies to the one we run.
  if (config.stress && !config.simUrl) source.setStress(true);
});
