#!/usr/bin/env node
/**
 * Proactive-alert cron skill: environmental watcher (one-shot).
 *
 * Self-contained CLI meant to be run periodically by Hermes Agent's own cron mechanism (see
 * ../../skills/environmental-watch/SKILL.md for the wiring). It does NOT talk to Telegram itself
 * -- it only decides whether an alert is warranted right now and, if so, prints the message text
 * for the calling agent to deliver.
 *
 * The decision itself lives in tick.ts and is shared verbatim with the persistent watchdog loop
 * (watch-loop.ts). This file is the stdout contract and nothing else.
 *
 * ⚠️ Hermes cron cannot run this faster than about once every two minutes -- `parse_duration`
 * has no seconds unit, the ticker thread polls on a 60s grid, and `next_run_at` is computed from
 * the job's *completion* time, so an `every 1m` job lands its due time just past the next poll
 * and fires every other one (measured over 547 executions: 120s x415 at "every 1m", 360s x113 at
 * "every 5m"). If you need faster than that, run watch-loop.ts instead -- and run only one of
 * the two, or the on-call gets every page twice.
 *
 * Output contract (stdout):
 *   - "NO_ALERT"                          -- nothing crossed a threshold since last check.
 *   - "ALERT <status>\n<message text>"    -- an alert is warranted; <message text> is ready to
 *                                            send as-is.
 * Pass --json for a machine-readable dump of the full decision. --json implies a DRY RUN: it
 * persists nothing, so inspecting the watchdog by hand can no longer advance the live rule
 * watermarks and swallow the next real alert.
 *
 * Exit code is always 0 on a successful check (an alert is a normal outcome, not a script error).
 * Non-zero only on unexpected internal failure.
 */
import { applySensorLogDefault, runWatchTick } from "./tick.js";

applySensorLogDefault();

async function main(): Promise<void> {
  const asJson = process.argv.includes("--json");
  const result = await runWatchTick(asJson ? { dryRun: true } : {});

  if (asJson) {
    const { reading, previous, decision, suppression, ruleMessages, nextState } = result;
    process.stdout.write(
      JSON.stringify(
        { reading, previous, decision, suppression, ruleMessages, nextState, dryRun: true },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  if (result.parts.length > 0) {
    process.stdout.write(`ALERT ${result.reading.status}\n${result.parts.join("\n")}\n`);
  } else {
    process.stdout.write("NO_ALERT\n");
  }
}

main().catch((err: unknown) => {
  console.error("[environmental-watch] fatal:", err);
  process.exit(1);
});
