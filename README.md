# Live Device Map

A real-time device map: a Node.js gateway streams simulated devices over WebSocket through a network-chaos layer (delays, duplicates, reordering), and a React client draws them on a canvas at display rate. The client reconciles out-of-order, duplicated, and late data, throttles per subscription, and resumes after reconnects without losing events. The optional stretch is implemented: two gateways see overlapping device subsets with different latency, and the client keeps both connections and merges their streams.

```
devices (simulator) ──► chaos (delay / duplicate) ──► gateway: reconcile, history, presence, per-client throttling ──WS──► client: reconcile, render
```

Monorepo (npm workspaces):

| Path | What |
|---|---|
| `packages/shared` | Protocol types and the ordering/dedup logic (`reconcile.ts`, `seenWindow.ts`), used by both the gateway and the client |
| `apps/server` | Gateway: simulator, chaos, device store with history, resume/replay, client sessions with throttling and backpressure, debug HTTP API |
| `apps/web` | React 18 + Vite client: connection layer outside React, canvas map, live sensor chart, event feed, diagnostics overlay |
| `scripts` | Two-gateway launcher and console tools (probe, slow client, resume check) |
## Running

Requires Node.js 20.12+ (uses `process.loadEnvFile`).

```bash
npm install
npm run dev          # gateway on :8080 (simulator in-process) + web on http://localhost:5173
```

| Command | What it does |
|---|---|
| `npm run dev` | One gateway with the simulator inside it, plus the web client |
| `npm run dev:mesh` | Stretch mode: separate simulator (`:8079`), gateway A (`:8080`, devices 1–6, no extra latency), gateway B (`:8081`, devices 3–8, +300 ms), web connected to both. `npm run dev:mesh -- --only gw-a` restarts a single process |
| `npm test` | Unit tests (vitest): 48 tests, about 0.5 s |
| `npm run typecheck` | Strict `tsc` over all packages and scripts |
| `npm run probe` | Console WebSocket client: prints what the gateway sends (`-- --seconds 10 --url ws://localhost:8081/ws`) |
| `npm run resume-check` | Connects, disconnects for `--gap` seconds, reconnects with its cursors, and checks that no event the gateway received was lost (`-- --gap 70` for a gap longer than the history) |
| `npm run slow-client` | A client that stops reading its socket, to show that gateway memory per slow client stays bounded |
| `npm run demo:reconcile` | Prints reconcile verdicts for a scripted sequence of duplicates, reordering, and a reboot |

### Configuration

Everything has a default, so no `.env` is needed. To change settings, copy the templates and edit them; every variable is documented there:

- `.env.example` → `.env` (gateway and simulator: ports, presence threshold, history size, replay limits, throttling, backpressure, chaos, debug logging);
- `apps/web/.env.example` → `apps/web/.env` (gateway URLs, reconnect backoff, dead-link timeout).

Priority: shell environment → `.env` → default in the app's `config.ts`. A one-off run, for example: `STRESS=1 npm run dev` (PowerShell: `$env:STRESS="1"; npm run dev`).

### Stress mode, dropped connections, chaos

The examples use `curl`. In Windows PowerShell call `curl.exe`, because `curl` there is an alias for `Invoke-WebRequest`.

```bash
# Stress mode: ~125 msg/s per device, ~1000 msg/s total. Also the "stress" button in the UI header.
curl -X POST localhost:8080/debug/stress -H "Content-Type: application/json" -d '{"enabled":true}'

# Drop all client connections (close frame); mode=terminate kills the TCP socket without a close frame
curl -X POST localhost:8080/debug/drop-connections
curl -X POST "localhost:8080/debug/drop-connections?mode=terminate"

# Chaos: read or change at runtime (any subset of the keys)
curl localhost:8080/debug/chaos
curl -X POST localhost:8080/debug/chaos -H "Content-Type: application/json" \
  -d '{"delayProbability":0.5,"minDelayMs":100,"maxDelayMs":3000,"duplicateProbability":0.1,"duplicateMaxDelayMs":1000}'

# Force a single device offline or reboot it
curl -X POST localhost:8080/debug/devices/dev-3/offline -H "Content-Type: application/json" -d '{"durationMs":15000}'
curl -X POST localhost:8080/debug/devices/dev-3/reboot

# Inspect state
curl localhost:8080/debug/stats
curl localhost:8080/debug/history/dev-3
```

