import { envNumber } from "../common/env.js";
import { readFileWithRetry } from "../common/read-retry.js";
import { round1 } from "../common/round.js";
import type { EnvironmentalReading } from "./types.js";

/**
 * One line of the JSON-lines history the UNO Q pushes to the laptop
 * (`push_sensor_log.sh`, see docs/UNOQ_SETUP.md). `event` is one of: a button
 * transition (A/B/C -> door_open/light_on/leak_detected, and their paired
 * release events), a presence crossing (object_entered/object_left), the
 * periodic `sensor_tick`, or -- since 2026-08-06 -- `activity`, written by the
 * board's own on-device LLM (`uno-q/hermes-sensor-logger/python/activity.py`,
 * see docs/ONDEVICE_ACTIVITY.md) when it correlates recent sensor history into
 * an inferred `activity`/`trigger` pair.
 */
export interface SensorLogLine {
  timestamp: string;
  event: string;
  temperature_c: number;
  humidity_pct: number;
  distance_mm?: number;
  /** Present only on `event: "activity"` lines -- the normalized `activity-...` label. */
  activity?: string;
  /** Present only on `event: "activity"` lines -- what triggered the inference. */
  trigger?: string;
}

export interface FileReading extends EnvironmentalReading {
  /** ISO timestamp of the newest log line the reading came from. */
  lastEventAt: string;
  /** Seconds between `now` and the newest log line. */
  ageSeconds: number;
  /** The newest line's event name (door_open / light_on / leak_detected). */
  lastEvent: string;
}

export interface ReadSensorLogOptions {
  /** Path to the JSON-lines file. Required (callers gate on UNOQ_SENSOR_LOG). */
  path: string;
  /** Injection point for tests; defaults to the wall clock. */
  now?: Date;
  /** Newest line older than this -> the file is stale and unusable. Default 180. */
  maxAgeSeconds?: number;
  /** A leak_detected event within this window of `now` sets leakDetected. Default 300. */
  leakWindowSeconds?: number;
  /**
   * Water-level leak threshold (mm): newest distance reading BELOW this means the
   * ToF float has risen -> water in the tray. Undefined (default) disables level
   * detection; set via UNOQ_LEAK_DISTANCE_MM after calibrating against the empty tray.
   */
  leakDistanceMm?: number;
}

export type FileSourceResult =
  | { ok: true; reading: FileReading }
  | { ok: false; reason: string };

/**
 * Newest line older than this and the log is unusable.
 *
 * 180s, matching the gateway's config.yaml, the demo scripts, and the Scheduled
 * Task payloads -- every place that configures this rig deliberately sets 180,
 * and this default used to be 3600. A default nobody wants is not a default, it
 * is a trap: it only applied when someone forgot the env var, which is exactly
 * the moment it would be believed. An hour-dead board read as "real" on the wall
 * while the agent, whose env server got 180 from config.yaml, called the same
 * file mock -- the two contradicting each other on stage.
 *
 * Exported and imported by dashboard/snapshot.ts rather than repeated: the two
 * copies of this number ARE the bug, and they had already drifted apart from
 * production once.
 */
export const DEFAULT_MAX_AGE_S = 180;
const DEFAULT_LEAK_WINDOW_S = 300;

/**
 * Parse one JSON-lines record, tolerating garbage. Exported because the live
 * dashboard reads the same file and must agree, line for line, with what the
 * MCP tool considers a valid reading.
 */
export function parseSensorLogLine(line: string): SensorLogLine | undefined {
  try {
    const obj = JSON.parse(line) as Partial<SensorLogLine>;
    if (
      typeof obj.timestamp === "string" &&
      typeof obj.event === "string" &&
      typeof obj.temperature_c === "number" &&
      typeof obj.humidity_pct === "number"
    ) {
      return obj as SensorLogLine;
    }
  } catch {
    // Tolerated: scp can land mid-append, leaving a truncated trailing line.
  }
  return undefined;
}

export interface LatestActivity {
  activity: string;
  trigger?: string;
  at: string;
}

/**
 * Newest `event: "activity"` line in the log, if any -- used by the watchdog
 * (alert-skill/tick.ts) to decide whether a fresh on-device inference needs a
 * Telegram push. See docs/ONDEVICE_ACTIVITY.md.
 *
 * Deliberately separate from `readSensorLogReading`: that function fails
 * "stale" once the newest line is older than `maxAgeSeconds`, but an activity
 * line can be several minutes old on a quiet board (sensor_tick keeps the
 * newest-line clock fresh) and is still worth reporting exactly once. "Is
 * this newer than the last one I reported" is the caller's job (a persisted
 * watermark), not this function's -- it just answers "what's the newest one
 * in the file right now". Never throws: a missing or unreadable log means no
 * activity to report, not an error.
 */
export async function readLatestActivity(path: string): Promise<LatestActivity | undefined> {
  let raw: string;
  try {
    raw = await readFileWithRetry(path);
  } catch {
    return undefined;
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    const parsed = parseSensorLogLine(line);
    if (parsed && parsed.event === "activity" && parsed.activity) {
      return {
        activity: parsed.activity,
        ...(parsed.trigger ? { trigger: parsed.trigger } : {}),
        at: parsed.timestamp,
      };
    }
  }
  return undefined;
}

