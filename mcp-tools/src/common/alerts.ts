import type { Status, Thresholds } from "./types.js";

/**
 * Map a numeric metric to a Status against a warning/critical threshold pair.
 *
 * direction "high" (default): worse as the value increases (latency, packet loss, capacity used).
 * direction "low": worse as the value decreases (e.g. free space, if ever modeled that way).
 */
export function statusForValue(value: number, thresholds: Thresholds, direction: "high" | "low" = "high"): Status {
  const crossed = (limit: number): boolean => (direction === "high" ? value >= limit : value <= limit);
  if (crossed(thresholds.critical)) return "critical";
  if (crossed(thresholds.warning)) return "warning";
  return "ok";
}

const RANK: Record<Status, number> = { ok: 0, warning: 1, critical: 2 };

/** Combine several statuses into the single worst one (used to roll up a list into one overall status). */
export function worstStatus(...statuses: Status[]): Status {
  return statuses.reduce<Status>((worst, s) => (RANK[s] > RANK[worst] ? s : worst), "ok");
}

export function statusRank(s: Status): number {
  return RANK[s];
}

/** True if `next` is strictly worse than `prev` (ok -> warning -> critical). */
export function isWorseThan(next: Status, prev: Status): boolean {
  return RANK[next] > RANK[prev];
}
