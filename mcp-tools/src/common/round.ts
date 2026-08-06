/**
 * One decimal place, everywhere a measurement leaves this system.
 *
 * The board logs raw floats -- `27.16626739501953 C`, `50.89215087890625 %` --
 * because that is what the Modulino returns and the log is the record. Sent to
 * a phone, that is unreadable and implies a precision no sensor on this board
 * has: the Thermo module is spec'd around ±0.2 C, so digits past the first
 * decimal are noise being reported as measurement.
 *
 * ## Round on the way in, not on the way out
 *
 * Every reading is rounded at the point it enters the system -- the log reader,
 * the SSH pull, the mock generator -- and never again. So the number the agent
 * reasons about, the number compared against a threshold, the number in the
 * Telegram alert, and the number on the wall are all the same number.
 *
 * Rounding at each display instead would let the wall show `35.0 C` beside a
 * `warning` badge because the unrounded 34.96 never crossed the critical line.
 * That kind of disagreement between the wall and the phone is exactly what this
 * project treats as a demo-losing bug, and it is why `summarizeReading` exists
 * as one shared function rather than two copies of the same sentence.
 *
 * Resolution is not a concern: no threshold in `thresholds.ts` is finer than
 * 1 (temperature warns at 30, packet loss at 1), so a tenth is already an order
 * of magnitude below the coarsest decision this data drives.
 *
 * ## What this is NOT for
 *
 * Face embeddings (`access/roster.ts`) keep 3 decimals -- they are compared to
 * each other, never read by a human, and a tenth would collapse distinct faces
 * onto the same vector. Counts, ages in seconds, and thresholds are integers
 * already.
 */

/** Limit a measurement to one decimal place. Whole numbers stay whole (22, not 22.0). */
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Format for display, padded to exactly one decimal (22.0, not 22).
 *
 * Use where a number sits in prose or on a tile and a ragged `22 C` next to
 * `22.4 C` would read as two different instruments.
 */
export function fixed1(n: number): string {
  return n.toFixed(1);
}
