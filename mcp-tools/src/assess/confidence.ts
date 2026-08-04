import type { ConfidenceLevel, ConfidenceResult, Family, Provenance } from "./types.js";

/**
 * Confidence is about PROVENANCE, not severity.
 *
 * The failure this is designed to prevent actually happened on 2026-08-04: the
 * watchdog pushed "CRITICAL, 38.95C, humidity 90.19%" to the on-call phone while
 * the board had been offline for 10.7 hours. The reading was honestly labelled
 * as mock -- but the *severity was unchanged* by the fact that every number in it
 * was invented. Severity without provenance is a confident lie.
 *
 * So: risk answers "how bad if true", confidence answers "how much should you
 * believe it". They are reported separately and never multiplied together.
 *
 * Levels are ordinal because we have no labelled incidents to calibrate against.
 * A percentage here would be false precision.
 */

/** Real data older than this is technically fresh but no longer authoritative. */
const SOFT_STALE_S = 60;

export interface ConfidenceInput {
  provenance: Provenance;
  /** Families showing a non-ok signal. */
  familiesInvolved: Family[];
  /** Families that were evaluated and came back clean. */
  familiesClean: Family[];
}

const ORDER: ConfidenceLevel[] = ["none", "low", "medium", "high"];

function downgrade(level: ConfidenceLevel): ConfidenceLevel {
  const idx = ORDER.indexOf(level);
  return ORDER[Math.max(0, idx - 1)] as ConfidenceLevel;
}

export function assessConfidence(input: ConfidenceInput): ConfidenceResult {
  const { provenance, familiesInvolved, familiesClean } = input;
  const reasons: string[] = [];

  // 1. Simulated physical input is disqualifying, whatever the numbers say.
  if (provenance.environmental === "mock") {
    return {
      level: "none",
      reasons: [
        "The physical reading is SIMULATED, not measured" +
          (provenance.fallbackReason ? ` (${provenance.fallbackReason})` : "") +
          " -- treat every value here as illustrative, not evidence.",
        "Restore the sensor path before acting on this assessment.",
      ],
    };
  }

  let level: ConfidenceLevel = "medium";
  reasons.push("Physical reading is live from the board sensor.");

  const age = provenance.ageSeconds;
  if (age !== undefined && age > SOFT_STALE_S) {
    level = "low";
    reasons.push(`Sensor data is ${Math.round(age)}s old -- recent, but no longer current.`);
  } else if (age !== undefined) {
    reasons.push(`Sensor data is ${Math.round(age)}s old.`);
  }

  // 2. Independent corroboration raises confidence; a lone signal does not.
  if (familiesInvolved.length >= 2 && level !== "low") {
    level = "high";
    reasons.push(
      `${familiesInvolved.length} independent signal families agree (${familiesInvolved.join(", ")}).`,
    );
  } else if (familiesInvolved.length === 1) {
    reasons.push(
      `Only one signal family (${familiesInvolved[0]}) is affected -- not yet corroborated.`,
    );
  } else if (familiesInvolved.length === 0) {
    level = "high";
    reasons.push("All evaluated families are within thresholds.");
  }

  // 3. A physical signal that nothing downstream reflects may be a sensor fault
  //    rather than an incident. Say so instead of quietly escalating.
  const physicalOnly = familiesInvolved.length === 1 && familiesInvolved[0] === "physical";
  if (physicalOnly && familiesClean.length > 0) {
    level = downgrade(level);
    reasons.push(
      "Physical signal is not yet reflected in storage, network or compute -- " +
        "could be an early warning or a sensor artefact.",
    );
  }

  return { level, reasons };
}
