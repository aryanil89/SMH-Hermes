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
  /**
   * Newest on-device activity inference from the board's own small LLM
   * (`event: "activity"`, docs/ONDEVICE_ACTIVITY.md). Real file path only --
   * the mock generator has no board to infer anything, and the SSH path reads
   * sensors rather than the log.
   *
   * Carried on the reading rather than fetched separately by each consumer so
   * that "what the board thinks is happening" travels with "what the board
   * measured". The watchdog had this and the agent did not, which is how the
   * wall could be showing a room-entry inference while the agent, asked about
   * the same moment, knew only the temperature.
   *
   * Not scored, and it must stay that way -- see assess.ts.
   */
  activity?: ObservedActivity;
  generatedAt: string;
}

/**
 * An on-device activity inference, with its age measured at read time.
 *
 * `ageSeconds` is computed here rather than left to the consumer because
 * `at` is the board's clock: two processes deriving age from it independently
 * is two chances to disagree about how old the same inference is.
 */
export interface ObservedActivity {
  /** Raw label, e.g. "activity-person_entered_room". Humanize for display. */
  activity: string;
  /** What the board's model keyed off, when it recorded one. */
  trigger?: string;
  /** ISO timestamp of the inference (board clock). */
  at: string;
  /** Age in seconds at read time. Absent if `at` did not parse. */
  ageSeconds?: number;
}
