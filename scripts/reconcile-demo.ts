import { DeviceCursor, createCounters, countVerdict, type DeviceMessage, type Verdict } from '@app/shared';

const DEV = 'dev-1';

function state(bootId: string, seq: number, ts: number): DeviceMessage {
  return { type: 'state', deviceId: DEV, bootId, seq, ts, payload: { x: seq, y: seq, sensor: 0, battery: 100 } };
}

function event(bootId: string, seq: number, ts: number): DeviceMessage {
  return { type: 'event', deviceId: DEV, bootId, seq, ts, payload: { kind: 'alert', severity: 'warning' } };
}

function describe(v: Verdict): string {
  if (!v.accepted) return `drop:${v.reason}`;
  const flags = [v.newBoot && 'newBoot', v.fromOldBoot && 'oldBoot', v.gap > 0 && `gap=${v.gap}`].filter(Boolean);
  return `accept:${v.kind}${flags.length ? `(${flags.join(',')})` : ''}`;
}

const T0 = 1_000_000;
const steps: Array<[string, DeviceMessage, string]> = [
  ['first contact', state('A', 0, T0), 'accept:latest'],
  ['next in order', state('A', 1, T0 + 100), 'accept:latest'],
  ['duplicate of 1', state('A', 1, T0 + 100), 'drop:duplicate'],
  ['jump to 4 (2,3 delayed)', state('A', 4, T0 + 400), 'accept:latest(gap=2)'],
  ['late state 2', state('A', 2, T0 + 200), 'drop:out_of_order'],
  ['late event 3', event('A', 3, T0 + 300), 'accept:late_event'],
  ['duplicate of late event 3', event('A', 3, T0 + 300), 'drop:duplicate'],
  ['event 6 ahead of state 5', event('A', 6, T0 + 600), 'accept:latest(gap=1)'],
  ['state 5 after event 6 (still newer state)', state('A', 5, T0 + 500), 'accept:latest'],
  ['reboot: new boot B, seq 0', state('B', 0, T0 + 5_000), 'accept:latest(newBoot)'],
  ['late state from old boot A', state('A', 7, T0 + 700), 'drop:old_boot'],
  ['late event from old boot A', event('A', 8, T0 + 800), 'accept:late_event(oldBoot)'],
  ['duplicate late event from A', event('A', 8, T0 + 800), 'drop:duplicate'],
  ['unknown boot Z older than B', state('Z', 0, T0 + 2_000), 'drop:old_boot'],
  ['B continues', state('B', 1, T0 + 5_100), 'accept:latest'],
];

const cursor = new DeviceCursor(DEV);
const counters = createCounters();
let failures = 0;

for (const [label, msg, expected] of steps) {
  const verdict = cursor.apply(msg);
  countVerdict(counters, verdict);
  const actual = describe(verdict);
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${msg.type.padEnd(5)} boot=${msg.bootId} seq=${String(msg.seq).padEnd(2)} ${label.padEnd(44)} -> ${actual}${ok ? '' : `   (expected ${expected})`}`,
  );
}

console.log('\ncursor:', cursor.toResumeCursor(), 'lastStateSeq:', cursor.lastStateSeq);
console.log('counters:', counters);
console.log(failures === 0 ? '\nAll steps match D2.' : `\n${failures} step(s) differ from D2.`);
process.exit(failures === 0 ? 0 : 1);
