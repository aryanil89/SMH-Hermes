import { fixed1 } from "../common/round.js";
import type { EnvironmentalResult } from "../environmental/types.js";

/**
 * One-line human summary of an environmental reading, used verbatim inside the
 * Telegram alert text.
 *
 * Lives in its own module because two callers need identical wording: the cron
 * watchdog (check-environmental.ts), which actually sends it, and the live
 * dashboard, which shows the on-call phone what the watchdog will send. If the
 * dashboard rendered its own phrasing, the wall display and the phone would
 * disagree mid-demo -- which is exactly the thing an audience notices.
 */
export function summarizeReading(reading: EnvironmentalResult): string {
  const leak = reading.leakDetected
    ? reading.leakVia === "level"
      ? "LEAK DETECTED (water level rising)"
      : "LEAK DETECTED (leak event)"
    : "no leak";
  const dist =
    reading.distanceMm !== undefined ? `, water-level distance ${fixed1(reading.distanceMm)}mm` : "";
  const src =
    reading.source === "mock"
      ? ` (mock data: ${reading.fallbackReason ?? "no board configured"})`
      : " (real sensor)";
  // Padded to one decimal rather than interpolated raw: readings arrive already
  // rounded (common/round.ts), but a whole-number 22 beside a 22.4 in the next
  // alert reads as two different instruments. The wall pads the same way.
  return `Temperature ${fixed1(reading.temperatureC)}C, humidity ${fixed1(reading.humidityPct)}%${dist}, ${leak}${src}.`;
}
