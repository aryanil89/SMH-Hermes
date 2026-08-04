import { describe, it, expect } from "vitest";
import { generateNetworkReport } from "./network.js";

describe("generateNetworkReport", () => {
  it("is deterministic for a given seed", () => {
    const a = generateNetworkReport({ seed: 42 });
    const b = generateNetworkReport({ seed: 42 });
    expect(b.links).toEqual(a.links);
    expect(b.overallStatus).toBe(a.overallStatus);
  });

  it("varies for different seeds", () => {
    const a = generateNetworkReport({ seed: 1 });
    const b = generateNetworkReport({ seed: 2 });
    expect(b.links).not.toEqual(a.links);
  });

  it("returns every link with a plausible shape", () => {
    const report = generateNetworkReport({ seed: 7 });
    expect(report.links.length).toBeGreaterThan(0);
    for (const link of report.links) {
      expect(link.latencyMs).toBeGreaterThanOrEqual(0);
      expect(link.packetLossPct).toBeGreaterThanOrEqual(0);
      expect(["ok", "warning", "critical"]).toContain(link.status);
      expect(typeof link.connected).toBe("boolean");
    }
  });

  it("filters by zone/rack substring", () => {
    const report = generateNetworkReport({ seed: 3, zone: "zone-east" });
    expect(report.links.length).toBeGreaterThan(0);
    for (const link of report.links) {
      expect(link.from.includes("zone-east") || link.to.includes("zone-east")).toBe(true);
    }
  });

  it("occasionally produces a degraded (non-ok) reading across many seeds", () => {
    const statuses = new Set<string>();
    for (let seed = 0; seed < 200; seed++) {
      const report = generateNetworkReport({ seed });
      statuses.add(report.overallStatus);
    }
    // With p(degraded) = 0.15 per link and 5 links, 200 seeds should surface a non-ok reading.
    expect(statuses.has("ok")).toBe(true);
    expect(statuses.size).toBeGreaterThan(1);
  });
});
