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
  /**
   * Age of the newest sensor line, in seconds. Present on the file path only.
   * Load-bearing for confidence scoring: a fresh real reading is trustworthy,
   * an old one is not, and the difference must be visible to the caller.
   */
  ageSeconds?: number;
  /** Timestamp of the newest sensor line (ISO). File path only. */
  lastEventAt?: string;
  /** Event type of the newest line, e.g. "sensor_tick" or "leak_detected". */
  lastEvent?: string;
  /** How the real reading was obtained: pushed log file vs on-demand SSH pull. */
  via?: "file" | "ssh";
  /** Present only when source === "mock" because a real read was unavailable or failed. */
  fallbackReason?: string;
  generatedAt: string;
}
