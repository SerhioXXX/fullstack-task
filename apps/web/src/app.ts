import type { ServerMessage, StatsMessage } from '@app/shared';
import { config } from './config.ts';
import { GatewayPool, type GatewayLink } from './net/gatewayPool.ts';
import { FrameLoop } from './render/frameLoop.ts';
import { DeviceStore } from './store/deviceStore.ts';

/** App-wide singletons, created once outside React (StrictMode double effects can't duplicate them). */
export const store = new DeviceStore();
export const frameLoop = new FrameLoop(store.metrics);

const SUBSCRIBE_DEBOUNCE_MS = 150;

/** Every gateway feeds the same store: (bootId, seq) come from the device, so merging needs no coordination (T9.5). */
function handle(link: GatewayLink, msg: ServerMessage): void {
  const gw = link.id;
  switch (msg.t) {
    case 'hello':
      store.setServerConfig(msg.config);
      // A new session starts with the gateway's defaults: restore what this client chose first,
      // so the resume answer already follows our subscription (e.g. full states for the charted device).
      sendSubscribe(link);
      sendResume(link);
      break;
    case 'stats':
      store.serverStats.set(gw, msg);
      break;
    case 'resync':
      // Our queue on the gateway overflowed and was dropped; the gap is recovered like a reconnect.
      sendResume(link);
      break;
    case 'snapshot':
      store.applySnapshot(gw, msg.devices, msg.reason);
      break;
    case 'replay':
      store.applyReplay(gw, msg);
      break;
    case 'batch':
      store.applyBatch(gw, msg.items);
      break;
    case 'presence':
      store.applyPresence(gw, msg);
      break;
    case 'heartbeat':
      break;
  }
}

function sendResume(link: GatewayLink): void {
  link.connection.send({ t: 'resume', cursors: store.beginResume(link.id) });
}

function sendSubscribe(link?: GatewayLink): void {
  const request = store.subscribeRequest();
  if (!request) return;
  if (link) link.connection.send(request);
  else pool.sendAll(request);
}

let subscribeTimer: ReturnType<typeof setTimeout> | null = null;
store.onSubscriptionChange = () => {
  if (subscribeTimer) clearTimeout(subscribeTimer);
  subscribeTimer = setTimeout(() => {
    subscribeTimer = null;
    sendSubscribe();
  }, SUBSCRIBE_DEBOUNCE_MS);
};

/** Stress lives in the (shared) simulator, so one gateway is enough: the primary. */
export function setStress(enabled: boolean): void {
  pool.sendPrimary({ t: 'control', stress: enabled });
}

export function primaryStats(): StatsMessage | null {
  const primary = pool.primary;
  return primary ? (store.serverStats.get(primary.id) ?? null) : null;
}

export const pool = new GatewayPool(
  config.wsUrls,
  {
    reconnectBaseMs: config.reconnectBaseMs,
    reconnectMaxMs: config.reconnectMaxMs,
    timeoutMs: config.connectionTimeoutMs,
  },
  {
    onMessage: handle,
    onClose: (link) => store.dropGateway(link.id),
  },
);

pool.start();

// The singletons hold all live state, so a hot update of them (or anything they import) would leave
// extra sockets and a stale store behind. Stop the old sockets and reload instead.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (subscribeTimer) clearTimeout(subscribeTimer);
    pool.stop();
    frameLoop.stop();
  });
  import.meta.hot.accept(() => window.location.reload());
}
