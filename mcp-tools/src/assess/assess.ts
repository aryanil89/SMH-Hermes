import { getEnvironmentalReading } from "../environmental/source.js";
import { generateStorageReport } from "../mock/storage.js";
import { generateNetworkReport } from "../mock/network.js";
import { generateComputeReport } from "../mock/compute.js";
import { statusForValue, worstStatus } from "../common/alerts.js";
import {
  COMPUTE_THRESHOLDS,
  ENVIRONMENTAL_THRESHOLDS,
  NETWORK_THRESHOLDS,
  STORAGE_THRESHOLDS,
} from "../common/thresholds.js";
import { THERMAL_ZONE } from "../common/thermal.js";
import { assessConfidence } from "./confidence.js";
import { LEAK_POINTS, pointsFor, scoreRisk } from "./risk.js";
import type {
  Evidence,
  Family,
  IncidentAssessment,
  ObservedActivityNote,
  Provenance,
} from "./types.js";
import { humanizeActivity } from "../common/activity.js";

/**
 * One call, one verdict.
 *
 * This exists because of a hard constraint, not for tidiness: on the Snapdragon
 * NPU each agent iteration re-prefills the whole prompt, so every extra tool call
 * costs 2-4 minutes of demo time. Four separate status calls plus reasoning is a
 * ten-minute answer. So all the arithmetic -- risk, confidence, evidence -- runs
 * here in TypeScript in microseconds, and the model's only job is to read the
 * summary out loud. It also makes the numbers reproducible: ask twice, get the
 * same score, which a reviewer can and will check.
 */

export interface AssessOptions {
  /** Fix the PRNG seed so a scenario is reproducible on stage. */
  seed?: number;
  /** Override the environmental reading (tests / what-if scenarios). */
  environmentalOverride?: Awaited<ReturnType<typeof getEnvironmentalReading>>;
}

function fmt(n: number, unit: string, digits = 1): string {
  return `${n.toFixed(digits)}${unit}`;
}

