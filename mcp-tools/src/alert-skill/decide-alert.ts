import { isWorseThan } from "../common/alerts.js";
import type { Status } from "../common/types.js";
import type { AlertState } from "./state-store.js";

export type AlertKind = "threshold-crossed" | "recovered" | "none" | "untrusted-reading";

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
  /**
   * Whether the reading actually came from the board.
   *
   * False for anything `getEnvironmentalReading` synthesised -- the mock
   * fallback it returns when the sensor log is unreadable, stale, or the board
   * is unconfigured. Defaults to true so every existing caller and test keeps
   * its meaning; only a caller that knows the provenance needs to pass it.
   */
  readingTrusted?: boolean;
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

  // A synthesised reading is INERT. It cannot raise an alarm and -- the half
  // that actually matters -- it cannot clear one either.
  //
  // Measured on the live rig 2026-08-05: the sensor log was locked mid-replace
  // for one tick, `getEnvironmentalReading` fell back to the mock generator
  // (20.0 C / 37% -- healthy by construction), and this function read that as
  // warning -> ok and paged **"recovered to OK"** while the rack was at 35 C and
  // 86% humidity. It also reset `lastStatus`, so the real excursion re-paged as
  // a fresh warning instead of the escalation it was.
  //
  // The mock was correctly labelled in the alert text the whole time. Labelling
  // is not a guard: the state machine acted on it regardless. So the guard goes
  // where the decision is made, and `previous` is carried forward verbatim --
  // the same "held, not cancelled" principle the suppression path already uses,
  // and the same freeze the access sentry performs when the feed goes stale.
  //
  // A genuinely dead feed is not silenced by this: it is `sys-feed-stale`'s job,
  // and that rule fires precisely when the log cannot be read.
  if (input.readingTrusted === false) {
    return {
      shouldAlert: false,
      kind: "untrusted-reading",
      nextState: { lastStatus: previous.lastStatus, lastAlertedAt: previous.lastAlertedAt },
    };
  }

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
