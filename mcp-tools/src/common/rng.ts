/**
 * Small deterministic PRNG utilities used by every mock data generator.
 *
 * Callers can pass a `seed` for reproducible output (unit tests); when omitted, a
 * time-based seed is used so live/demo calls vary from one invocation to the next.
 */

export type Rng = () => number;

/** mulberry32 -- tiny, fast, good-enough-for-mocks PRNG. Same seed -> same sequence, always. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function rng(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fresh, non-deterministic seed -- varies call to call so mocked tools feel "live" in a demo. */
export function randomSeed(): number {
  return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
}

/** Build an Rng from an explicit seed (tests), or a fresh one (real calls). */
export function createRng(seed?: number): Rng {
  return mulberry32(seed ?? randomSeed());
}

/** Uniform value in [min, max]. */
export function range(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** True with probability p (0..1). Used to occasionally flip a metric into a degraded state. */
export function chance(rng: Rng, p: number): boolean {
  return rng() < p;
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  const idx = Math.min(Math.floor(rng() * items.length), items.length - 1);
  // items is non-empty by contract of all call sites in this project.
  return items[idx] as T;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