/**
 * Read the newest sensor state from the pushed JSON-lines history file.
 *
 * Never throws: every failure mode (missing file, empty file, no parseable
 * line, stale data) comes back as `{ ok: false, reason }` so the caller can
 * fall through to the next source. `leakDetected` is true when any
 * leak_detected event occurred within `leakWindowSeconds` of `now` -- a leak
 * is an incident with a recovery, not a permanent latch on the last line.
 */
export async function readSensorLogReading(opts: ReadSensorLogOptions): Promise<FileSourceResult> {
  const now = opts.now ?? new Date();
  const maxAgeSeconds = opts.maxAgeSeconds ?? envNumber("UNOQ_LOG_MAX_AGE_S", DEFAULT_MAX_AGE_S);
  const leakWindowSeconds = opts.leakWindowSeconds ?? envNumber("UNOQ_LEAK_WINDOW_S", DEFAULT_LEAK_WINDOW_S);
  const leakDistanceMm = opts.leakDistanceMm ?? envNumber("UNOQ_LEAK_DISTANCE_MM", undefined);

  let raw: string;
  try {
    // Retrying, not plain readFile: the push replaces this file wholesale every
    // ~10s, and losing that race used to hand the caller a mock reading that
    // paged a false all-clear. See common/read-retry.ts.
    raw = await readFileWithRetry(opts.path);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `sensor log not readable at ${opts.path}: ${reason}` };
  }

  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { ok: false, reason: `sensor log at ${opts.path} is empty` };
  }

  // Newest parseable line wins; skip a truncated tail from an in-flight push.
  let latest: SensorLogLine | undefined;
  for (let i = lines.length - 1; i >= 0 && !latest; i--) {
    const candidate = lines[i];
    if (candidate !== undefined) latest = parseSensorLogLine(candidate);
  }
  if (!latest) {
    return { ok: false, reason: `sensor log at ${opts.path} has no parseable lines` };
  }

  const lastEventMs = Date.parse(latest.timestamp);
  if (Number.isNaN(lastEventMs)) {
    return { ok: false, reason: `sensor log newest line has unparseable timestamp "${latest.timestamp}"` };
  }
  const ageSeconds = Math.max(0, (now.getTime() - lastEventMs) / 1000);
  if (ageSeconds > maxAgeSeconds) {
    return {
      ok: false,
      reason:
        `sensor log is stale: newest line is ${Math.round(ageSeconds)}s old ` +
        `(max ${maxAgeSeconds}s) -- board may be offline`,
    };
  }

  // Leak via event = a leak_detected recent enough to still be "now" for
  // alerting purposes, and not since cancelled.
  //
  // Scanning newest-first, whichever of leak_detected / leak_cleared appears
  // first decides. The leak_cleared check must come first because it also
  // contains "leak": the board logs it when button C is released, and a
  // substring test alone would let the very event that clears the leak re-raise
  // it, latching the alert on until the window expired.
  const leakCutoffMs = now.getTime() - leakWindowSeconds * 1000;
  let eventLeak = false;
  for (let i = lines.length - 1; i >= 0 && !eventLeak; i--) {
    const rawLine = lines[i];
    if (rawLine === undefined) continue;
    const line = parseSensorLogLine(rawLine);
    if (!line) continue;
    const ts = Date.parse(line.timestamp);
    if (!Number.isNaN(ts) && ts < leakCutoffMs) break; // lines are appended in order
    const event = line.event.toLowerCase();
    if (event === "leak_cleared") break; // explicitly cancelled, and newer than any leak_detected
    if (event.includes("leak")) eventLeak = true;
  }

  // Round before comparing, not after. The reported distance and the distance
  // the leak decision was made on have to be the same number, or the wall can
  // read "150.0mm, no leak" against a 150mm threshold because the raw 150.04
  // never crossed it. See common/round.ts.
  // sketch reports -1 when no distance sample is available.
  const distanceMm =
    typeof latest.distance_mm === "number" && latest.distance_mm >= 0
      ? round1(latest.distance_mm)
      : undefined;

  // Leak via level = the ToF float has risen: newest distance reading is below
  // the calibrated threshold. Water in the tray lifts the float -> distance
  // shrinks. Recovers on its own once the level drops (no time window needed --
  // the sensor keeps saying "high" for as long as the water is actually there).
  const levelLeak =
    leakDistanceMm !== undefined && distanceMm !== undefined && distanceMm < leakDistanceMm;

  const leakDetected = eventLeak || levelLeak;

  return {
    ok: true,
    reading: {
      temperatureC: round1(latest.temperature_c),
      humidityPct: round1(latest.humidity_pct),
      leakDetected,
      // Level is the measured signal; report it as the cause when both fire.
      ...(leakDetected ? { leakVia: (levelLeak ? "level" : "event") as "level" | "event" } : {}),
      ...(distanceMm !== undefined ? { distanceMm } : {}),
      lastEventAt: latest.timestamp,
      ageSeconds: Math.round(ageSeconds),
      lastEvent: latest.event,
    },
  };
}
