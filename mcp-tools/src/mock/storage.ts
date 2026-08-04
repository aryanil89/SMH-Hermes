import { createRng, range, chance, round2, type Rng } from "../common/rng.js";
import { statusForValue, worstStatus } from "../common/alerts.js";
import { STORAGE_THRESHOLDS } from "../common/thresholds.js";
import type { Status } from "../common/types.js";

export interface StorageVolume {
  id: string;
  zone: string;
  capacityUsedPct: number;
  failureRiskScore: number;
  status: Status;
}

export interface StorageReport {
  generatedAt: string;
  volumes: StorageVolume[];
  overallStatus: Status;
}

export interface GenerateStorageOptions {
  /** Fix the PRNG seed for reproducible output (tests). Omit for live/demo variability. */
  seed?: number;
  /** Filter to a single volume id, e.g. "vol-01". */
  volume?: string;
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
    buildVolume(rng, id, zone),
  );

  return {
    generatedAt: new Date().toISOString(),
    volumes,
    overallStatus: worstStatus(...volumes.map((v) => v.status)),
  };
}

function buildVolume(rng: Rng, id: string, zone: string): StorageVolume {
  const stressed = chance(rng, 0.12);
  const capacityUsedPct = stressed ? range(rng, 85, 98) : range(rng, 35, 75);
  const failureRiskScore = stressed ? range(rng, 55, 95) : range(rng, 2, 35);

  const status = worstStatus(
    statusForValue(capacityUsedPct, STORAGE_THRESHOLDS.capacityUsedPct, "high"),
    statusForValue(failureRiskScore, STORAGE_THRESHOLDS.failureRiskScore, "high"),
  );

  return {
    id,
    zone,
    capacityUsedPct: round2(capacityUsedPct),
    failureRiskScore: round2(failureRiskScore),
    status,
  };
}
