import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWatchTick } from "./tick.js";
import { writeState, readState } from "./state-store.js";

/**
 * These exercise the whole tick against real files, because the bugs worth
 * catching here are all about what gets *persisted* between ticks. The
 * flap-latch regression below was found on a live 25-minute soak, not by
 * reasoning about the code.
 */

let dir: string;
let statePath: string;
const saved: Record<string, string | undefined> = {};

const ENV_KEYS = [
  "UNOQ_SENSOR_LOG",
  "ALERT_RULES_PATH",
  "ALERT_RULE_STATE_PATH",
  "ALERT_STATE_PATH",
  "ACCESS_STATE_PATH",
  "UNOQ_LOG_MAX_AGE_S",
  "RULE_ENGINE_GRACE_S",
];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "smh-hermes-tick-"));
  statePath = join(dir, "environmental-watch.json");
  for (const k of ENV_KEYS) saved[k] = process.env[k];

  process.env.ALERT_RULES_PATH = join(dir, "rules.json");
  process.env.ALERT_RULE_STATE_PATH = join(dir, "rule-state.json");
  process.env.ACCESS_STATE_PATH = join(dir, "access.json");
  process.env.UNOQ_SENSOR_LOG = join(dir, "sensor.json");
  // The production value, not the old 3600 code default. These tests write
  // sensor lines a couple of seconds before `now`, so a tighter window costs
  // nothing -- and pinning the value the rig actually runs on means a tick test
  // cannot pass under a staleness setting no deployment uses.
  process.env.UNOQ_LOG_MAX_AGE_S = "180";
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  await rm(dir, { recursive: true, force: true });
});

/** One healthy sensor line, timestamped relative to `now` so it is never stale. */
async function writeLog(now: Date, temperatureC = 21): Promise<void> {
  const line = {
    timestamp: new Date(now.getTime() - 2000).toISOString(),
    event: "sensor_tick",
    temperature_c: temperatureC,
    humidity_pct: 50,
  };
  await writeFile(join(dir, "sensor.json"), JSON.stringify(line) + "\n", "utf8");
}

