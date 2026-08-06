/**
 * Reading a file that another process replaces underneath you.
 *
 * The sensor log is rewritten wholesale every ~10s -- the board's push and the
 * adb fallback both land a temp file and then call the atomic replace (see
 * uno-q/pull_sensor_log.ps1). On Windows that replace fails, or makes the reader
 * fail, if the other side holds a handle at that exact instant. The puller
 * already retries in its direction; nothing retried in ours.
 *
 * That gap was not theoretical. Measured on the live rig 2026-08-05: a watchdog
 * tick hit EBUSY mid-replace, `readSensorLogReading` returned `{ok:false}`,
 * `getEnvironmentalReading` fell through to the MOCK generator, and the watchdog
 * paged **"recovered to OK"** while the rack was at 35C and 86% humidity. A
 * one-in-a-hundred file lock became an all-clear during a real excursion.
 *
 * Two defences, and this is only the first: retry the transient case here, and
 * refuse to let an untrusted reading move the alert state machine at all
 * (see decide-alert.ts `readingTrusted`). This one narrows the window; that one
 * makes the window harmless.
 *
 * ENOENT is deliberately NOT retried. A genuinely missing log is a real,
 * persistent condition that `sys-feed-stale` exists to report, and burning
 * retries on it would slow down the very path that reports a dead feed.
 */
import { readFile } from "node:fs/promises";

/**
 * Windows sharing-violation family. These mean "someone else has it open right
 * now", which is by definition a condition that passes.
 */
const TRANSIENT_CODES = new Set(["EBUSY", "EPERM", "EACCES", "UNKNOWN"]);

/** Attempts include the first try, so 4 = one read plus three retries. */
const DEFAULT_ATTEMPTS = 4;
/** Total added latency in the worst transient case: 3 x 50ms = 150ms. */
const DEFAULT_DELAY_MS = 50;

export function isTransientReadError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && TRANSIENT_CODES.has(code);
}

export interface ReadRetryOptions {
  attempts?: number;
  delayMs?: number;
  /** Injection point for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * `readFile(path, "utf8")` that survives a concurrent atomic replace.
 *
 * Rethrows the LAST error rather than a synthesised one, so callers keep the
 * real errno and their existing message formatting still reads correctly.
 */
export async function readFileWithRetry(path: string, opts: ReadRetryOptions = {}): Promise<string> {
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS);
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = opts.sleep ?? realSleep;

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await readFile(path, "utf8");
    } catch (err) {
      lastErr = err;
      // A non-transient failure is the answer, not something to wait out.
      if (!isTransientReadError(err)) throw err;
      if (i < attempts - 1) await sleep(delayMs);
    }
  }
  throw lastErr;
}

/**
 * Generic form, for readers that do not want the whole file as a string
 * (the dashboard tails the last 256KB with open/stat instead).
 */
export async function withReadRetry<T>(fn: () => Promise<T>, opts: ReadRetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS);
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = opts.sleep ?? realSleep;

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientReadError(err)) throw err;
      if (i < attempts - 1) await sleep(delayMs);
    }
  }
  throw lastErr;
}
