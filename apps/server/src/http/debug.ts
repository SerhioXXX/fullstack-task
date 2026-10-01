import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeviceMessage } from '@app/shared';
import type { Chaos, ChaosConfig } from '../chaos.ts';
import type { DeviceStore } from '../hub/deviceStore.ts';
import type { DeviceSource } from '../sim/source.ts';
import type { RateMeter } from '../util/rate.ts';
import type { ClientHub } from '../ws/clientHub.ts';
import { HttpError, readJson, sendJson } from './util.ts';

export interface DebugDeps {
  gatewayId: string;
  source: DeviceSource;
  chaos: Chaos<DeviceMessage>;
  received: RateMeter;
  store: DeviceStore;
  hub: ClientHub;
}

/** A shared simulator applies stress asynchronously; wait briefly so the reply shows the new state. */
const STRESS_SETTLE_MS = 300;

const CHAOS_KEYS: Array<keyof ChaosConfig> = [
  'delayProbability',
  'minDelayMs',
  'maxDelayMs',
  'duplicateProbability',
  'duplicateMaxDelayMs',
];

/** Returns true if the request was handled. */
export async function handleDebug(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: DebugDeps,
): Promise<boolean> {
  const { method } = req;
  const path = url.pathname;

  if (method === 'GET' && path === '/debug/stats') {
    const mem = process.memoryUsage();
    const now = Date.now();
    const sim = deps.source.status();
    sendJson(res, 200, {
      gatewayId: deps.gatewayId,
      stress: sim.stress,
      simulatorLinked: sim.linked,
      emittedPerSec: sim.emittedPerSec,
      receivedPerSec: deps.received.perSecond,
      emittedTotal: sim.emittedTotal,
      receivedTotal: deps.received.total,
      chaos: { config: deps.chaos.config, stats: deps.chaos.stats },
      reconcile: deps.store.counters,
      store: deps.store.stats(now),
      simulator: sim.devices,
      clients: deps.hub.stats(),
      memoryMb: { rss: mb(mem.rss), heapUsed: mb(mem.heapUsed) },
    });
    return true;
  }

  if (path === '/debug/stress') {
    if (method === 'GET') {
      sendJson(res, 200, { enabled: deps.source.isStress });
      return true;
    }
    if (method === 'POST') {
      const body = await readJson(req);
      if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'body must be {"enabled": true|false}');
      deps.source.setStress(body.enabled);
      if (deps.source.isStress !== body.enabled) await new Promise((r) => setTimeout(r, STRESS_SETTLE_MS));
      sendJson(res, 200, { enabled: deps.source.isStress });
      return true;
    }
  }

  if (method === 'POST' && path === '/debug/drop-connections') {
    const mode = url.searchParams.get('mode') === 'terminate' ? 'terminate' : 'close';
    sendJson(res, 200, { dropped: deps.hub.dropAll(mode), mode });
    return true;
  }

  if (path === '/debug/chaos') {
    if (method === 'GET') {
      sendJson(res, 200, deps.chaos.config);
      return true;
    }
    if (method === 'POST') {
      const body = await readJson(req);
      const patch: Partial<ChaosConfig> = {};
      for (const key of Object.keys(body)) {
        if (!CHAOS_KEYS.includes(key as keyof ChaosConfig)) throw new HttpError(400, `unknown chaos key "${key}"`);
        patch[key as keyof ChaosConfig] = body[key] as number;
      }
      try {
        sendJson(res, 200, deps.chaos.update(patch));
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      return true;
    }
  }

  const historyPath = /^\/debug\/history\/([^/]+)$/.exec(path);
  if (method === 'GET' && historyPath) {
    const history = deps.store.history(historyPath[1]!);
    if (!history) throw new HttpError(404, `unknown device "${historyPath[1]}"`);
    const now = Date.now();
    const entries = history.all();
    let ordered = true;
    for (let i = 1; i < entries.length; i++) {
      const a = entries[i - 1]!;
      const b = entries[i]!;
      if (a.bootRank > b.bootRank || (a.bootRank === b.bootRank && a.msg.seq >= b.msg.seq)) ordered = false;
    }
    sendJson(res, 200, {
      size: entries.length,
      ordered,
      entries: entries.map((e) => ({
        boot: e.msg.bootId.slice(0, 8),
        seq: e.msg.seq,
        type: e.msg.type,
        ...(e.msg.type === 'event' ? { kind: e.msg.payload.kind } : {}),
        receivedAgoMs: now - e.receivedAt,
      })),
    });
    return true;
  }

  const deviceAction = /^\/debug\/devices\/([^/]+)\/(offline|reboot)$/.exec(path);
  if (method === 'POST' && deviceAction) {
    const [, deviceId, action] = deviceAction;
    let durationMs: number | undefined;
    if (action === 'offline') {
      const body = await readJson(req);
      durationMs = body.durationMs === undefined ? 10_000 : Number(body.durationMs);
      if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 600_000) {
        throw new HttpError(400, 'durationMs must be in (0, 600000]');
      }
    }
    let info;
    try {
      info = await deps.source.deviceAction(deviceId!, action as 'offline' | 'reboot', durationMs);
    } catch (e) {
      throw new HttpError(503, (e as Error).message);
    }
    if (!info) throw new HttpError(404, `unknown device "${deviceId}"`);
    sendJson(res, 200, info);
    return true;
  }

  return false;
}

function mb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}
