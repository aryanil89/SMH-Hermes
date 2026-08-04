import { describe, it, expect } from "vitest";
import { generateMockEnvironmentalReading } from "./mock-environmental.js";

describe("generateMockEnvironmentalReading", () => {
  it("is deterministic for a given seed", () => {
    const a = generateMockEnvironmentalReading(123);
    const b = generateMockEnvironmentalReading(123);
    expect(b).toEqual(a);
  });

  it("returns plausible ranges", () => {
    for (let seed = 0; seed < 50; seed++) {
      const r = generateMockEnvironmentalReading(seed);
      expect(r.temperatureC).toBeGreaterThan(0);
      expect(r.temperatureC).toBeLessThan(50);
      expect(r.humidityPct).toBeGreaterThanOrEqual(0);
      expect(r.humidityPct).toBeLessThanOrEqual(100);
      expect(typeof r.leakDetected).toBe("boolean");
    }
  });

  it("occasionally produces a degraded (hot/humid) reading across many seeds", () => {
    let sawDegraded = false;
    for (let seed = 0; seed < 100; seed++) {
      const r = generateMockEnvironmentalReading(seed);
      if (r.temperatureC > 30 || r.humidityPct > 70) sawDegraded = true;
    }
    expect(sawDegraded).toBe(true);
  });

  it("occasionally detects a leak across many seeds, but rarely", () => {
    let leaks = 0;
    const total = 500;
    for (let seed = 0; seed < total; seed++) {
      if (generateMockEnvironmentalReading(seed).leakDetected) leaks++;
    }
    expect(leaks).toBeGreaterThan(0);
    expect(leaks).toBeLessThan(total * 0.2);
  });
});