Chaos defaults are set by `CHAOS_DELAY_PROB`, `CHAOS_MIN_DELAY_MS`, `CHAOS_MAX_DELAY_MS`, `CHAOS_DUP_PROB`, and `CHAOS_DUP_MAX_DELAY_MS`. In `dev:mesh`, stress and device actions sent to either gateway reach the shared simulator. Chaos, history, and dropped connections are per gateway.

### What to look at in the UI

- Device markers: **online**, **stale** (quieter than about three of its usual intervals), **offline** (the gateway reports at least 5 s of silence; the marker stays at the last known position with "last seen N s ago"), **unknown** (no connection to any gateway that hears this device).
- Connection badges per gateway (★ marks the primary). A "connection lost" banner appears only when all gateways are down. A silent device and a lost connection look different.
- Click a device to open its live sensor chart with a pulse indicator, its event feed, and per-device status.
- Diagnostics overlay: messages/s received, frames/s rendered, and drops by reason (duplicate, out-of-order, coalesced, old boot), plus cross-gateway duplicates. It also shows gateway-side counters (coalesced, backpressure skips, resyncs, queue depth) and the result of the last resume.
- `maxHz` slider (1–60 Hz or no limit) sends `subscribe`. "Selected ≥ 30 Hz" keeps the selected device's chart detailed while the others are throttled.

## Decisions (section 3)

### Reconnect gap: freeze and mark, never invent movement

- While a device is silent it goes `online → stale → offline`. `stale` is a local client threshold that accounts for the subscribed `maxHz`. `offline` comes from a server `presence` message, because the gateway sees the unthrottled stream.
- An offline marker stays at the last known position, greyed out and hollow, with "last seen 12 s ago". When the device returns, the marker snaps to the new position with a short fade-in and the trail breaks. Nothing is interpolated across the gap.
- A reboot clears the trail, breaks the chart, and adds a "rebooted" entry to the feed.
- Within a continuous stream the marker eases towards the latest accepted position (τ ≈ 120 ms). This smooths rendering and never draws a point beyond the last real sample.
- Only new messages keep a device alive on the server. A duplicate or a delayed message delivered 3 s after the device went silent proves it was alive then, not now.
- A lost connection is not an offline device. All devices become `unknown`, the map dims, and "last seen" timers stop. After reconnect, statuses are restored from the server's `lastSeenAgoMs`, not from the client's clock.

**Why:** the product is about situational awareness. "It was here 12 s ago" is honest; a plausible invented path is false information.

### Ordering: `(bootId, seq)`, device `ts` only to compare boots of the same device

- **Server receive time** is distorted by delays and duplicates, so it is used only for liveness, never for ordering.
- **Device `ts`** has a different clock offset on every device, so it is never compared across devices.
- **`seq`** is generated by the source, is strictly monotonic within a boot, and is shared by `state` and `event`. It is the order key.

Each device has a `DeviceCursor` (`packages/shared/src/reconcile.ts`), the same pure code on the gateway and the client:

- **Same boot:**
  - a seq already in the 1024-wide seen window is a `duplicate`;
  - a seq below the window is `too_old`;
  - a `state` older than the displayed state is `out_of_order` (position never goes backwards);
  - an older unseen `event` is accepted and marked `late` in its place in the feed;
  - a jump in seq is only an informational `gap` (with throttling, gaps are normal).
- **A new `bootId`:**
  - with a larger `ts` than the current boot, it is a reboot: the current boot is retired and the cursor resets;
  - otherwise it is a late message from an older, unseen boot.
- **Retired boots (the last 4):**
  - their states are dropped (`old_boot`);
  - their unseen events are still accepted once, because events are never lost.

The gateway forwards the live stream as is, including duplicates and late messages. The client must handle them anyway: during replay overlapping live data, failover, merging two gateways, or a real mesh. The per-device feed is ordered by (boot, seq). The all-devices feed is in arrival order, because no reliable cross-device order exists.

**Limitation:** comparing boots by `ts` assumes the device clock survives a reboot (an RTC). On real hardware the right fix is a persistent boot counter and ordering by `(bootNo, seq)`.

### What to drop under load, and where to throttle

| Data | Policy |
|---|---|
| `state` (position, sensor, battery) | Coalesced, latest wins by seq (not by arrival). Each state fully replaces the previous one. |
| `event` (`alert`, `low_battery`, `rebooted`) | Never dropped or coalesced. |
| `presence` | Never dropped. A status change cannot be recovered from later states. |
| Duplicates, stale states | Dropped and counted in diagnostics. |

Throttling happens on **both sides**, for different reasons:

