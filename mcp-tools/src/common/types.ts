/** Shared status vocabulary used across every mocked and real tool. */
export type Status = "ok" | "warning" | "critical";

export interface Thresholds {
  /** Value at/beyond which status becomes "warning". */
  warning: number;
  /** Value at/beyond which status becomes "critical" (takes precedence over warning). */
  critical: number;
}
