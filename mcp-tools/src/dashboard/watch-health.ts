/**
 * Which watchdog is actually running, asked rather than assumed.
 *
 * The phone panel used to state a cadence in prose ("re-checks every 5
 * minutes"). That was wrong in both possible worlds: the cron job really fires
 * every N+1 minutes (see alert-skill/watch-loop.ts for why), and the persistent
 * loop fires every 15s. A caption that is confidently wrong about how long the
 * on-call will wait is worse than no caption, because the whole panel exists to
 * be believed.
 *
 * So the wall asks. watch-loop.ts binds a loopback health port; if something
 * answers there, the loop is up and reports its own interval. If nothing
 * answers, the wall says so rather than inventing a number -- the alert path
 * might be the cron job, or it might be nothing at all, and this process cannot
 * tell those apart from the outside.
 */
import { envNumber, envPositive } from "../common/env.js";

export interface WatchRunner {
  /** "loop" = watch-loop.ts answered. "unknown" = nothing on the health port. */
  mode: "loop" | "unknown";
  /** The loop's own tick cadence, straight from the process. */
  intervalMs?: number;
  lastTickAt?: string;
  ticks?: number;
  /** False when the loop is up but has no Telegram credentials -- it cannot page. */
  canDeliver?: boolean;
  /**
   * When the loop last completed a Telegram send. This is the only positive
   * evidence of delivery available from outside the watchdog process: the alert
   * state file is written when a tick *decides* to alert (tick.ts), before
   * delivery is attempted (watch-loop.ts), so a changed state file proves a
   * decision and not a delivery. See telegram-feed.ts.
   */
  lastMessageAt?: string;
  /** Set while the most recent send attempt failed; cleared on the next success. */
  lastDeliveryError?: string;
  /** Why the probe came back empty, for the panel to show instead of a guess. */
  detail?: string;
}

interface HealthPayload {
  intervalMs?: unknown;
  lastTickAt?: unknown;
  ticks?: unknown;
  canDeliver?: unknown;
  lastMessageAt?: unknown;
  lastDeliveryError?: unknown;
}

const DEFAULT_PORT = 7789;
/**
 * The wall ticks every 2s; the loop's cadence does not change between ticks.
 * Cached so the panel does not open a socket per repaint for a number that
 * moves once per restart.
 */
const CACHE_MS = 5000;
/** Loopback. A probe that can outlive a dashboard tick is a probe that stalls the wall. */
const TIMEOUT_MS = 400;

const PORT = envNumber("WATCH_HEALTH_PORT", DEFAULT_PORT);
const CACHE_TTL_MS = envPositive("WATCH_HEALTH_CACHE_MS", CACHE_MS);

let cached: { at: number; value: WatchRunner } | undefined;

/**
 * Never throws and never rejects: every failure is "unknown" with a reason. A
 * dashboard tick that dies because a watchdog is not running would take the
 * whole wall down at precisely the moment it is most worth reading.
 */
export async function probeWatchRunner(now: Date = new Date()): Promise<WatchRunner> {
  if (!Number.isFinite(PORT) || PORT <= 0) {
    return { mode: "unknown", detail: "health probe disabled (WATCH_HEALTH_PORT=0)" };
  }
  if (cached && now.getTime() - cached.at < CACHE_TTL_MS) return cached.value;

  const value = await probe();
  cached = { at: now.getTime(), value };
  return value;
}

/** Test seam: forget the cached answer so a probe runs on the next call. */
export function resetWatchRunnerCache(): void {
  cached = undefined;
}

async function probe(): Promise<WatchRunner> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: controller.signal });
    if (!res.ok) {
      return { mode: "unknown", detail: `health port ${PORT} answered ${res.status}` };
    }
    const body = (await res.json()) as HealthPayload;
    return {
      mode: "loop",
      ...(typeof body.intervalMs === "number" && Number.isFinite(body.intervalMs)
        ? { intervalMs: body.intervalMs }
        : {}),
      ...(typeof body.lastTickAt === "string" ? { lastTickAt: body.lastTickAt } : {}),
      ...(typeof body.ticks === "number" ? { ticks: body.ticks } : {}),
      ...(typeof body.canDeliver === "boolean" ? { canDeliver: body.canDeliver } : {}),
      ...(typeof body.lastMessageAt === "string" ? { lastMessageAt: body.lastMessageAt } : {}),
      ...(typeof body.lastDeliveryError === "string"
        ? { lastDeliveryError: body.lastDeliveryError }
        : {}),
    };
  } catch {
    // Connection refused is the normal, expected answer on a rig running the
    // cron job instead. It is not an error and must not read like one.
    return {
      mode: "unknown",
      detail: `no watch loop on 127.0.0.1:${PORT} -- alerts are on the hermes cron path (every ~2 min) or not running`,
    };
  } finally {
    clearTimeout(timer);
  }
}
