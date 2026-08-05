/**
 * Rule evaluation. Runs on every cron tick, in plain code, with **zero LLM
 * tokens** -- the same property that lets the current watchdog run every 5
 * minutes on a box where one completion takes one to three minutes.
 *
 * Two shapes, because "alert me every single time the door opens" and "alert me
 * when it's above 25" are not the same question:
 *
 *   level-ish (level / sustained / state_duration / stale)
 *       Ask "was the condition true at any point since the last tick?".
 *       Edge-triggered via `fired`, so a sustained problem alerts once and then
 *       stays quiet until it recovers.
 *
 *   event
 *       Ask "what happened since I last looked?". Needs a watermark, because a
 *       tick that only inspects the newest line loses every event that happened
 *       between ticks -- three door opens inside one 5-minute window would be
 *       reported as one.
 *
 * Both shapes read a *window*, never a single instant. The log carries 10s
 * resolution and ticks are 5 minutes apart; anything that inspects only the
 * newest line throws away 29 samples out of 30.
 */
import type { SensorLogLine } from "../environmental/file-source.js";
import { EVENT_CHANNELS, NUMERIC_CHANNELS } from "./channels.js";
import type { Baselines, Rule, RuleRuntime, RuleStateFile } from "./types.js";

export interface Firing {
  ruleId: string;
  text: string;
}

export interface EvaluateInput {
  rules: Rule[];
  state: RuleStateFile;
  lines: SensorLogLine[];
  now: Date;
  /** Observed history, used to caveat a firing the log cannot fully support. */
  baselines?: Baselines;
  /**
   * Whether the slow rules are due this tick. Event rules ignore it entirely --
   * they are the reason the tick is fast. Default true so every existing caller
   * and test keeps its old behaviour.
   */
  evaluateLevels?: boolean;
}

