/**
 * Network telemetry -- DELIBERATELY NOT COUPLED to rack temperature.
 *
 * This is the control family. Storage and compute degrade as a function of the
 * real ambient temperature (see common/thermal.ts); network does not, and takes
 * no `ambientC` option at all. That asymmetry is what lets the agent say
 * "thermal, not network" and be right, instead of blaming everything at once.
 * Do not add thermal coupling here -- it would destroy the discriminating signal.
 */
import { createRng, range, chance, type Rng } from "../common/rng.js";
import { round1 } from "../common/round.js";
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
    overallStatus: worstStatus(...links.map((l) => l.status)) };
}

/**
 * Per-link probability of a degraded link.
 *
 * Calibrated, not guessed. At the original 0.15 this topology reported an overall
 * CRITICAL on 44% of calls, because the chance compounds over 5 links and a degraded
 * link is critical ~73% of the time. Combined with the other two simulators, 69% of
 * all tool calls surfaced at least one CRITICAL subsystem and only 19% were all-clear
 * -- so a "healthy baseline" was unshowable and any correlation between families was
 * usually coincidence. See docs/REVIEW_3_2026-08-04.md for the measurements.
 *
 * Baseline health is now the normal state; incidents are injected deliberately.
 */
const DEGRADED_LINK_P = 0.01;

function buildLink(rng: Rng, from: string, to: string): NetworkLink {
  const degraded = chance(rng, DEGRADED_LINK_P);
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
    latencyMs: round1(latencyMs),
    packetLossPct: round1(packetLossPct),
    connected,
    status };
}