describe("runWatchTick — rule engine failure reporting", () => {
  it("says nothing about a failure that lasts a single tick", async () => {
    // No sensor log on disk at all: the rule engine cannot read it.
    const t0 = new Date("2026-08-05T12:00:00.000Z");
    const first = await runWatchTick({ now: t0, statePath });

    // The failure is recorded so the clock can start...
    expect(first.nextState.ruleEngineError).toBeDefined();
    expect(first.nextState.ruleEngineReported).toBe(false);
    // ...but the on-call hears nothing yet.
    expect(first.parts.join("\n")).not.toContain("degraded");

    // It clears on the very next tick, as a file lock does.
    await writeLog(new Date(t0.getTime() + 15_000));
    const second = await runWatchTick({ now: new Date(t0.getTime() + 15_000), statePath });

    // And crucially: no "recovered" either. Nobody was told anything, so there
    // is nothing to take back. This is the 11-pairs-in-25-minutes regression.
    expect(second.parts.join("\n")).not.toContain("recovered");
    expect(second.nextState.ruleEngineError).toBeUndefined();
  });

  it("reports a failure that persists past the grace window, exactly once", async () => {
    const t0 = new Date("2026-08-05T12:00:00.000Z");
    await runWatchTick({ now: t0, statePath });

    // Still broken 8 ticks later (120s).
    const t1 = new Date(t0.getTime() + 120_000);
    const reported = await runWatchTick({ now: t1, statePath });
    expect(reported.parts.join("\n")).toContain("Alert rule engine is degraded");
    expect(reported.nextState.ruleEngineReported).toBe(true);
    // The clock is NOT restarted by reporting.
    expect(reported.nextState.ruleEngineErrorSince).toBe(t0.toISOString());

    // Still broken another 8 ticks later -- and silent, because it is latched.
    const t2 = new Date(t1.getTime() + 120_000);
    const again = await runWatchTick({ now: t2, statePath });
    expect(again.parts.join("\n")).not.toContain("degraded");
  });

  it("announces recovery only for a failure it actually reported", async () => {
    const t0 = new Date("2026-08-05T12:00:00.000Z");
    await runWatchTick({ now: t0, statePath });
    const t1 = new Date(t0.getTime() + 120_000);
    await runWatchTick({ now: t1, statePath });

    await writeLog(new Date(t1.getTime() + 15_000));
    const healed = await runWatchTick({ now: new Date(t1.getTime() + 15_000), statePath });

    expect(healed.parts.join("\n")).toContain("Alert rule engine has recovered.");
    expect(healed.nextState.ruleEngineError).toBeUndefined();
    expect(healed.nextState.ruleEngineReported).toBeUndefined();
  });

  it("still announces recovery for a legacy state file with no reported flag", async () => {
    // Written by the previous scheme, which reported on the first failing tick.
    await writeState(statePath, {
      lastStatus: "ok",
      ruleEngineError: "cannot read the sensor log: something",
    });

    const now = new Date("2026-08-05T12:00:00.000Z");
    await writeLog(now);
    const result = await runWatchTick({ now, statePath });

    expect(result.parts.join("\n")).toContain("Alert rule engine has recovered.");
  });

  it("does not repeat 'recovered' on every tick while a page is held", async () => {
    // The held-page branch inherits `previous` wholesale, so a stale
    // ruleEngineError left in the persisted state would re-emit the recovery
    // line forever. Simplest proof: a recovered engine must clear the field.
    await writeState(statePath, {
      lastStatus: "ok",
      ruleEngineError: "cannot read the sensor log: something",
      ruleEngineReported: true,
      ruleEngineErrorSince: "2026-08-05T11:00:00.000Z",
    });

    const now = new Date("2026-08-05T12:00:00.000Z");
    await writeLog(now);
    await runWatchTick({ now, statePath });

    const persisted = await readState(statePath);
    expect(persisted.ruleEngineError).toBeUndefined();
    expect(persisted.ruleEngineReported).toBeUndefined();
    expect(persisted.ruleEngineErrorSince).toBeUndefined();
  });

  it("honours dryRun: computes the decision, persists nothing", async () => {
    // Wall clock, not a fixed date: `getEnvironmentalReading` reads the sensor
    // log against the real clock rather than the `now` passed to the tick, so a
    // 2026-dated fixture would be judged stale and fall back to mock.
    const now = new Date();
    await writeLog(now);
    const result = await runWatchTick({ now, statePath, dryRun: true });

    expect(result.reading.source).toBe("real");
    // readState on a path that was never written returns the default baseline.
    const persisted = await readState(statePath);
    expect(persisted).toEqual({ lastStatus: "ok" });
  });
});

