import type { Thresholds } from "./types.js";

export const NETWORK_THRESHOLDS = {
  latencyMs: { warning: 50, critical: 150 } as Thresholds,
  packetLossPct: { warning: 1, critical: 5 } as Thresholds,
};

export const STORAGE_THRESHOLDS = {
  capacityUsedPct: { warning: 80, critical: 92 } as Thresholds,
  failureRiskScore: { warning: 60, critical: 85 } as Thresholds,
  /** Read latency. Thermally coupled -- see common/thermal.ts. */
  latencyMs: { warning: 40, critical: 80 } as Thresholds,
  /** Backup throughput degrades as the array throttles, so "low is worse". */
  backupThroughputMbs: { warning: 320, critical: 240 } as Thresholds,
  /** Minutes the nightly job runs past its nominal finish time. */
  backupDelayMin: { warning: 10, critical: 25 } as Thresholds,
};

export const COMPUTE_THRESHOLDS = {
  cpuPct: { warning: 85, critical: 95 } as Thresholds,
  memPct: { warning: 85, critical: 95 } as Thresholds,
};

/** Also used by the proactive-alert cron skill (src/alert-skill), not just the MCP tool. */
export const ENVIRONMENTAL_THRESHOLDS = {
  temperatureC: { warning: 30, critical: 35 } as Thresholds,
  humidityPct: { warning: 70, critical: 85 } as Thresholds,
};