export interface EvaluateResult {
  firings: Firing[];
  nextState: Record<string, RuleRuntime>;
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

function ts(line: SensorLogLine): number {
  return Date.parse(line.timestamp);
}

function describeDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round((seconds / 3600) * 10) / 10}h`;
}

function localTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Where a rule should start reading from, for both the event and level paths.
 *
 * Always derived from **log-line timestamps**, never from the wall clock. The
 * board writes the timestamps and the file arrives by a periodic push, so a
 * sample logged just before a tick can land in the file just after it. Flooring
 * on "when the last tick ran" drops those samples permanently -- a blind slice
 * the width of the push latency on every tick, and the width of the whole
 * outage after a log-read failure.
 *
 * `armedAt` wins when newer than the stored watermark, which covers a rule armed
 * between ticks (its events must not be skipped) and a rule resumed after being
 * muted (the backlog accumulated while silent must not arrive as one burst).
 */
function windowFloor(rule: Rule, prev: RuleRuntime): number | undefined {
  const armed = rule.armedAt ? Date.parse(rule.armedAt) : NaN;
  const mark = prev.watermark ? Date.parse(prev.watermark) : NaN;

  if (Number.isFinite(mark)) {
    return Number.isFinite(armed) ? Math.max(mark, armed) : mark;
  }
  // A user rule starts at the moment it was armed, so nothing between arming
  // and the first tick is missed.
  if (Number.isFinite(armed)) return armed;
  // Undefined means "first sight, no anchor" -- a system rule, whose createdAt
  // is the epoch and so cannot be used. Each path handles it differently: event
  // rules adopt the end of the log and report nothing (replaying every event
  // ever recorded is the thing to avoid), level rules judge the newest sample
  // (they describe a present condition, so there is nothing to replay).
  return undefined;
}

export function evaluateRules(input: EvaluateInput): EvaluateResult {
  const { rules, state, lines, now, baselines, evaluateLevels } = input;
  const firings: Firing[] = [];
  // Built only from rules that currently exist. Carrying entries forward for
  // deleted rules leaks state, and -- worse -- lets a recycled id inherit a
  // stale watermark or a stuck `fired` latch from a rule cancelled days ago.
  const nextState: Record<string, RuleRuntime> = {};

  const newest = lines[lines.length - 1];
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  for (const rule of rules) {
    const prev = state.state[rule.id] ?? { fireCount: 0 };

    // Disabled rules are inert but keep their state, so re-enabling a system
    // rule resumes bookkeeping rather than starting from zero. What it must NOT
    // do is replay the muted period -- resume() re-stamps armedAt for that.
    if (!rule.enabled) {
      nextState[rule.id] = prev;
      continue;
    }

    // --- Expiry -------------------------------------------------------------
    // Events in the final window are reported before the notice: a door that
    // opened four minutes before a 24h watch lapsed still happened inside it.
    if (rule.expiresAt !== null && Date.parse(rule.expiresAt) <= nowMs) {
      if (prev.expiredNotified) {
        nextState[rule.id] = prev;
        continue;
      }
      let carried = prev;
      if (rule.kind === "event") {
        const upTo = lines.filter((l) => ts(l) <= Date.parse(rule.expiresAt as string));
        carried = evaluateEvent(rule, prev, upTo, firings);
      }
      firings.push({
        ruleId: rule.id,
        text: `Alert rule ${rule.id} has expired${rule.note ? ` ("${rule.note}")` : ""}. It fired ${carried.fireCount} time${carried.fireCount === 1 ? "" : "s"}. Ask again if you still want it.`,
      });
      nextState[rule.id] = { ...carried, expiredNotified: true };
      continue;
    }

    const floor = windowFloor(rule, prev);

    if (rule.kind === "event") {
      nextState[rule.id] = evaluateEvent(rule, prev, lines, firings, floor);
      continue;
    }

    // Slow rules sit out most ticks. Carrying `prev` forward untouched -- and
    // in particular NOT advancing the watermark -- means the next evaluation
    // reads the whole interval it skipped, so gating changes the cadence and
    // never the coverage.
    if (evaluateLevels === false) {
      nextState[rule.id] = prev;
      continue;
    }

    const outcome = evaluateLevelish(rule, lines, newest, nowMs, floor, baselines);
    // Advance to the newest line actually examined, so the next window starts
    // exactly where this one ended -- no gap, no overlap, no clock involved.
    const advanced = newest?.timestamp ?? prev.watermark;
    const carried: RuleRuntime = {
      ...prev,
      ...(advanced !== undefined ? { watermark: advanced } : {}),
    };

    if (outcome === undefined) {
      // Not enough data to judge -- leave the latch untouched rather than
      // recording a dead sensor as a healthy one that simply isn't triggering.
      nextState[rule.id] = carried;
      continue;
    }

    if (outcome.condition && !prev.fired) {
      firings.push({ ruleId: rule.id, text: outcome.text });
      nextState[rule.id] = {
        ...carried,
        fired: true,
        fireCount: prev.fireCount + 1,
        lastFiredAt: nowIso,
      };
    } else {
      nextState[rule.id] = { ...carried, fired: outcome.condition };
    }
  }

  return { firings, nextState };
}

function evaluateEvent(
  rule: Extract<Rule, { kind: "event" }>,
  prev: RuleRuntime,
  lines: SensorLogLine[],
  firings: Firing[],
  floor?: number,
): RuleRuntime {
  const newest = lines[lines.length - 1];
  const newestTs = newest?.timestamp;
  const since = floor ?? windowFloor(rule, prev);

  // First sight with no anchor: adopt the end of the log. Without this, arming
  // a system event rule would deliver 31 hours of history as one burst.
  if (since === undefined) {
    return { ...prev, ...(newestTs !== undefined ? { watermark: newestTs } : {}) };
  }

  const matches = lines.filter((l) => {
    const t = ts(l);
    return Number.isFinite(t) && t > since && l.event === rule.match;
  });

  const advanced = newestTs ?? prev.watermark;
  if (matches.length === 0) {
    return { ...prev, ...(advanced !== undefined ? { watermark: advanced } : {}) };
  }

  const spec = EVENT_CHANNELS[rule.channel];
  const times = matches.map((m) => localTime(m.timestamp)).join(", ");
  const text =
    matches.length === 1
      ? `${spec.label}: ${rule.match} at ${times}.`
      : `${spec.label}: ${rule.match} ${matches.length}x - ${times}.`;

  firings.push({ ruleId: rule.id, text });

  const last = matches[matches.length - 1];
  return {
    ...prev,
    watermark: advanced ?? last?.timestamp,
    fireCount: prev.fireCount + matches.length,
    ...(last ? { lastFiredAt: last.timestamp } : {}),
  };
}

interface LevelOutcome {
  condition: boolean;
  text: string;
}

/**
 * Returns undefined when the log cannot answer the question at all (no samples
 * for the channel). Callers treat that as "no change", never as "condition
 * false" -- a missing sensor must not silently look like a healthy one.
 */
function evaluateLevelish(
  rule: Rule,
  lines: SensorLogLine[],
  newest: SensorLogLine | undefined,
  nowMs: number,
  floor: number | undefined,
  baselines?: Baselines,
): LevelOutcome | undefined {
  switch (rule.kind) {
    case "stale": {
      if (!newest) return { condition: true, text: `Sensor feed is silent - no readings at all.` };
      const age = (nowMs - ts(newest)) / 1000;
      return {
        condition: age > rule.forSeconds,
        text: `Sensor feed is silent - no reading for ${describeDuration(age)} (limit ${describeDuration(rule.forSeconds)}). The board or the push may be down.`,
      };
    }

    case "level": {
      const spec = NUMERIC_CHANNELS[rule.channel];
      // Every line since the last one examined, so a spike that rose and
      // recovered between ticks is still caught. No floor (a system rule's very
      // first tick) means newest-only -- arming a rule must not mine history.
      const window = (floor === undefined ? (newest ? [newest] : []) : lines.filter((l) => ts(l) > floor))
        .map((l) => l[spec.field])
        .filter((v): v is number => typeof v === "number" && !(spec.sparse && v < 0));

      if (window.length === 0) return undefined;

      const hits = window.filter((v) => compare(rule.op, v, rule.value));
      if (hits.length === 0) {
        const latest = window[window.length - 1];
        return {
          condition: false,
          text: `${spec.label} is ${latest}${spec.unit} (rule: ${rule.op} ${rule.value}${spec.unit}).`,
        };
      }
      // Report the extreme, not the latest: a spike that already recovered is
      // still the reason this fired, and "25.1" would understate a peak of 31.
      const peak =
        rule.op === ">" || rule.op === ">=" ? Math.max(...hits) : Math.min(...hits);
      const recovered = !compare(rule.op, window[window.length - 1] as number, rule.value);
      return {
        condition: true,
        text:
          `${spec.label} reached ${peak}${spec.unit} (rule: ${rule.op} ${rule.value}${spec.unit})` +
          `${recovered ? `, now back to ${window[window.length - 1]}${spec.unit}` : ""}.`,
      };
    }

    case "sustained": {
      const spec = NUMERIC_CHANNELS[rule.channel];
      const cutoff = nowMs - rule.forSeconds * 1000;
      const window = lines.filter((l) => {
        const t = ts(l);
        if (!Number.isFinite(t) || t < cutoff) return false;
        const v = l[spec.field];
        return typeof v === "number" && !(spec.sparse && v < 0);
      });
      if (window.length === 0) return undefined;

      // Require the window to actually be covered. Two samples a second apart
      // must not satisfy "above 25 for ten minutes" just because both are hot.
      // Slop is capped at a quarter of the window so a short duration doesn't
      // make the coverage test vacuous (cutoff+60s lying in the future).
      const slop = Math.min(60_000, (rule.forSeconds * 1000) / 4);
      const oldest = window[0];
      const covered = oldest !== undefined && ts(oldest) <= cutoff + slop;
      const all = window.every((l) => {
        const v = l[spec.field];
        return typeof v === "number" && compare(rule.op, v, rule.value);
      });
      const latest = window[window.length - 1]?.[spec.field];
      return {
        condition: covered && all,
        text: `${spec.label} has stayed ${rule.op} ${rule.value}${spec.unit} for ${describeDuration(rule.forSeconds)} (now ${latest}${spec.unit}).`,
      };
    }

    case "state_duration": {
      const spec = EVENT_CHANNELS[rule.channel];
      const relevant = lines.filter((l) => l.event === spec.enter || l.event === spec.exit);
      const last = relevant[relevant.length - 1];
      if (!last) return undefined;
      if (last.event !== rule.match) {
        return { condition: false, text: `${spec.label} is not in the ${rule.match} state.` };
      }
      const held = (nowMs - ts(last)) / 1000;

      // If the closing edge has never once been logged, this channel is
      // enter-only in the current firmware: the duration is a lower bound, not
      // a measurement, and the latch will never clear on its own. Say so rather
      // than reporting "open for 7.9h" as though a close had been ruled out.
      const exitSeen = (baselines?.events[spec.exit]?.count ?? 0) > 0;
      const caveat = exitSeen
        ? ""
        : ` (no ${spec.exit} has ever been logged - the board may not report it, so this is a lower bound)`;

      return {
        condition: held >= rule.forSeconds,
        text: `${spec.label} has been ${rule.match} for ${describeDuration(held)} (limit ${describeDuration(rule.forSeconds)})${caveat}.`,
      };
    }

    default:
      return undefined;
  }
}
