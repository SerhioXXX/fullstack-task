import type { ClientMessage, ServerMessage } from '@app/shared';
import { backoffDelay } from './backoff.ts';

export type ConnectionState =
  /** First attempt or an attempt in flight. */
  | 'connecting'
  | 'open'
  /** Waiting for the next attempt after a failure. */
  | 'reconnecting'
  /** The browser reports no network; we wait for the `online` event instead of retrying. */
  | 'browser-offline';

export interface ConnectionStatus {
  state: ConnectionState;
  url: string;
  /** Failed attempts since the last stable connection. */
  attempt: number;
  /** performance.now() of the next attempt while reconnecting. */
  nextAttemptAt: number | null;
  /** performance.now() of the last received frame. */
  lastMessageAt: number | null;
  openedAt: number | null;
  lastClose: { code: number; reason: string } | null;
}

export interface ConnectionOptions {
  url: string;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  /** No frame at all for this long while open = dead link (half-open TCP never fires `close`). */
  timeoutMs: number;
}

export interface ConnectionHandlers {
  onOpen?(): void;
  onMessage(msg: ServerMessage): void;
  onClose?(): void;
}

/** An open link has to survive this long before the backoff attempt counter is reset. */
const STABLE_AFTER_MS = 5_000;
const WATCHDOG_INTERVAL_MS = 500;

/**
 * Owns the WebSocket outside React. React reads `status` through useSyncExternalStore;
 * messages go straight to handlers without touching component state.
 */
export class Connection {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus;
  private readonly listeners = new Set<() => void>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(
    private readonly options: ConnectionOptions,
    private readonly handlers: ConnectionHandlers,
  ) {
    this.status = {
      state: 'connecting',
      url: options.url,
      attempt: 0,
      nextAttemptAt: null,
      lastMessageAt: null,
      openedAt: null,
      lastClose: null,
    };
  }

  // --- useSyncExternalStore API ---
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getStatus = (): ConnectionStatus => this.status;

  get isOpen(): boolean {
    return this.status.state === 'open';
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    window.addEventListener('online', this.onBrowserOnline);
    window.addEventListener('offline', this.onBrowserOffline);
    this.watchdog = setInterval(this.checkLiveness, WATCHDOG_INTERVAL_MS);
    if (navigator.onLine) this.connect();
    else this.update({ state: 'browser-offline' });
  }

  stop(): void {
    this.started = false;
    window.removeEventListener('online', this.onBrowserOnline);
    window.removeEventListener('offline', this.onBrowserOffline);
    if (this.watchdog) clearInterval(this.watchdog);
    this.clearRetry();
    this.discardSocket(1000, 'client stopped');
  }

  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** Skips the remaining backoff delay. */
  reconnectNow(): void {
    if (this.status.state === 'open' || this.status.state === 'connecting') return;
    this.clearRetry();
    this.connect();
  }

  private connect(): void {
    this.discardSocket(1000, 'reconnecting');
    this.update({ state: 'connecting', nextAttemptAt: null });

    const ws = new WebSocket(this.options.url);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      const now = performance.now();
      this.update({ state: 'open', openedAt: now, lastMessageAt: now });
      this.handlers.onOpen?.();
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      // Mutate instead of update(): this runs hundreds of times per second and no UI depends on it directly.
      this.status.lastMessageAt = performance.now();
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return;
      }
      this.handlers.onMessage(msg);
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.handleLoss(event.code, event.reason || 'closed');
    };

    // `error` is always followed by `close`; nothing to do here.
    ws.onerror = () => {};
  }

  private handleLoss(code: number, reason: string): void {
    const wasOpenFor = this.status.openedAt !== null ? performance.now() - this.status.openedAt : 0;
    const wasOpen = this.status.state === 'open';
    this.discardSocket(4001, reason);
    if (wasOpen) this.handlers.onClose?.();

    const attempt = wasOpen && wasOpenFor >= STABLE_AFTER_MS ? 0 : this.status.attempt + 1;
    if (!this.started) return;
    if (!navigator.onLine) {
      this.update({ state: 'browser-offline', attempt, openedAt: null, lastClose: { code, reason } });
      return;
    }

    const delay = backoffDelay(attempt, this.options.reconnectBaseMs, this.options.reconnectMaxMs);
    this.update({
      state: 'reconnecting',
      attempt,
      openedAt: null,
      nextAttemptAt: performance.now() + delay,
      lastClose: { code, reason },
    });
    this.clearRetry();
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private readonly checkLiveness = (): void => {
    const { state, lastMessageAt } = this.status;
    if (state !== 'open' || lastMessageAt === null) return;
    if (performance.now() - lastMessageAt > this.options.timeoutMs) {
      this.handleLoss(4002, `no data for ${this.options.timeoutMs} ms`);
    }
  };

  private readonly onBrowserOnline = (): void => {
    if (this.status.state === 'browser-offline' || this.status.state === 'reconnecting') {
      this.clearRetry();
      this.update({ attempt: 0 });
      this.connect();
    }
  };

  private readonly onBrowserOffline = (): void => {
    if (this.status.state === 'open') this.handleLoss(4003, 'browser offline');
  };

  /** Detaches handlers first, so a socket that closes late can never affect the current one. */
  private discardSocket(code: number, reason: string): void {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try {
        ws.close(code >= 4000 || code === 1000 ? code : 1000, reason.slice(0, 120));
      } catch {
        /* closing a socket that is already failing can throw; it is discarded either way */
      }
    }
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private update(patch: Partial<ConnectionStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const l of this.listeners) l();
  }
}