- **Gateway, per client session (`apps/server/src/ws/session.ts`):**
  - one "latest state" slot per device, flushed on a shared `1000 / maxHz` grid;
  - events and presence go to a separate queue that is never throttled and is sent before the slots in each batch;
  - batches go out every 50 ms;
  - while `ws.bufferedAmount` is above the threshold, nothing is sent and states keep coalescing in their slots (even with no limit), so memory is O(devices), not O(time the client is slow);
  - the event queue is capped. On overflow it is cleared and the client gets `resync`, then resumes from history. Events are never discarded silently.
- **Client:**
  - rendering runs on `requestAnimationFrame` and draws the latest accepted state, whatever arrived in between;
  - React components poll the store 2–4 times a second instead of re-rendering per message;
  - the socket and the store live outside React.

**Why:** server throttling alone doesn't save the renderer, and client throttling alone saves neither the network nor slow clients, nor does it honour `maxHz`. A state is idempotent and self-contained; an event is not.

### Resume vs snapshot: decided per device, cutoff by history coverage and size

- The gateway keeps a per-device history: up to `HISTORY_MAX_MESSAGES` (500) or `HISTORY_MAX_AGE_MS` (60 s), whichever comes first.
- After every `hello`, the client sends `resume` with a cursor per device: the highest accepted `(bootId, seq)`.
- The gateway decides per device, so one rebooted device doesn't force a full resync of all of them:

| Situation | Answer |
|---|---|
| Same boot, the gap is fully in history (checked by seq), and the answer fits `REPLAY_MAX_MESSAGES` (300) | **Replay:** every event in the gap plus the latest state. The selected device and unlimited subscriptions also get all intermediate states, so the chart has no hole. |
| Gap older than the history, or the answer is too big | **Snapshot** of the device, the events still in history, and `eventsIncomplete`. The client puts an "Events may be missing" marker in the feed right after the old cursor. |
| Reboot during the gap | **Snapshot** with the old boot's tail events and the new boot's events. It is incomplete if either end is missing from history. |
| No cursor (new client) | **Snapshot** |

- Every answer ends with a `snapshot` message, which means "resume done". The live stream starts in the same tick, so nothing falls between the answer and live data. A server-side `resync` uses the same path.
- Replayed events include a look-back of `REPLAY_EVENT_LOOKBACK_MS` (5 s, more than the maximum chaos delay). Reason: a chaos-delayed event can carry a seq below the client's cursor. The resulting duplicates are removed by the client's seen window.

**Why this cutoff:**

- The hard limit is physical: you can replay only what is in history.
- The size limit exists because replay is valuable for events. States in the gap are superseded by the latest one anyway, so a huge replay costs more than a snapshot and shows the same picture.
- In stress mode the history holds only about 4 s. A long gap under stress therefore degrades to a snapshot, and this is visible in diagnostics.

### A real mesh: what breaks without a central history buffer

The gateway is currently the only place that holds history, decides presence, and throttles per client; those are what stop working without it.

What still holds: ordering and dedup are keyed by `(bootId, seq)`, which the device itself generates. Reconcile therefore works no matter which neighbour or how many paths delivered a message. Resume cursors aren't tied to a server; the two-gateway mode already relies on this.

What has to change:

1. **History** moves to the edge. Each device keeps a ring buffer of its own messages, since it is the authority on its data, and neighbours cache tails of others. Resume becomes "give me device X after seq N" sent to any node that has it, falling back to the device itself.
2. **The snapshot** becomes gossip/anti-entropy. Nodes exchange cursor vectors `{deviceId: (bootId, seq)}`. Per-device state is last-writer-wins by `(bootId, seq)`, a trivial CRDT that merges without coordination.
3. **Presence** can no longer be decided in one place. "Offline" becomes a node's local opinion, and the UI must tell "the device is silent" from "I have no path to it". The client already does this per gateway.
4. **Throttling and coalescing** happen at every relay, and `subscribe` has to propagate through the network so unneeded data doesn't cross the radio link.
5. **Comparing boots by `ts`** becomes unreliable without a reference node, so a persistent `bootNo` is needed.
6. **"Never drop" events** need acks or store-and-forward, because no server guarantees they were written to history.

### Stretch: two gateways (implemented)

- `npm run dev:mesh` runs one simulator and two gateways. Each gateway applies its own device filter, link latency, and chaos, like two receivers hearing overlapping devices.
- **One connection per gateway:**
  - the client (`apps/web/src/net/gatewayPool.ts`) connects to every gateway in `VITE_WS_URLS`;
  - each connection has its own backoff, subscription, and resume;
  - all messages go into one store through the same `DeviceCursor`, so the copy from the second gateway is an ordinary duplicate and no coordination between gateways is needed.
