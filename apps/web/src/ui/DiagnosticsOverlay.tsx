import { useState } from 'react';
import type { StatsMessage } from '@app/shared';
import type { ResumeSummary } from '../store/deviceStore.ts';
import { pool, store } from '../app.ts';
import { usePoll } from './usePoll.ts';

interface Readout {
  msgsPerSec: number;
  batchesPerSec: number;
  fps: number;
  frameCostMs: number;
  frameCostMaxMs: number;
  accepted: number;
  duplicate: number;
  outOfOrder: number;
  oldBoot: number;
  tooOld: number;
  coalescedClient: number;
  lateEvents: number;
  gaps: number;
  newBoots: number;
  crossGateway: number;
  /** One entry per configured gateway, in list order. */
  gateways: Array<{ id: string; server: StatsMessage | null; resume: ResumeSummary | null }>;
}

function read(): Readout {
  const m = store.metrics;
  const r = m.reconcile;
  return {
    gateways: pool.links.map((l) => {
      const resume = store.lastResume.get(l.id);
      return { id: l.id, server: store.serverStats.get(l.id) ?? null, resume: resume ? { ...resume } : null };
    }),
    crossGateway: m.crossGatewayDuplicates,
    msgsPerSec: m.messages.perSecond,
    batchesPerSec: m.batches.perSecond,
    fps: m.frames.perSecond,
    frameCostMs: m.frameCostMs,
    frameCostMaxMs: m.frameCostMaxMs,
    accepted: r.accepted,
    duplicate: r.duplicate,
    outOfOrder: r.outOfOrder,
    oldBoot: r.oldBoot,
    tooOld: r.tooOld,
    coalescedClient: m.coalesced,
    lateEvents: r.lateEvents,
    gaps: r.gaps,
    newBoots: r.newBoots,
  };
}

function Row({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <>
      <dt title={hint}>{label}</dt>
      <dd className="mono">{value}</dd>
    </>
  );
}

export function DiagnosticsOverlay() {
  const [open, setOpen] = useState(true);
  const d = usePoll(read, 500);

  if (!open) {
    return (
      <button className="diag diag-collapsed" onClick={() => setOpen(true)}>
        {d.msgsPerSec} msg/s · {d.fps} fps
      </button>
    );
  }

  return (
    <div className="diag">
      <div className="diag-head">
        <strong>Diagnostics</strong>
        <button className="link-button" onClick={() => setOpen(false)}>
          hide
        </button>
      </div>
      <dl>
        <Row label="received" value={`${d.msgsPerSec} msg/s`} hint="Device messages received per second (all, incl. duplicates)" />
        <Row
          label="batches"
          value={`${d.batchesPerSec} /s × ${d.batchesPerSec > 0 ? (d.msgsPerSec / d.batchesPerSec).toFixed(1) : 0}`}
          hint="Batches per second × average messages per batch"
        />
        <Row label="rendered" value={`${d.fps} fps`} hint="Frames drawn per second; follows the display, not the message rate" />
        <Row
          label="frame cost"
          value={`${d.frameCostMs.toFixed(2)} ms (max ${d.frameCostMaxMs.toFixed(1)})`}
          hint="Time spent drawing all canvases in one frame"
        />
      </dl>
      <div className="diag-sub">dropped</div>
      <dl>
        <Row label="duplicate" value={d.duplicate} hint="Same (boot, seq) seen before" />
        {pool.isMulti && (
          <Row
            label="↳ across gateways"
            value={d.crossGateway}
            hint="Duplicates whose first copy came through the other gateway: the merge at work"
          />
        )}
        <Row label="out-of-order" value={d.outOfOrder + d.tooOld} hint="State older than the one already shown" />
        <Row label="old boot" value={d.oldBoot} hint="State from a boot the device has already left" />
        <Row
          label="coalesced (frame)"
          value={d.coalescedClient}
          hint="Newer state arrived before the previous one was drawn"
        />
      </dl>
      <div className="diag-sub">accepted</div>
      <dl>
        <Row label="total" value={d.accepted} />
        <Row label="late events" value={d.lateEvents} hint="Events kept although newer messages had arrived" />
        <Row label="seq gaps" value={d.gaps} hint="Informational: skipped seq values (delayed, lost or throttled)" />
        <Row label="reboots" value={d.newBoots} />
      </dl>
      {d.gateways.map((g) => (
        <GatewaySection key={g.id} gateway={g} multi={d.gateways.length > 1} />
      ))}
    </div>
  );
}

function GatewaySection({ gateway, multi }: { gateway: Readout['gateways'][number]; multi: boolean }) {
  const { resume, server } = gateway;
  const suffix = multi ? ` · ${gateway.id}` : '';
  return (
    <>
      {resume && (
        <>
          <div className="diag-sub">last resume{suffix}</div>
          <dl>
            <Row
              label="devices"
              value={resume.pending ? 'waiting…' : `${resume.replayed} replay / ${resume.snapshots} snapshot`}
              hint="Per device: replay when the gap was in the gateway's history, snapshot otherwise (or for a new client)"
            />
            <Row
              label="recovered events"
              value={resume.recoveredEvents}
              hint="Events from replays that we did not have; duplicates from the lookback are not counted"
            />
            <Row
              label="may be missing"
              value={resume.incomplete}
              hint="Devices whose gap was no longer covered by the history; marked in the event feed"
            />
          </dl>
        </>
      )}
      {server && (
        <>
          <div className="diag-sub">gateway{suffix} (this session)</div>
          <dl>
            <Row
              label="received"
              value={`${server.gatewayReceivedPerSec} msg/s`}
              hint="Messages the gateway gets from all devices"
            />
            <Row label="sent to us" value={`${server.sentPerSec} msg/s`} />
            <Row
              label="coalesced"
              value={server.coalesced}
              hint="States replaced in the gateway's per-device slot before being sent (maxHz, backpressure)"
            />
            <Row label="queue" value={server.queueDepth} hint="Events and presence waiting to be sent to us" />
            <Row
              label="socket buffer"
              value={`${(server.bufferedAmount / 1024).toFixed(0)} KB`}
              hint="Bytes the gateway could not push to us yet"
            />
            <Row
              label="backpressure"
              value={`${server.backpressureSkips} skips, ${server.resyncs} resync`}
              hint="Ticks skipped because our socket was full; resyncs after queue overflow"
            />
            <Row label="heap" value={`${server.heapUsedMb} MB`} />
          </dl>
        </>
      )}
    </>
  );
}
