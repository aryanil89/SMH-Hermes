import { describe, it, expect } from "vitest";
import { computeBaselines, parseLogLines } from "./baseline.js";
import type { SensorLogLine } from "../environmental/file-source.js";

const T0 = Date.parse("2026-08-04T00:00:00.000Z");

function line(offsetSeconds: number, over: Partial<SensorLogLine> = {}): SensorLogLine {
  return {
    timestamp: new Date(T0 + offsetSeconds * 1000).toISOString(),
    event: "sensor_tick",
    temperature_c: 24,
    humidity_pct: 60,
    ...over,
  };
}

describe("computeBaselines -- the learned picture of this room", () => {
  it("summarises a numeric channel", () => {
    const lines = [
      line(0, { temperature_c: 22 }),
      line(10, { temperature_c: 24 }),
      line(20, { temperature_c: 26 }),
    ];
    const b = computeBaselines(lines);
    expect(b.numeric.temperature_c).toMatchObject({ n: 3, mean: 24, min: 22, max: 26 });
  });

  it("excludes the sketch's -1 'no ranging result' from distance stats", () => {
    // -1 is the absence of a measurement. Averaging it in would drag the mean
    // toward zero and make a water-level rule look permanently triggered.
    const lines = [
      line(0, { distance_mm: -1 }),
      line(10, { distance_mm: 200 }),
      line(20, { distance_mm: 400 }),
    ];
    const b = computeBaselines(lines);
    expect(b.numeric.distance_mm).toMatchObject({ n: 2, min: 200, max: 400, mean: 300 });
  });

  it("reports no baseline for a channel that never appeared", () => {
    const b = computeBaselines([line(0), line(10)]);
    expect(b.numeric.distance_mm).toBeUndefined();
  });

  it("derives the observation window from the log rather than assuming one", () => {
    const b = computeBaselines([line(0), line(3600), line(7200)]);
    expect(b.windowHours).toBe(2);
    expect(b.lines).toBe(3);
  });

  it("counts events per hour and ignores the sensor_tick carrier", () => {
    const lines = [
      line(0),
      line(1800, { event: "door_open" }),
      line(3600, { event: "door_open" }),
      line(7200),
    ];
    const b = computeBaselines(lines);
    expect(b.events["sensor_tick"]).toBeUndefined();
    expect(b.events["door_open"]).toMatchObject({ count: 2, perHour: 1 });
  });

  it("survives an empty log without throwing", () => {
    const b = computeBaselines([]);
    expect(b.lines).toBe(0);
    expect(b.windowHours).toBe(0);
    expect(b.numeric.temperature_c).toBeUndefined();
  });
});

describe("parseLogLines", () => {
  it("skips blank and truncated lines rather than failing the tick", () => {
    // scp can land mid-append, leaving a partial trailing line.
    const raw = [
      JSON.stringify(line(0)),
      "",
      '{"timestamp":"2026-08-04T00:00:10.000Z","event":"sensor_ti',
      JSON.stringify(line(20)),
    ].join("\n");
    expect(parseLogLines(raw)).toHaveLength(2);
  });

  it("drops records missing the fields the evaluator relies on", () => {
    const raw = [
      JSON.stringify({ timestamp: "2026-08-04T00:00:00.000Z", temperature_c: 24, humidity_pct: 60 }),
      JSON.stringify(line(10)),
    ].join("\n");
    expect(parseLogLines(raw)).toHaveLength(1);
  });

  it("rounds on the way in, so a rule quotes the number it compared", () => {
    // Verbatim from the board: raw Modulino floats. A live soak put
    // "temperature reached 35.62625503540039C" on the on-call phone.
    const raw = JSON.stringify({
      timestamp: "2026-08-04T00:00:00.000Z",
      event: "sensor_tick",
      temperature_c: 35.62625503540039,
      humidity_pct: 86.13333129882812,
      distance_mm: 149.96,
    });

    const [parsed] = parseLogLines(raw);

    expect(parsed?.temperature_c).toBe(35.6);
    expect(parsed?.humidity_pct).toBe(86.1);
    expect(parsed?.distance_mm).toBe(150);
  });

  it("leaves a line with no distance without one", () => {
    const [parsed] = parseLogLines(JSON.stringify(line(0)));
    expect(parsed).toBeDefined();
    expect("distance_mm" in (parsed as object)).toBe(false);
  });
});
