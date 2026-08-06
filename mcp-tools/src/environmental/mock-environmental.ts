import { createRng, range, chance } from "../common/rng.js";
import { round1 } from "../common/round.js";
import type { EnvironmentalReading } from "./types.js";

/**
 * Plausible, dynamic mock sensor reading -- used automatically whenever the real UNO Q board
 * is unreachable or unconfigured (see ../environmental/source.ts).
 */
export function generateMockEnvironmentalReading(seed?: number): EnvironmentalReading {
  const rng = createRng(seed);
  const degraded = chance(rng, 0.15);
  const leakEvent = chance(rng, 0.03);

  const temperatureC = degraded ? range(rng, 31, 39) : range(rng, 19, 26);
  const humidityPct = degraded ? range(rng, 72, 92) : range(rng, 35, 55);

  return {
    temperatureC: round1(temperatureC),
    humidityPct: round1(humidityPct),
    leakDetected: leakEvent };
}
