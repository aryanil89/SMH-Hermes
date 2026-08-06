import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { round1, fixed1 } from "./round.js";
import { readSensorLogReading } from "../environmental/file-source.js";
import { readSensorLogView } from "../dashboard/sensor-log.js";
import { generateMockEnvironmentalReading } from "../environmental/mock-environmental.js";
import { generateNetworkReport } from "../mock/network.js";
import { generateStorageReport } from "../mock/storage.js";
import { generateComputeReport } from "../mock/compute.js";
import { computeBaselines, parseLogLines } from "../rules/baseline.js";
import { summarizeReading } from "../alert-skill/summarize.js";

const NOW = new Date("2026-08-03T12:00:00Z");

/** The precision the board actually logs: raw Modulino floats. */
const RAW_TEMP = 27.16626739501953;
const RAW_HUM = 50.89215087890625;
const RAW_DIST = 133.04999923706055;

function rawLine(secondsBeforeNow: number, event: string, distanceMm: number = RAW_DIST): string {
  return JSON.stringify({
    timestamp: new Date(NOW.getTime() - secondsBeforeNow * 1000).toISOString(),
    event,
    temperature_c: RAW_TEMP,
    humidity_pct: RAW_HUM,
    distance_mm: distanceMm,
  });
}

/** Every finite number anywhere in a payload, however deeply nested. */
function numbersIn(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number") {
    if (Number.isFinite(value)) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) numbersIn(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) numbersIn(item, out);
  }
  return out;
}

function decimals(n: number): number {
  const text = String(n);
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

describe("round1 / fixed1", () => {
  it("limits a raw sensor float to one decimal", () => {
    expect(round1(RAW_TEMP)).toBe(27.2);
    expect(round1(RAW_HUM)).toBe(50.9);
    expect(round1(RAW_DIST)).toBe(133);
  });

  it("leaves whole numbers whole, and pads only when formatting", () => {
    expect(round1(22)).toBe(22);
    expect(fixed1(22)).toBe("22.0");
    expect(fixed1(round1(RAW_TEMP))).toBe("27.2");
  });

  it("does not accumulate float error on a value already rounded", () => {
    expect(round1(round1(RAW_TEMP))).toBe(round1(RAW_TEMP));
  });

  it("rounds halves up, including below zero", () => {
    // Math.round breaks ties toward +Infinity, so a negative half rounds toward
    // zero (-2.25 -> -2.2, not -2.3). Pinned rather than fixed: the channel spec
    // allows -40 C, and a tenth either way on a tie is not worth a custom
    // rounder -- but it should not surprise anyone reading a cold-aisle number.
    expect(round1(0.05)).toBe(0.1);
    expect(round1(-2.25)).toBe(-2.2);
  });
});

describe("readings leave the environmental tool at one decimal", () => {
  let dir: string;
  let logPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "round-log-"));
    logPath = path.join(dir, "sensor_log.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("rounds temperature, humidity and distance off the raw log", async () => {
    await writeFile(logPath, rawLine(30, "sensor_tick"));
    const result = await readSensorLogReading({ path: logPath, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reading.temperatureC).toBe(27.2);
    expect(result.reading.humidityPct).toBe(50.9);
    expect(result.reading.distanceMm).toBe(133);
  });

  it("decides the level leak on the number it reports, not the raw one", async () => {
    // Raw 149.96 rounds to 150.0. With a 150mm threshold, comparing the raw
    // value would page a leak while reporting a distance that reads as exactly
    // at the line -- the wall and the alert disagreeing about one reading.
    await writeFile(logPath, rawLine(30, "sensor_tick", 149.96));
    const result = await readSensorLogReading({
      path: logPath,
      now: NOW,
      leakDistanceMm: 150,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reading.distanceMm).toBe(150);
    expect(result.reading.leakDetected).toBe(false);
  });

  it("still detects a level leak once the reported number is genuinely below", async () => {
    await writeFile(logPath, rawLine(30, "sensor_tick", 149.93));
    const result = await readSensorLogReading({
      path: logPath,
      now: NOW,
      leakDistanceMm: 150,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reading.distanceMm).toBe(149.9);
    expect(result.reading.leakDetected).toBe(true);
    expect(result.reading.leakVia).toBe("level");
  });
});

describe("the wall reads the same log to the same precision", () => {
  let dir: string;
  let logPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "round-wall-"));
    logPath = path.join(dir, "sensor_log.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("rounds climate points, the event feed and the newest distance", async () => {
    await writeFile(logPath, [rawLine(60, "sensor_tick"), rawLine(30, "door_open")].join("\n"));
    const result = await readSensorLogView({ path: logPath, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const point of result.climate) {
      expect(decimals(point.temperatureC)).toBeLessThanOrEqual(1);
      expect(decimals(point.humidityPct)).toBeLessThanOrEqual(1);
    }
    expect(result.climate.at(-1)?.temperatureC).toBe(27.2);
    expect(result.events[0]?.humidityPct).toBe(50.9);
    expect(result.distanceMm).toBe(133);
  });
});

describe("no generated telemetry exceeds one decimal", () => {
  // Sweeping seeds rather than asserting one: these are random generators, and
  // a single seed can miss the value that happens to land on a long float.
  const seeds = Array.from({ length: 60 }, (_, i) => i + 1);

  it("environmental, network, storage and compute", () => {
    for (const seed of seeds) {
      const payloads: unknown[] = [
        generateMockEnvironmentalReading(seed),
        generateNetworkReport({ seed }),
        generateStorageReport({ seed, ambientC: 27.16626739501953 }),
        generateComputeReport({ seed, ambientC: 27.16626739501953 }),
      ];
      for (const payload of payloads) {
        for (const n of numbersIn(payload)) {
          expect(decimals(n), `seed ${seed}: ${n} has more than one decimal`).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe("learned baselines are measurements, not float dumps", () => {
  it("rounds mean, stddev, min, max and the event rate", () => {
    const lines = parseLogLines(
      [rawLine(3600, "sensor_tick"), rawLine(1800, "sensor_tick"), rawLine(30, "door_open")].join("\n"),
    );
    const baselines = computeBaselines(lines, NOW);
    for (const n of numbersIn(baselines)) {
      expect(decimals(n), `${n} has more than one decimal`).toBeLessThanOrEqual(1);
    }
    expect(baselines.numeric.temperature_c?.max).toBe(27.2);
  });
});

describe("the alert text the phone receives", () => {
  it("pads to exactly one decimal so readings look like one instrument", () => {
    const text = summarizeReading({
      temperatureC: 22,
      humidityPct: 50.9,
      distanceMm: 133,
      leakDetected: false,
      status: "ok",
      source: "real",
      generatedAt: NOW.toISOString(),
    });
    expect(text).toContain("Temperature 22.0C");
    expect(text).toContain("humidity 50.9%");
    expect(text).toContain("water-level distance 133.0mm");
  });
});
