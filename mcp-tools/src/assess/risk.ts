import type { Status } from "../common/types.js";
import type { Evidence, Family, RiskLevel, RiskResult } from "./types.js";

/**
 * Rule-based severity index. Two design decisions worth defending out loud:
 *
 * 1. SCORE PER FAMILY, NOT PER METRIC. A hot rack drives up storage latency,
 *    backup delay AND backup throughput loss. Those are one event observed three
 *    times. Adding each at full weight would inflate the score precisely when the
 *    signals are most redundant, so within a family the worst signal scores full
 *    and each additional one decays.
 *
 * 2. CORRELATION ACROSS FAMILIES IS WORTH MORE THAN VOLUME WITHIN ONE. Two
 *    *independent* families agreeing is real evidence; ten metrics in one family
 *    is one symptom. Hence the cross-family bonus.
 *
 * This is an inspectable index, not a learned model and not a probability. Its
 * virtue is that the same inputs always produce the same number and a human can
 * check the arithmetic.
 */

/** Points for the worst signal in each family, by severity. */
const FAMILY_POINTS: Record<Family, { warning: number; critical: number }> = {
  physical: { warning: 22, critical: 45 },
  storage: { warning: 12, critical: 25 },
  network: { warning: 10, critical: 20 },
  compute: { warning: 8, critical: 15 },
};

/** A confirmed leak is categorically worse than a hot rack. */
export const LEAK_POINTS = 50;

/** Each additional non-ok signal within the same family counts at this rate. */
const WITHIN_FAMILY_DECAY = 0.35;

/** Independent families agreeing is the signal correlation is real. */
const CORRELATION_BONUS: Record<number, number> = { 0: 0, 1: 0, 2: 10, 3: 18, 4: 24 };

export function pointsFor(family: Family, status: Status): number {
  if (status === "ok") return 0;
  const table = FAMILY_POINTS[family];
  return status === "critical" ? table.critical : table.warning;
}

export function levelFor(score: number): RiskLevel {
  if (score <= 30) return "low";
  if (score <= 60) return "medium";
  if (score <= 80) return "high";
  return "critical";
}

const LEVEL_ORDER: RiskLevel[] = ["low", "medium", "high", "critical"];

/**
 * Some signals are categorical, not additive.
 *
 * A confirmed leak scores 50, which lands in "medium" on its own -- but water in
 * a live rack is a critical incident before anything downstream has degraded, and
 * the cost of waiting for corroboration is asymmetric: a false positive costs a
 * technician walking to a rack, a false negative costs the rack. So certain
 * signals impose a floor on the level, and the additive score still explains how
 * the rest of the picture contributed.
 */
function applyFloor(level: RiskLevel, evidence: Evidence[]): RiskLevel {
  let idx = LEVEL_ORDER.indexOf(level);
  for (const e of evidence) {
    if (e.floor) idx = Math.max(idx, LEVEL_ORDER.indexOf(e.floor));
  }
  return LEVEL_ORDER[idx] as RiskLevel;
}

/**
 * Score a list of evidence. Mutates each item's `points` so the caller can show
 * exactly where the number came from -- the score is never a black box.
 */
export function scoreRisk(evidence: Evidence[]): RiskResult {
  const byFamily = new Map<Family, Evidence[]>();
  for (const e of evidence) {
    if (e.status === "ok") continue;
    const list = byFamily.get(e.family) ?? [];
    list.push(e);
    byFamily.set(e.family, list);
  }

  let total = 0;
  const families: Family[] = [];

  for (const [family, items] of byFamily) {
    families.push(family);
    // Worst first, so the full-weight slot goes to the most severe signal.
    items.sort((a, b) => b.points - a.points);
    items.forEach((item, idx) => {
      const weighted = idx === 0 ? item.points : item.points * WITHIN_FAMILY_DECAY;
      item.points = Math.round(weighted * 10) / 10;
      total += item.points;
    });
  }

  const correlationBonus = CORRELATION_BONUS[Math.min(families.length, 4)] ?? 0;
  const score = Math.min(100, Math.round(total + correlationBonus));

  return {
    score,
    level: applyFloor(levelFor(score), evidence),
    familiesInvolved: families,
    correlationBonus,
  };
}
