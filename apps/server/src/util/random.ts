export type Rng = () => number;

export function uniform(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** Exponentially distributed interval with the given mean (memoryless "happens every ~N ms"). */
export function exponential(rng: Rng, mean: number): number {
  return -Math.log(1 - rng()) * mean;
}