describe("runWatchTick — on-device activity push", () => {
  // No staleness gate on the activity scan (see readLatestActivity), so a
  // fixed 2026 date is fine here even though it makes `getEnvironmentalReading`
  // fall back to mock -- these tests don't depend on `reading.source`.
  async function writeActivityLog(now: Date, activity: string, trigger = "object_entered"): Promise<void> {
    const lines = [
      { timestamp: new Date(now.getTime() - 3000).toISOString(), event: "sensor_tick", temperature_c: 21, humidity_pct: 50 },
      { timestamp: new Date(now.getTime() - 1000).toISOString(), event: "activity", activity, trigger, temperature_c: 21, humidity_pct: 50 },
    ];
    await writeFile(join(dir, "sensor.json"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  }

  it("pushes a Telegram message naming the activity for a new activity line", async () => {
    const now = new Date("2026-08-06T00:04:38.000Z");
    await writeActivityLog(now, "activity-person_entered_room");

    const result = await runWatchTick({ now, statePath });

    expect(result.parts).toContain("UNO Q detected a possible activity: Person entered room.");
    expect(result.nextState.lastActivityAt).toBeDefined();
  });

  it("does not repeat the same activity on the next tick", async () => {
    const t0 = new Date("2026-08-06T00:04:38.000Z");
    await writeActivityLog(t0, "activity-person_entered_room");
    await runWatchTick({ now: t0, statePath });

    // Same log, unchanged -- a later tick reading the identical newest activity
    // line must not re-push it.
    const t1 = new Date(t0.getTime() + 15_000);
    const second = await runWatchTick({ now: t1, statePath });

    expect(second.parts.join("\n")).not.toContain("detected a possible activity");
  });

  it("pushes again when a genuinely new activity line appears", async () => {
    const t0 = new Date("2026-08-06T00:04:38.000Z");
    await writeActivityLog(t0, "activity-person_entered_room");
    await runWatchTick({ now: t0, statePath });

    const t1 = new Date(t0.getTime() + 15_000);
    await writeActivityLog(t1, "activity-possible_fire_risk");
    const second = await runWatchTick({ now: t1, statePath });

    expect(second.parts).toContain("UNO Q detected a possible activity: Possible fire risk.");
  });

  it("says nothing when the log has no activity line at all", async () => {
    const now = new Date("2026-08-06T00:04:38.000Z");
    await writeLog(now); // plain sensor_tick only, no activity event
    const result = await runWatchTick({ now, statePath });

    expect(result.parts).toEqual([]);
    expect(result.nextState.lastActivityAt).toBeUndefined();
  });
});

describe("runWatchTick — how a held page is worded when it finally goes out", () => {
  /**
   * A hold ends two different ways and the on-call has to be able to tell them
   * apart from the message alone. Both paths were previously untested, which is
   * why both produced the same sentence for two years' worth of very different
   * situations: "held while the on-call was on site; sending now" was applied to
   * a rack that had quietly deteriorated under a responder's nose.
   */
  async function writeAccess(now: Date, present: boolean): Promise<void> {
    if (!present) {
      // Nobody at the rack. Not a deleted file -- the sentry is alive and
      // reporting an empty rack, which is the ordinary "they walked away" case.
      await writeFile(
        process.env.ACCESS_STATE_PATH as string,
        JSON.stringify({ updatedAt: now.toISOString(), log: [] }),
        "utf8",
      );
      return;
    }
    await writeFile(
      process.env.ACCESS_STATE_PATH as string,
      JSON.stringify({
        updatedAt: now.toISOString(),
        log: [],
        pending: {
          id: "acc_20260805T120000Z",
          at: "2026-08-05T12:00:00.000Z",
          zone: "zone-east",
          trigger: "object_entered",
          faces: [{ match: "known", name: "Lauren R", similarity: 0.81 }],
          identityMethod: "qr-badge",
          doorOpenCount: 1,
          verdict: "expected",
          severity: "ok",
          reasons: [],
          approval: { required: false, state: "not-required" },
        },
      }),
      "utf8",
    );
  }

  // Anchored to the wall clock, unlike the fixed dates elsewhere in this file.
  // getEnvironmentalReading calls readSensorLogReading without a `now`, so the
  // sensor log's freshness is judged against the real clock no matter what is
  // injected here -- a fixed 2026-08-05 fixture reads as days stale, the source
  // falls back to mock, and decideAlert returns `untrusted-reading` for it. The
  // suppression path is then never reached and the test passes vacuously.
  const t0 = new Date(Date.now() - 5_000);
  const t1 = new Date(t0.getTime() + 15_000);

  /** Warning-level rack (>30C) with a known responder standing at it. */
  async function holdOnePage(): Promise<void> {
    await writeLog(t0, 32);
    await writeAccess(t0, true);
    const held = await runWatchTick({ now: t0, statePath });
    // Guard the premise: if this stopped holding, the tests below would pass
    // for the wrong reason.
    expect(held.suppression.hold).toBe(true);
    expect(held.parts).toEqual([]);
    expect(held.nextState.heldPage?.heldStatus).toBe("warning");
  }

  it("says the page was merely deferred when the responder walks away", async () => {
    await holdOnePage();

    await writeLog(t1, 32); // unchanged rack -- only the human moved
    await writeAccess(t1, false);
    const out = await runWatchTick({ now: t1, statePath });

    expect(out.released).toBe(true);
    expect(out.parts.join("\n")).toContain("held while the on-call was on site; sending now");
    expect(out.nextState.heldPage).toBeUndefined();
  });

  it("says the rack escalated, not that the page was merely deferred", async () => {
    await holdOnePage();

    // The responder never left. The rack got worse while they stood there --
    // the one case suppression is forbidden to swallow.
    await writeLog(t1, 38); // critical
    await writeAccess(t1, true);
    const out = await runWatchTick({ now: t1, statePath });

    const text = out.parts.join("\n");
    expect(out.released).toBe(true);
    expect(out.suppression.escalatedPastResponder).toBe(true);
    expect(text).toContain("escalated while the on-call was on site");
    // The old wording would have told the on-call nothing had changed since
    // they were standing there, which is the opposite of what happened.
    expect(text).not.toContain("sending now");
  });
});
