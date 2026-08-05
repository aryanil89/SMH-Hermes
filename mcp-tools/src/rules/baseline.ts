/**
 * What the system has learned about this room, computed from the sensor log.
 *
 * This is the whole of the "self-learning" claim, and it is deliberately not
 * machine learning: no weights, no model call, no training. It is min/max/mean
 * and an events-per-hour rate over whatever history the log holds. That is
 * enough to turn the validator from a datasheet lookup into something that
 * knows this particular room -- "above 50C is legal for the sensor but this
 * room has never passed 35.7 in 31 hours" is a fact nobody typed in.
 *
 * Recomputed from the full file every tick rather than accumulated
 * incrementally. At ~2k lines that costs single-digit milliseconds, and it
 * cannot drift out of sync with the log the way a running total can.
 */
import { parseSensorLogLine, type SensorLogLine } from "../environmental/file-source.js";
import { NUMERIC_CHANNELS } from "./channels.js";
import type { Baselines, NumericBaseline, NumericChannel } from "./types.js";

export function parseLogLines(raw: string): SensorLogLine[] {
  const out: SensorLogLine[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const parsed = parseSensorLogLine(line);
    if (parsed) out.push(parsed);
  }
  return out;
}

function summarize(values: number[]): NumericBaseline | undefined {
  if (values.length === 0) return undefined;
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return {
    n,
    mean: round(mean),
    stddev: round(Math.sqrt(variance)),
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
  };
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}

export function computeBaselines(lines: SensorLogLine[], now = new Date()): Baselines {
  const numeric: Partial<Record<NumericChannel, NumericBaseline>> = {};

  for (const [name, spec] of Object.entries(NUMERIC_CHANNELS)) {
    const values: number[] = [];
    for (const line of lines) {
      const v = line[spec.field];
      // -1 is the sketch's "no usable ranging result", not a measurement of 1mm.
      if (typeof v === "number" && Number.isFinite(v) && !(spec.sparse && v < 0)) {
        values.push(v);
      }
    }
    const summary = summarize(values);
    if (summary) numeric[name as NumericChannel] = summary;
  }

  // Window is measured from the log itself, not assumed: the file is the
  // board's, overwritten wholesale by scp, so its depth is whatever the board
  // still holds and can shrink after a board reboot.
  const first = lines[0];
  const last = lines[lines.length - 1];
  const firstMs = first ? Date.parse(first.timestamp) : NaN;
  const lastMs = last ? Date.parse(last.timestamp) : NaN;
  const spanHours =
    Number.isFinite(firstMs) && Number.isFinite(lastMs) && lastMs > firstMs
      ? (lastMs - firstMs) / 3_600_000
      : 0;

  const events: Baselines["events"] = {};
  for (const line of lines) {
    if (line.event === "sensor_tick") continue; // the carrier, not an event
    const prev = events[line.event] ?? { count: 0, perHour: 0 };
    events[line.event] = { count: prev.count + 1, perHour: 0, lastAt: line.timestamp };
  }
  for (const key of Object.keys(events)) {
    const e = events[key];
    if (!e) continue;
    e.perHour = spanHours > 0 ? round(e.count / spanHours) : 0;
  }

  return {
    computedAt: now.toISOString(),
    windowHours: round(spanHours),
    lines: lines.length,
    numeric,
    events,
  };
}
