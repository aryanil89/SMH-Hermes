import { createRng, range, chance, round2, type Rng } from "../common/rng.js";
import { statusForValue, worstStatus } from "../common/alerts.js";
import { NETWORK_THRESHOLDS } from "../common/thresholds.js";
import type { Status } from "../common/types.js";

export interface NetworkLink {
  id: string;
  from: string;
  to: string;
  latencyMs: number;
  packetLossPct: number;
  connected: boolean;
  status: Status;
}

export interface NetworkReport {
  generatedAt: string;
  links: NetworkLink[];
  overallStatus: Status;
}

export interface GenerateNetworkOptions {
  /** Fix the PRNG seed for reproducible output (tests). Omit for live/demo variability. */
  seed?: number;
  /** Filter to links whose "from" or "to" name contains this substring (case-insensitive). */
  zone?: string;
}

/** Fixed rack/zone topology -- small and readable is enough for a hackathon demo. */
const TOPOLOGY: ReadonlyArray<readonly [string, string]> = [
  ["rack-a1", "rack-a2"],
  ["rack-a2", "rack-b1"],
  ["rack-b1", "zone-east"],
  ["zone-east", "zone-west"],
  ["rack-b1", "rack-b2"],
];

export function generateNetworkReport(opts: GenerateNetworkOptions = {}): NetworkReport {
  const rng = createRng(opts.seed);
  const zoneFilter = opts.zone?.toLowerCase();
  const links = TOPOLOGY.filter(
    ([from, to]) => !zoneFilter || from.toLowerCase().includes(zoneFilter) || to.toLowerCase().includes(zoneFilter),
  ).map(([from, to]) => buildLink(rng, from, to));

  return {
    generatedAt: new Date().toISOString(),
    links,
    overallStatus: worstStatus(...links.map((l) => l.status)),
  };
}

function buildLink(rng: Rng, from: string, to: string): NetworkLink {
  const degraded = chance(rng, 0.15);
  const latencyMs = degraded ? range(rng, 60, 220) : range(rng, 2, 25);
  const packetLossPct = degraded ? range(rng, 1, 8) : range(rng, 0, 0.3);
  // A degraded link occasionally drops entirely -- rare, so demos mostly see "slow", not "down".
  const connected = !(degraded && chance(rng, 0.15));

  const status: Status = connected
    ? worstStatus(
        statusForValue(latencyMs, NETWORK_THRESHOLDS.latencyMs, "high"),
        statusForValue(packetLossPct, NETWORK_THRESHOLDS.packetLossPct, "high"),
      )
    : "critical";

  return {
    id: `${from}--${to}`,
    from,
    to,
    latencyMs: round2(latencyMs),
    packetLossPct: round2(packetLossPct),
    connected,
    status,
  };
}
