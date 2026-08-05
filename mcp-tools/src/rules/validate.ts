/**
 * Plausibility checks for a proposed rule.
 *
 * The division of labour that makes this work on a 4B model: **arithmetic
 * decides, the model phrases.** Every verdict below is a comparison against a
 * datasheet limit or against observed history. The model's job is to turn
 * `{code: "below_sensor_range", ...}` into "I can't set that -- the board's
 * HS300x reads down to -40C, so -100C is a value it can never report. Did you
 * mean -10?". It must never be the thing that decides whether -100 is reachable,
 * because a small model asked to judge plausibility will simply agree with you.
 *
 * Two severities:
 *   reject -- the rule provably cannot fire (outside sensor range, no such
 *             channel, no such event). Refused, with a reason.
 *   warn   -- the rule can fire but probably won't, or will fire a lot, or is
 *             already true. Armed anyway; the requester may know something the
 *             history doesn't.
 */
import {
  EVENT_CHANNELS,
  NUMERIC_CHANNELS,
  describeChannels,
  isEventChannel,
  isNumericChannel,
} from "./channels.js";
import type { Baselines, Predicate } from "./types.js";

export type FindingCode =
  | "unknown_channel"
  | "unknown_event"
  | "below_sensor_range"
  | "above_sensor_range"
  | "never_observed"
  | "already_true"
  | "noisy"
  | "sparse_channel"
  | "channel_silent"
  | "invalid_duration"
  | "no_history";

export interface Finding {
  severity: "reject" | "warn";
  code: FindingCode;
  /** Plain-language fact. The agent may rephrase, but must not contradict it. */
  detail: string;
}

export interface ValidationResult {
  ok: boolean;
  findings: Finding[];
  /** Numbers behind the findings, so the agent can quote them precisely. */
  facts: Record<string, unknown>;
}

export interface ValidateInput {
  predicate: Predicate;
  baselines?: Baselines;
  /** Newest reading, for the "already true right now" check. */
  current?: { temperature_c?: number; humidity_pct?: number; distance_mm?: number };
  /** Window the rule will be armed for, in seconds. Used for the noise estimate. */
  windowSeconds?: number;
}

function compare(op: string, left: number, right: number): boolean {
  switch (op) {
    case ">":
      return left > right;
    case ">=":
      return left >= right;
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    default:
      return false;
  }
}

/** More than this many messages over the rule's lifetime counts as spam. */
const NOISY_MESSAGE_BUDGET = 50;

