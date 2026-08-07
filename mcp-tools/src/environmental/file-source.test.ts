import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_MAX_AGE_S, readSensorLogReading } from "./file-source.js";
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

  it("clears leakDetected when leak_cleared follows leak_detected inside the window", async () => {
    // Button C is held then released: the board logs leak_detected followed by
    // leak_cleared. The clearing event must not itself re-raise the leak.
    await writeFile(logPath, [line(120, "leak_detected"), line(60, "leak_cleared")].join("\n"));
    const result = await readSensorLogReading({ path: logPath, now: NOW, leakWindowSeconds: 300 });
    expect(result.ok && result.reading.leakDetected).toBe(false);
  });

  it("re-raises leakDetected when a new leak_detected follows a leak_cleared", async () => {
    await writeFile(
      logPath,
      [line(200, "leak_detected"), line(150, "leak_cleared"), line(60, "leak_detected")].join("\n"),
    );
    const result = await readSensorLogReading({ path: logPath, now: NOW, leakWindowSeconds: 300 });
    expect(result.ok && result.reading.leakDetected).toBe(true);
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

  it("defaults to the production staleness window, not an hour", async () => {
    // Pins the number itself, because nothing failed the last time it drifted.
    // This default was 3600 while every deployment set 180 -- the gateway's
    // config.yaml, the demo scripts, the Scheduled Task payloads. So it applied
    // only when someone forgot the env var, and in that exact case it declared
    // an hour-dead board fresh while the wall (which had the env var) called the
    // same file stale. dashboard/snapshot.ts imports this constant rather than
    // repeating it, so the two cannot disagree again.
    const original = process.env.UNOQ_LOG_MAX_AGE_S;
    delete process.env.UNOQ_LOG_MAX_AGE_S;
    try {
      expect(DEFAULT_MAX_AGE_S).toBe(180);

      await writeFile(logPath, line(200, "sensor_tick"));
      const stale = await readSensorLogReading({ path: logPath, now: NOW });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.reason).toMatch(/stale/);

      await writeFile(logPath, line(170, "sensor_tick"));
      const fresh = await readSensorLogReading({ path: logPath, now: NOW });
      expect(fresh.ok).toBe(true);
    } finally {
      if (original === undefined) delete process.env.UNOQ_LOG_MAX_AGE_S;
      else process.env.UNOQ_LOG_MAX_AGE_S = original;
    }
  });

  it("falls back to the default when a numeric env var is malformed (NaN guard)", async () => {
    const original = process.env.UNOQ_LOG_MAX_AGE_S;
    process.env.UNOQ_LOG_MAX_AGE_S = "abc";
    try {
      // 7200s old vs the 180s default: must be stale. Before the guard,
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
  // ---- on-device activity rides along with the reading -------------------
  // The board's own small LLM writes `event: "activity"` lines into this same
  // log. The watchdog has read them for a while; the agent could not, so the
  // wall could show "person entered room" while the agent, asked about that
  // exact moment, knew only the temperature.

  function sensorLine(secondsAgo: number, event = "sensor_tick"): string {
    return JSON.stringify({
      timestamp: new Date(Date.now() - secondsAgo * 1000).toISOString(),
      event,
      temperature_c: 24.1,
      humidity_pct: 51.0,
    });
  }

  // Shaped like the board actually writes them: activity lines carry the
  // sensor values too (verified against arduino_uno_q-sensor_log.json), and
  // parseSensorLogLine requires temperature_c/humidity_pct on every line --
  // a fixture without them is silently dropped and the test passes vacuously.
  function activityLine(secondsAgo: number, activity: string, trigger?: string): string {
    return JSON.stringify({
      timestamp: new Date(Date.now() - secondsAgo * 1000).toISOString(),
      activity,
      ...(trigger ? { trigger } : {}),
      event: "activity",
      temperature_c: 23.4,
      humidity_pct: 60.2,
    });
  }

  it("carries the newest activity inference, aged, onto the reading", async () => {
    await writeFile(
      logPath,
      [
        activityLine(300, "activity-door_left_open"),
        activityLine(40, "activity-person_entered_room", "motion"),
        sensorLine(2),
      ].join("\n"),
    );
    process.env.UNOQ_SENSOR_LOG = logPath;
    const result = await getEnvironmentalReading();
    expect(result.source).toBe("real");
    expect(result.activity?.activity).toBe("activity-person_entered_room");
    expect(result.activity?.trigger).toBe("motion");
    // Newest wins: the 300s-old inference must not be the one reported.
    expect(result.activity?.ageSeconds).toBeGreaterThanOrEqual(39);
    expect(result.activity?.ageSeconds).toBeLessThanOrEqual(45);
  });

  it("still reports an activity older than the staleness window", async () => {
    // Deliberate asymmetry, and the reason readLatestActivity is a separate
    // scan: a sensor line older than UNOQ_LOG_MAX_AGE_S is untrustworthy
    // because it is a *sample* of a value that has since moved. An activity
    // line is an *event* -- "someone entered the room" four minutes ago is
    // still the last thing the board concluded, and suppressing it would tell
    // the agent nothing had happened. The age is attached so it can judge.
    await writeFile(
      logPath,
      [activityLine(600, "activity-person_entered_room"), sensorLine(2)].join("\n"),
    );
    process.env.UNOQ_SENSOR_LOG = logPath;
    const result = await getEnvironmentalReading();
    expect(result.activity?.activity).toBe("activity-person_entered_room");
    expect(result.activity?.ageSeconds).toBeGreaterThanOrEqual(595);
  });

  it("omits the field entirely when the board has inferred nothing", async () => {
    await writeFile(logPath, sensorLine(2));
    process.env.UNOQ_SENSOR_LOG = logPath;
    const result = await getEnvironmentalReading();
    expect(result.source).toBe("real");
    expect(result.activity).toBeUndefined();
  });

  it("never lets a bad activity timestamp cost us the reading or the activity", async () => {
    // An unparseable timestamp yields an activity with no age -- not a failed
    // read, and not a dropped inference. Losing a real temperature because the
    // board's narration was malformed would be the worse trade by far, and so
    // would discarding "someone entered the room" over a clock format.
    await writeFile(
      logPath,
      [
        JSON.stringify({
          timestamp: "not-a-date",
          activity: "activity-person_entered_room",
          event: "activity",
          temperature_c: 23.4,
          humidity_pct: 60.2,
        }),
        sensorLine(2),
      ].join("\n"),
    );
    process.env.UNOQ_SENSOR_LOG = logPath;
    const result = await getEnvironmentalReading();
    expect(result.source).toBe("real");
    expect(result.temperatureC).toBe(24.1);
    expect(result.activity?.activity).toBe("activity-person_entered_room");
    expect(result.activity?.ageSeconds).toBeUndefined();
  });
});
