import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSensorLogView } from "./sensor-log.js";

const NOW = new Date("2026-08-04T19:10:00.000Z");

function line(offsetSeconds: number, event: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: new Date(NOW.getTime() + offsetSeconds * 1000).toISOString(),
    event,
    temperature_c: 23.4,
    humidity_pct: 61.2,
    ...extra,
  });
}

describe("readSensorLogView", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "hermes-dash-"));
    path = join(dir, "sensor_log.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports a missing file without throwing", async () => {
    const view = await readSensorLogView({ path: join(dir, "nope.json"), now: NOW });
    expect(view.ok).toBe(false);
    expect(view.reason).toContain("not readable");
    expect(view.door.state).toBe("unknown");
  });

  it("derives channel state from the newest edge of each pair", async () => {
    await writeFile(
      path,
      [
        line(-300, "door_open"),
        line(-240, "light_on"),
        line(-180, "door_closed"),
        line(-60, "sensor_tick"),
      ].join("\n") + "\n",
    );

    const view = await readSensorLogView({ path, now: NOW });

    expect(view.ok).toBe(true);
    expect(view.door.state).toBe("closed");
    expect(view.door.heldSeconds).toBe(180);
    expect(view.light.state).toBe("on");
    expect(view.light.heldSeconds).toBe(240);
  });

  it("leaves a channel unknown when the window holds no edge for it", async () => {
    // Real case: the board only learned to emit release events partway through
    // the build, so an unobserved channel must not be rendered as its rest state.
    await writeFile(path, line(-30, "sensor_tick") + "\n");

    const view = await readSensorLogView({ path, now: NOW });

    expect(view.door.observed).toBe(false);
    expect(view.door.state).toBe("unknown");
    expect(view.presence.observed).toBe(false);
  });

  it("returns the event feed newest-first and counts every event type", async () => {
    await writeFile(
      path,
      [line(-40, "sensor_tick"), line(-30, "leak_detected"), line(-20, "sensor_tick")].join("\n") + "\n",
    );

    const view = await readSensorLogView({ path, now: NOW });

    expect(view.events[0]?.event).toBe("sensor_tick");
    expect(view.events[1]?.event).toBe("leak_detected");
    expect(view.eventCounts).toEqual({ sensor_tick: 2, leak_detected: 1 });
    expect(view.ageSeconds).toBe(20);
  });

  it("tolerates a truncated trailing line from an in-flight push", async () => {
    await writeFile(path, [line(-20, "sensor_tick"), '{"timestamp": "2026-08'].join("\n"));

    const view = await readSensorLogView({ path, now: NOW });

    expect(view.ok).toBe(true);
    expect(view.linesInWindow).toBe(1);
  });

  it("carries the newest measured distance forward past distance-free ticks", async () => {
    // Since 2026-08-05 the board puts distance on presence/button lines only, so
    // the newest line is almost always a tick with no distance at all. Reading
    // only the newest line -- which is what the MCP tool does -- would report no
    // distance essentially always.
    await writeFile(
      path,
      [
        line(-200, "object_entered", { distance_mm: 380 }),
        line(-30, "sensor_tick"),
        line(-20, "sensor_tick"),
      ].join("\n") + "\n",
    );

    const view = await readSensorLogView({ path, now: NOW });

    expect(view.distanceMm).toBe(380);
    expect(view.distanceAt).toBeDefined();
  });

  it("drops a distance reading of -1 (the sketch's no-sample sentinel)", async () => {
    await writeFile(
      path,
      [line(-30, "object_entered", { distance_mm: -1 }), line(-10, "object_left", { distance_mm: 420 })].join("\n") +
        "\n",
    );

    const view = await readSensorLogView({ path, now: NOW });

    expect(view.events[1]?.distanceMm).toBeUndefined();
    expect(view.events[0]?.distanceMm).toBe(420);
    expect(view.presence.state).toBe("clear");
  });

  it("keeps the climate series in chronological order for the sparkline", async () => {
    await writeFile(
      path,
      [
        line(-30, "sensor_tick", { temperature_c: 22 }),
        line(-20, "sensor_tick", { temperature_c: 23 }),
        line(-10, "sensor_tick", { temperature_c: 24 }),
      ].join("\n") + "\n",
    );

    const view = await readSensorLogView({ path, now: NOW });

    expect(view.climate.map((p) => p.temperatureC)).toEqual([22, 23, 24]);
  });

  it("surfaces activity/trigger on the individual event feed entries", async () => {
    // Written by uno-q/hermes-sensor-logger/python/activity.py -- see
    // docs/ONDEVICE_ACTIVITY.md. Consumed by the pipeline stream and the raw
    // Sensor-log feed (both in app.js); there is no dedicated device-level
    // "latest activity" field -- that was tried as a wall tile and removed in
    // favour of a Telegram push (see alert-skill/tick.ts).
    await writeFile(path, line(-10, "activity", { activity: "activity-possible_fire_risk", trigger: "temp_humidity_rate" }) + "\n");

    const view = await readSensorLogView({ path, now: NOW });

    expect(view.events[0]?.activity).toBe("activity-possible_fire_risk");
    expect(view.events[0]?.trigger).toBe("temp_humidity_rate");
  });
});
