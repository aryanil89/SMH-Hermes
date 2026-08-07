import { createRng, range, chance, type Rng } from "../common/rng.js";
import { round1 } from "../common/round.js";
import { statusForValue, worstStatus } from "../common/alerts.js";
import { STORAGE_THRESHOLDS } from "../common/thresholds.js";
import {
  THERMAL_ZONE,
  backupDelayMin,
  backupThroughputMbs,
  storageLatencyMs,
  thermalExcessC } from "../common/thermal.js";
import type { Status } from "../common/types.js";

export interface StorageVolume {
  id: string;
  zone: string;
  capacityUsedPct: number;
  failureRiskScore: number;
  /** Read latency (ms). Thermally coupled in THERMAL_ZONE -- see common/thermal.ts. */
  latencyMs: number;
  /** Backup throughput (MB/s). Degrades as the array throttles. */
  backupThroughputMbs: number;
  /** Minutes the nightly backup runs past its nominal finish time. */
  backupDelayMin: number;
  /** True when this volume's numbers were shifted by rack temperature. */
  thermallyAffected: boolean;
  status: Status;
}

export interface StorageReport {
  generatedAt: string;
  volumes: StorageVolume[];
  overallStatus: Status;
  /** Ambient rack temperature applied to this report, when one was supplied. */
  ambientC?: number;
}

export interface GenerateStorageOptions {
  /** Fix the PRNG seed for reproducible output (tests). Omit for live/demo variability. */
  seed?: number;
  /** Filter to a single volume id, e.g. "vol-01". */
  volume?: string;
  /**
   * Real rack temperature from the UNO Q. When supplied, volumes in THERMAL_ZONE
   * degrade as a documented function of it instead of drawing independent noise.
   * Omit and the generator behaves exactly as before.
   */
  ambientC?: number;
}

const VOLUMES: ReadonlyArray<readonly [string, string]> = [
  ["vol-01", "zone-east"],
  ["vol-02", "zone-east"],
  ["vol-03", "zone-west"],
  ["vol-04", "zone-west"],
];

export function generateStorageReport(opts: GenerateStorageOptions = {}): StorageReport {
  const rng = createRng(opts.seed);
  const volumes = VOLUMES.filter(([id]) => !opts.volume || id === opts.volume).map(([id, zone]) =>
    buildVolume(rng, id, zone, opts.ambientC),
  );

  return {
    generatedAt: new Date().toISOString(),
    volumes,
    overallStatus: worstStatus(...volumes.map((v) => v.status)),
    ...(opts.ambientC !== undefined ? { ambientC: round1(opts.ambientC) } : {}) };
}

/**
 * Per-volume probability of a spontaneously stressed volume (capacity/failure-risk
 * noise, independent of temperature).
 *
 * Calibrated, not guessed -- see network.ts DEGRADED_LINK_P for the measurements.
 * This is deliberately low so that the *thermal* signal below is the thing that
 * moves storage. Otherwise random capacity spikes fire critical far more often than
 * the coupling does, and "storage degraded because the rack is hot" becomes
 * unprovable on stage.
 */
const STRESSED_VOLUME_P = 0.015;

function buildVolume(rng: Rng, id: string, zone: string, ambientC?: number): StorageVolume {
  const stressed = chance(rng, STRESSED_VOLUME_P);
  const capacityUsedPct = stressed ? range(rng, 85, 98) : range(rng, 35, 75);
  const failureRiskScore = stressed ? range(rng, 55, 95) : range(rng, 2, 35);

  // Only the instrumented zone feels the heat. zone-west is the control: if a
  // reviewer asks "how do you know it's thermal?", the answer is that the other
  // zone, running the same simulator, did not move.
  const affected = zone === THERMAL_ZONE && ambientC !== undefined;
  const excessC = affected ? thermalExcessC(ambientC) : 0;

  // Small independent jitter so two volumes in the same zone are not identical,
  // while the thermal term stays the dominant, reproducible signal.
  const jitter = range(rng, 0.92, 1.08);
  const latencyMs = storageLatencyMs(excessC) * jitter;
  const throughput = backupThroughputMbs(excessC) * range(rng, 0.97, 1.03);
  const delayMin = Math.max(0, backupDelayMin(throughput));

  const status = worstStatus(
    statusForValue(capacityUsedPct, STORAGE_THRESHOLDS.capacityUsedPct, "high"),
    statusForValue(failureRiskScore, STORAGE_THRESHOLDS.failureRiskScore, "high"),
    statusForValue(latencyMs, STORAGE_THRESHOLDS.latencyMs, "high"),
    statusForValue(throughput, STORAGE_THRESHOLDS.backupThroughputMbs, "low"),
    statusForValue(delayMin, STORAGE_THRESHOLDS.backupDelayMin, "high"),
  );

  return {
    id,
    zone,
    capacityUsedPct: round1(capacityUsedPct),
    failureRiskScore: round1(failureRiskScore),
    latencyMs: round1(latencyMs),
    backupThroughputMbs: round1(throughput),
    backupDelayMin: round1(delayMin),
    thermallyAffected: affected && excessC > 0,
    status };
}
