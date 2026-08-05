import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRuleTick } from "./runner.js";

let dir: string;
const saved = { ...process.env };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rules-runner-"));
  process.env["UNOQ_SENSOR_LOG"] = join(dir, "log.jsonl");
  process.env["ALERT_RULES_PATH"] = join(dir, "rules.json");
  process.env["ALERT_RULE_STATE_PATH"] = join(dir, "state.json");
});

afterEach(async () => {
  process.env = { ...saved };
  await rm(dir, { recursive: true, force: true });
});

function tickLine(offsetSeconds: number, now: number): string {
  return JSON.stringify({
    timestamp: new Date(now + offsetSeconds * 1000).toISOString(),
    event: "sensor_tick",
    temperature_c: 24,
    humidity_pct: 60,
  });
}

describe("runRuleTick -- an unreadable log is a reportable condition", () => {
  it("fires the staleness rule when the sensor log is missing", async () => {
    // The rule whose message reads "the board or the push may be down" must be
    // able to fire when it is. Returning early on a read failure made that the
    // one condition it could not report.
    const result = await runRuleTick();
    expect(result.logError).toBeDefined();
    expect(result.firings.some((f) => f.text.includes("silent"))).toBe(true);
  });

  it("keeps the learned baselines when the log becomes unreadable", async () => {
    const now = Date.now();
    await writeFile(
      process.env["UNOQ_SENSOR_LOG"] as string,
      [tickLine(-20, now), tickLine(-10, now)].join("\n") + "\n",
    );
    const first = await runRuleTick();
    expect(first.baselines.numeric.temperature_c?.n).toBe(2);

    await rm(process.env["UNOQ_SENSOR_LOG"] as string);
    const second = await runRuleTick();
    // A transient read failure must not erase what the system learned.
    expect(second.baselines.numeric.temperature_c?.n).toBe(2);
  });

  it("does not persist state on a dry run", async () => {
    const now = Date.now();
    await writeFile(process.env["UNOQ_SENSOR_LOG"] as string, tickLine(-10, now) + "\n");
    await runRuleTick({ dryRun: true });
    await expect(readFile(process.env["ALERT_RULE_STATE_PATH"] as string, "utf8")).rejects.toThrow();
  });

  it("skips pruning when rules.json exists but cannot be read", async () => {
    // A failed read yields system rules only. Pruning against that would throw
    // away every user rule's watermark, so the events in the gap would be
    // silently dropped once the file became readable again. A directory in
    // place of the file reproduces a non-ENOENT read failure portably.
    const now = Date.now();
    await writeFile(process.env["UNOQ_SENSOR_LOG"] as string, tickLine(-10, now) + "\n");
    await writeFile(
      process.env["ALERT_RULE_STATE_PATH"] as string,
      JSON.stringify({ state: { r1: { fireCount: 4, watermark: "2026-08-04T00:00:00.000Z" } } }),
    );
    await mkdir(process.env["ALERT_RULES_PATH"] as string);

    const result = await runRuleTick();
    expect(result.rulesError).toBeDefined();

    const state = JSON.parse(
      await readFile(process.env["ALERT_RULE_STATE_PATH"] as string, "utf8"),
    ) as { state: Record<string, { fireCount: number }> };
    expect(state.state["r1"]?.fireCount).toBe(4);
  });

  it("prunes orphaned runtime when rules.json reads cleanly", async () => {
    const now = Date.now();
    await writeFile(process.env["UNOQ_SENSOR_LOG"] as string, tickLine(-10, now) + "\n");
    await writeFile(process.env["ALERT_RULES_PATH"] as string, JSON.stringify({ rules: [] }));
    await writeFile(
      process.env["ALERT_RULE_STATE_PATH"] as string,
      JSON.stringify({ state: { r1: { fireCount: 4 } } }),
    );

    await runRuleTick();
    const state = JSON.parse(
      await readFile(process.env["ALERT_RULE_STATE_PATH"] as string, "utf8"),
    ) as { state: Record<string, unknown> };
    expect(state.state["r1"]).toBeUndefined();
  });

  it("evaluates event rules every tick but slow rules only on their interval", async () => {
    // A door press is a now-or-never signal, so the tick is fast. Temperature
    // is not, so it keeps its own rhythm behind levelsEvaluatedAt.
    const now = Date.now();
    await writeFile(
      process.env["ALERT_RULES_PATH"] as string,
      JSON.stringify({
        rules: [
          {
            id: "ev",
            author: "user",
            createdAt: new Date(now - 60_000).toISOString(),
            armedAt: new Date(now - 60_000).toISOString(),
            expiresAt: null,
            enabled: true,
            kind: "event",
            channel: "door",
            match: "door_open",
          },
        ],
      }),
    );
    const doorLine = JSON.stringify({
      timestamp: new Date(now - 5_000).toISOString(),
      event: "door_open",
      temperature_c: 24,
      humidity_pct: 60,
    });
    await writeFile(
      process.env["UNOQ_SENSOR_LOG"] as string,
      [tickLine(-20, now), doorLine, tickLine(-1, now)].join("\n") + "\n",
    );

    const first = await runRuleTick();
    expect(first.firings.some((f) => f.ruleId === "ev")).toBe(true);

    const state = JSON.parse(
      await readFile(process.env["ALERT_RULE_STATE_PATH"] as string, "utf8"),
    ) as { levelsEvaluatedAt?: string };
    expect(state.levelsEvaluatedAt).toBeDefined();

    // Immediately after, the slow rules are not due again -- but the fast path
    // still ran (nothing new to report, hence no firings).
    const second = await runRuleTick();
    expect(second.firings).toHaveLength(0);
    const state2 = JSON.parse(
      await readFile(process.env["ALERT_RULE_STATE_PATH"] as string, "utf8"),
    ) as { levelsEvaluatedAt?: string };
    expect(state2.levelsEvaluatedAt).toBe(state.levelsEvaluatedAt);
  });

  it("does not advance a skipped slow rule's watermark, so coverage is unbroken", async () => {
    // Gating must change cadence, never coverage: the next evaluation has to
    // read the whole interval it sat out.
    const now = Date.now();
    await writeFile(process.env["ALERT_RULES_PATH"] as string, JSON.stringify({ rules: [] }));
    await writeFile(process.env["UNOQ_SENSOR_LOG"] as string, tickLine(-10, now) + "\n");

    await runRuleTick();
    const a = JSON.parse(
      await readFile(process.env["ALERT_RULE_STATE_PATH"] as string, "utf8"),
    ) as { state: Record<string, { watermark?: string }> };
    const before = a.state["sys-humidity-high"]?.watermark;

    await writeFile(
      process.env["UNOQ_SENSOR_LOG"] as string,
      [tickLine(-10, now), tickLine(-1, now)].join("\n") + "\n",
    );
    await runRuleTick(); // slow rules not due
    const b = JSON.parse(
      await readFile(process.env["ALERT_RULE_STATE_PATH"] as string, "utf8"),
    ) as { state: Record<string, { watermark?: string }> };
    expect(b.state["sys-humidity-high"]?.watermark).toBe(before);
  });

  it("persists watermarks and baselines on a committed tick", async () => {
    const now = Date.now();
    await writeFile(process.env["UNOQ_SENSOR_LOG"] as string, tickLine(-10, now) + "\n");
    await runRuleTick();
    const state = JSON.parse(
      await readFile(process.env["ALERT_RULE_STATE_PATH"] as string, "utf8"),
    ) as { state: Record<string, unknown>; baselines?: { lines: number } };
    expect(state.baselines?.lines).toBe(1);
    expect(Object.keys(state.state)).toContain("sys-leak");
  });
});
