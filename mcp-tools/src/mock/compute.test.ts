import { describe, it, expect } from "vitest";
import { generateComputeReport } from "./compute.js";

describe("generateComputeReport", () => {
  it("is deterministic for a given seed", () => {
    const a = generateComputeReport({ seed: 99 });
    const b = generateComputeReport({ seed: 99 });
    // generatedAt is wall-clock, not seeded -- comparing it makes the test
    // flaky across millisecond boundaries.
    expect({ ...b, generatedAt: "" }).toEqual({ ...a, generatedAt: "" });
  });

  it("returns plausible node shapes", () => {
    const report = generateComputeReport({ seed: 4 });
    expect(report.nodes.length).toBeGreaterThan(0);
    for (const node of report.nodes) {
      expect(node.cpuPct).toBeGreaterThanOrEqual(0);
      expect(node.memPct).toBeGreaterThanOrEqual(0);
      expect(node.uptimeSec).toBeGreaterThan(0);
      expect(["running", "degraded", "down"]).toContain(node.serviceState);
      expect(["ok", "warning", "critical"]).toContain(node.status);
    }
  });

  it("filters by node id", () => {
    const report = generateComputeReport({ seed: 1, node: "node-03" });
    expect(report.nodes).toHaveLength(1);
    expect(report.nodes[0]?.id).toBe("node-03");
  });

  it("a down service always yields critical status", () => {
    let sawDown = false;
    for (let seed = 0; seed < 300; seed++) {
      const report = generateComputeReport({ seed });
      for (const node of report.nodes) {
        if (node.serviceState === "down") {
          sawDown = true;
          expect(node.status).toBe("critical");
        }
      }
    }
    expect(sawDown).toBe(true);
  });
});
