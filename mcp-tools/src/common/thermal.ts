/**
 * Thermal coupling -- the transfer functions that make simulated telemetry a
 * FUNCTION of the real rack temperature instead of independent noise.
 *
 * WHY THIS EXISTS. The pitch is "Hermes correlates physical and digital
 * signals": temperature rose, then storage latency rose, therefore cooling
 * degradation. If the storage mock draws its numbers independently, that
 * correlation is a coincidence the demo manufactures -- ask for it twice and the
 * second run won't reproduce it. These functions make the relationship real,
 * deterministic and inspectable, so the agent is detecting something that is
 * genuinely there.
 *
 * WHAT TO SAY ON STAGE (say it before someone asks):
 *   "Storage and compute are coupled to rack temperature the way thermal
 *    throttling actually behaves. Network is deliberately NOT coupled -- which
 *    is exactly why Hermes rules the network out instead of blaming it."
 *
 * That last point is load-bearing: an agent that blames everything whenever one
 * thing is wrong has learned nothing. The uncoupled family is the control.
 *
 * Only zone-east is thermally affected -- it is the zone containing the rack the
 * UNO Q instruments. zone-west is a second control: same simulator, no heat.
 */

/** At or below this ambient temperature there is no thermal effect at all. */
export const THERMAL_NEUTRAL_C = 26;

/** Hardware thermal throttling engages here (compute clocks drop). */
export const THROTTLE_ONSET_C = 34;

/** The zone physically instrumented by the UNO Q; the only one heat reaches. */
export const THERMAL_ZONE = "zone-east";

/** Nominal (unstressed) values the transfer functions degrade away from. */
export const NOMINAL_STORAGE_LATENCY_MS = 12;
export const NOMINAL_BACKUP_THROUGHPUT_MBS = 420;
/** Size of the nightly backup job, used to turn a throughput drop into minutes. */
export const BACKUP_JOB_SIZE_MB = 900_000;

/** Degrees above the neutral point. 0 when no temperature is available. */
export function thermalExcessC(temperatureC?: number): number {
  if (temperatureC === undefined || !Number.isFinite(temperatureC)) return 0;
  return Math.max(0, temperatureC - THERMAL_NEUTRAL_C);
}

/**
 * Storage read latency (ms). Superlinear in thermal excess: throttling compounds
 * because a slower controller both serves each request slower and queues more.
 *   26C -> 12ms | 34C -> ~47ms (warning) | 41C -> ~84ms (critical)
 */
export function storageLatencyMs(excessC: number, base = NOMINAL_STORAGE_LATENCY_MS): number {
  return base + 3.2 * Math.pow(excessC, 1.15);
}

/**
 * Backup throughput (MB/s). Falls ~3.5% per degree of excess, floored at 25% of
 * nominal -- a throttled array still makes progress, it just misses its window.
 */
export function backupThroughputMbs(excessC: number, nominal = NOMINAL_BACKUP_THROUGHPUT_MBS): number {
  const retained = Math.max(0.25, 1 - 0.035 * excessC);
  return nominal * retained;
}

/**
 * How many minutes later the nightly job finishes, versus running at nominal
 * throughput. This is arithmetic, not a forecast: (size/actual) - (size/nominal).
 */
export function backupDelayMin(
  actualMbs: number,
  nominal = NOMINAL_BACKUP_THROUGHPUT_MBS,
  jobSizeMb = BACKUP_JOB_SIZE_MB,
): number {
  if (actualMbs <= 0) return Number.POSITIVE_INFINITY;
  return (jobSizeMb / actualMbs - jobSizeMb / nominal) / 60;
}

/** True once ambient reaches the point where hardware throttles clocks. */
export function thermalThrottled(temperatureC?: number): boolean {
  return temperatureC !== undefined && Number.isFinite(temperatureC) && temperatureC >= THROTTLE_ONSET_C;
}

/**
 * Extra CPU utilisation (percentage points) caused by throttling: the same work
 * against a lower clock reads as higher utilisation. Capped so it cannot alone
 * push a node critical.
 */
export function throttleCpuPenaltyPct(temperatureC?: number): number {
  if (!thermalThrottled(temperatureC)) return 0;
  const over = (temperatureC as number) - THROTTLE_ONSET_C;
  return Math.min(15, 2.5 * over + 4);
}
