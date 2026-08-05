/**
 * Create / list / cancel, shared by the CLI and the MCP server so both behave
 * identically. This is the only module that writes rules.json.
 *
 * Everything here runs at *authoring* time -- once, conversationally, when a
 * human asks for an alert. Slow is fine. Nothing in the 5-minute evaluation
 * path calls into this file.
 */
import { isEventChannel, isNumericChannel, describeChannels } from "./channels.js";
import { isSystemRuleId, mergeWithDefaults, SYSTEM_RULES } from "./defaults.js";
import { newRuleId, readRuleState, readRules, tryReadRules, writeRules } from "./store.js";
import { currentBaselines, currentReadings } from "./runner.js";
import { validateRule, type Finding, type ValidationResult } from "./validate.js";
import type { ComparisonOp, Predicate, Rule, RuleStateFile } from "./types.js";

export interface CreateRuleInput {
  kind: Predicate["kind"];
  channel?: string;
  op?: string;
  value?: number;
  match?: string;
  /** For sustained / state_duration / stale: how long the condition must hold. */
  forSeconds?: number;
  /** How long the rule stays armed. Omit or null for "until cancelled". */
  windowSeconds?: number | null;
  /** The requester's own words. Echoed back on list and on expiry. */
  note?: string;
  chatId?: string;
}

export interface CreateRuleResult extends ValidationResult {
  created: boolean;
  rule?: Rule;
  /** Ready-to-send text. The agent may rephrase but must not contradict it. */
  message: string;
}

const VALID_OPS: ComparisonOp[] = [">", ">=", "<", "<="];

/**
 * Turn the flat, model-friendly tool arguments into a typed predicate, or say
 * why they don't form one. Exported so `cli.js validate` runs the exact same
 * construction as `cli.js add` -- a validator that accepts inputs the creator
 * would reject is worse than no validator.
 */
export function buildPredicate(input: CreateRuleInput): Predicate | { error: string } {
  const { kind } = input;

  if (kind === "stale") {
    return { kind, forSeconds: input.forSeconds ?? 600 };
  }

  const channel = input.channel;
  if (channel === undefined) return { error: `a channel is required. Available -- ${describeChannels()}` };

  if (kind === "level" || kind === "sustained") {
    if (!isNumericChannel(channel)) {
      return { error: `"${channel}" is not a numeric channel. Available -- ${describeChannels()}` };
    }
    const op = input.op as ComparisonOp | undefined;
    if (op === undefined || !VALID_OPS.includes(op)) {
      return { error: `op must be one of ${VALID_OPS.join(", ")}` };
    }
    if (typeof input.value !== "number" || !Number.isFinite(input.value)) {
      return { error: "a numeric threshold value is required" };
    }
    return kind === "level"
      ? { kind, channel, op, value: input.value }
      : { kind, channel, op, value: input.value, forSeconds: input.forSeconds ?? 600 };
  }

  if (!isEventChannel(channel)) {
    return { error: `"${channel}" is not an event channel. Available -- ${describeChannels()}` };
  }
  if (typeof input.match !== "string" || input.match.length === 0) {
    return { error: "an event name is required (e.g. door_open)" };
  }
  return kind === "event"
    ? { kind, channel, match: input.match }
    : { kind, channel, match: input.match, forSeconds: input.forSeconds ?? 600 };
}

function renderFindings(findings: Finding[]): string {
  return findings.map((f) => `- ${f.detail}`).join("\n");
}

export async function createRule(input: CreateRuleInput): Promise<CreateRuleResult> {
  const built = buildPredicate(input);
  if ("error" in built) {
    return {
      created: false,
      ok: false,
      findings: [{ severity: "reject", code: "unknown_channel", detail: built.error }],
      facts: {},
      message: `I can't set that up: ${built.error}`,
    };
  }

  const windowSeconds = input.windowSeconds ?? null;
  const validation = validateRule({
    predicate: built,
    baselines: await currentBaselines(),
    current: await currentReadings(),
    ...(windowSeconds !== null ? { windowSeconds } : {}),
  });

  if (!validation.ok) {
    // Rejected. The *reason* is arithmetic; the agent turns it into a sentence.
    return {
      ...validation,
      created: false,
      message: `I can't set that one up.\n${renderFindings(validation.findings)}`,
    };
  }

  // Every write path re-reads first, so an unreadable rules.json must abort
  // rather than fall back to "no rules" -- writing [newRule] over a file that
  // exists but couldn't be read would delete everything already armed.
  let stored: Rule[];
  try {
    stored = await readRules();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      created: false,
      ok: false,
      findings: [{ severity: "reject", code: "unknown_channel", detail: reason }],
      facts: {},
      message: `I couldn't save that rule - the rule store is unreadable right now (${reason}). Nothing was changed; try again in a moment.`,
    };
  }
  const state = await readRuleState();
  const now = new Date();
  const rule: Rule = {
    // Skip ids still carrying runtime from a cancelled rule: reusing one would
    // inherit its watermark (replaying days of events) or its `fired` latch
    // (swallowing the very next crossing the validator just promised).
    id: newRuleId(stored, Object.keys(state.state)),
    author: "user",
    createdAt: now.toISOString(),
    armedAt: now.toISOString(),
    expiresAt:
      windowSeconds === null ? null : new Date(now.getTime() + windowSeconds * 1000).toISOString(),
    enabled: true,
    ...(input.note !== undefined ? { note: input.note } : {}),
    ...(input.chatId !== undefined ? { chatId: input.chatId } : {}),
    ...built,
  };

  await writeRules([...gcExpired(stored, state), rule]);

  const until = rule.expiresAt ? ` until ${new Date(rule.expiresAt).toLocaleString()}` : "";
  const warnings = validation.findings.filter((f) => f.severity === "warn");
  const message =
    `Armed as ${rule.id}: ${describeRule(rule)}${until}.` +
    (warnings.length > 0 ? `\nWorth knowing:\n${renderFindings(warnings)}` : "");

  return { ...validation, created: true, rule, message };
}

