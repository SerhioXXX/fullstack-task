import { useSyncExternalStore } from 'react';
import { pool } from '../app.ts';
import type { ConnectionStatus } from '../net/connection.ts';
import type { LinkStatus } from '../net/gatewayPool.ts';
import { usePoll } from './usePoll.ts';

export function useLinkStatuses(): LinkStatus[] {
  return useSyncExternalStore(pool.subscribe, pool.getStatuses);
}

function describe(status: ConnectionStatus, now: number): { text: string; tone: 'ok' | 'warn' | 'bad' } {
  switch (status.state) {
    case 'open':
      return { text: 'Connected', tone: 'ok' };
    case 'connecting':
      return { text: status.attempt === 0 ? 'Connecting…' : `Connecting… (attempt ${status.attempt + 1})`, tone: 'warn' };
    case 'reconnecting': {
      const left = status.nextAttemptAt === null ? 0 : Math.max(0, (status.nextAttemptAt - now) / 1000);
      return { text: `Reconnecting in ${left.toFixed(1)} s (attempt ${status.attempt})`, tone: 'bad' };
    }
    case 'browser-offline':
      return { text: 'No network — waiting for the browser to come online', tone: 'bad' };
  }
}

function LinkBadge({ status, now, multi }: { status: LinkStatus; now: number; multi: boolean }) {
  const link = pool.links.find((l) => l.id === status.id)!;
  const { text, tone } = describe(status, now);
  const lastMessageAt = link.connection.getStatus().lastMessageAt;
  const quietFor = lastMessageAt === null ? null : (now - lastMessageAt) / 1000;
  const name = status.serverId ?? status.url;

  return (
    <div className={`badge badge-${tone}`} title={`${name} — ${status.url}`}>
      <span className="badge-dot" />
      {multi && (
        <strong>
          {status.id}
          {status.primary && <span className="badge-primary" title="Primary: receives control messages (stress)">★</span>}
        </strong>
      )}
      <span>{text}</span>
      {status.state === 'open' && quietFor !== null && quietFor > 1.5 && (
        <span className="badge-sub">no data for {quietFor.toFixed(1)} s</span>
      )}
      {status.state !== 'open' && status.lastClose && (
        <span className="badge-sub">
          last close: {status.lastClose.code} {status.lastClose.reason}
        </span>
      )}
      {status.state === 'reconnecting' && (
        <button className="link-button" onClick={() => link.connection.reconnectNow()}>
          retry now
        </button>
      )}
    </div>
  );
}

export function ConnectionBadge() {
  const statuses = useLinkStatuses();
  const now = usePoll(() => performance.now(), 100);
  return (
    <div className="badges">
      {statuses.map((s) => (
        <LinkBadge key={s.id} status={s} now={now} multi={pool.isMulti} />
      ))}
    </div>
  );
}

/** Full-map banner: a lost connection must not look like every device going offline (D1). */
export function ConnectionLostBanner() {
  const statuses = useLinkStatuses();
  const now = usePoll(() => performance.now(), 100);
  // With one gateway left the devices it hears are live; the rest show `unknown` on their own.
  if (statuses.some((s) => s.state === 'open')) return null;
  const { text } = describe(statuses[0]!, now);
  return (
    <div className="map-banner">
      <strong>{statuses.length > 1 ? 'Connection to all gateways lost' : 'Connection to gateway lost'}</strong>
      <span>{text}</span>
      <span className="map-banner-sub">Device states below are frozen at the last known values.</span>
    </div>
  );
}
