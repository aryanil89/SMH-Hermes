import type { Status } from "../common/types.js";

export interface EnvironmentalReading {
  temperatureC: number;
  humidityPct: number;
  leakDetected: boolean;
  /** ToF distance to the water-level float (mm). Only present from the real board's log. */
  distanceMm?: number;
  /**
   * What triggered leakDetected: a leak_detected button event, or the measured
   * water level (distance below UNOQ_LEAK_DISTANCE_MM). Absent when no leak.
   */
  leakVia?: "event" | "level";
}

export type EnvironmentalSource = "real" | "mock";

export interface EnvironmentalResult extends EnvironmentalReading {
  status: Status;
  source: EnvironmentalSource;
  /** How the real reading was obtained: pushed log file vs on-demand SSH pull. */
  via?: "file" | "ssh";
  /** Present only when source === "mock" because a real read was unavailable or failed. */
  fallbackReason?: string;
  generatedAt: string;
}
