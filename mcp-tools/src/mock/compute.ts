import { createRng, range, chance, type Rng } from "../common/rng.js";
import { round1 } from "../common/round.js";
import { statusForValue, worstStatus } from "../common/alerts.js";
import { COMPUTE_THRESHOLDS } from "../common/thresholds.js";
import { thermalThrottled, throttleCpuPenaltyPct } from "../common/thermal.js";
import type { Status } from "../common/types.js";

export type ServiceState = "running" | "degraded" | "down";

export interface ComputeNode {
  id: string;
  cpuPct: number;
  memPct: number;
  uptimeSec: number;
  serviceState: ServiceState;
  /**
   * Hardware clock throttling from ambient heat -- see common/thermal.ts.
   * Optional because it is derived from the simulated rack's ambient
   * temperature: the one real node (real/host-compute.ts) has no counter Node
   * can read for this, and omits the field rather than claiming `false`.
   */
  thermalThrottle?: boolean;
  status: Status;
  /**
   * Where the numbers came from. Every node carries it so a reader never has
   * to know which module produced a row -- an unlabelled real number sitting
   * next to five invented ones invites trust in all six.
   */
  source?: "real" | "mock";
}

export interface ComputeReport {
  generatedAt: string;
  nodes: ComputeNode[];
  overallStatus: Status;
  ambientC?: number;
}

export interface GenerateComputeOptions {
  /** Fix the PRNG seed for reproducible output (tests). Omit for live/demo variability. */
  seed?: number;
  /** Filter to a single node id, e.g. "node-03". */
  node?: string;
  /**
   * Real rack temperature. Above THROTTLE_ONSET_C nodes throttle, which reads as
   * higher CPU utilisation for the same work. Omit for the previous behaviour.
   */
  ambientC?: number;
}

const NODE_IDS = ["node-01", "node-02", "node-03", "node-04", "node-05", "node-06"] as const;

export function generateComputeReport(opts: GenerateComputeOptions = {}): ComputeReport {
  const rng = createRng(opts.seed);
  const nodes = NODE_IDS.filter((id) => !opts.node || id === opts.node).map((id) =>
    buildNode(rng, id, opts.ambientC),
  );

  return {
    generatedAt: new Date().toISOString(),
    nodes,
    overallStatus: worstStatus(...nodes.map((n) => n.status)),
    ...(opts.ambientC !== undefined ? { ambientC: round1(opts.ambientC) } : {}) };
}

/**
 * Per-node probability of a spontaneously stressed node (CPU/memory noise,
 * independent of temperature). Calibrated -- see network.ts DEGRADED_LINK_P.
 */
const STRESSED_NODE_P = 0.01;

function buildNode(rng: Rng, id: string, ambientC?: number): ComputeNode {
  const stressed = chance(rng, STRESSED_NODE_P);
  const throttle = thermalThrottled(ambientC);
  const cpuPct = Math.min(
    99,
    (stressed ? range(rng, 86, 99) : range(rng, 10, 70)) + throttleCpuPenaltyPct(ambientC),
  );
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
    cpuPct: round1(cpuPct),
    memPct: round1(memPct),
    uptimeSec,
    serviceState,
    thermalThrottle: throttle,
    status,
    source: "mock" };
}