- **Failover and resume:**
  - the primary (the target of `control` messages such as stress) is the first open gateway in list order, with failback;
  - resume cursors are built from the merged stream and sent to each gateway as is.
- **Presence and markers:**
  - presence is tracked per gateway→device path; a device is offline only if every gateway that hears it says so, and `unknown` if no path is left;
  - a restarted gateway with empty history doesn't add "events may be missing" for devices the other gateway kept delivering.
- **UI:** map labels show "via A / B / A+B", and the device table has a `via` column.

## Tests

`npm test` runs 48 unit tests (vitest):

- `packages/shared/src/reconcile.test.ts`:
  - duplicates and out-of-order states;
  - late events;
  - gaps;
  - reboots;
  - old-boot states dropped while their events are kept once;
  - an unknown older boot;
  - `too_old`, and the resume cursor.
- `packages/shared/src/seenWindow.test.ts`: window boundary, slot reuse while sliding, reset on a large jump.
- `apps/server/src/hub/deviceStore.test.ts`:
  - replay vs snapshot: in history, beyond history, over the size limit, reboot during the gap, no cursor;
  - event look-back, presence, and history trimming.
- `apps/server/src/ws/session.test.ts`:
  - throttling: latest wins by seq, the `maxHz` grid, per-device limits;
  - delivery: events never coalesced, presence kept in order;
  - backpressure, queue overflow leading to `resync`, bounded memory, subscription filter.
- `apps/web/src/net/backoff.test.ts`: exponential backoff with full jitter stays within bounds.

## What I cut and why

| Cut | Why |
|---|---|
| A real map library (Mapbox/Leaflet/deck.gl) | The task asks for an arbitrary 2D space. A plain canvas with a render loop keeps full control over frame rate and makes the rendering work visible. |
| Persistence (database, durable history) | The task says hardcoded in-process devices with no database. History is an in-memory ring buffer, so a restarted gateway starts with empty history and answers resume with snapshots. |
| Authentication, TLS, input hardening beyond basic validation | Out of scope for a local demo. Invalid client messages are rejected as a whole, but there are no users, tokens, or `wss`. |
| A separate `apps/sim` package | The stand-alone simulator is a second entry point in `apps/server` (`src/sim/main.ts`) and reuses the same code, without one more workspace. |
| Choosing the "best" gateway as primary | The primary is the first open gateway in list order. It only receives `control`; data flows through all gateways equally. |
| ESLint / Prettier | Time. Strict `tsc` (`npm run typecheck`) catches most of it. |
| End-to-end tests | Not required. Reconnect and resume are checked by `npm run resume-check`, and the slow-client case by `npm run slow-client`. |

### Known limitations

- **Boots are compared by device `ts`.** This is correct only if the clock survives a reboot (see Ordering).
- **The backpressure threshold protects gateway process memory, not OS buffers.** On Windows loopback the kernel accepts about 3.5 MB into TCP buffers before `bufferedAmount` starts growing.
- **Replay depth in stress mode is only about 4 s of history.** Longer gaps fall back to a snapshot with "events may be missing".

## What I'd do with more time

**An offline cache and a local outbox in the web client.** Today a page reload loses everything: cursors, the last known state, and the event feed. A reload behaves like a brand-new client and gets a snapshot with only the last 20 events per device.

- **Persist reconcile state in IndexedDB.** Save the merged store (cursors, last state and status per device, the event feed with its seen windows) periodically and on `visibilitychange`/`pagehide`.
  - On start, render the cached picture at once, marked `unknown` with "cached N s ago".
  - Send the persisted cursors in `resume`, so a reload within the history window becomes a replay without lost events, not a snapshot.
  - The same mechanism covers a tab that was backgrounded or frozen by the browser.
- **An outbox for operator actions.** Control messages and device commands (stress today; offline/reboot and real commands later) go through a persisted queue. Each action carries an idempotency key.
  - If the link is down, actions are queued instead of failing. They are shown as "pending" in the UI and sent in order after `resume` completes.
  - The gateway deduplicates by key, so a retry after an unacknowledged send can't run a command twice.
  - Each action ends up acked, rejected, or expired. Stale ones are dropped and reported, not replayed blindly.

This mirrors what a mobile client needs (backgrounding, flaky links, local storage of actions). The reconcile code in `packages/shared` is platform-independent, so the same logic would move to React Native with its own storage layer.
