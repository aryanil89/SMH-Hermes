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

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/alert-skill/check-environmental.js -> package root is two levels up.
const PACKAGE_ROOT = join(__dirname, "..", "..");
const DEFAULT_STATE_PATH = join(PACKAGE_ROOT, ".state", "environmental-watch.json");

// The cron agent session that runs this script doesn't reliably inherit the
// MCP server's env block, so default to the pushed sensor log at its fixed
// repo-relative location when the caller hasn't chosen a source explicitly.
// getEnvironmentalReading() keeps its own opt-in behavior everywhere else.
const DEFAULT_SENSOR_LOG = join(PACKAGE_ROOT, "..", "arduino_uno_q-sensor_log.json");
if (!process.env.UNOQ_SENSOR_LOG && existsSync(DEFAULT_SENSOR_LOG)) {
  process.env.UNOQ_SENSOR_LOG = DEFAULT_SENSOR_LOG;
}

function summarize(reading: Awaited<ReturnType<typeof getEnvironmentalReading>>): string {
  const leak = reading.leakDetected
    ? reading.leakVia === "level"
      ? "LEAK DETECTED (water level rising)"
      : "LEAK DETECTED (leak event)"
    : "no leak";
  const dist = reading.distanceMm !== undefined ? `, water-level distance ${reading.distanceMm}mm` : "";
  const src = reading.source === "mock" ? ` (mock data: ${reading.fallbackReason ?? "no board configured"})` : " (real sensor)";
  return `Temperature ${reading.temperatureC}C, humidity ${reading.humidityPct}%${dist}, ${leak}${src}.`;
}

async function main(): Promise<void> {
  const statePath = process.env.ALERT_STATE_PATH ?? DEFAULT_STATE_PATH;
  const asJson = process.argv.includes("--json");

  const reading = await getEnvironmentalReading();
  const previous = await readState(statePath);
  const decision = decideAlert({
    currentStatus: reading.status,
    previous,
    now: new Date(),
    summary: summarize(reading),
  });

  await writeState(statePath, decision.nextState);

  if (asJson) {
    process.stdout.write(JSON.stringify({ reading, previous, decision }, null, 2) + "\n");
    return;
  }

  if (decision.shouldAlert) {
    process.stdout.write(`ALERT ${reading.status}\n${decision.message}\n`);
  } else {
    process.stdout.write("NO_ALERT\n");
  }
}

main().catch((err: unknown) => {
  console.error("[environmental-watch] fatal:", err);
  process.exit(1);
});
