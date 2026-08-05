/**
 * What this deployment can actually sense.
 *
 * This table is the difference between "reject implausible rules" being a model
 * opinion and being arithmetic. `-100C` is refused because the HS300x bottoms
 * out at -40, not because a 4B model felt uneasy about it -- small models are
 * agreeable and will happily arm a rule that can never fire.
 *
 * Ranges are datasheet limits for the parts listed in
 * uno-q/hermes-sensor-logger/sketch/sketch.yaml.
 */
import type { EventChannel, NumericChannel } from "./types.js";

export interface NumericChannelSpec {
  kind: "numeric";
  label: string;
  unit: string;
  /** Which field of a sensor log line carries it. */
  field: "temperature_c" | "humidity_pct" | "distance_mm";
  /** Hard sensor limits: a threshold outside these can never be reported. */
  min: number;
  max: number;
  hardware: string;
  /**
   * True when the field is absent from most lines. The board's periodic
   * sensor_tick carries temperature and humidity only -- distance is reported
   * on presence/button events -- so a distance rule can go minutes without a
   * sample even though the sensor is healthy.
   */
  sparse?: boolean;
}

export interface EventChannelSpec {
  kind: "event";
  label: string;
  /** Event that puts the channel into its active state. */
  enter: string;
  /** Event that takes it out again. */
  exit: string;
}

export const NUMERIC_CHANNELS: Record<NumericChannel, NumericChannelSpec> = {
  temperature_c: {
    kind: "numeric",
    label: "temperature",
    unit: "C",
    field: "temperature_c",
    min: -40,
    max: 125,
    hardware: "Modulino Thermo (HS300x)",
  },
  humidity_pct: {
    kind: "numeric",
    label: "humidity",
    unit: "%",
    field: "humidity_pct",
    min: 0,
    max: 100,
    hardware: "Modulino Thermo (HS300x)",
  },
  distance_mm: {
    kind: "numeric",
    label: "water-level distance",
    unit: "mm",
    field: "distance_mm",
    min: 0,
    max: 4000,
    hardware: "Modulino Distance (VL53L4CD/VL53L4ED ToF)",
    sparse: true,
  },
};

export const EVENT_CHANNELS: Record<EventChannel, EventChannelSpec> = {
  door: { kind: "event", label: "door", enter: "door_open", exit: "door_closed" },
  light: { kind: "event", label: "lighting", enter: "light_on", exit: "light_off" },
  leak: { kind: "event", label: "leak", enter: "leak_detected", exit: "leak_cleared" },
  presence: {
    kind: "event",
    label: "presence",
    enter: "object_entered",
    exit: "object_left",
  },
};

export function isNumericChannel(name: string): name is NumericChannel {
  return Object.prototype.hasOwnProperty.call(NUMERIC_CHANNELS, name);
}

export function isEventChannel(name: string): name is EventChannel {
  return Object.prototype.hasOwnProperty.call(EVENT_CHANNELS, name);
}

/** Every event name this deployment can emit, for "no such event" rejections. */
export function knownEventNames(): string[] {
  return Object.values(EVENT_CHANNELS).flatMap((c) => [c.enter, c.exit]);
}

/** Human list of what can be watched, for the agent to quote when refusing. */
export function describeChannels(): string {
  const numeric = Object.entries(NUMERIC_CHANNELS).map(
    ([k, s]) => `${k} (${s.label}, ${s.min}..${s.max}${s.unit}${s.sparse ? ", sparse" : ""})`,
  );
  const events = Object.entries(EVENT_CHANNELS).map(
    ([k, s]) => `${k} (${s.enter} / ${s.exit})`,
  );
  return `numeric: ${numeric.join(", ")}; events: ${events.join(", ")}`;
}
