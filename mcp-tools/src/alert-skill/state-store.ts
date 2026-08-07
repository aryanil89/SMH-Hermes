import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "../common/atomic-write.js";
import type { Status } from "../common/types.js";

export interface AlertState {
  lastStatus: Status;
  /** ISO timestamp of the last time an alert was actually emitted (for cooldown re-notify). */
  lastAlertedAt?: string;
  /**
   * The rule engine's current infrastructure failure, if it is still failing.
   * Latched here so a permanently missing sensor log produces one message on the
   * way in and one on the way out, instead of nagging the on-call phone every
   * tick forever. Absent means healthy.
   */
  ruleEngineError?: string;
  /**
   * When the CURRENT failure was first seen. The failure has to persist past a
   * grace window before anyone is told about it.
   *
   * Measured on a 25-minute soak: without this, transient `EBUSY` on the sensor
   * log produced **11 degraded/recovered pairs** -- one file lock lasting a few
   * hundred milliseconds, reported as an engine outage and then an engine
   * recovery, over and over. A latch that latches on the first sample is not a
   * latch; it is a flap detector wired to the on-call's phone.
   */
  ruleEngineErrorSince?: string;
  /**
   * True once the failure above was actually reported. Recovery only speaks if
   * something was said in the first place -- otherwise a blip that never paged
   * anyone would still produce an "engine has recovered" message about an outage
   * the on-call never heard of.
   */
  ruleEngineReported?: boolean;
  /**
   * A page that was computed, withheld, and is still owed.
   *
   * Set when a known responder is physically at the rack, so re-paging them about
   * the thing they are already standing in front of would be noise. It is a
   * *deferral*, never a cancellation: `lastStatus` is deliberately not advanced
   * while a page is held, so the crossing fires the moment they leave.
   *
   * Recorded here rather than inferred, because the wall has to be able to show
   * "one page held" without re-deriving the decision -- and because a held page
   * that nobody can see is indistinguishable from a watchdog that has died.
   */
  heldPage?: {
    since: string;
    heldStatus: Status;
    reason: string;
  };
  /**
   * ISO timestamp of the newest UNO Q on-device activity inference
   * (`event: "activity"`, see docs/ONDEVICE_ACTIVITY.md) already pushed to
   * the phone. A watermark, not a cooldown: activity lines are already
   * edge-triggered and deduped at the source (activity.py's own 120s
   * cooldown before re-logging the same activity), so the watchdog doesn't
   * need a second rate limit -- it only needs to know whether it has already
   * reported the newest one.
   */
  lastActivityAt?: string;
}

const DEFAULT_STATE: AlertState = { lastStatus: "ok" };

function parseHeldPage(value: unknown): AlertState["heldPage"] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const held = value as Record<string, unknown>;
  const { since, heldStatus, reason } = held;
  if (typeof since !== "string" || typeof reason !== "string") return undefined;
  if (heldStatus !== "ok" && heldStatus !== "warning" && heldStatus !== "critical") return undefined;
  return { since, heldStatus, reason };
}

/** Reads persisted state; missing/corrupt file is treated as a fresh "ok" baseline, never throws. */
export async function readState(path: string): Promise<AlertState> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<AlertState>;
    if (parsed && (parsed.lastStatus === "ok" || parsed.lastStatus === "warning" || parsed.lastStatus === "critical")) {
      return {
        lastStatus: parsed.lastStatus,
        lastAlertedAt: parsed.lastAlertedAt,
        ...(typeof parsed.ruleEngineError === "string"
          ? { ruleEngineError: parsed.ruleEngineError }
          : {}),
        ...(typeof parsed.ruleEngineErrorSince === "string"
          ? { ruleEngineErrorSince: parsed.ruleEngineErrorSince }
          : {}),
        ...(typeof parsed.ruleEngineReported === "boolean"
          ? { ruleEngineReported: parsed.ruleEngineReported }
          : {}),
        // Allowlisted like ruleEngineError above: this reader drops unknown
        // fields, so a new field that is not named here is silently lost on the
        // next write -- which for a held page would mean quietly forgetting an
        // alert someone is still owed.
        ...(parseHeldPage(parsed.heldPage) ? { heldPage: parseHeldPage(parsed.heldPage) } : {}),
        ...(typeof parsed.lastActivityAt === "string" ? { lastActivityAt: parsed.lastActivityAt } : {}),
      };
    }
    return { ...DEFAULT_STATE };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/**
 * Write atomically: temp file, then rename.
 *
 * `access/state.ts` credits this file as the model for its atomic write, but
 * this one wrote in place -- the pattern was documented here and implemented
 * only there. It mattered less at a 5-minute cadence with a single writer; it
 * matters now that the watchdog loop persists every 15s while the wall reads
 * this same path every 2s.
 *
 * The failure it prevents is quiet and expensive: a reader that catches a torn
 * file falls back to `{lastStatus:"ok"}` by design (readState must never throw),
 * so a half-written file is indistinguishable from a healthy rack. That would
 * drop `lastStatus` mid-incident and re-page an excursion as if it were new --
 * the same class of bug as the mock-fallback false recovery, arriving by a
 * different road. See common/atomic-write.ts for the mechanism, including why
 * the rename itself has to retry on Windows.
 */
export async function writeState(path: string, state: AlertState): Promise<void> {
  await writeJsonAtomic(path, state);
}