/**
 * Drop expired rules whose expiry notice has already gone out. Runs here, on the
 * agent's own write, so the evaluator never has to touch rules.json -- keeping
 * one writer per file. (Reading rule-state.json is fine; only writing it is the
 * evaluator's exclusive right.)
 *
 * Gating on `expiredNotified` rather than on elapsed time is what makes the
 * ordering an invariant instead of a probability: if cron has been down across
 * the expiry, the rule survives here until the evaluator has actually reported
 * it, so the notice can never be lost.
 */
function gcExpired(rules: Rule[], state: RuleStateFile): Rule[] {
  return rules.filter(
    (r) => r.expiresAt === null || state.state[r.id]?.expiredNotified !== true,
  );
}

export function describeRule(rule: Rule): string {
  switch (rule.kind) {
    case "level":
      return `${rule.channel} ${rule.op} ${rule.value}`;
    case "sustained":
      return `${rule.channel} ${rule.op} ${rule.value} for ${Math.round(rule.forSeconds / 60)}m`;
    case "event":
      return `every ${rule.match}`;
    case "state_duration":
      return `${rule.match} held for ${Math.round(rule.forSeconds / 60)}m`;
    case "stale":
      return `sensor feed silent for ${Math.round(rule.forSeconds / 60)}m`;
  }
}

export interface ListedRule {
  id: string;
  author: "user" | "system";
  enabled: boolean;
  description: string;
  note?: string;
  expiresAt: string | null;
  fireCount: number;
  lastFiredAt?: string;
}

export async function listRules(): Promise<ListedRule[]> {
  // Read-only, so a degraded read degrades gracefully to the built-ins rather
  // than failing the whole listing.
  const rules = mergeWithDefaults((await tryReadRules()).rules);
  const state = await readRuleState();
  return rules.map((r) => {
    const rt = state.state[r.id];
    return {
      id: r.id,
      author: r.author,
      enabled: r.enabled,
      description: describeRule(r),
      ...(r.note !== undefined ? { note: r.note } : {}),
      expiresAt: r.expiresAt,
      fireCount: rt?.fireCount ?? 0,
      ...(rt?.lastFiredAt !== undefined ? { lastFiredAt: rt.lastFiredAt } : {}),
    };
  });
}

export interface CancelResult {
  ok: boolean;
  message: string;
}

/**
 * User rules are removed. System rules are disabled via an override entry --
 * "stop telling me about leaks" is obeyed, but the safety net can be restored
 * with `resume`, and it can never be permanently deleted by anyone in the chat.
 */
export async function cancelRule(id: string): Promise<CancelResult> {
  let stored: Rule[];
  try {
    stored = await readRules();
  } catch (err) {
    return {
      ok: false,
      message: `The rule store is unreadable right now (${err instanceof Error ? err.message : String(err)}); nothing was changed.`,
    };
  }

  if (isSystemRuleId(id)) {
    const existing = stored.find((r) => r.id === id);
    if (existing && !existing.enabled) {
      return { ok: true, message: `${id} is already muted.` };
    }
    const base = SYSTEM_RULES.find((r) => r.id === id);
    if (!base) return { ok: false, message: `No rule called ${id}.` };
    const override: Rule = { ...base, enabled: false };
    await writeRules([...stored.filter((r) => r.id !== id), override]);
    return {
      ok: true,
      message: `Muted ${id} (${base.note ?? describeRule(base)}). This is a built-in safety alert - say "resume ${id}" to turn it back on.`,
    };
  }

  const match = stored.find((r) => r.id === id);
  if (!match) return { ok: false, message: `No rule called ${id}.` };
  await writeRules(stored.filter((r) => r.id !== id));
  return { ok: true, message: `Cancelled ${id} (${describeRule(match)}).` };
}

export async function resumeRule(id: string): Promise<CancelResult> {
  let stored: Rule[];
  try {
    stored = await readRules();
  } catch (err) {
    return {
      ok: false,
      message: `The rule store is unreadable right now (${err instanceof Error ? err.message : String(err)}); nothing was changed.`,
    };
  }
  const match = stored.find((r) => r.id === id);
  if (!match) return { ok: false, message: `No muted rule called ${id}.` };

  // Re-stamping armedAt is what stops "resume leak alerts" from immediately
  // delivering every leak event that happened while it was muted. Resuming a
  // watch means watching from now, not being handed the backlog.
  const armedAt = new Date().toISOString();

  if (isSystemRuleId(id)) {
    // A system rule is stored only as a disable-override, so restoring it means
    // deleting that override -- but then armedAt has nowhere to live. Keep an
    // enabled override carrying the fresh stamp instead; mergeWithDefaults
    // treats it as the definition, and it is identical apart from armedAt.
    const base = SYSTEM_RULES.find((r) => r.id === id);
    if (!base) return { ok: false, message: `No rule called ${id}.` };
    await writeRules([...stored.filter((r) => r.id !== id), { ...base, enabled: true, armedAt }]);
    return { ok: true, message: `Resumed ${id}.` };
  }

  await writeRules(stored.map((r) => (r.id === id ? { ...r, enabled: true, armedAt } : r)));
  return { ok: true, message: `Resumed ${id}.` };
}
