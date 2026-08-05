import { describe, it, expect } from "vitest";
import { validateRule } from "./validate.js";
import { computeBaselines } from "./baseline.js";
import type { SensorLogLine } from "../environmental/file-source.js";

function line(over: Partial<SensorLogLine> = {}): SensorLogLine {
  return {
    timestamp: "2026-08-04T12:00:00.000Z",
    event: "sensor_tick",
    temperature_c: 24,
    humidity_pct: 60,
    ...over,
  };
}

/** 24h of readings between 22 and 26C, with six door_open events. */
function historyLines(): SensorLogLine[] {
  const out: SensorLogLine[] = [];
  const start = Date.parse("2026-08-03T12:00:00.000Z");
  for (let i = 0; i < 240; i++) {
    out.push(
      line({
        timestamp: new Date(start + i * 360_000).toISOString(),
        temperature_c: 22 + (i % 5),
        humidity_pct: 55 + (i % 10),
      }),
    );
  }
  for (let i = 0; i < 6; i++) {
    out.push(
      line({
        timestamp: new Date(start + i * 4 * 3_600_000).toISOString(),
        event: "door_open",
      }),
    );
  }
  out.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return out;
}

describe("validateRule -- rejections (arithmetic, not opinion)", () => {
  const baselines = computeBaselines(historyLines());

  it("rejects a threshold below what the sensor can report", () => {
    const result = validateRule({
      predicate: { kind: "level", channel: "temperature_c", op: "<", value: -100 },
      baselines,
    });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === "below_sensor_range")).toBe(true);
    // The rejection must name the part and its limit -- that is what makes the
    // agent's explanation checkable rather than a plausible-sounding guess.
    expect(result.findings[0]?.detail).toContain("HS300x");
    expect(result.findings[0]?.detail).toContain("-40");
  });

  it("rejects a threshold above what the sensor can report", () => {
    const result = validateRule({
      predicate: { kind: "level", channel: "humidity_pct", op: ">", value: 150 },
      baselines,
    });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === "above_sensor_range")).toBe(true);
  });

  it("rejects an event the channel cannot emit", () => {
    const result = validateRule({
      predicate: { kind: "event", channel: "door", match: "door_exploded" },
      baselines,
    });
    expect(result.ok).toBe(false);
    expect(result.findings[0]?.code).toBe("unknown_event");
    expect(result.findings[0]?.detail).toContain("door_open");
  });

  it("rejects a non-positive duration", () => {
    // A negative window puts the cutoff in the future, so the sample set is
    // always empty and the rule is dead forever while looking armed -- exactly
    // the class of unfireable rule this validator exists to refuse.
    for (const forSeconds of [0, -600]) {
      const result = validateRule({
        predicate: { kind: "sustained", channel: "temperature_c", op: ">", value: 25, forSeconds },
        baselines,
      });
      expect(result.ok).toBe(false);
      expect(result.findings[0]?.code).toBe("invalid_duration");
    }
  });

  it("rejects a non-positive armed window", () => {
    const result = validateRule({
      predicate: { kind: "event", channel: "door", match: "door_open" },
      baselines,
      windowSeconds: -3600,
    });
    expect(result.ok).toBe(false);
    expect(result.findings[0]?.code).toBe("invalid_duration");
  });

  it("accepts a valid staleness duration", () => {
    const result = validateRule({ predicate: { kind: "stale", forSeconds: 600 }, baselines });
    expect(result.ok).toBe(true);
  });

  it("rejects a numeric comparison against an event channel", () => {
    const result = validateRule({
      predicate: { kind: "level", channel: "door" as never, op: ">", value: 1 },
      baselines,
    });
    expect(result.ok).toBe(false);
  });
});

describe("validateRule -- warnings (armed anyway)", () => {
  const baselines = computeBaselines(historyLines());

  it("warns when the value is reachable for the sensor but never seen here", () => {
    const result = validateRule({
      predicate: { kind: "level", channel: "temperature_c", op: ">", value: 50 },
      baselines,
    });
    expect(result.ok).toBe(true); // armed: the requester may know something we don't
    const warn = result.findings.find((f) => f.code === "never_observed");
    expect(warn?.severity).toBe("warn");
    expect(warn?.detail).toContain("26"); // quotes the observed max
  });

  it("warns when the rule is already satisfied right now", () => {
    const result = validateRule({
      predicate: { kind: "level", channel: "temperature_c", op: ">", value: 20 },
      baselines,
      current: { temperature_c: 25 },
    });
    expect(result.ok).toBe(true);
    expect(result.findings.some((f) => f.code === "already_true")).toBe(true);
  });

  it("does not warn already_true when the condition is false right now", () => {
    const result = validateRule({
      predicate: { kind: "level", channel: "temperature_c", op: ">", value: 25 },
      baselines,
      current: { temperature_c: 24 },
    });
    expect(result.findings.some((f) => f.code === "already_true")).toBe(false);
  });

  it("estimates message volume from the measured event rate", () => {
    const result = validateRule({
      predicate: { kind: "event", channel: "door", match: "door_open" },
      baselines,
      windowSeconds: 24 * 3600,
    });
    expect(result.ok).toBe(true);
    // 6 opens over ~24h stays well inside the budget: a useful validator has to
    // say "this is fine" with a number, not only ever object.
    expect(result.facts["expectedMessages"]).toBeLessThan(20);
    expect(result.findings.some((f) => f.code === "noisy")).toBe(false);
  });

  it("warns when the event rate would bury the phone", () => {
    const noisy: SensorLogLine[] = [];
    const start = Date.parse("2026-08-04T00:00:00.000Z");
    for (let i = 0; i < 400; i++) {
      noisy.push(line({ timestamp: new Date(start + i * 9_000).toISOString(), event: "door_open" }));
    }
    const result = validateRule({
      predicate: { kind: "event", channel: "door", match: "door_open" },
      baselines: computeBaselines(noisy),
      windowSeconds: 24 * 3600,
    });
    expect(result.findings.some((f) => f.code === "noisy")).toBe(true);
  });

  it("warns that distance is sparse, since a healthy sensor still goes quiet", () => {
    const result = validateRule({
      predicate: { kind: "level", channel: "distance_mm", op: "<", value: 150 },
      baselines: computeBaselines([...historyLines(), line({ distance_mm: 200 })]),
    });
    expect(result.findings.some((f) => f.code === "sparse_channel")).toBe(true);
  });

  it("warns when an event has never been logged (firmware may not emit it)", () => {
    const result = validateRule({
      predicate: { kind: "event", channel: "door", match: "door_closed" },
      baselines,
    });
    expect(result.ok).toBe(true);
    expect(result.findings.some((f) => f.code === "channel_silent")).toBe(true);
  });
});
