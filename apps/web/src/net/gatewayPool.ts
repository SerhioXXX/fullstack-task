import type { ClientMessage, ServerMessage } from '@app/shared';
import { Connection, type ConnectionOptions, type ConnectionStatus } from './connection.ts';

export interface GatewayLink {
  /** Short stable name by position in the URL list ("A", "B"); used for "via" labels and per-gateway state. */
  readonly id: string;
  readonly connection: Connection;
  /** `serverId` from the gateway's hello, once known. */
  serverId: string | null;
}

export interface LinkStatus extends ConnectionStatus {
  id: string;
  serverId: string | null;
  primary: boolean;
}

export interface PoolHandlers {
  onMessage(link: GatewayLink, msg: ServerMessage): void;
  /** The link was open and is now lost; whatever only it delivered has no path any more. */
  onClose(link: GatewayLink): void;
}

/**
 * One connection per gateway, each with its own backoff (T9.4). All of them feed the same store;
 * the primary - the first open one in list order - takes control messages, and fails over to the
 * next open one when it drops.
 */
export class GatewayPool {
  readonly links: GatewayLink[];
  private readonly listeners = new Set<() => void>();
  private statuses: LinkStatus[] = [];

  constructor(urls: string[], options: Omit<ConnectionOptions, 'url'>, handlers: PoolHandlers) {
    this.links = urls.map((url, i) => {
      const link: GatewayLink = {
        id: String.fromCharCode(65 + i),
        serverId: null,
        connection: new Connection(
          { ...options, url },
          {
            onMessage: (msg) => {
              if (msg.t === 'hello' && link.serverId !== msg.serverId) {
                link.serverId = msg.serverId;
                this.changed();
              }
              handlers.onMessage(link, msg);
            },
            onClose: () => handlers.onClose(link),
          },
        ),
      };
      link.connection.subscribe(() => this.changed());
      return link;
    });
    this.recompute();
  }

  get isMulti(): boolean {
    return this.links.length > 1;
  }

  /** At least one gateway is reachable. */
  get isOpen(): boolean {
    return this.links.some((l) => l.connection.isOpen);
  }

  get primary(): GatewayLink | null {
    return this.links.find((l) => l.connection.isOpen) ?? null;
  }

  sendPrimary(msg: ClientMessage): boolean {
    return this.primary?.connection.send(msg) ?? false;
  }

  sendAll(msg: ClientMessage): void {
    for (const l of this.links) l.connection.send(msg);
  }

  start(): void {
    for (const l of this.links) l.connection.start();
  }

  stop(): void {
    for (const l of this.links) l.connection.stop();
  }

  // --- useSyncExternalStore API ---
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getStatuses = (): LinkStatus[] => this.statuses;

  private changed(): void {
    this.recompute();
    for (const l of this.listeners) l();
  }

  private recompute(): void {
    const primary = this.primary;
    this.statuses = this.links.map((l) => ({
      ...l.connection.getStatus(),
      id: l.id,
      serverId: l.serverId,
      primary: l === primary,
    }));
  }
}
