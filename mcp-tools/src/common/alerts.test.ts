import { describe, it, expect } from "vitest";
import { statusForValue, worstStatus, isWorseThan, statusRank } from "./alerts.js";

describe("statusForValue", () => {
  const thresholds = { warning: 50, critical: 100 };

  it("returns ok below warning", () => {
    expect(statusForValue(10, thresholds)).toBe("ok");
    expect(statusForValue(49.9, thresholds)).toBe("ok");
  });

  it("returns warning at/above the warning threshold", () => {
    expect(statusForValue(50, thresholds)).toBe("warning");
    expect(statusForValue(99, thresholds)).toBe("warning");
  });

  it("returns critical at/above the critical threshold", () => {
    expect(statusForValue(100, thresholds)).toBe("critical");
    expect(statusForValue(1000, thresholds)).toBe("critical");
  });

  it("supports 'low' direction (worse as value decreases)", () => {
    const low = { warning: 20, critical: 5 };
    expect(statusForValue(50, low, "low")).toBe("ok");
    expect(statusForValue(20, low, "low")).toBe("warning");
    expect(statusForValue(5, low, "low")).toBe("critical");
  });
});

describe("worstStatus", () => {
  it("returns ok for no arguments", () => {
    expect(worstStatus()).toBe("ok");
  });

  it("picks the worst of several statuses regardless of order", () => {
    expect(worstStatus("ok", "warning", "ok")).toBe("warning");
    expect(worstStatus("critical", "ok", "warning")).toBe("critical");
    expect(worstStatus("ok", "ok")).toBe("ok");
  });
});

describe("isWorseThan / statusRank", () => {
  it("ranks ok < warning < critical", () => {
    expect(statusRank("ok")).toBeLessThan(statusRank("warning"));
    expect(statusRank("warning")).toBeLessThan(statusRank("critical"));
  });

  it("isWorseThan compares correctly", () => {
    expect(isWorseThan("warning", "ok")).toBe(true);
    expect(isWorseThan("critical", "warning")).toBe(true);
    expect(isWorseThan("ok", "warning")).toBe(false);
    expect(isWorseThan("warning", "warning")).toBe(false);
  });
});
