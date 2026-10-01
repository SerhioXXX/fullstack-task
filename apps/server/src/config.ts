import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Repo-root .env is optional; variables already set in the environment win over the file.
const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Env ${name} must be a number, got "${raw}"`);
  return value;
}

function flag(name: string): boolean {
  const raw = process.env[name];
  return raw !== undefined && raw !== '' && raw !== '0' && raw.toLowerCase() !== 'false';
}

/** "1" / "*" = all devices, "dev-1,dev-3" = only those, unset = off. */
function deviceList(name: string): Set<string> | 'all' | null {
  const raw = process.env[name];
  if (!raw || raw === '0') return null;
  if (raw === '1' || raw === '*') return 'all';
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

/** Unset, "" or "*" = every device (null), "dev-1,dev-3" = only those. */
function deviceFilter(name: string): Set<string> | null {
  const raw = process.env[name]?.trim();
  if (!raw || raw === '*') return null;
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

export const config = {
  port: num('PORT', 8080),
  gatewayId: process.env.GATEWAY_ID ?? 'gw-a',
  /** Devices this gateway accepts; null = all. Two gateways with overlapping filters share devices. */
  deviceFilter: deviceFilter('DEVICE_FILTER'),

  /** Gateway: '' = run the simulator in-process; otherwise the separate simulator's WebSocket. */
  simUrl: process.env.SIM_URL ?? '',
  /** Gateway: fixed extra delay on the device link, before chaos (makes one gateway slower). */
  linkLatencyMs: num('LINK_LATENCY_MS', 0),
  /** Separate simulator process (npm run dev:mesh): port it serves devices on. */
  simPort: num('SIM_PORT', 8079),

  deviceCount: Math.min(8, Math.max(1, Math.round(num('DEVICE_COUNT', 8)))),
  stress: flag('STRESS'),
  /** < 1 makes offline/reboot/spike happen more often (0.2 = five times more often). */
  lifecycleScale: num('SIM_LIFECYCLE_SCALE', 1),

  /** Silence after which the gateway reports a device offline; must exceed chaos.maxDelayMs. */
  offlineAfterMs: num('OFFLINE_AFTER_MS', 5_000),
  historyMaxMessages: num('HISTORY_MAX_MESSAGES', 500),
  historyMaxAgeMs: num('HISTORY_MAX_AGE_MS', 60_000),
  /** A resume answer larger than this becomes a snapshot instead of a replay. */
  replayMaxMessages: num('REPLAY_MAX_MESSAGES', 300),
  /** Events received this long before the cursor's message are replayed too; must exceed chaos.maxDelayMs. */
  replayEventLookbackMs: num('REPLAY_EVENT_LOOKBACK_MS', 5_000),
  batchIntervalMs: num('BATCH_INTERVAL_MS', 50),
  pingIntervalMs: num('WS_PING_INTERVAL_MS', 10_000),

  /** State updates per second per device until a client subscribes; 0 = no limit. */
  defaultMaxHz: num('DEFAULT_MAX_HZ', 10) || null,
  /** Above this many bytes waiting in a client socket, nothing more is sent to it on that tick. */
  backpressureBytes: num('WS_BACKPRESSURE_BYTES', 512 * 1024),
  /** Events + presence (+ states with no limit) waiting for one client; overflow triggers resync. */
  clientQueueMax: num('CLIENT_QUEUE_MAX', 1000),

  chaos: {
    delayProbability: num('CHAOS_DELAY_PROB', 0.2),
    minDelayMs: num('CHAOS_MIN_DELAY_MS', 100),
    maxDelayMs: num('CHAOS_MAX_DELAY_MS', 3000),
    duplicateProbability: num('CHAOS_DUP_PROB', 0.05),
    duplicateMaxDelayMs: num('CHAOS_DUP_MAX_DELAY_MS', 1000),
  },

  debugSim: flag('DEBUG_SIM'),
  debugIngest: deviceList('DEBUG_INGEST'),
 };

export type Config = typeof config;
