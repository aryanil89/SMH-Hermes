/**
 * One watchdog decision, start to finish.
 *
 * Extracted from check-environmental.ts so that the one-shot CLI and the
 * persistent loop run *the same code* rather than two implementations that
 * agree until they don't. Everything about what to say and what to persist
 * lives here; the callers own only how the result leaves the process -- stdout
 * for the CLI, a Telegram send for the loop.
 *
 * Nothing in here knows about cadence. That is the point: the tick is idempotent
 * with respect to how often it runs, because every rate-limiting decision is
 * made from persisted state (the cooldown, the `fired` latch, the rule
 * watermarks) rather than from an assumption about the gap between calls.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getEnvironmentalReading } from "../environmental/source.js";
import { readLatestActivity } from "../environmental/file-source.js";
import type { EnvironmentalResult } from "../environmental/types.js";
import { readState, writeState, type AlertState } from "./state-store.js";
import { decideAlert, type DecideAlertResult } from "./decide-alert.js";
import { evaluateSuppression } from "./suppress.js";
import { summarizeReading } from "./summarize.js";
import { runRuleTick } from "../rules/runner.js";
import { readAccessState } from "../access/state.js";
import { envPositive } from "../common/env.js";
import { humanizeActivity } from "../common/activity.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/alert-skill/tick.js -> package root is two levels up.
const PACKAGE_ROOT = join(__dirname, "..", "..");
const DEFAULT_STATE_PATH = join(PACKAGE_ROOT, ".state", "environmental-watch.json");
const DEFAULT_ACCESS_STATE_PATH = join(PACKAGE_ROOT, ".state", "access.json");
const DEFAULT_SENSOR_LOG = join(PACKAGE_ROOT, "..", "arduino_uno_q-sensor_log.json");

/**
 * How long a rule-engine failure must persist before the on-call hears about it.
 *
 * 120s is eight ticks at the loop's 15s cadence, and one tick on the legacy
 * ~2-minute cron path -- so the cron path behaves as it always did while the
 * loop stops flapping. Long enough that no file-lock blip survives it; short
 * enough that a genuinely dead sensor feed is reported well inside the 600s
 * window `sys-feed-stale` uses for the same underlying condition.
 */
const RULE_ENGINE_GRACE_MS = envPositive("RULE_ENGINE_GRACE_S", 120) * 1000;

/**
 * Point the reader at the pushed sensor log unless the caller chose a source.
 *
 * Neither the cron agent session nor a bare `node dist/...` inherits the MCP
 * server's env block from config.yaml, so without this the watchdog silently
 * reads nothing and reports mock data forever. Exported and called explicitly
 * rather than run as an import side effect, so a test can control it.
 */
export function applySensorLogDefault(): void {
  if (!process.env.UNOQ_SENSOR_LOG && existsSync(DEFAULT_SENSOR_LOG)) {
    process.env.UNOQ_SENSOR_LOG = DEFAULT_SENSOR_LOG;
  }
}

export interface WatchTickOptions {
  now?: Date;
  statePath?: string;
  accessStatePath?: string;
  /** Compute everything but persist nothing. For `--json` inspection and tests. */
  dryRun?: boolean;
}

export interface WatchTickResult {
  reading: EnvironmentalResult;
  previous: AlertState;
  decision: DecideAlertResult;
  suppression: { hold: boolean; reason: string };
  ruleMessages: string[];
  /** State that was persisted (or would have been, under dryRun). */
  nextState: AlertState;
  /** True when a previously held page is being let go on this tick. */
  released: boolean;
  /**
   * The lines to deliver, in order. Empty means say nothing -- which is the
   * overwhelmingly common case and the reason this watchdog is affordable to
   * run often.
   */
  parts: string[];
}

