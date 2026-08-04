import { describe, it, expect } from "vitest";
import { generateStorageReport } from "./storage.js";

describe("generateStorageReport", () => {
  it("is deterministic for a given seed", () => {
    const a = generateStorageReport({ seed: 11 });
    const b = generateStorageReport({ seed: 11 });
    // generatedAt is wall-clock, not seeded -- comparing it makes the test
    // flaky across millisecond boundaries.
    expect({ ...b, generatedAt: "" }).toEqual({ ...a, generatedAt: "" });
  });

  it("returns plausible volume shapes", () => {
    const report = generateStorageReport({ seed: 5 });
    expect(report.volumes.length).toBeGreaterThan(0);
    for (const vol of report.volumes) {
      expect(vol.capacityUsedPct).toBeGreaterThanOrEqual(0);
      expect(vol.capacityUsedPct).toBeLessThanOrEqual(100);
      expect(vol.failureRiskScore).toBeGreaterThanOrEqual(0);
      expect(["ok", "warning", "critical"]).toContain(vol.status);
    }
  });

  it("filters by volume id", () => {
    const report = generateStorageReport({ seed: 1, volume: "vol-02" });
    expect(report.volumes).toHaveLength(1);
    expect(report.volumes[0]?.id).toBe("vol-02");
  });

  it("occasionally produces a degraded (non-ok) reading across many seeds", () => {
    const statuses = new Set<string>();
    for (let seed = 0; seed < 200; seed++) {
      statuses.add(generateStorageReport({ seed }).overallStatus);
    }
    expect(statuses.has("ok")).toBe(true);
    expect(statuses.size).toBeGreaterThan(1);
  });
});