export async function assessIncident(opts: AssessOptions = {}): Promise<IncidentAssessment> {
  const env = opts.environmentalOverride ?? (await getEnvironmentalReading());

  // The real temperature drives the simulated telemetry (common/thermal.ts).
  // Only pass it through when it is genuinely measured -- feeding a mock
  // temperature into the couplings would fabricate a correlation.
  const ambientC = env.source === "real" ? env.temperatureC : undefined;

  const storage = generateStorageReport({ seed: opts.seed, ambientC });
  const network = generateNetworkReport({ seed: opts.seed });
  const compute = generateComputeReport({ seed: opts.seed, ambientC });

  const evidence: Evidence[] = [];
  const add = (
    family: Family,
    signal: string,
    value: string,
    status: Evidence["status"],
    detail: string,
  ): void => {
    if (status === "ok") return;
    evidence.push({ family, signal, value, status, detail, points: pointsFor(family, status) });
  };

  // ---- physical -----------------------------------------------------------
  if (env.leakDetected) {
    evidence.push({
      family: "physical",
      signal: "leak",
      value: env.leakVia === "level" ? "water level rising" : "leak event",
      status: "critical",
      detail: "a confirmed leak is critical on its own -- no corroboration required",
      points: LEAK_POINTS,
      floor: "critical",
    });
  }
  const tempStatus = statusForValue(env.temperatureC, ENVIRONMENTAL_THRESHOLDS.temperatureC, "high");
  add(
    "physical",
    "rack temperature",
    fmt(env.temperatureC, " C"),
    tempStatus,
    `warning ${ENVIRONMENTAL_THRESHOLDS.temperatureC.warning} C / critical ${ENVIRONMENTAL_THRESHOLDS.temperatureC.critical} C`,
  );
  const humStatus = statusForValue(env.humidityPct, ENVIRONMENTAL_THRESHOLDS.humidityPct, "high");
  add(
    "physical",
    "humidity",
    fmt(env.humidityPct, "%"),
    humStatus,
    `warning ${ENVIRONMENTAL_THRESHOLDS.humidityPct.warning}%`,
  );

  // ---- storage ------------------------------------------------------------
  const hotVols = storage.volumes.filter((v) => v.zone === THERMAL_ZONE);
  const worstVol = [...storage.volumes].sort((a, b) => b.latencyMs - a.latencyMs)[0];
  if (worstVol) {
    add(
      "storage",
      `read latency (${worstVol.id})`,
      fmt(worstVol.latencyMs, " ms"),
      statusForValue(worstVol.latencyMs, STORAGE_THRESHOLDS.latencyMs, "high"),
      `warning ${STORAGE_THRESHOLDS.latencyMs.warning} ms / critical ${STORAGE_THRESHOLDS.latencyMs.critical} ms`,
    );
    add(
      "storage",
      "backup throughput",
      fmt(worstVol.backupThroughputMbs, " MB/s", 0),
      statusForValue(worstVol.backupThroughputMbs, STORAGE_THRESHOLDS.backupThroughputMbs, "low"),
      `below ${STORAGE_THRESHOLDS.backupThroughputMbs.warning} MB/s is degraded`,
    );
    add(
      "storage",
      "backup delay",
      fmt(worstVol.backupDelayMin, " min", 0),
      statusForValue(worstVol.backupDelayMin, STORAGE_THRESHOLDS.backupDelayMin, "high"),
      `past nominal finish; warning ${STORAGE_THRESHOLDS.backupDelayMin.warning} min`,
    );
  }
  const capWorst = [...storage.volumes].sort((a, b) => b.capacityUsedPct - a.capacityUsedPct)[0];
  if (capWorst) {
    add(
      "storage",
      `capacity (${capWorst.id})`,
      fmt(capWorst.capacityUsedPct, "%"),
      statusForValue(capWorst.capacityUsedPct, STORAGE_THRESHOLDS.capacityUsedPct, "high"),
      `warning ${STORAGE_THRESHOLDS.capacityUsedPct.warning}%`,
    );
  }

  // ---- network (the uncoupled control) ------------------------------------
  const worstLink = [...network.links].sort((a, b) => b.packetLossPct - a.packetLossPct)[0];
  if (worstLink) {
    add(
      "network",
      `packet loss (${worstLink.id})`,
      fmt(worstLink.packetLossPct, "%", 2),
      statusForValue(worstLink.packetLossPct, NETWORK_THRESHOLDS.packetLossPct, "high"),
      `warning ${NETWORK_THRESHOLDS.packetLossPct.warning}%`,
    );
    add(
      "network",
      `link latency (${worstLink.id})`,
      fmt(worstLink.latencyMs, " ms"),
      statusForValue(worstLink.latencyMs, NETWORK_THRESHOLDS.latencyMs, "high"),
      `warning ${NETWORK_THRESHOLDS.latencyMs.warning} ms`,
    );
  }

  // ---- compute ------------------------------------------------------------
  const worstNode = [...compute.nodes].sort((a, b) => b.cpuPct - a.cpuPct)[0];
  if (worstNode) {
    add(
      "compute",
      `cpu (${worstNode.id})`,
      fmt(worstNode.cpuPct, "%"),
      statusForValue(worstNode.cpuPct, COMPUTE_THRESHOLDS.cpuPct, "high"),
      `warning ${COMPUTE_THRESHOLDS.cpuPct.warning}%`,
    );
    if (worstNode.thermalThrottle) {
      evidence.push({
        family: "compute",
        signal: "thermal throttling",
        value: "engaged",
        status: "warning",
        detail: "ambient at or above the throttle onset temperature",
        points: pointsFor("compute", "warning"),
      });
    }
  }

  const risk = scoreRisk(evidence);

  const allFamilies: Family[] = ["physical", "storage", "network", "compute"];
  const familiesClean = allFamilies.filter((f) => !risk.familiesInvolved.includes(f));

  const provenance: Provenance = {
    environmental: env.source,
    ...(env.ageSeconds !== undefined ? { ageSeconds: env.ageSeconds } : {}),
    ...(env.fallbackReason ? { fallbackReason: env.fallbackReason } : {}),
    simulatedInputs: true, // storage/network/compute are always simulated
  };

  const confidence = assessConfidence({
    provenance,
    familiesInvolved: risk.familiesInvolved,
    familiesClean,
  });

  const { likelyCause, recommendedAction } = explain(risk.familiesInvolved, env.leakDetected);

  // Reported alongside the verdict, never folded into it. Deliberately built
  // AFTER scoreRisk and assessConfidence so it is structurally impossible for
  // this to change either number -- both have already been computed from
  // `evidence`, which this never touches.
  const observedActivity: ObservedActivityNote | undefined = env.activity
    ? { ...env.activity, humanized: humanizeActivity(env.activity.activity) }
    : undefined;

  const summary = buildSummary(
    risk,
    confidence.level,
    likelyCause,
    recommendedAction,
    evidence,
    env.source,
    observedActivity,
  );

  return {
    generatedAt: new Date().toISOString(),
    zone: THERMAL_ZONE,
    risk,
    confidence,
    evidence,
    likelyCause,
    recommendedAction,
    provenance,
    ...(observedActivity ? { observedActivity } : {}),
    summary,
  };
}

