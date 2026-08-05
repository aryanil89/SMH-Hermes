#!/usr/bin/env node
/**
 * Proactive-alert cron skill: environmental watcher.
 *
 * Self-contained CLI meant to be run periodically by Hermes Agent's own cron mechanism (see
 * ../../skills/environmental-watch/SKILL.md for the wiring). It does NOT talk to Telegram itself
 * -- it only decides whether an alert is warranted right now and, if so, prints the message text
 * for the calling agent to deliver.
 *
 * Output contract (stdout):
 *   - "NO_ALERT"                          -- nothing crossed a threshold since last check.
 *   - "ALERT <status>\n<message text>"    -- an alert is warranted; <message text> is ready to
 *                                            send as-is.
 * Pass --json for a machine-readable dump of the full decision (useful for debugging/manual runs;
 * not used by the skill's own instructions).
 *
 * Exit code is always 0 on a successful check (an alert is a normal outcome, not a script error).
 * Non-zero only on unexpected internal failure.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { getEnvironmentalReading } from "../environmental/source.js";
import { readState, writeState } from "./state-store.js";
import { decideAlert } from "./decide-alert.js";
import { evaluateSuppression } from "./suppress.js";
import { summarizeReading } from "./summarize.js";
import { runRuleTick } from "../rules/runner.js";
import { readAccessState } from "../access/state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/alert-skill/check-environmental.js -> package root is two levels up.
const PACKAGE_ROOT = join(__dirname, "..", "..");
const DEFAULT_STATE_PATH = join(PACKAGE_ROOT, ".state", "environmental-watch.json");
const DEFAULT_ACCESS_STATE_PATH = join(PACKAGE_ROOT, ".state", "access.json");

// The cron agent session that runs this script doesn't reliably inherit the
// MCP server's env block, so default to the pushed sensor log at its fixed
// repo-relative location when the caller hasn't chosen a source explicitly.
// getEnvironmentalReading() keeps its own opt-in behavior everywhere else.
const DEFAULT_SENSOR_LOG = join(PACKAGE_ROOT, "..", "arduino_uno_q-sensor_log.json");
if (!process.env.UNOQ_SENSOR_LOG && existsSync(DEFAULT_SENSOR_LOG)) {
  process.env.UNOQ_SENSOR_LOG = DEFAULT_SENSOR_LOG;
}

async function main(): Promise<void> {
  const statePath = process.env.ALERT_STATE_PATH ?? DEFAULT_STATE_PATH;
  const asJson = process.argv.includes("--json");

  const now = new Date();
  const reading = await getEnvironmentalReading();
  const previous = await readState(statePath);
  const decision = decideAlert({
    currentStatus: reading.status,
    previous,
    now,
    summary: summarizeReading(reading),
  });

  // Physical presence can withhold a page: if a known responder is standing at
  // the rack, telling them about the thing they are looking at is noise. This is
  // the only rule in the system that makes it quieter, so it is also the one most
  // able to do harm -- see suppress.ts for the three guards.
  //
  // Read across a process boundary on purpose: the dashboard drives the sentry
  // and owns access.json; this cron process only ever reads it. One writer per
  // file. If the read fails, `undefined` means "page normally" -- never "stay
  // quiet", because a watchdog silenced by a missing input is indistinguishable
  // from one silenced by good news.
  const accessStatePath = process.env.ACCESS_STATE_PATH ?? DEFAULT_ACCESS_STATE_PATH;
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
  // cron process goes nowhere anyone looks, and a rule engine that has quietly
  // stopped reading the sensor log is indistinguishable from one with nothing
  // to say. But they are also LATCHED, because a permanently missing log would
  // otherwise nag the on-call phone every 5 minutes forever, which is the one
  // thing every rule firing is careful not to do.
  const ruleMessages: string[] = [];
  let engineError: string | undefined;
  try {
    const tick = await runRuleTick();
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

  const previousError = previous.ruleEngineError;
  if (engineError !== undefined && engineError !== previousError) {
    ruleMessages.push(`Alert rule engine is degraded - ${engineError}`);
  } else if (engineError === undefined && previousError !== undefined) {
    ruleMessages.push("Alert rule engine has recovered.");
  }

  // HELD, NOT CANCELLED. When a page is withheld, `lastStatus` is deliberately
  // NOT advanced -- the previous state is kept verbatim, so `decideAlert` still
  // sees the crossing as un-notified and fires it the instant the responder
  // leaves. Advancing it would make the next tick read "same bad level", hand it
  // to the one-hour cooldown, and swallow the alert entirely. The whole point is
  // a deferral; a suppression that silently becomes a cancellation is the worst
  // outcome this feature could produce.
  const nextState = suppression.hold
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
    : decision.nextState;

  const released = previous.heldPage !== undefined && !suppression.hold;

  await writeState(statePath, {
    ...nextState,
    ...(engineError !== undefined ? { ruleEngineError: engineError } : {}),
  });

  if (asJson) {
    process.stdout.write(
      JSON.stringify({ reading, previous, decision, suppression, ruleMessages }, null, 2) + "\n",
    );
    return;
  }

  const alertText =
    decision.shouldAlert && decision.message && !suppression.hold
      ? released
        ? `${decision.message} (held while the on-call was on site; sending now)`
        : decision.message
      : undefined;

  const parts = [...(alertText ? [alertText] : []), ...ruleMessages];

  if (parts.length > 0) {
    process.stdout.write(`ALERT ${reading.status}\n${parts.join("\n")}\n`);
  } else {
    process.stdout.write("NO_ALERT\n");
  }
}

main().catch((err: unknown) => {
  console.error("[environmental-watch] fatal:", err);
  process.exit(1);
});
