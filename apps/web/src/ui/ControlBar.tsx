import { primaryStats, setStress, store } from '../app.ts';
import { SELECTED_BOOST_HZ } from '../store/deviceStore.ts';
import { usePollWithRefresh } from './usePoll.ts';

const SLIDER_MAX = 60;
/** Slider position past SLIDER_MAX stands for "no limit". */
const UNLIMITED_POS = SLIDER_MAX + 1;

function read() {
  return {
    stress: primaryStats()?.stress ?? store.serverConfig?.stress ?? false,
    subscription: store.subscription,
  };
}

export function ControlBar() {
  const [s, refresh] = usePollWithRefresh(read, 250);
  const sub = s.subscription;
  const pos = sub === null ? 10 : sub.maxHz === null ? UNLIMITED_POS : sub.maxHz;

  return (
    <div className="controls">
      <button
        className={`toggle ${s.stress ? 'on' : ''}`}
        disabled={sub === null}
        onClick={() => setStress(!s.stress)}
        title="Devices switch to ~125 msg/s each (≈1000 msg/s total)"
      >
        stress {s.stress ? 'on' : 'off'}
      </button>
      <label className="hz" title="State updates per second per device sent by the gateway. Events are never limited.">
        maxHz
        <input
          type="range"
          min={1}
          max={UNLIMITED_POS}
          value={pos}
          disabled={sub === null}
          onChange={(e) => {
            const v = Number(e.target.value);
            store.updateSubscription({ maxHz: v >= UNLIMITED_POS ? null : v });
            refresh();
          }}
        />
        <span className="mono hz-value">{pos >= UNLIMITED_POS ? 'no limit' : `${pos} Hz`}</span>
      </label>
      <label
        className="check"
        title={`The selected device is sent at least ${SELECTED_BOOST_HZ} Hz, so its chart stays detailed`}
      >
        <input
          type="checkbox"
          checked={sub?.boostSelected ?? true}
          disabled={sub === null}
          onChange={(e) => {
            store.updateSubscription({ boostSelected: e.target.checked });
            refresh();
          }}
        />
        selected ≥{SELECTED_BOOST_HZ} Hz
      </label>
    </div>
  );
}
