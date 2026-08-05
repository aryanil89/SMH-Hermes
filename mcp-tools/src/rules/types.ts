/**
 * Wire contract for user-authored alert rules.
 *
 * Two files, two writers, no lock (see store.ts):
 *   rules.json       -- definitions. Written ONLY by the agent, when someone
 *                       asks for an alert over Telegram.
 *   rule-state.json  -- runtime. Written ONLY by the evaluator, every cron tick.
 *
 * The split is not tidiness: a single file would lose the evaluator's watermark
 * whenever the agent read the file, held it across a 40-second conversation, and
 * wrote it back -- which re-fires every event in the gap.
 */

/** Channels carrying a continuous number on (nearly) every log line. */
export type NumericChannel = "temperature_c" | "humidity_pct" | "distance_mm";

/** Channels carrying paired enter/exit events instead of a value. */
export type EventChannel = "door" | "light" | "leak" | "presence";

export type Channel = NumericChannel | EventChannel;

export type ComparisonOp = ">" | ">=" | "<" | "<=";

export interface RuleBase {
  id: string;
  /** "system" rules ship enabled and can be disabled but never deleted. */
  author: "user" | "system";
  /** Telegram chat that asked for it. Absent on system rules. */
  chatId?: string;
  createdAt: string;
  /**
   * When this rule last became live -- set on create and again on resume.
   *
   * Load-bearing for event rules. The evaluator starts their watermark here
   * rather than at the newest log line, so an event that happens between
   * "alert me when the door opens" and the next 5-minute tick is still
   * reported. Absent on system rules, whose createdAt is the epoch: starting
   * them there would replay the entire log on first run.
   *
   * Resuming a muted rule re-stamps it, so unmuting delivers what happens
   * *next* rather than the whole backlog accumulated while it was silent.
   */
  armedAt?: string;
  /** ISO instant, or null for "runs until cancelled". */
  expiresAt: string | null;
  enabled: boolean;
  /** The requester's own words, kept so `list` can echo intent back verbatim. */
  note?: string;
}

/**
 * "temp above 25" -- fires if any sample since the last examined line crossed
 * the threshold, then stays latched until the channel recovers. Scans the window
 * rather than the newest line because ticks are 5 minutes apart over a 10-second
 * log: a spike that rose and passed between ticks is on disk either way.
 */
export interface LevelPredicate {
  kind: "level";
  channel: NumericChannel;
  op: ComparisonOp;
  value: number;
}

/** "temp above 25 for 10 minutes" -- every sample in the window must satisfy it. */
export interface SustainedPredicate {
  kind: "sustained";
  channel: NumericChannel;
  op: ComparisonOp;
  value: number;
  forSeconds: number;
}

/** "every time the door opens" -- fires once per occurrence, never misses one. */
export interface EventPredicate {
  kind: "event";
  channel: EventChannel;
  match: string;
}

/** "door left open for 10 minutes" -- times how long a channel has held a state. */
export interface StateDurationPredicate {
  kind: "state_duration";
  channel: EventChannel;
  /** The event that puts the channel INTO the state being timed. */
  match: string;
  forSeconds: number;
}

/** "the board stopped reporting" -- watches the feed itself, not a channel. */
export interface StalePredicate {
  kind: "stale";
  forSeconds: number;
}

export type Predicate =
  | LevelPredicate
  | SustainedPredicate
  | EventPredicate
  | StateDurationPredicate
  | StalePredicate;

export type Rule = RuleBase & Predicate;

export interface RulesFile {
  rules: Rule[];
}

/**
 * Per-rule runtime. `watermark` belongs to event rules (the newest log line
 * already accounted for); `fired` belongs to every level-ish rule (currently
 * inside the alerting condition, so don't re-alert until it recovers).
 */
export interface RuleRuntime {
  /**
   * Timestamp of the newest **log line** this rule has already examined. Every
   * predicate reads the window after it, so consecutive ticks tile the log with
   * no gap and no overlap.
   *
   * Deliberately a log timestamp and never a wall-clock stamp: the board writes
   * the timestamps and the file arrives by a periodic push, so a sample logged
   * just before a tick routinely lands in the file just after it. Flooring on
   * "when the last tick ran" would drop those samples forever.
   */
  watermark?: string;
  fired?: boolean;
  fireCount: number;
  lastFiredAt?: string;
  /** Set once the "this rule expired" notice has gone out, so it goes out once. */
  expiredNotified?: boolean;
}

/** Welford-free: recomputed from the whole log each tick. Cheap at this size. */
export interface NumericBaseline {
  n: number;
  mean: number;
  stddev: number;
  min: number;
  max: number;
}

export interface EventBaseline {
  count: number;
  perHour: number;
  lastAt?: string;
}

/**
 * What the system has learned about this room by watching it. Persisted so the
 * validator can quote it back ("never gone past 35.7 in 31 hours") and so the
 * learning is inspectable on disk rather than implied.
 */
export interface Baselines {
  computedAt: string;
  windowHours: number;
  lines: number;
  numeric: Partial<Record<NumericChannel, NumericBaseline>>;
  events: Record<string, EventBaseline>;
}

export interface RuleStateFile {
  state: Record<string, RuleRuntime>;
  baselines?: Baselines;
  /**
   * When the slow (level-ish) rules were last evaluated.
   *
   * The tick runs every minute so that a door press reaches the phone in
   * seconds rather than up to five minutes. Temperature does not need that, and
   * re-deciding it sixty times an hour would only add noise, so level /
   * sustained / state_duration / stale rules are gated to LEVEL_INTERVAL_MS
   * behind this stamp.
   *
   * NOT a window floor -- it never filters which log lines a rule reads. That
   * distinction matters: an earlier version filtered the level window on tick
   * time and silently dropped every sample that arrived between the push and
   * the tick. Windows are floored on `watermark` (a log timestamp); this field
   * only answers "is it time to look again yet".
   */
  levelsEvaluatedAt?: string;
}
