import { ConnectionBadge } from './ui/ConnectionBadge.tsx';
import { ControlBar } from './ui/ControlBar.tsx';
import { DeviceList } from './ui/DeviceList.tsx';
import { DevicePanel } from './ui/DevicePanel.tsx';
import { EventFeed } from './ui/EventFeed.tsx';
import { MapView } from './ui/MapView.tsx';

export function App() {
  return (
    <div className="layout">
      <header className="header">
        <h1>Live Device Map</h1>
        <ConnectionBadge />
        <ControlBar />
        <ul className="legend-inline">
          <li>
            <span className="legend-dot online" /> online
          </li>
          <li title="Quieter than ~3 of its usual intervals">
            <span className="legend-dot stale" /> stale
          </li>
          <li title="Gateway reports silence ≥ 5 s; marker stays at the last known position">
            <span className="legend-dot offline" /> offline
          </li>
          <li title="No connection to the gateway, or the device is unsubscribed; states are frozen">
            <span className="legend-dot unknown" /> unknown
          </li>
        </ul>
      </header>
      <main className="main">
        <MapView />
        <aside className="side">
          <DevicePanel />
          <section className="panel">
            <h2>Devices</h2>
            <DeviceList />
          </section>
          <EventFeed />
        </aside>
      </main>
    </div>
  );
}
