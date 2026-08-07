import { UnoQClient, type UnoQExec } from "./unoq-client.js";
import { readSensorLogReading, readLatestActivity } from "./file-source.js";
import { generateMockEnvironmentalReading } from "./mock-environmental.js";
import { withTimeout } from "../common/timeout.js";
import { statusForValue, worstStatus } from "../common/alerts.js";
import { ENVIRONMENTAL_THRESHOLDS } from "../common/thresholds.js";
import type { EnvironmentalReading, EnvironmentalResult, ObservedActivity } from "./types.js";
import { envPositive } from "../common/env.js";

export interface GetEnvironmentalOptions {
  /** Mock-only: fix the PRNG seed for reproducible output (tests/live fallback). */
  seed?: number;
  /** Overrides UNOQ_TIMEOUT_MS; how long to wait for the real board before falling back. */
  timeoutMs?: number;
  /** Test-only injection point for the SSH transport -- see unoq-client.ts. */
  exec?: UnoQExec;
}

const DEFAULT_TIMEOUT_MS = 3000;

export function statusForReading(reading: EnvironmentalReading): EnvironmentalResult["status"] {
  if (reading.leakDetected) return "critical";
  return worstStatus(
    statusForValue(reading.temperatureC, ENVIRONMENTAL_THRESHOLDS.temperatureC, "high"),
    statusForValue(reading.humidityPct, ENVIRONMENTAL_THRESHOLDS.humidityPct, "high"),
  );
}

/**
 * Newest on-device activity inference, stamped with its age at read time.
 *
 * Never throws and never blocks a reading: `readLatestActivity` already
 * swallows every file error, and an unparseable timestamp yields an activity
 * with no age rather than no activity at all. A sensor reading must not fail
 * because the board's narration of it did.
 */
async function readObservedActivity(
  path: string,
  generatedAt: string,
): Promise<ObservedActivity | undefined> {
  const latest = await readLatestActivity(path);
  if (!latest) return undefined;
  const at = Date.parse(latest.at);
  const ageSeconds = Number.isNaN(at)
    ? undefined
    : Math.max(0, Math.round((Date.parse(generatedAt) - at) / 1000));
  return {
    activity: latest.activity,
    ...(latest.trigger ? { trigger: latest.trigger } : {}),
    at: latest.at,
    ...(ageSeconds !== undefined ? { ageSeconds } : {}),
  };
}

/**
 * Get an environmental reading, preferring the real UNO Q board and falling back to a plausible
 * mock automatically. This never throws and never hangs: any real-read failure (unreachable host,
 * timeout, bad payload) is caught and turned into a mock reading with `fallbackReason` set.
 */
export async function getEnvironmentalReading(opts: GetEnvironmentalOptions = {}): Promise<EnvironmentalResult> {
  const generatedAt = new Date().toISOString();
  const host = process.env.UNOQ_HOST;
  const sensorLogPath = process.env.UNOQ_SENSOR_LOG;
  const failures: string[] = [];

  // Preferred source: the JSON-lines history the board pushes to this machine
  // (push model, see docs/UNOQ_SETUP.md) -- no network round-trip at read time.
  if (sensorLogPath) {
    const fileResult = await readSensorLogReading({ path: sensorLogPath });
    if (fileResult.ok) {
      const { temperatureC, humidityPct, leakDetected, distanceMm, leakVia } = fileResult.reading;
      const reading = { temperatureC, humidityPct, leakDetected, distanceMm, leakVia };
      // Freshness metadata is load-bearing downstream: confidence scoring treats a
      // 5-second-old reading and a 5-minute-old one very differently, and it can
      // only do that if the age survives this boundary. It used to be dropped here.
      const { ageSeconds, lastEventAt, lastEvent } = fileResult.reading;
      // Same file, second scan: activity lines are edge-triggered and can be
      // much older than the newest sensor tick, so they cannot be recovered
      // from the reading above. Deliberately not gated on staleness -- an
      // inference from four minutes ago is still the last thing the board
      // concluded, and hiding it would tell the agent nothing had happened.
      // Its age travels with it so the caller can weigh that itself.
      const activity = await readObservedActivity(sensorLogPath, generatedAt);
      return {
        ...reading,
        status: statusForReading(reading),
        source: "real",
        via: "file",
        ageSeconds,
        lastEventAt,
        lastEvent,
        ...(activity ? { activity } : {}),
        generatedAt,
      };
    }
    failures.push(fileResult.reason);
  }

  if (!host) {
    const reading = generateMockEnvironmentalReading(opts.seed);
    const detail = failures.length > 0 ? `${failures.join("; ")}; ` : "";
    return {
      ...reading,
      status: statusForReading(reading),
      source: "mock",
      fallbackReason: `${detail}UNOQ_HOST is not set -- board not configured`,
      generatedAt,
    };
  }

  // envPositive, not Number(): a typo here makes withTimeout fire immediately,
  // so every board read "times out" and the system serves mock data forever
  // while reporting the board as unreachable. See common/env.ts.
  const timeoutMs = opts.timeoutMs ?? envPositive("UNOQ_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const client = new UnoQClient({
    host,
    user: process.env.UNOQ_USER,
    timeoutMs,
    exec: opts.exec,
  });

  try {
    // Belt-and-suspenders: UnoQClient already bounds the ssh subprocess via execFile's own
    // timeout; this outer timeout guarantees a bound even if a custom `exec` misbehaves.
    const reading = await withTimeout(client.readSensors(), timeoutMs + 500, "UNO Q sensor read");
    return { ...reading, status: statusForReading(reading), source: "real", via: "ssh", generatedAt };
  } catch (err) {
    const reading = generateMockEnvironmentalReading(opts.seed);
    failures.push(err instanceof Error ? err.message : String(err));
    return {
      ...reading,
      status: statusForReading(reading),
      source: "mock",
      fallbackReason: `real sensor read failed, falling back to mock data: ${failures.join("; ")}`,
      generatedAt,
    };
  }
}
