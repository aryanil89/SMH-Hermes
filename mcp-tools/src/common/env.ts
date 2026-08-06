/**
 * Numeric environment variables that cannot silently become NaN.
 *
 * This started as a local helper in environmental/file-source.ts, with a comment
 * explaining the trap: `UNOQ_LOG_MAX_AGE_S=abc` makes `Number(...)` NaN, and
 * `ageSeconds > NaN` is always false, so the staleness check never fires. The
 * lesson was written down and then not applied anywhere else, and NaN is worse
 * than a wrong number in almost every place this project reads one:
 *
 *   - `Math.max(250, NaN)` is **NaN**, and `setInterval(NaN)` is treated as 1ms
 *     -- the wall's 2s tick becomes a busy loop re-reading the sensor log
 *     thousands of times a second, on the same machine running NPU inference.
 *   - `withTimeout(promise, NaN)` fires immediately, so a typo'd
 *     `UNOQ_TIMEOUT_MS` makes every board read "time out" and the system serves
 *     mock data forever while insisting the board is unreachable.
 *   - `listen(NaN)` binds an arbitrary free port, so the wall comes up somewhere
 *     nobody is looking.
 *
 * All three fail *quietly*, which is the reason this is centralised rather than
 * fixed once at each call site as it comes up.
 */

/** Parse `name` as a finite number, falling back when unset, blank, or garbage. */
export function envNumber(name: string, fallback: number): number;
export function envNumber(name: string, fallback: undefined): number | undefined;
export function envNumber(name: string, fallback: number | undefined): number | undefined;
export function envNumber(name: string, fallback: number | undefined): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * As `envNumber`, but also rejects values at or below zero.
 *
 * For the things where a non-positive value is not a configuration choice but a
 * mistake with teeth -- an interval, a timeout, a port.
 */
export function envPositive(name: string, fallback: number): number {
  const n = envNumber(name, fallback);
  return n > 0 ? n : fallback;
}
