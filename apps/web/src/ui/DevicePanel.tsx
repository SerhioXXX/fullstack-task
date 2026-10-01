import { useEffect, useRef } from 'react';
import { frameLoop, pool, store } from '../app.ts';
import { SensorChart } from '../render/sensorChart.ts';
import { SensorPulse } from '../render/sensorPulse.ts';
import type { DisplayStatus, FeedEntry } from '../store/deviceStore.ts';
import { EventRow } from '../ui/EventFeed.tsx';
import { usePoll } from './usePoll.ts';

interface Summary {
  deviceId: string;
  color: string;
  status: DisplayStatus;
  silentS: number;
  bootId: string;
  bootCount: number;
  seq: number;
  battery: number;
  sensor: number;
  x: number;
  y: number;
  intervalMs: number;
  events: FeedEntry[];
  eventsVersion: number;
}

function readSummary(): Summary | null {
  const id = store.selectedId;
  const v = id ? store.devices.get(id) : undefined;
  if (!v?.state) return null;
  const now = performance.now();
  return {
    deviceId: v.deviceId,
    color: v.color,
    status: store.statusOf(v, now, pool.isOpen),
    silentS: (now - v.lastAcceptedAt) / 1000,
    bootId: v.cursor.bootId?.slice(0, 8) ?? '—',
    bootCount: v.bootCount,
    seq: v.cursor.lastSeq,
    battery: v.state.payload.battery,
    sensor: v.state.payload.sensor,
    x: v.state.payload.x,
    y: v.state.payload.y,
    intervalMs: v.intervalEmaMs,
    events: v.events.slice(-8).reverse(),
    eventsVersion: v.events.length,
  };
}

/** Canvases are mounted once and follow the selection themselves, every frame. */
function useCanvas<T extends { destroy(): void }>(create: (canvas: HTMLCanvasElement) => T) {
  const ref = useRef<HTMLCanvasElement>(null);
  const createRef = useRef(create);
  useEffect(() => {
    const instance = createRef.current(ref.current!);
    return () => instance.destroy();
  }, []);
  return ref;
}

export function DevicePanel() {
  const s = usePoll(readSummary, 250);
  const pulseRef = useCanvas((c) => new SensorPulse(c, store, pool, frameLoop));
  const chartRef = useCanvas((c) => new SensorChart(c, store, pool, frameLoop));

  return (
    <section className="panel device-panel">
      <div className="device-panel-head">
        <h2>
          {s ? (
            <>
              <span className="swatch" style={{ background: s.color }} />
              {s.deviceId}
            </>
          ) : (
            'Device'
          )}
        </h2>
        {s && (
          <span className={`status status-${s.status}`}>
            {s.status}
            {(s.status === 'stale' || s.status === 'offline') && ` · ${s.silentS.toFixed(1)}s`}
          </span>
        )}
      </div>

      <div className="device-panel-live">
        <canvas ref={pulseRef} className="pulse-canvas" />
        <dl className="facts">
          <dt>sensor</dt>
          <dd className="mono">{s ? s.sensor.toFixed(2) : '—'}</dd>
          <dt>battery</dt>
          <dd>
            {s ? (
              <span className="battery">
                <span
                  className={`battery-fill ${s.battery <= 20 ? 'low' : ''}`}
                  style={{ width: `${Math.max(0, Math.min(100, s.battery))}%` }}
                />
                <span className="battery-text mono">{s.battery.toFixed(0)}%</span>
              </span>
            ) : (
              '—'
            )}
          </dd>
          <dt>boot</dt>
          <dd className="mono">
            {s?.bootId ?? '—'}
            {s && s.bootCount > 0 && <span className="muted"> ↻{s.bootCount}</span>}
          </dd>
          <dt>seq</dt>
          <dd className="mono">{s?.seq ?? '—'}</dd>
          <dt>position</dt>
          <dd className="mono">{s ? `${s.x.toFixed(0)}, ${s.y.toFixed(0)}` : '—'}</dd>
          <dt>rate</dt>
          <dd className="mono">{s ? `${(1000 / Math.max(1, s.intervalMs)).toFixed(1)} /s` : '—'}</dd>
        </dl>
      </div>

      <canvas ref={chartRef} className="chart-canvas" />

      <div className="device-events">
        {s && s.events.length === 0 && <div className="muted">No events from this device yet.</div>}
        {s?.events.map((e) => <EventRow key={e.id} entry={e} showDevice={false} />)}
      </div>
    </section>
  );
}
