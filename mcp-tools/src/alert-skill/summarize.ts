import type { EnvironmentalResult } from "../environmental/types.js";

/**
 * One-line human summary of an environmental reading, used verbatim inside the
 * Telegram alert text.
 *
 * Lives in its own module because two callers need identical wording: the cron
 * watchdog (check-environmental.ts), which actually sends it, and the live
 * dashboard, which shows the on-call phone what the watchdog will send. If the
 * dashboard rendered its own phrasing, the wall display and the phone would
 * disagree mid-demo -- which is exactly the thing a judge notices.
 */
export function summarizeReading(reading: EnvironmentalResult): string {
  const leak = reading.leakDetected
    ? reading.leakVia === "level"
      ? "LEAK DETECTED (water level rising)"
      : "LEAK DETECTED (leak event)"
    : "no leak";
  const dist = reading.distanceMm !== undefined ? `, water-level distance ${reading.distanceMm}mm` : "";
  const src =
    reading.source === "mock"
      ? ` (mock data: ${reading.fallbackReason ?? "no board configured"})`
      : " (real sensor)";
  return `Temperature ${reading.temperatureC}C, humidity ${reading.humidityPct}%${dist}, ${leak}${src}.`;
}
