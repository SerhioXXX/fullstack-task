const env = import.meta.env;

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function list(value: string | undefined, fallback: string[]): string[] {
  const items = (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : fallback;
}

export const config = {
  /** Gateways to connect to at once; the first reachable one is primary (control messages). */
  wsUrls: list(env.VITE_WS_URLS, ['ws://localhost:8080/ws']),
  /** First reconnect delay ceiling; doubles per attempt up to reconnectMaxMs (full jitter below it). */
  reconnectBaseMs: num(env.VITE_RECONNECT_BASE_MS, 500),
  reconnectMaxMs: num(env.VITE_RECONNECT_MAX_MS, 10_000),
  /** No data at all (not even a heartbeat) for this long means the link is dead. */
  connectionTimeoutMs: num(env.VITE_CONNECTION_TIMEOUT_MS, 4_000),
};