export async function runWatchTick(opts: WatchTickOptions = {}): Promise<WatchTickResult> {
  const now = opts.now ?? new Date();
  const statePath = opts.statePath ?? process.env.ALERT_STATE_PATH ?? DEFAULT_STATE_PATH;
  const accessStatePath =
    opts.accessStatePath ?? process.env.ACCESS_STATE_PATH ?? DEFAULT_ACCESS_STATE_PATH;

  const reading = await getEnvironmentalReading();
  const previous = await readState(statePath);

  // On-device activity inference (docs/ONDEVICE_ACTIVITY.md): the UNO Q's own
  // small LLM correlates its recent sensor history into an `activity-*` line
  // and writes it to the same log this watchdog already reads. This is a
  // watermark comparison, not a threshold decision like decideAlert below --
  // activity.py already edge-triggers and cooldowns its own inferences (120s
  // before it will re-log the same activity), so the only question here is
  // "have I already told the phone about this one". Deliberately NOT run
  // through evaluateSuppression: "someone is at the rack" is not a reason to
  // withhold "someone just entered the room" the way it is for an
  // environmental threshold the responder is already looking at.
  const sensorLogPath = process.env.UNOQ_SENSOR_LOG;
  const latestActivity = sensorLogPath ? await readLatestActivity(sensorLogPath) : undefined;
  const activityIsNew =
    latestActivity !== undefined &&
    (!previous.lastActivityAt || Date.parse(latestActivity.at) > Date.parse(previous.lastActivityAt));
  const activityText = activityIsNew
    ? `UNO Q detected a possible activity: ${humanizeActivity(latestActivity!.activity)}.`
    : undefined;

  const decision = decideAlert({
    currentStatus: reading.status,
    previous,
    now,
    summary: summarizeReading(reading),
    // Mock readings are inert -- they can neither raise nor clear an alarm.
    // See decide-alert.ts for the false all-clear this prevents.
    readingTrusted: reading.source === "real",
  });

  // Physical presence can withhold a page: if a known responder is standing at
  // the rack, telling them about the thing they are looking at is noise. This is
  // the only rule in the system that makes it quieter, so it is also the one most
  // able to do harm -- see suppress.ts for the three guards.
  //
  // Read across a process boundary on purpose: the dashboard drives the sentry
  // and owns access.json; this process only ever reads it. One writer per file.
  // If the read fails, `undefined` means "page normally" -- never "stay quiet",
  // because a watchdog silenced by a missing input is indistinguishable from one
  // silenced by good news.
  const access = existsSync(accessStatePath) ? await readAccessState(accessStatePath) : undefined;
  const suppression = decision.shouldAlert
    ? evaluateSuppression({
        access,
        currentStatus: reading.status,
        // The baseline is what was true when the responder arrived, carried on
        // the existing hold -- not the last status we paged at. See suppress.ts.
        ...(previous.heldPage ? { heldStatus: previous.heldPage.heldStatus } : {}),
        now,
      })
    : { hold: false, reason: "no alert to hold" };

  // User-authored and built-in rules, evaluated in plain code against the same
  // log. Deliberately after the built-in status decision and never in place of
  // it: muting every rule must not disable the original watchdog.
  //
  // Infrastructure failures here are reported, not swallowed -- stderr from a
  // background process goes nowhere anyone looks, and a rule engine that has
  // quietly stopped reading the sensor log is indistinguishable from one with
  // nothing to say. But they are also LATCHED, because a permanently missing log
  // would otherwise nag the on-call phone every tick forever, which is the one
  // thing every rule firing is careful not to do.
  const ruleMessages: string[] = [];
  let engineError: string | undefined;
  try {
    const tick = await runRuleTick({ now, ...(opts.dryRun ? { dryRun: true } : {}) });
    ruleMessages.push(...tick.firings.map((f) => f.text));
    engineError =
      tick.logError !== undefined
        ? `cannot read the sensor log: ${tick.logError}`
        : tick.rulesError !== undefined
          ? `cannot read rules.json: ${tick.rulesError}`
          : undefined;
  } catch (err) {
    console.error("[environmental-watch] rule evaluation failed:", err);
    engineError = `evaluation failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  // A failure has to PERSIST before anyone is told about it.
  //
  // Reporting on the first failing tick looked right and was measured wrong: on
  // a 25-minute soak of the 15s loop it produced 11 "degraded"/"recovered" pairs
  // from transient EBUSY on the sensor log -- file locks lasting a few hundred
  // milliseconds, each one announced to the on-call as an engine outage and then
  // an engine recovery. Reading the log is contended by design (the puller
  // replaces it every ~10s, the wall reads it every 2s, this tick reads it
  // twice), so at 15s the flap was continuous.
  //
  // This is the same two-threshold shape used for feed staleness: "is this
  // working?" is not the same question as "should I wake someone?".
  const previousError = previous.ruleEngineError;
  const sameFailure = engineError !== undefined && engineError === previousError;
  const errorSince = sameFailure && previous.ruleEngineErrorSince
    ? previous.ruleEngineErrorSince
    : now.toISOString();
  // Legacy state files carry an error with no `reported` flag; under the old
  // rule they had certainly been reported, so recovery must still speak.
  const alreadyReported = sameFailure && (previous.ruleEngineReported ?? true);
  const sinceMs = Date.parse(errorSince);
  const heldLongEnough =
    !Number.isFinite(sinceMs) || now.getTime() - sinceMs >= RULE_ENGINE_GRACE_MS;

  const reportNow = engineError !== undefined && !alreadyReported && heldLongEnough;
  if (reportNow) {
    ruleMessages.push(`Alert rule engine is degraded - ${engineError}`);
  } else if (engineError === undefined && (previous.ruleEngineReported ?? previousError !== undefined)) {
    ruleMessages.push("Alert rule engine has recovered.");
  }
  const engineReported = alreadyReported || reportNow;

  // HELD, NOT CANCELLED. When a page is withheld, `lastStatus` is deliberately
  // NOT advanced -- the previous state is kept verbatim, so `decideAlert` still
  // sees the crossing as un-notified and fires it the instant the responder
  // leaves. Advancing it would make the next tick read "same bad level", hand it
  // to the one-hour cooldown, and swallow the alert entirely.
  //
  // An untrusted (mock) reading must not drop the hold either. `decideAlert`
  // returns `shouldAlert: false` for one, so nothing above would hold it, and
  // `decision.nextState` carries no `heldPage` -- a single mock blip would
  // forget the deferral and, when the real feed came back, rebuild it with the
  // *current* status as the escalation baseline. Same class of bug as advancing
  // `heldStatus`, arriving by a different road.
  const heldState: AlertState = suppression.hold
    ? {
        ...previous,
        heldPage: {
          // Preserve the original hold time across repeated ticks so the wall can
          // say how long the on-call has been covering it.
          since: previous.heldPage?.since ?? now.toISOString(),
          // And preserve the ORIGINAL status. Advancing this to the current
          // status each tick would move the escalation baseline along with the
          // thing it is supposed to detect, so a rack that crept warning ->
          // critical under a responder's nose would never page at all.
          heldStatus: previous.heldPage?.heldStatus ?? reading.status,
          reason: suppression.reason,
        },
      }
    : decision.kind === "untrusted-reading" && previous.heldPage
      ? { ...decision.nextState, heldPage: previous.heldPage }
      : decision.nextState;

  // Derived from what is actually being persisted, not from `suppression.hold`:
  // the untrusted case above is "still held" even though nothing held it on this
  // tick, and reporting it as a release would put "sending now" on a page that
  // is not being sent.
  const released = previous.heldPage !== undefined && heldState.heldPage === undefined;

  // Spread and then delete rather than a conditional spread: `heldState` inherits
  // `previous` wholesale on a held tick, so a conditional spread leaves a stale
  // `ruleEngineError` in place after the engine recovers -- and the "recovered"
  // line above, which compares against the persisted value, would then fire on
  // every single tick for as long as the page stays held.
  const nextState: AlertState = { ...heldState };
  if (engineError !== undefined) {
    nextState.ruleEngineError = engineError;
    nextState.ruleEngineErrorSince = errorSince;
    nextState.ruleEngineReported = engineReported;
  } else {
    delete nextState.ruleEngineError;
    delete nextState.ruleEngineErrorSince;
    delete nextState.ruleEngineReported;
  }
  // Advances the watermark to the newest activity line seen, whether or not
  // it was new THIS tick -- unconditional, unlike the held/error fields
  // above, because there is no hold/suppress concept for this signal.
  if (latestActivity !== undefined) nextState.lastActivityAt = latestActivity.at;

  if (!opts.dryRun) await writeState(statePath, nextState);

  // Two different events end a hold, and they must not read the same.
  //
  // The responder walked away: a deferred page arriving late, nothing new about
  // the rack. "Held ...; sending now" is exactly right for that.
  //
  // The rack got WORSE while they stood there: an escalation that broke through
  // the hold, which is the more urgent of the two and the reason suppress.ts
  // treats escalation as inviolable. The old wording applied to both, so the one
  // page that means "this deteriorated under a responder's nose" read as routine
  // catch-up -- and the on-call, seeing "held while you were on site", would
  // reasonably conclude nothing had changed since they were there.
  const releaseNote = suppression.escalatedPastResponder
    ? "(escalated while the on-call was on site -- paging anyway)"
    : "(held while the on-call was on site; sending now)";

  const alertText =
    decision.shouldAlert && decision.message && !suppression.hold
      ? released
        ? `${decision.message} ${releaseNote}`
        : decision.message
      : undefined;

  return {
    reading,
    previous,
    decision,
    suppression,
    ruleMessages,
    nextState,
    released,
    parts: [...(alertText ? [alertText] : []), ...ruleMessages, ...(activityText ? [activityText] : [])],
  };
}