export function validateRule(input: ValidateInput): ValidationResult {
  const { predicate, baselines, current } = input;
  const findings: Finding[] = [];
  const facts: Record<string, unknown> = {};

  // --- 0. Durations must be positive ---------------------------------------
  // A negative window puts the cutoff in the future, so the sample set is always
  // empty and the rule is silently dead forever -- precisely the class of
  // provably-unfireable rule this validator exists to refuse.
  if ("forSeconds" in predicate && !(predicate.forSeconds > 0)) {
    findings.push({
      severity: "reject",
      code: "invalid_duration",
      detail: `a duration must be a positive number of seconds, not ${predicate.forSeconds}`,
    });
    return { ok: false, findings, facts };
  }
  if (input.windowSeconds !== undefined && !(input.windowSeconds > 0)) {
    findings.push({
      severity: "reject",
      code: "invalid_duration",
      detail: `the window a rule stays armed for must be positive, not ${input.windowSeconds}`,
    });
    return { ok: false, findings, facts };
  }

  if (predicate.kind === "stale") {
    return { ok: true, findings, facts };
  }

  const channel = predicate.channel;

  // --- 1. Does this deployment sense that at all? ---------------------------
  if (!isNumericChannel(channel) && !isEventChannel(channel)) {
    findings.push({
      severity: "reject",
      code: "unknown_channel",
      detail: `there is no "${channel}" sensor on this board. Available -- ${describeChannels()}`,
    });
    return { ok: false, findings, facts };
  }

  // --- Numeric channels: level and sustained -------------------------------
  if (predicate.kind === "level" || predicate.kind === "sustained") {
    if (!isNumericChannel(channel)) {
      findings.push({
        severity: "reject",
        code: "unknown_channel",
        detail: `"${channel}" is an event channel -- it has no numeric value to compare against`,
      });
      return { ok: false, findings, facts };
    }
    const spec = NUMERIC_CHANNELS[channel];
    facts["sensor"] = spec.hardware;
    facts["sensorRange"] = `${spec.min}..${spec.max}${spec.unit}`;

    // 2. Outside what the hardware can ever report -> provably dead rule.
    if (predicate.value < spec.min) {
      findings.push({
        severity: "reject",
        code: "below_sensor_range",
        detail:
          `${spec.label} is measured by the ${spec.hardware}, which bottoms out at ` +
          `${spec.min}${spec.unit}. A threshold of ${predicate.value}${spec.unit} can never be reported.`,
      });
    } else if (predicate.value > spec.max) {
      findings.push({
        severity: "reject",
        code: "above_sensor_range",
        detail:
          `${spec.label} is measured by the ${spec.hardware}, which tops out at ` +
          `${spec.max}${spec.unit}. A threshold of ${predicate.value}${spec.unit} can never be reported.`,
      });
    }

    const observed = baselines?.numeric[channel];
    if (!observed) {
      findings.push({
        severity: "warn",
        code: "no_history",
        detail: `no ${spec.label} history yet, so I can't say how likely this is to fire`,
      });
    } else {
      facts["observed"] = observed;
      facts["observedWindowHours"] = baselines?.windowHours;

      // 3. Legal for the sensor, but this room has never been there.
      const reachable =
        predicate.op === ">" || predicate.op === ">="
          ? observed.max >= predicate.value
          : observed.min <= predicate.value;
      if (!reachable) {
        findings.push({
          severity: "warn",
          code: "never_observed",
          detail:
            `${spec.label} here has stayed between ${observed.min} and ${observed.max}${spec.unit} ` +
            `over ${baselines?.windowHours ?? 0}h of readings, so ${predicate.op} ${predicate.value}${spec.unit} ` +
            `has never happened. I'll arm it, but it may never fire.`,
        });
      }

      if (spec.sparse) {
        findings.push({
          severity: "warn",
          code: "sparse_channel",
          detail:
            `${spec.label} is only logged on button and presence events, not on the 10s climate tick, ` +
            `so this rule can go minutes without a sample even when the sensor is healthy`,
        });
      }
    }

    // 4. Already true this second -- arm it, but say so.
    const currentValue = current?.[spec.field];
    if (typeof currentValue === "number") {
      facts["current"] = currentValue;
      if (compare(predicate.op, currentValue, predicate.value)) {
        findings.push({
          severity: "warn",
          code: "already_true",
          detail:
            `${spec.label} is ${currentValue}${spec.unit} right now, which already satisfies this rule -- ` +
            `expect it to fire on the next check`,
        });
      }
    }

    return { ok: findings.every((f) => f.severity !== "reject"), findings, facts };
  }

  // --- Event channels: event and state_duration ----------------------------
  if (!isEventChannel(channel)) {
    findings.push({
      severity: "reject",
      code: "unknown_channel",
      detail: `"${channel}" is a numeric channel -- it emits readings, not events`,
    });
    return { ok: false, findings, facts };
  }

  const spec = EVENT_CHANNELS[channel];
  const valid = [spec.enter, spec.exit];
  facts["channelEvents"] = valid;

  // 5. The event name must be one this channel can emit.
  if (!valid.includes(predicate.match)) {
    findings.push({
      severity: "reject",
      code: "unknown_event",
      detail: `the ${spec.label} channel only emits ${valid.join(" and ")} -- "${predicate.match}" is not one of them`,
    });
    return { ok: false, findings, facts };
  }

  const observed = baselines?.events[predicate.match];
  if (!observed || observed.count === 0) {
    findings.push({
      severity: "warn",
      code: "channel_silent",
      detail:
        `"${predicate.match}" has never appeared in ${baselines?.windowHours ?? 0}h of log history. ` +
        `If the board firmware predates paired button edges, this event may not be emitted at all.`,
    });
    return { ok: true, findings, facts };
  }

  facts["observed"] = observed;
  facts["observedWindowHours"] = baselines?.windowHours;

  // 6. Would this bury the on-call phone? Estimate from the measured rate.
  const windowSeconds = input.windowSeconds ?? 24 * 3600;
  const expected = (observed.perHour * windowSeconds) / 3600;
  facts["expectedMessages"] = Math.round(expected);
  if (predicate.kind === "event" && expected > NOISY_MESSAGE_BUDGET) {
    findings.push({
      severity: "warn",
      code: "noisy",
      detail:
        `"${predicate.match}" happens about ${observed.perHour} times an hour, so over this window ` +
        `that's roughly ${Math.round(expected)} messages. Consider a longer window or a duration rule instead.`,
    });
  }

  return { ok: true, findings, facts };
}
