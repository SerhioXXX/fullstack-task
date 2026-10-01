export const PROTOCOL_VERSION = 1;

/** Devices move inside [0, WORLD_SIZE] x [0, WORLD_SIZE]. */
export const WORLD_SIZE = 1000;

// ---------- Device messages ----------

export interface StatePayload {
  x: number;
  y: number;
  sensor: number;
  battery: number;
}

export type EventKind = 'low_battery' | 'alert' | 'rebooted';
export type EventSeverity = 'info' | 'warning' | 'critical';

export interface EventPayload {
  kind: EventKind;
  severity: EventSeverity;
  message?: string;
  value?: number;
}

interface BaseMessage {
  deviceId: string;
  bootId: string;
  /** Monotonic within one bootId; shared by state and event messages. */
  seq: number;
  /** Device clock, ms. Comparable only within the same device. */
  ts: number;
}

export interface StateMessage extends BaseMessage {
  type: 'state';
  payload: StatePayload;
}

export interface EventMessage extends BaseMessage {
  type: 'event';
  payload: EventPayload;
}

export type DeviceMessage = StateMessage | EventMessage;

// ---------- Server -> client ----------

export type PresenceStatus = 'online' | 'offline';

export interface GatewayConfigInfo {
  offlineAfterMs: number;
  historyMaxMessages: number;
  stress: boolean;
  /** State rate per device used until the client subscribes; null = no limit. */
  defaultMaxHz: number | null;
}

export interface DeviceSnapshot {
  deviceId: string;
  bootId: string;
  seq: number;
  ts: number;
  state: StatePayload;
  status: PresenceStatus;
  /** Measured on the server clock, so the client never compares clocks. */
  lastSeenAgoMs: number;
  /** Oldest first; may include tail events of the boot the client's cursor was in. */
  recentEvents: EventMessage[];
  /** Answer to a resume whose gap the history no longer covers: events in the gap may be missing. */
  eventsIncomplete: boolean;
}

export interface HelloMessage {
  t: 'hello';
  serverId: string;
  serverTime: number;
  protocol: number;
  config: GatewayConfigInfo;
}

export interface SnapshotMessage {
  t: 'snapshot';
  /** 'subscribe': devices just added to the subscription. */
  reason: 'initial' | 'resync' | 'subscribe';
  devices: DeviceSnapshot[];
}

/**
 * Answer to `resume` for a device whose gap is fully in the gateway's history: the events of the gap
 * (plus a lookback for events delayed past the cursor) and the latest state, in emission order.
 */
export interface ReplayMessage {
  t: 'replay';
  deviceId: string;
  bootId: string;
  /** The client's cursor seq. */
  fromSeq: number;
  /** Seq of the gateway's latest state. */
  toSeq: number;
  /** Every state of the gap is included (so a chart can be filled), not only the latest one. */
  statesIncluded: boolean;
  items: DeviceMessage[];
  /** The device may have gone silent during the gap; same meaning as in DeviceSnapshot. */
  status: PresenceStatus;
  lastSeenAgoMs: number;
}

export interface BatchMessage {
  t: 'batch';
  serverTime: number;
  items: DeviceMessage[];
}

export interface PresenceMessage {
  t: 'presence';
  deviceId: string;
  status: PresenceStatus;
  lastSeenAgoMs: number;
}

/** The session's queue overflowed and was cleared; the client answers with `resume`. */
export interface ResyncMessage {
  t: 'resync';
}

/** Sent when nothing else went to the client for HEARTBEAT_IDLE_MS, so silence always means a dead link. */
export interface HeartbeatMessage {
  t: 'heartbeat';
  serverTime: number;
}

export const HEARTBEAT_IDLE_MS = 1000;

/** Sent every second; counters are totals for this session. */
export interface StatsMessage {
  t: 'stats';
  stress: boolean;
  /** Device messages the gateway receives from all devices (after chaos). */
  gatewayReceivedPerSec: number;
  /** Device messages sent to this client. */
  sentPerSec: number;
  /** States replaced in a slot before being sent (server-side throttling). */
  coalesced: number;
  /** Ticks on which nothing was sent because the socket buffer was full. */
  backpressureSkips: number;
  resyncs: number;
  queueDepth: number;
  bufferedAmount: number;
  heapUsedMb: number;
}

export type ServerMessage =
  | HelloMessage
  | SnapshotMessage
  | ReplayMessage
  | BatchMessage
  | PresenceMessage
  | ResyncMessage
  | HeartbeatMessage
  | StatsMessage;

// ---------- Client -> server ----------

export interface ResumeCursor {
  bootId: string;
  seq: number;
}

/**
 * Sent after every `hello` and in answer to `resync`; the gateway sends nothing live before it.
 * Empty cursors = a new client, which gets a snapshot of every device.
 */
export interface ResumeRequest {
  t: 'resume';
  cursors: Record<string, ResumeCursor>;
}

export interface SubscribeRequest {
  t: 'subscribe';
  devices: string[] | '*';
  /** State updates per second per device; null = no limit. Events and presence are never limited. */
  maxHz: number | null;
  /** Overrides maxHz for some devices (e.g. a higher rate for the one shown on the chart). */
  perDevice?: Record<string, number | null>;
}

export interface ControlRequest {
  t: 'control';
  stress?: boolean;
}

export type ClientMessage = ResumeRequest | SubscribeRequest | ControlRequest;
