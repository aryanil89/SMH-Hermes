/**
 * Persistence for alert rules. Two files, one writer each, atomic replace.
 *
 * Why not one file: the agent holds rules.json across a Telegram conversation
 * (seconds to minutes) while the evaluator advances watermarks every 5 minutes.
 * Sharing a file means the agent's write silently reverts the evaluator's
 * progress, and every event in that gap alerts a second time.
 *
 * Why not SQLite (yet): nothing here needs transactions or queries. Node 24
 * ships `node:sqlite`, so the upgrade is a one-file change if firing history
 * ever needs to be queryable -- but a service (Postgres) is not on that path.
 */
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Rule, RuleRuntime, RuleStateFile, RulesFile } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** dist/rules/store.js -> package root is two levels up. */
const PACKAGE_ROOT = join(__dirname, "..", "..");
const STATE_DIR = join(PACKAGE_ROOT, ".state");

export function rulesPath(): string {
  return process.env.ALERT_RULES_PATH ?? join(STATE_DIR, "rules.json");
}

export function ruleStatePath(): string {
  return process.env.ALERT_RULE_STATE_PATH ?? join(STATE_DIR, "rule-state.json");
}

/**
 * Write via temp-then-rename so a reader mid-write never sees a truncated file.
 * Same discipline as boot_status.json on the board and pull_sensor_log.ps1 on
 * the laptop -- rename is atomic within a filesystem on both platforms.
 */
async function writeAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Per-process temp name. A fixed `${path}.tmp` lets two writers interleave
  // write and rename, so one truncates the other's staging file and the loser
  // renames a partial document into place -- or fails ENOENT after the winner
  // renamed it away.
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

/**
 * Absent and unreadable are different failures and must not be conflated.
 *
 * "Missing" is the normal first-run state and safely means "no rules". A
 * transient EBUSY/EPERM (an editor, a scanner, a concurrent rename) also
 * produces an exception, but treating *that* as "no rules" is destructive:
 * the evaluator would prune every user rule's runtime and the agent would
 * overwrite the file with only the rule it just created. So ENOENT yields the
 * fallback and everything else propagates.
 */
async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return fallback;
    if (err instanceof SyntaxError) return fallback; // corrupt beats crashing
    throw err;
  }
}

/** Throws if the file exists but could not be read. Callers must handle that. */
export async function readRules(path = rulesPath()): Promise<Rule[]> {
  const file = await readJson<RulesFile>(path, { rules: [] });
  return Array.isArray(file.rules) ? file.rules : [];
}

/**
 * Evaluator-side read that cannot throw. `degraded` means "the file exists but
 * I could not read it" -- the caller must then skip anything destructive
 * (pruning state, garbage collection) because the rule list it is holding is a
 * lie, not an empty store.
 */
export async function tryReadRules(
  path = rulesPath(),
): Promise<{ rules: Rule[]; degraded: boolean; reason?: string }> {
  try {
    return { rules: await readRules(path), degraded: false };
  } catch (err) {
    return {
      rules: [],
      degraded: true,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Agent-side writer. Never call this from the evaluator. */
export async function writeRules(rules: Rule[], path = rulesPath()): Promise<void> {
  await writeAtomic(path, { rules } satisfies RulesFile);
}

/**
 * NOTE: this reader rebuilds the object field by field, so any field NOT named
 * here is silently dropped on the next write. Add new state here at the same
 * time you add it to RuleStateFile -- `levelsEvaluatedAt` was written but not
 * read back for exactly one commit, which made the slow-rule gate a no-op that
 * looked like it worked.
 */
export async function readRuleState(path = ruleStatePath()): Promise<RuleStateFile> {
  const file = await readJson<RuleStateFile>(path, { state: {} });
  return {
    state: file.state ?? {},
    ...(file.baselines ? { baselines: file.baselines } : {}),
    ...(typeof file.levelsEvaluatedAt === "string"
      ? { levelsEvaluatedAt: file.levelsEvaluatedAt }
      : {}),
  };
}

/** Evaluator-side writer. Never call this from the agent. */
export async function writeRuleState(file: RuleStateFile, path = ruleStatePath()): Promise<void> {
  await writeAtomic(path, file);
}

export function runtimeFor(state: RuleStateFile, ruleId: string): RuleRuntime {
  return state.state[ruleId] ?? { fireCount: 0 };
}

/**
 * Short, readable, collision-safe-enough for a store that holds tens of rules.
 * Not a UUID on purpose: these ids get typed into Telegram to cancel a rule.
 *
 * `reserved` must include every id still present in rule-state.json, not just
 * the live rules. Cancelling deletes from rules.json but leaves runtime behind
 * until the next evaluation prunes it, and an id handed out in that gap would
 * inherit the dead rule's watermark or its stuck `fired` latch.
 */
export function newRuleId(existing: Rule[], reserved: string[] = []): string {
  const used = new Set([...existing.map((r) => r.id), ...reserved]);
  for (let i = 1; ; i++) {
    const id = `r${i}`;
    if (!used.has(id)) return id;
  }
}
