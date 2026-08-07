import { describe, it, expect } from "vitest";
import { generateNetworkReport } from "./network.js";
import { generateStorageReport } from "./storage.js";
import { generateComputeReport } from "./compute.js";

/**
 * Base-rate guard.
 *
 * These simulators are what a viewer sees when they ask "is everything healthy?".
 * Before calibration each generator drew its incident chance independently *per
 * entity* (5 links / 4 volumes / 6 nodes), so the per-report probability compounded:
 * 68.7% of calls reported at least one CRITICAL subsystem and only 19.3% were
 * all-clear. A healthy baseline was effectively unshowable, and two families fired
 * together by coincidence 35.2% of the time -- which would have made any claim of
 * *correlation* between temperature and storage indistinguishable from noise.
 *
 * These tests pin the corrected rates so the problem cannot silently return when
 * someone tunes a probability. They are statistical, so they use a fixed seed range
 * (deterministic, no flake) and generous bands -- they are a regression tripwire,
 * not a precise measurement. Measurements live in docs/REVIEW_3_2026-08-04.md.
 */

const N = 4000;

function sample(): { anyCritical: number; twoPlus: number; allOk: number } {
  let anyCritical = 0;
  let twoPlus = 0;
  let allOk = 0;

  for (let seed = 0; seed < N; seed++) {
    // No ambientC: the healthy baseline, with no thermal incident injected.
    const statuses = [
      generateNetworkReport({ seed }).overallStatus,
      generateStorageReport({ seed }).overallStatus,
      generateComputeReport({ seed }).overallStatus,
    ];
    const criticals = statuses.filter((s) => s === "critical").length;
    if (criticals >= 1) anyCritical++;
    if (criticals >= 2) twoPlus++;
    if (statuses.every((s) => s === "ok")) allOk++;
  }

  return { anyCritical, twoPlus, allOk };
}

describe("simulated telemetry base rates", () => {
  const { anyCritical, twoPlus, allOk } = sample();

  it("reports an all-clear baseline most of the time", () => {
    // Measured ~88%. A viewer asking "is the rack healthy?" must usually be told yes.
    expect(allOk / N).toBeGreaterThan(0.8);
  });

  it("keeps spontaneous CRITICAL rare", () => {
    // Measured ~8.5%, down from 68.7%.
    expect(anyCritical / N).toBeLessThan(0.15);
  });

  it("almost never fires two families at once by chance", () => {
    // Measured ~2.6%, down from 35.2%. This is the number that decides whether a
    // correlated-incident story is evidence or coincidence.
    expect(twoPlus / N).toBeLessThan(0.06);
  });

  it("still produces some incidents, so the simulator is not a flatline", () => {
    expect(anyCritical).toBeGreaterThan(0);
  });
});
