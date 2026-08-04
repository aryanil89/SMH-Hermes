import { isWorseThan } from "../common/alerts.js";
import type { Status } from "../common/types.js";
import type { AlertState } from "./state-store.js";

export type AlertKind = "threshold-crossed" | "recovered" | "none";

export interface DecideAlertResult {
  shouldAlert: boolean;
  kind: AlertKind;
  /** Only set when shouldAlert is true. */
  message?: string;
  nextState: AlertState;
}

export interface DecideAlertInput {
  currentStatus: Status;
  previous: AlertState;
  now: Date;
  /** Minimum time between repeat alerts while status stays at the same bad level. Default 1h. */
  cooldownMs?: number;
  /** Human-readable summary of the current reading, used inside the alert message. */
  summary: string;
}

const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Pure decision function: given the previous persisted state and a fresh status, decide whether
 * this check should produce an alert, and what state to persist for next time.
 *
 * Rules (deliberately simple -- "threshold crossed", not "threshold exceeded on every tick"):
 *   - ok -> warning/critical, or warning -> critical: always alert (a crossing just happened).
 *   - stays at warning/critical: re-alert only after `cooldownMs` has elapsed since the last
 *     alert, so a sustained problem doesn't go silent forever but also doesn't spam every tick.
 *   - warning/critical -> ok: a one-time "recovered" alert.
 *   - stays ok: never alert.
 */
export function decideAlert(input: DecideAlertInput): DecideAlertResult {
  const { currentStatus, previous, now, summary } = input;
  const cooldownMs = input.cooldownMs ?? DEFAULT_COOLDOWN_MS;

  if (currentStatus !== "ok") {
    const crossedWorse = isWorseThan(currentStatus, previous.lastStatus);
    const sameBadLevel = currentStatus === previous.lastStatus;
    const cooldownElapsed =
      !previous.lastAlertedAt || now.getTime() - Date.parse(previous.lastAlertedAt) >= cooldownMs;

    if (crossedWorse || (sameBadLevel && cooldownElapsed)) {
      const nowIso = now.toISOString();
      return {
        shouldAlert: true,
        kind: "threshold-crossed",
        message: `Environmental status is now ${currentStatus.toUpperCase()}. ${summary}`,
        nextState: { lastStatus: currentStatus, lastAlertedAt: nowIso },
      };
    }

    return {
      shouldAlert: false,
      kind: "none",
      nextState: { lastStatus: currentStatus, lastAlertedAt: previous.lastAlertedAt },
    };
  }

  // currentStatus === "ok"
  if (previous.lastStatus !== "ok") {
    return {
      shouldAlert: true,
      kind: "recovered",
      message: `Environmental status has recovered to OK (was ${previous.lastStatus.toUpperCase()}). ${summary}`,
      nextState: { lastStatus: "ok", lastAlertedAt: undefined },
    };
  }

  return {
    shouldAlert: false,
    kind: "none",
    nextState: { lastStatus: "ok", lastAlertedAt: previous.lastAlertedAt },
  };
}