/**
 * Rule-derived cause. The important branch is the last one: when compute is busy
 * but nothing physical moved, say "workload", not "cooling". An agent that blames
 * cooling every time has not demonstrated judgement.
 */
function explain(
  families: Family[],
  leak: boolean,
): { likelyCause: string; recommendedAction: string } {
  const has = (f: Family): boolean => families.includes(f);

  if (leak) {
    return {
      likelyCause: `Physical water/leak incident in ${THERMAL_ZONE}, with downstream infrastructure risk.`,
      recommendedAction:
        "Dispatch a technician to the rack now, and pause non-critical backup writes to the affected volumes.",
    };
  }
  if (has("physical") && has("storage") && !has("network")) {
    return {
      likelyCause:
        `Cooling degradation in ${THERMAL_ZONE}: rack temperature is elevated and storage in the same zone ` +
        "is slowing, while network telemetry stays normal.",
      recommendedAction:
        "Inspect airflow and cooling around the rack before restarting backup jobs. Network needs no action.",
    };
  }
  if (has("network") && !has("physical")) {
    return {
      likelyCause: "Network path degradation. Physical and storage signals are normal.",
      recommendedAction: "Check the affected link and switch path; this is not an environmental incident.",
    };
  }
  if (has("compute") && !has("physical") && !has("storage")) {
    return {
      likelyCause: "Workload-driven load increase, not an environmental incident.",
      recommendedAction: "No facilities action. Review scheduling if the load persists.",
    };
  }
  if (has("physical")) {
    return {
      likelyCause:
        "Early environmental anomaly. Not yet reflected in storage, network or compute telemetry.",
      recommendedAction: "Continue monitoring; inspect airflow if the trend continues.",
    };
  }
  return {
    likelyCause: "No incident detected. All evaluated families are within thresholds.",
    recommendedAction: "No action required.",
  };
}

/**
 * How long ago, in words. `summary` is read aloud to an on-call engineer, and
 * "1731s ago" is not something a person says -- worse, it reads as precision
 * about an inference that deserves none. Seconds are kept under 90s because
 * that is the range where the exact number is the point ("it just happened").
 * The minutes band runs to 90, so the hours band never has to say "1 hour".
 */
function agoPhrase(ageSeconds: number): string {
  if (ageSeconds < 90) return `${ageSeconds}s ago`;
  const minutes = Math.round(ageSeconds / 60);
  if (minutes < 90) return `${minutes} minutes ago`;
  return `about ${Math.round(ageSeconds / 3600)} hours ago`;
}

function buildSummary(
  risk: IncidentAssessment["risk"],
  confidence: IncidentAssessment["confidence"]["level"],
  likelyCause: string,
  action: string,
  evidence: Evidence[],
  source: "real" | "mock",
  activity?: ObservedActivityNote,
): string {
  const top = evidence
    .filter((e) => e.status !== "ok")
    .slice(0, 4)
    .map((e) => `${e.signal} ${e.value}`)
    .join("; ");
  const caveat =
    source === "mock"
      ? " NOTE: the physical reading is simulated, so this assessment is illustrative only."
      : "";
  // Placed after the evidence and labelled "not scored" in the same breath.
  // The model is instructed to relay this paragraph verbatim, so an unlabelled
  // sentence here would be read out as though it had contributed to the risk
  // number -- which is precisely the kind of claim this project does not make.
  const observed = activity
    ? ` Also observed (not scored): the board's own model inferred "${activity.humanized}"` +
      (activity.ageSeconds !== undefined ? ` ${agoPhrase(activity.ageSeconds)}` : "") +
      "."
    : "";
  return (
    `Risk ${risk.level.toUpperCase()} (${risk.score}/100), confidence ${confidence}. ` +
    `${likelyCause}` +
    (top ? ` Evidence: ${top}.` : "") +
    observed +
    ` Recommended: ${action}${caveat}`
  );
}
