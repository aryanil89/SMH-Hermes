import type { Thresholds } from "./types.js";

export const NETWORK_THRESHOLDS = {
  latencyMs: { warning: 50, critical: 150 } as Thresholds,
  packetLossPct: { warning: 1, critical: 5 } as Thresholds,
};

export const STORAGE_THRESHOLDS = {
  capacityUsedPct: { warning: 80, critical: 92 } as Thresholds,
  failureRiskScore: { warning: 60, critical: 85 } as Thresholds,
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
