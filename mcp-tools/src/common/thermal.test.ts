import { describe, expect, it } from "vitest";
import {
  THERMAL_NEUTRAL_C,
  THROTTLE_ONSET_C,
  backupDelayMin,
  backupThroughputMbs,
  storageLatencyMs,
  thermalExcessC,
  thermalThrottled,
  throttleCpuPenaltyPct,
} from "./thermal.js";
import { generateStorageReport } from "../mock/storage.js";
import { generateComputeReport } from "../mock/compute.js";

describe("thermalExcessC", () => {
  it("is zero at or below the neutral point, and never negative", () => {
    expect(thermalExcessC(THERMAL_NEUTRAL_C)).toBe(0);
    expect(thermalExcessC(10)).toBe(0);
  });

  it("is zero for a missing or non-finite reading (no coupling without data)", () => {
    expect(thermalExcessC(undefined)).toBe(0);
    expect(thermalExcessC(Number.NaN)).toBe(0);
  });

  it("grows with temperature above neutral", () => {
    expect(thermalExcessC(THERMAL_NEUTRAL_C + 8)).toBeCloseTo(8);
  });
});

describe("transfer functions", () => {
  it("storage latency is monotonic in thermal excess", () => {
    const cool = storageLatencyMs(0);
    const warm = storageLatencyMs(8);
    const hot = storageLatencyMs(15);
    expect(cool).toBeLessThan(warm);
    expect(warm).toBeLessThan(hot);
  });

  it("storage latency crosses warning by ~34C and critical by ~41C", () => {
    expect(storageLatencyMs(THROTTLE_ONSET_C - THERMAL_NEUTRAL_C)).toBeGreaterThan(40);
    expect(storageLatencyMs(15)).toBeGreaterThan(80);
  });

  it("backup throughput degrades with heat but never collapses to zero", () => {
    expect(backupThroughputMbs(0)).toBeGreaterThan(backupThroughputMbs(10));
    expect(backupThroughputMbs(100)).toBeGreaterThan(0);
  });

  it("backup delay is zero at nominal throughput and positive when throttled", () => {
    expect(backupDelayMin(backupThroughputMbs(0))).toBeCloseTo(0, 5);
    expect(backupDelayMin(backupThroughputMbs(12))).toBeGreaterThan(0);
  });

  it("throttling engages only at the onset temperature", () => {
    expect(thermalThrottled(THROTTLE_ONSET_C - 0.1)).toBe(false);
    expect(thermalThrottled(THROTTLE_ONSET_C)).toBe(true);
    expect(thermalThrottled(undefined)).toBe(false);
    expect(throttleCpuPenaltyPct(20)).toBe(0);
    expect(throttleCpuPenaltyPct(40)).toBeGreaterThan(0);
    expect(throttleCpuPenaltyPct(200)).toBeLessThanOrEqual(15);
  });
});

describe("coupling is zone-scoped (zone-west is the control)", () => {
  it("heats zone-east storage while leaving zone-west untouched", () => {
    const hot = generateStorageReport({ seed: 7, ambientC: 38 });
    const east = hot.volumes.filter((v) => v.zone === "zone-east");
    const west = hot.volumes.filter((v) => v.zone === "zone-west");

    for (const v of east) {
      expect(v.thermallyAffected).toBe(true);
      expect(v.latencyMs).toBeGreaterThan(40);
    }
    // The claim that makes the RCA defensible: same simulator, same call, no heat.
    for (const v of west) {
      expect(v.thermallyAffected).toBe(false);
      expect(v.latencyMs).toBeLessThan(25);
    }
  });

  it("is a no-op when no temperature is supplied (previous behaviour preserved)", () => {
    const report = generateStorageReport({ seed: 7 });
    for (const v of report.volumes) {
      expect(v.thermallyAffected).toBe(false);
      expect(v.latencyMs).toBeLessThan(25);
    }
    expect(report.ambientC).toBeUndefined();
  });

  it("is reproducible: same seed and temperature give the same numbers", () => {
    const a = generateStorageReport({ seed: 42, ambientC: 36 });
    const b = generateStorageReport({ seed: 42, ambientC: 36 });
    expect(a.volumes.map((v) => v.latencyMs)).toEqual(b.volumes.map((v) => v.latencyMs));
  });

  it("raises compute CPU and flags throttling only when hot", () => {
    const cool = generateComputeReport({ seed: 3, ambientC: 24 });
    const hot = generateComputeReport({ seed: 3, ambientC: 39 });
    expect(cool.nodes.every((n) => !n.thermalThrottle)).toBe(true);
    expect(hot.nodes.every((n) => n.thermalThrottle)).toBe(true);
    const coolMax = Math.max(...cool.nodes.map((n) => n.cpuPct));
    const hotMax = Math.max(...hot.nodes.map((n) => n.cpuPct));
    expect(hotMax).toBeGreaterThan(coolMax);
  });
});
