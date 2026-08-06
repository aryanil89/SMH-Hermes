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

/** A fresh, non-deterministic seed -- varies call to call. Kept for callers that want pure noise. */
export function randomSeed(): number {
  return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
}

/**
 * Default window, in seconds, over which the simulated world holds still.
 * Override with SIM_WORLD_WINDOW_S (0 = every call re-rolls, the old behaviour).
 */
const DEFAULT_WORLD_WINDOW_S = 60;

/**
 * Seed derived from the current time *bucket* rather than the instant.
 *
 * Why: with a per-call random seed, asking the same question twice returned
 * different telemetry, so "show me that again" contradicted the first answer and
 * nothing could be corroborated across two tool calls in one agent turn. Bucketing
 * makes the simulated datacenter hold a consistent state for a window (default 60s)
 * and then move on, which is both demo-safe and closer to how real telemetry behaves.
 */
export function windowSeed(nowMs: number = Date.now()): number {
  const windowS = envWindowSeconds();
  if (windowS <= 0) return randomSeed();
  return Math.floor(nowMs / 1000 / windowS) >>> 0;
}

function envWindowSeconds(): number {
  const raw = process.env.SIM_WORLD_WINDOW_S;
  if (raw === undefined || raw.trim() === "") return DEFAULT_WORLD_WINDOW_S;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_WORLD_WINDOW_S;
}

/**
 * Build an Rng from an explicit seed (tests), or from the current time window
 * (live calls -- stable within the window, see windowSeed).
 */
export function createRng(seed?: number): Rng {
  return mulberry32(seed ?? windowSeed());
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

// Rounding moved to common/round.ts and went from 2dp to 1dp: a generated
// `latencyMs: 12.47` is fake precision the same way a raw sensor float is, and
// mixing 2dp telemetry with 1dp readings in one alert reads as a bug.
