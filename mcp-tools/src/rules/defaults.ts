/**
 * The always-on rules -- the "tell me if you see something abnormal" half.
 *
 * These live in code, not in rules.json, and are merged in at evaluation time.
 * Two consequences, both deliberate:
 *
 *   - they cannot be lost. Deleting rules.json restores the safety net rather
 *     than removing it.
 *   - cancelling one is an *override*: the agent writes a same-id entry with
 *     enabled:false into rules.json, which wins. So "stop telling me about
 *     leaks" is obeyable and reversible, and a system rule can be disabled but
 *     never deleted.
 *
 * Adding a new datacenter condition is a row here, not new code -- which is the
 * point. The evaluator already knows how to run all five predicate shapes.
 */
import type { Rule } from "./types.js";

const EPOCH = "1970-01-01T00:00:00.000Z";

export const SYSTEM_RULES: Rule[] = [
  {
    id: "sys-leak",
    author: "system",
    createdAt: EPOCH,
    expiresAt: null,
    enabled: true,
    note: "water leak detected",
    kind: "event",
    channel: "leak",
    match: "leak_detected",
  },
  {
    id: "sys-temp-sustained",
    author: "system",
    createdAt: EPOCH,
    expiresAt: null,
    enabled: true,
    note: "temperature elevated for 10 minutes",
    kind: "sustained",
    channel: "temperature_c",
    op: ">",
    value: 28,
    forSeconds: 600,
  },
  {
    id: "sys-humidity-high",
    author: "system",
    createdAt: EPOCH,
    expiresAt: null,
    enabled: true,
    note: "humidity above the safe band",
    kind: "level",
    channel: "humidity_pct",
    op: ">",
    value: 70,
  },
  {
    id: "sys-humidity-low",
    author: "system",
    createdAt: EPOCH,
    expiresAt: null,
    enabled: true,
    note: "humidity below the safe band (static risk)",
    kind: "level",
    channel: "humidity_pct",
    op: "<",
    value: 20,
  },
  {
    id: "sys-door-left-open",
    author: "system",
    createdAt: EPOCH,
    expiresAt: null,
    enabled: true,
    note: "door left open for 10 minutes",
    kind: "state_duration",
    channel: "door",
    match: "door_open",
    forSeconds: 600,
  },
  {
    id: "sys-feed-stale",
    author: "system",
    createdAt: EPOCH,
    expiresAt: null,
    enabled: true,
    note: "sensor feed went silent",
    kind: "stale",
    forSeconds: 600,
  },
];

/**
 * User rules plus every system rule the user hasn't overridden. A stored rule
 * with a system id replaces the built-in entirely, which is how disabling works.
 */
export function mergeWithDefaults(stored: Rule[]): Rule[] {
  const overridden = new Set(stored.map((r) => r.id));
  return [...SYSTEM_RULES.filter((r) => !overridden.has(r.id)), ...stored];
}

export function isSystemRuleId(id: string): boolean {
  return SYSTEM_RULES.some((r) => r.id === id);
}
