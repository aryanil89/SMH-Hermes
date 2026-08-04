import { UnoQClient, type UnoQExec } from "./unoq-client.js";
import { readSensorLogReading } from "./file-source.js";
import { generateMockEnvironmentalReading } from "./mock-environmental.js";
import { withTimeout } from "../common/timeout.js";
import { statusForValue, worstStatus } from "../common/alerts.js";
import { ENVIRONMENTAL_THRESHOLDS } from "../common/thresholds.js";
import type { EnvironmentalReading, EnvironmentalResult } from "./types.js";

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
      return {
        ...reading,
        status: statusForReading(reading),
        source: "real",
        via: "file",
        ageSeconds,
        lastEventAt,
        lastEvent,
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

  const timeoutMs = opts.timeoutMs ?? Number(process.env.UNOQ_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
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
