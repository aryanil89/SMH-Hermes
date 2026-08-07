import type { Status } from "../common/types.js";
import type { ObservedActivity } from "../environmental/types.js";

/**
 * Independent signal families. Scoring is per-family on purpose: a single root
 * cause (a hot rack) shows up as several *correlated* metrics, and adding them
 * all at full weight would inflate the score exactly when the signals are most
 * redundant. See risk.ts.
 */
export type Family = "physical" | "storage" | "network" | "compute";

export interface Evidence {
  family: Family;
  /** Human-readable signal name, e.g. "rack temperature". */
  signal: string;
  /** Formatted observed value, e.g. "34.2 C". */
  value: string;
  status: Status;
  /** Why it counts, e.g. "warning threshold 30 C". */
  detail: string;
  /** Points this signal contributed after within-family decay. */
  points: number;
  /**
   * Minimum risk level this signal forces on its own, regardless of score.
   * For signals whose cost is asymmetric enough that waiting for corroboration
   * is itself the error -- a confirmed leak being the canonical case.
   */
  floor?: RiskLevel;
}

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface RiskResult {
  /** 0-100 rule-based severity index. NOT a probability. */
  score: number;
  level: RiskLevel;
  /** Families that showed a non-ok signal. */
  familiesInvolved: Family[];
  /** Points added because independent families agree (genuine correlation). */
  correlationBonus: number;
}

/**
 * Ordinal on purpose. We have no labelled incidents and no validation set, so a
 * percentage would imply a calibration we cannot support. "none" is reserved for
 * the case where the physical input is simulated.
 */
export type ConfidenceLevel = "none" | "low" | "medium" | "high";

export interface ConfidenceResult {
  level: ConfidenceLevel;
  /** Plain-language reasons, safe to read aloud. */
  reasons: string[];
}

export interface Provenance {
  environmental: "real" | "mock";
  ageSeconds?: number;
  fallbackReason?: string;
  /** True when any input feeding this assessment was simulated. */
  simulatedInputs: boolean;
}

export interface IncidentAssessment {
  generatedAt: string;
  zone: string;
  risk: RiskResult;
  confidence: ConfidenceResult;
  evidence: Evidence[];
  /** Rule-derived cause. Deliberately hedged wording -- it is an inference. */
  likelyCause: string;
  recommendedAction: string;
  provenance: Provenance;
  /**
   * What the board's own model last inferred was happening in the room, if
   * anything (docs/ONDEVICE_ACTIVITY.md). Reported, never scored -- it is a
   * qualitative inference from a 1.5B model, not a threshold crossing, and
   * folding it into `evidence` would put points on the board, pull `physical`
   * into `familiesInvolved`, and move the correlation bonus. The risk number
   * has to stay reproducible from measurements alone.
   */
  observedActivity?: ObservedActivityNote;
  /** One-paragraph brief the model can relay verbatim. */
  summary: string;
}

export interface ObservedActivityNote extends ObservedActivity {
  /** Display form, e.g. "Person entered room". */
  humanized: string;
}
