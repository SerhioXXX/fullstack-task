import { DeviceCursor, type DeviceMessage } from '@app/shared';
import { log } from '../util/log.ts';

/**
 * Prints, once per second, the seq values each device delivered to the gateway, annotated
 * with the reconcile verdict so reordering and duplicates are visible by eye:
 *   12   in-order state      E12  event
 *   12<  out-of-order state  E12< late event
 *   12*  duplicate           12x  state of an old boot
 *   [boot ab12cd34]          a new boot starts
 */
export class IngestLogger {
  private readonly cursors = new Map<string, DeviceCursor>();
  private readonly lines = new Map<string, string[]>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly filter: Set<string> | 'all') {
    this.timer = setInterval(() => this.flush(), 1000);
    this.timer.unref();
  }

  observe(msg: DeviceMessage): void {
    if (this.filter !== 'all' && !this.filter.has(msg.deviceId)) return;

    let cursor = this.cursors.get(msg.deviceId);
    if (!cursor) {
      cursor = new DeviceCursor(msg.deviceId);
      this.cursors.set(msg.deviceId, cursor);
    }
    const verdict = cursor.apply(msg);

    const prefix = msg.type === 'event' ? 'E' : '';
    let token = `${prefix}${msg.seq}`;
    if (verdict.accepted) {
      if (verdict.newBoot) token = `[boot ${msg.bootId.slice(0, 8)}] ${token}`;
      if (verdict.kind === 'late_event') token += '<';
    } else if (verdict.reason === 'duplicate') token += '*';
    else if (verdict.reason === 'out_of_order') token += '<';
    else token += 'x';

    let tokens = this.lines.get(msg.deviceId);
    if (!tokens) {
      tokens = [];
      this.lines.set(msg.deviceId, tokens);
    }
    tokens.push(token);
  }

  private flush(): void {
    const ids = [...this.lines.keys()].sort();
    for (const id of ids) {
      const tokens = this.lines.get(id)!;
      if (tokens.length === 0) continue;
      const shown = tokens.length > 40 ? [...tokens.slice(0, 40), `... +${tokens.length - 40}`] : tokens;
      log(`ingest ${id}`, shown.join(' '));
      tokens.length = 0;
    }
  }
}
