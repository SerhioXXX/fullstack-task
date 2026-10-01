import { memo } from 'react';
import { store } from '../app.ts';
import type { EventEntry, FeedEntry } from '../store/deviceStore.ts';
import { usePoll } from './usePoll.ts';

const SHOWN = 60;

function formatTime(wall: number): string {
  const d = new Date(wall);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function describe(entry: EventEntry): string {
  const p = entry.msg.payload;
  const value = p.value !== undefined ? ` (${p.value})` : '';
  return `${p.message ?? p.kind}${value}`;
}

function DeviceTag({ deviceId }: { deviceId: string }) {
  return (
    <span className="event-device">
      <span className="swatch" style={{ background: store.devices.get(deviceId)?.color }} />
      {deviceId}
    </span>
  );
}

export const EventRow = memo(function EventRow({ entry, showDevice }: { entry: FeedEntry; showDevice: boolean }) {
  if (entry.kind === 'missing') {
    return (
      <div
        className="event-row event-missing"
        onClick={() => store.select(entry.deviceId)}
        title="After a reconnect the gateway's history no longer covered the gap, so events in it may be lost"
      >
        <span className="event-time mono">{formatTime(entry.receivedWall)}</span>
        {showDevice && <DeviceTag deviceId={entry.deviceId} />}
        <span className="event-kind">gap</span>
        <span className="event-text">Events may be missing</span>
        <span className="event-meta mono">after #{entry.afterSeq}</span>
      </div>
    );
  }
  const { severity, kind } = entry.msg.payload;
  return (
    <div className={`event-row severity-${severity}`} onClick={() => store.select(entry.deviceId)}>
      <span className="event-time mono">{formatTime(entry.receivedWall)}</span>
      {showDevice && <DeviceTag deviceId={entry.deviceId} />}
      <span className={`event-kind kind-${kind}`}>{kind}</span>
      <span className="event-text">{describe(entry)}</span>
      <span className="event-meta mono">
        #{entry.msg.seq}
        {entry.late && <span className="tag tag-late" title="Arrived after newer messages of this device; placed by seq">late</span>}
        {entry.historical && (
          <span className="tag tag-old" title="From the gateway's history in the snapshot; the time shown is when we received it">
            history
          </span>
        )}
        {entry.fromOldBoot && <span className="tag tag-old" title="Belongs to a previous boot of the device">old boot</span>}
      </span>
    </div>
  );
});

/**
 * Global feed in arrival order: device clocks differ, so there is no trustworthy cross-device
 * order. Within one device, events are ordered by (boot, seq) in the device panel.
 */
export function EventFeed() {
  const version = usePoll(() => store.feedVersion, 250);
  const entries = store.feed.slice(-SHOWN).reverse();

  return (
    <section className="panel">
      <h2>
        Events <span className="muted">({store.feed.length}, never dropped)</span>
      </h2>
      <div className="event-feed" data-version={version}>
        {entries.length === 0 && <div className="muted">Waiting for events…</div>}
        {entries.map((e) => (
          <EventRow key={e.id} entry={e} showDevice />
        ))}
      </div>
    </section>
  );
}
