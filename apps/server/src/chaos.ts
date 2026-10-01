import { uniform, type Rng } from './util/random.ts';

export interface ChaosConfig {
  delayProbability: number;
  minDelayMs: number;
  maxDelayMs: number;
  duplicateProbability: number;
  duplicateMaxDelayMs: number;
}

export interface ChaosStats {
  passed: number;
  delayed: number;
  duplicated: number;
  inFlight: number;
}

/** Above this many pending timers messages pass through undelayed, so chaos itself can't exhaust memory. */
const MAX_IN_FLIGHT = 20_000;

/**
 * Simulated radio link between devices and the gateway: delays some messages
 * (reordering them) and duplicates others.
 */
export class Chaos<T> {
  private cfg: ChaosConfig;
  readonly stats: ChaosStats = { passed: 0, delayed: 0, duplicated: 0, inFlight: 0 };

  constructor(
    initial: ChaosConfig,
    private readonly deliver: (msg: T) => void,
    private readonly rng: Rng = Math.random,
  ) {
    this.cfg = validateChaos(initial);
  }

  get config(): ChaosConfig {
    return { ...this.cfg };
  }

  update(patch: Partial<ChaosConfig>): ChaosConfig {
    this.cfg = validateChaos({ ...this.cfg, ...patch });
    return this.config;
  }

  push(msg: T): void {
    const saturated = this.stats.inFlight >= MAX_IN_FLIGHT;

    if (!saturated && this.rng() < this.cfg.delayProbability) {
      this.stats.delayed++;
      this.later(msg, uniform(this.rng, this.cfg.minDelayMs, this.cfg.maxDelayMs));
    } else {
      this.stats.passed++;
      this.deliver(msg);
    }

    if (!saturated && this.rng() < this.cfg.duplicateProbability) {
      this.stats.duplicated++;
      this.later(msg, uniform(this.rng, 0, this.cfg.duplicateMaxDelayMs));
    }
  }

  private later(msg: T, delayMs: number): void {
    this.stats.inFlight++;
    setTimeout(() => {
      this.stats.inFlight--;
      this.deliver(msg);
    }, delayMs);
  }
}

export function validateChaos(c: ChaosConfig): ChaosConfig {
  const prob = (name: keyof ChaosConfig) => {
    const v = c[name];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      throw new Error(`chaos.${name} must be a number in [0, 1]`);
    }
  };
  const ms = (name: keyof ChaosConfig) => {
    const v = c[name];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 60_000) {
      throw new Error(`chaos.${name} must be a number of ms in [0, 60000]`);
    }
  };
  prob('delayProbability');
  prob('duplicateProbability');
  ms('minDelayMs');
  ms('maxDelayMs');
  ms('duplicateMaxDelayMs');
  if (c.minDelayMs > c.maxDelayMs) throw new Error('chaos.minDelayMs must be <= maxDelayMs');
  return { ...c };
}
