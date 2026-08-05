import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Status } from "../common/types.js";

export interface AlertState {
  lastStatus: Status;
  /** ISO timestamp of the last time an alert was actually emitted (for cooldown re-notify). */
  lastAlertedAt?: string;
  /**
   * The rule engine's last reported infrastructure failure, if it is still
   * failing. Latched here so a permanently missing sensor log produces one
   * message on the way in and one on the way out, instead of nagging the on-call
   * phone every 5 minutes forever. Absent means healthy.
   */
  ruleEngineError?: string;
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
        // Allowlisted like ruleEngineError above: this reader drops unknown
        // fields, so a new field that is not named here is silently lost on the
        // next write -- which for a held page would mean quietly forgetting an
        // alert someone is still owed.
        ...(parseHeldPage(parsed.heldPage) ? { heldPage: parseHeldPage(parsed.heldPage) } : {}),
      };
    }
    return { ...DEFAULT_STATE };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export async function writeState(path: string, state: AlertState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), "utf8");
}
