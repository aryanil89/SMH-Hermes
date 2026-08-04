import { createRng, range, chance, round2, type Rng } from "../common/rng.js";
import { statusForValue, worstStatus } from "../common/alerts.js";
import { COMPUTE_THRESHOLDS } from "../common/thresholds.js";
import type { Status } from "../common/types.js";

export type ServiceState = "running" | "degraded" | "down";

export interface ComputeNode {
  id: string;
  cpuPct: number;
  memPct: number;
  uptimeSec: number;
  serviceState: ServiceState;
  status: Status;
}

export interface ComputeReport {
  generatedAt: string;
  nodes: ComputeNode[];
  overallStatus: Status;
}

export interface GenerateComputeOptions {
  /** Fix the PRNG seed for reproducible output (tests). Omit for live/demo variability. */
  seed?: number;
  /** Filter to a single node id, e.g. "node-03". */
  node?: string;
}

const NODE_IDS = ["node-01", "node-02", "node-03", "node-04", "node-05", "node-06"] as const;

export function generateComputeReport(opts: GenerateComputeOptions = {}): ComputeReport {
  const rng = createRng(opts.seed);
  const nodes = NODE_IDS.filter((id) => !opts.node || id === opts.node).map((id) => buildNode(rng, id));

  return {
    generatedAt: new Date().toISOString(),
    nodes,
    overallStatus: worstStatus(...nodes.map((n) => n.status)),
  };
}

function buildNode(rng: Rng, id: string): ComputeNode {
  const stressed = chance(rng, 0.15);
  const cpuPct = stressed ? range(rng, 86, 99) : range(rng, 10, 70);
  const memPct = stressed ? range(rng, 86, 99) : range(rng, 20, 75);
  // Uptime: mostly long-running, occasionally a node that just came back from a restart.
  const uptimeSec = chance(rng, 0.1) ? Math.floor(range(rng, 30, 900)) : Math.floor(range(rng, 3600, 30 * 86400));

  let serviceState: ServiceState = "running";
  if (stressed && chance(rng, 0.35)) {
    serviceState = "down";
  } else if (stressed) {
    serviceState = "degraded";
  }

  const status = worstStatus(
    statusForValue(cpuPct, COMPUTE_THRESHOLDS.cpuPct, "high"),
    statusForValue(memPct, COMPUTE_THRESHOLDS.memPct, "high"),
    serviceState === "down" ? "critical" : serviceState === "degraded" ? "warning" : "ok",
  );

  return {
    id,
    cpuPct: round2(cpuPct),
    memPct: round2(memPct),
    uptimeSec,
    serviceState,
    status,
  };
}
