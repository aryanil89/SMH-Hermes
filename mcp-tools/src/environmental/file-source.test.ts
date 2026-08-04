import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSensorLogReading } from "./file-source.js";
import { getEnvironmentalReading } from "./source.js";

const NOW = new Date("2026-08-03T12:00:00Z");

function line(secondsBeforeNow: number, event: string, tempC = 24.1, humidityPct = 56.7, distanceMm = 133.0): string {
  const ts = new Date(NOW.getTime() - secondsBeforeNow * 1000).toISOString();
  return JSON.stringify({
    timestamp: ts,
    event,
    temperature_c: tempC,
    humidity_pct: humidityPct,
    distance_mm: distanceMm,
  });
}

describe("readSensorLogReading", () => {
  let dir: string;
  let logPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "unoq-log-"));
    logPath = path.join(dir, "sensor_log.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the newest line's temperature/humidity with age metadata", async () => {
    await writeFile(logPath, [line(600, "door_open", 23.0, 50), line(30, "light_on", 24.5, 57)].join("\n"));
    const result = await readSensorLogReading({ path: logPath, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reading.temperatureC).toBe(24.5);
    expect(result.reading.humidityPct).toBe(57);
    expect(result.reading.ageSeconds).toBe(30);
    expect(result.reading.lastEvent).toBe("light_on");
  });

  it("sets leakDetected when a leak_detected event is within the leak window", async () => {
    await writeFile(logPath, [line(120, "leak_detected"), line(30, "door_open")].join("\n"));
    const result = await readSensorLogReading({ path: logPath, now: NOW, leakWindowSeconds: 300 });
    expect(result.ok && result.reading.leakDetected).toBe(true);
  });

  it("clears leakDetected once the leak event ages out of the window (recovery)", async () => {
    await writeFile(logPath, [line(600, "leak_detected"), line(30, "door_open")].join("\n"));
    const result = await readSensorLogReading({ path: logPath, now: NOW, leakWindowSeconds: 300 });
    expect(result.ok && !result.reading.leakDetected).toBe(true);
  });

  it("tolerates a truncated trailing line from an in-flight push", async () => {
    const partial = '{"timestamp": "2026-08-03T11:59:5';
    await writeFile(logPath, [line(60, "door_open", 22.2, 48), partial].join("\n"));
    const result = await readSensorLogReading({ path: logPath, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reading.temperatureC).toBe(22.2);
  });

  it("rejects a stale file so the caller can fall through", async () => {
    await writeFile(logPath, line(7200, "door_open"));
    const result = await readSensorLogReading({ path: logPath, now: NOW, maxAgeSeconds: 3600 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/stale/);
  });

  it("reports a missing file as a reason, never throwing", async () => {
    const result = await readSensorLogReading({ path: path.join(dir, "nope.jsonl"), now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/not readable/);
  });

  it("reports an empty file as a reason", async () => {
    await writeFile(logPath, "\n\n");
    const result = await readSensorLogReading({ path: logPath, now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/empty/);
  });

  it("parses periodic sensor_tick lines like any other event", async () => {
    await writeFile(logPath, [line(30, "sensor_tick", 26.0, 55, 210)].join("\n"));
    const result = await readSensorLogReading({ path: logPath, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reading.lastEvent).toBe("sensor_tick");
    expect(result.reading.temperatureC).toBe(26.0);
  });

  it("surfaces distanceMm from the newest line", async () => {
    await writeFile(logPath, [line(30, "sensor_tick", 24.1, 56.7, 187)].join("\n"));
    const result = await readSensorLogReading({ path: logPath, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reading.distanceMm).toBe(187);
  });

  it("omits distanceMm when the sketch reports -1 (no sample)", async () => {
    await writeFile(logPath, [line(30, "sensor_tick", 24.1, 56.7, -1)].join("\n"));
    const result = await readSensorLogReading({ path: logPath, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reading.distanceMm).toBeUndefined();
    expect(result.reading.leakDetected).toBe(false);
  });

  it("detects a level leak when distance drops below the threshold", async () => {
    // Float risen: 90mm to the surface, threshold calibrated at 150mm.
    await writeFile(logPath, [line(30, "sensor_tick", 24.1, 56.7, 90)].join("\n"));
    const result = await readSensorLogReading({ path: logPath, now: NOW, leakDistanceMm: 150 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reading.leakDetected).toBe(true);
    expect(result.reading.leakVia).toBe("level");
  });

  it("no level leak when distance is above the threshold", async () => {
    await writeFile(logPath, [line(30, "sensor_tick", 24.1, 56.7, 210)].join("\n"));
    const result = await readSensorLogReading({ path: logPath, now: NOW, leakDistanceMm: 150 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reading.leakDetected).toBe(false);
    expect(result.reading.leakVia).toBeUndefined();
  });

  it("level detection is off when no threshold is configured", async () => {
    // 90mm would be a leak with a 150mm threshold; without one it must not fire.
    await writeFile(logPath, [line(30, "sensor_tick", 24.1, 56.7, 90)].join("\n"));
    const result = await readSensorLogReading({ path: logPath, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reading.leakDetected).toBe(false);
  });

  it("event leak still reports leakVia=event", async () => {
    await writeFile(logPath, [line(120, "leak_detected"), line(30, "sensor_tick", 24.1, 56.7, 210)].join("\n"));
    const result = await readSensorLogReading({ path: logPath, now: NOW, leakWindowSeconds: 300, leakDistanceMm: 150 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reading.leakDetected).toBe(true);
    expect(result.reading.leakVia).toBe("event");
  });

  it("falls back to the default when a numeric env var is malformed (NaN guard)", async () => {
    const original = process.env.UNOQ_LOG_MAX_AGE_S;
    process.env.UNOQ_LOG_MAX_AGE_S = "abc";
    try {
      // 7200s old vs the 3600s default: must be stale. Before the guard,
      // Number("abc")=NaN made `ageSeconds > NaN` false and this passed as fresh.
      await writeFile(logPath, line(7200, "sensor_tick"));
      const result = await readSensorLogReading({ path: logPath, now: NOW });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toMatch(/stale/);
    } finally {
      if (original === undefined) delete process.env.UNOQ_LOG_MAX_AGE_S;
      else process.env.UNOQ_LOG_MAX_AGE_S = original;
    }
  });
});

describe("getEnvironmentalReading with UNOQ_SENSOR_LOG", () => {
  const ORIGINAL_ENV = { ...process.env };
  let dir: string;
  let logPath: string;

  beforeEach(async () => {
    delete process.env.UNOQ_HOST;
    delete process.env.UNOQ_SENSOR_LOG;
    dir = await mkdtemp(path.join(tmpdir(), "unoq-src-"));
    logPath = path.join(dir, "sensor_log.jsonl");
  });

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    await rm(dir, { recursive: true, force: true });
  });

  it("prefers the pushed log file and marks the reading real/file", async () => {
    // A fresh line relative to the wall clock, since source.ts uses new Date().
    await writeFile(
      logPath,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        event: "door_open",
        temperature_c: 25.5,
        humidity_pct: 60,
      }),
    );
    process.env.UNOQ_SENSOR_LOG = logPath;
    const result = await getEnvironmentalReading();
    expect(result.source).toBe("real");
    expect(result.via).toBe("file");
    expect(result.temperatureC).toBe(25.5);
    expect(result.fallbackReason).toBeUndefined();
  });

  it("falls through to mock with the file failure in the reason when the log is unusable", async () => {
    process.env.UNOQ_SENSOR_LOG = path.join(dir, "missing.jsonl");
    const result = await getEnvironmentalReading({ seed: 4 });
    expect(result.source).toBe("mock");
    expect(result.fallbackReason).toMatch(/not readable/);
    expect(result.fallbackReason).toMatch(/UNOQ_HOST is not set/);
  });
});
