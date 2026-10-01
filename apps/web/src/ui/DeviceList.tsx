import { pool, store } from '../app.ts';
import type { DisplayStatus } from '../store/deviceStore.ts';
import { usePoll, usePollWithRefresh } from './usePoll.ts';

interface Row {
  deviceId: string;
  color: string;
  status: DisplayStatus;
  silentS: number;
  bootId: string;
  seq: number;
  battery: number | null;
  sensor: number | null;
  bootCount: number;
  subscribed: boolean;
  via: string[];
  lastVia: string | null;
}

function toggleSubscribed(deviceId: string, on: boolean): void {
  const excluded = new Set(store.subscription?.excluded);
  if (on) excluded.delete(deviceId);
  else excluded.add(deviceId);
  store.updateSubscription({ excluded });
}

function readRows(): Row[] {
  const now = performance.now();
  const connected = pool.isOpen;
  return [...store.devices.values()]
    .sort((a, b) => a.deviceId.localeCompare(b.deviceId, undefined, { numeric: true }))
    .map((v) => ({
      deviceId: v.deviceId,
      color: v.color,
      status: store.statusOf(v, now, connected),
      silentS: (now - v.lastAcceptedAt) / 1000,
      bootId: v.cursor.bootId?.slice(0, 8) ?? '—',
      seq: v.cursor.lastSeq,
      battery: v.state?.payload.battery ?? null,
      sensor: v.state?.payload.sensor ?? null,
      bootCount: v.bootCount,
      subscribed: store.isSubscribed(v.deviceId),
      via: store.viaOf(v),
      lastVia: v.lastVia,
    }));
}

export function DeviceList() {
  const [rows, refresh] = usePollWithRefresh(readRows, 250);
  const selectedId = usePoll(() => store.selectedId, 100);

  return (
    <table className="device-table">
      <thead>
        <tr>
          <th title="Subscribed: the gateway sends this device to us">sub</th>
          <th>device</th>
          <th>status</th>
          {pool.isMulti && <th title="Gateways that currently hear the device; bold = delivered the last accepted message">via</th>}
          <th>boot</th>
          <th className="num">seq</th>
          <th className="num">sensor</th>
          <th className="num">battery</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.deviceId}
            className={r.deviceId === selectedId ? 'selected' : undefined}
            onClick={() => store.select(r.deviceId)}
          >
            <td onClick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={r.subscribed}
                onChange={(e) => {
                  toggleSubscribed(r.deviceId, e.target.checked);
                  refresh();
                }}
              />
            </td>
            <td>
              <span className="swatch" style={{ background: r.color }} />
              {r.deviceId}
            </td>
            <td>
              <span className={`status status-${r.status}`}>{r.status}</span>
              {(r.status === 'stale' || r.status === 'offline') && (
                <span className="muted"> {r.silentS.toFixed(r.status === 'stale' ? 1 : 0)}s</span>
              )}
            </td>
            {pool.isMulti && (
              <td className="mono">
                {r.via.length === 0
                  ? '—'
                  : r.via.map((g, i) => (
                      <span key={g}>
                        {i > 0 && '+'}
                        {g === r.lastVia ? <strong>{g}</strong> : <span className="muted">{g}</span>}
                      </span>
                    ))}
              </td>
            )}
            <td className="mono">
              {r.bootId}
              {r.bootCount > 0 && <span className="muted"> ↻{r.bootCount}</span>}
            </td>
            <td className="num mono">{r.seq}</td>
            <td className="num mono">{r.sensor?.toFixed(1) ?? '—'}</td>
            <td className="num mono">{r.battery !== null ? `${r.battery.toFixed(0)}%` : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
