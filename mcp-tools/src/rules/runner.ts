/**
 * One tick: read the log, learn from it, evaluate every rule, persist runtime.
 *
 * Called from the cron watchdog (check-environmental.ts) and from the CLI. The
 * only writer of rule-state.json, which is what lets rules.json stay lock-free.
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SensorLogLine } from "../environmental/file-source.js";
import { computeBaselines, parseLogLines } from "./baseline.js";
import { evaluateRules, type Firing } from "./evaluate.js";
import { mergeWithDefaults } from "./defaults.js";
import { readRuleState, tryReadRules, writeRuleState } from "./store.js";
import type { Baselines, Rule } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..", "..");

/**
 * How often the slow rules re-evaluate, independent of how often the tick runs.
 * Overridable so the demo can be dialled without touching the cron schedule.
 */
const LEVEL_INTERVAL_MS =
  Number(process.env["UNOQ_LEVEL_INTERVAL_S"] ?? "300") * 1000 || 300_000;

export function sensorLogPath(): string {
  return process.env.UNOQ_SENSOR_LOG ?? join(PACKAGE_ROOT, "..", "arduino_uno_q-sensor_log.json");
}

export interface TickResult {
  firings: Firing[];
  baselines: Baselines;
  rules: Rule[];
  linesRead: number;
  /**
   * Set when the sensor log could not be read. Rules are still evaluated
   * against zero lines -- that is what lets the staleness rule fire in the very
   * condition it exists to report -- and the reason is surfaced to the caller
   * rather than swallowed.
   */
  logError?: string;
  /**
   * Set when rules.json exists but could not be read. State pruning is skipped
   * for that tick: the rule list in hand is a failed read, not an empty store,
   * and pruning against it would discard every user rule's watermark.
   */
  rulesError?: string;
}

export interface TickOptions {
  now?: Date;
  /** Compute and report, but don't persist. The default for `cli check`. */
  dryRun?: boolean;
}

export async function runRuleTick(opts: TickOptions = {}): Promise<TickResult> {
  const now = opts.now ?? new Date();
  const path = sensorLogPath();

  const stored = await tryReadRules();
  const rules = mergeWithDefaults(stored.rules);
  const state = await readRuleState();

  let logError: string | undefined;
  let lines: SensorLogLine[] = [];
  try {
    lines = parseLogLines(await readFile(path, "utf8"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logError = `sensor log not readable at ${path}: ${reason}`;
  }

  // Keep the last good baselines when the log is unreadable: a transient read
  // failure must not erase what the system has learned about the room.
  const baselines = logError
    ? (state.baselines ?? computeBaselines([], now))
    : computeBaselines(lines, now);

  // Deliberately NOT an early return on logError. An unreadable log is exactly
  // the condition sys-feed-stale exists to report; bailing out here made the one
  // rule whose message reads "the board or the push may be down" the one rule
  // that could not fire when it was. Evaluating against zero lines fires the
  // staleness rule and leaves every other kind untouched (they all return
  // "cannot judge" without samples).
  // Cadence split. The tick runs every minute so an event rule ("tell me when
  // the door opens") reaches the phone in tens of seconds instead of up to five
  // minutes -- a door is a now-or-never signal. Temperature is not: re-deciding
  // it every minute buys nothing and only adds noise, so the slow rules keep
  // their five-minute rhythm behind this gate.
  const lastLevels = state.levelsEvaluatedAt ? Date.parse(state.levelsEvaluatedAt) : NaN;
  const evaluateLevels =
    !Number.isFinite(lastLevels) || now.getTime() - lastLevels >= LEVEL_INTERVAL_MS;

  const { firings, nextState } = evaluateRules({
    rules,
    state,
    lines,
    now,
    baselines,
    evaluateLevels,
  });

  // evaluateRules prunes runtime for rules it wasn't given. That is correct
  // when the rule list is trustworthy and destructive when it isn't: a failed
  // read of rules.json yields system rules only, and pruning against that would
  // throw away every user rule's watermark, silently dropping the events in the
  // gap once the file becomes readable again.
  const persisted = stored.degraded ? { ...state.state, ...nextState } : nextState;

  if (!opts.dryRun) {
    await writeRuleState({
      state: persisted,
      baselines,
      // Only stamp when they actually ran, so a skipped tick doesn't push the
      // next slow evaluation another interval into the future.
      levelsEvaluatedAt: evaluateLevels ? now.toISOString() : state.levelsEvaluatedAt,
    });
  }

  return {
    firings,
    baselines,
    rules,
    linesRead: lines.length,
    ...(logError !== undefined ? { logError } : {}),
    ...(stored.degraded ? { rulesError: stored.reason ?? "rules.json unreadable" } : {}),
  };
}

/** Current numeric readings, for the validator's "already true right now" check. */
export async function currentReadings(): Promise<{
  temperature_c?: number;
  humidity_pct?: number;
  distance_mm?: number;
}> {
  try {
    const lines = parseLogLines(await readFile(sensorLogPath(), "utf8"));
    const newest = lines[lines.length - 1];
    if (!newest) return {};
    return {
      temperature_c: newest.temperature_c,
      humidity_pct: newest.humidity_pct,
      ...(typeof newest.distance_mm === "number" && newest.distance_mm >= 0
        ? { distance_mm: newest.distance_mm }
        : {}),
    };
  } catch {
    return {};
  }
}

export async function currentBaselines(): Promise<Baselines> {
  try {
    const lines = parseLogLines(await readFile(sensorLogPath(), "utf8"));
    return computeBaselines(lines);
  } catch {
    return computeBaselines([]);
  }
}
