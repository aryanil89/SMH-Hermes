import { describe, it, expect } from "vitest";
import { evaluateRules } from "./evaluate.js";
import { computeBaselines } from "./baseline.js";
import type { Rule, RuleStateFile } from "./types.js";
import type { SensorLogLine } from "../environmental/file-source.js";

const T0 = Date.parse("2026-08-04T12:00:00.000Z");

function line(offsetSeconds: number, over: Partial<SensorLogLine> = {}): SensorLogLine {
  return {
    timestamp: new Date(T0 + offsetSeconds * 1000).toISOString(),
    event: "sensor_tick",
    temperature_c: 24,
    humidity_pct: 60,
    ...over,
  };
}

const emptyState: RuleStateFile = { state: {} };

function doorRule(over: Partial<Rule> = {}): Rule {
  return {
    id: "r1",
    author: "user",
    createdAt: new Date(T0).toISOString(),
    expiresAt: null,
    enabled: true,
    kind: "event",
    channel: "door",
    match: "door_open",
    ...over,
  } as Rule;
}

describe("event rules -- every occurrence, never a replay", () => {
  it("adopts the end of the log on first sight instead of replaying history", () => {
    // Arming "tell me when the door opens" must not immediately deliver every
    // door event already in the file -- 31 hours of history as one burst.
    const lines = [line(0, { event: "door_open" }), line(10, { event: "door_open" }), line(20)];
    const result = evaluateRules({
      rules: [doorRule()],
      state: emptyState,
      lines,
      now: new Date(T0 + 30_000),
    });
    expect(result.firings).toHaveLength(0);
    expect(result.nextState["r1"]?.watermark).toBe(lines[2]?.timestamp);
  });

  it("fires once per occurrence and batches them into one message per tick", () => {
    const lines = [
      line(0),
      line(10, { event: "door_open" }),
      line(20, { event: "door_open" }),
      line(30, { event: "door_open" }),
      line(40),
    ];
    const state: RuleStateFile = {
      state: { r1: { fireCount: 0, watermark: line(0).timestamp } },
    };
    const result = evaluateRules({
      rules: [doorRule()],
      state,
      lines,
      now: new Date(T0 + 50_000),
    });
    expect(result.firings).toHaveLength(1);
    expect(result.firings[0]?.text).toContain("3x");
    // fireCount counts occurrences, not messages -- three opens happened.
    expect(result.nextState["r1"]?.fireCount).toBe(3);
  });

  it("does not re-report events already past the watermark", () => {
    const lines = [line(0), line(10, { event: "door_open" }), line(20)];
    const first = evaluateRules({
      rules: [doorRule()],
      state: { state: { r1: { fireCount: 0, watermark: line(0).timestamp } } },
      lines,
      now: new Date(T0 + 30_000),
    });
    expect(first.firings).toHaveLength(1);

    const second = evaluateRules({
      rules: [doorRule()],
      state: { state: first.nextState },
      lines,
      now: new Date(T0 + 60_000),
    });
    expect(second.firings).toHaveLength(0);
  });

  it("ignores events on other channels", () => {
    const lines = [line(0), line(10, { event: "light_on" }), line(20)];
    const result = evaluateRules({
      rules: [doorRule()],
      state: { state: { r1: { fireCount: 0, watermark: line(0).timestamp } } },
      lines,
      now: new Date(T0 + 30_000),
    });
    expect(result.firings).toHaveLength(0);
  });
});

describe("arm gap -- events between creation and the first tick", () => {
  it("reports an event that happened after arming but before the first tick", () => {
    // The demo flow: user asks for the alert, walks over, opens the door, and
    // the next cron tick is up to 5 minutes away. Adopting the newest log line
    // at first sight would silently skip exactly that event.
    const armedAt = new Date(T0).toISOString();
    const rule = doorRule({ armedAt });
    const lines = [line(-60, { event: "door_open" }), line(30, { event: "door_open" }), line(40)];

    const result = evaluateRules({
      rules: [rule],
      state: emptyState,
      lines,
      now: new Date(T0 + 240_000),
    });
    expect(result.firings).toHaveLength(1);
    // Only the one after arming -- the earlier open is still history.
    expect(result.nextState["r1"]?.fireCount).toBe(1);
  });

  it("still refuses to replay history for a system rule with no armedAt", () => {
    const systemish = doorRule({ id: "sys-x", author: "system" });
    const lines = [line(-3600, { event: "door_open" }), line(-10, { event: "door_open" }), line(0)];
    const result = evaluateRules({
      rules: [systemish],
      state: emptyState,
      lines,
      now: new Date(T0 + 1000),
    });
    expect(result.firings).toHaveLength(0);
  });

  it("does not deliver the backlog accumulated while a rule was muted", () => {
    // resumeRule re-stamps armedAt. Without that, unmuting "leak alerts" would
    // dump every leak that happened during the silence in one burst.
    const resumedAt = new Date(T0 + 100_000).toISOString();
    const rule = doorRule({ armedAt: resumedAt });
    const stale = { r1: { fireCount: 3, watermark: line(0).timestamp } };
    const lines = [
      line(10, { event: "door_open" }), // during the mute
      line(50, { event: "door_open" }), // during the mute
      line(150, { event: "door_open" }), // after resume
      line(160),
    ];
    const result = evaluateRules({
      rules: [rule],
      state: { state: stale },
      lines,
      now: new Date(T0 + 170_000),
    });
    expect(result.firings).toHaveLength(1);
    expect(result.nextState["r1"]?.fireCount).toBe(4); // 3 prior + 1 new, not + 3
  });
});

describe("state hygiene", () => {
  it("prunes runtime for rules that no longer exist", () => {
    // Otherwise a recycled id inherits a cancelled rule's watermark (replaying
    // days of events) or its stuck `fired` latch (swallowing the next crossing).
    const result = evaluateRules({
      rules: [doorRule({ armedAt: new Date(T0).toISOString() })],
      state: { state: { r1: { fireCount: 1 }, "deleted-rule": { fireCount: 9, fired: true } } },
      lines: [line(10)],
      now: new Date(T0 + 20_000),
    });
    expect(Object.keys(result.nextState)).toEqual(["r1"]);
  });
});

describe("level rules -- edge triggered", () => {
  const rule: Rule = {
    id: "r2",
    author: "user",
    createdAt: new Date(T0).toISOString(),
    expiresAt: null,
    enabled: true,
    kind: "level",
    channel: "temperature_c",
    op: ">",
    value: 25,
  };

  it("fires on the crossing, then stays quiet while still hot", () => {
    const hot = [line(0, { temperature_c: 26 })];
    const first = evaluateRules({ rules: [rule], state: emptyState, lines: hot, now: new Date(T0 + 1000) });
    expect(first.firings).toHaveLength(1);

    const second = evaluateRules({
      rules: [rule],
      state: { state: first.nextState },
      lines: hot,
      now: new Date(T0 + 2000),
    });
    expect(second.firings).toHaveLength(0);
  });

  it("re-arms after recovering, so the next crossing alerts again", () => {
    const first = evaluateRules({
      rules: [rule],
      state: emptyState,
      lines: [line(0, { temperature_c: 26 })],
      now: new Date(T0 + 1000),
    });
    const cooled = evaluateRules({
      rules: [rule],
      state: { state: first.nextState },
      lines: [line(10, { temperature_c: 24 })],
      now: new Date(T0 + 11_000),
    });
    expect(cooled.firings).toHaveLength(0);
    expect(cooled.nextState["r2"]?.fired).toBe(false);

    const again = evaluateRules({
      rules: [rule],
      state: { state: cooled.nextState },
      lines: [line(20, { temperature_c: 27 })],
      now: new Date(T0 + 21_000),
    });
    expect(again.firings).toHaveLength(1);
  });

  it("floors the window on log timestamps, not on when the last tick ran", () => {
    // The board writes timestamps; the file arrives by a periodic push. A
    // sample logged at T-3s can land in the file after the tick at T. Flooring
    // on wall clock would drop it forever -- a blind slice the width of the
    // push latency on every single tick.
    const lastSeen = line(-15); // newest line the previous tick actually saw
    const lines = [lastSeen, line(-3, { temperature_c: 31 }), line(200, { temperature_c: 24 })];
    const result = evaluateRules({
      rules: [rule],
      state: { state: { r2: { fireCount: 0, watermark: lastSeen.timestamp } } },
      lines,
      now: new Date(T0 + 300_000),
    });
    expect(result.firings).toHaveLength(1);
    expect(result.firings[0]?.text).toContain("31");
  });

  it("does not advance past an outage, so the backlog is examined on recovery", () => {
    // A tick that could not read the log must not consume the window it never
    // saw; the event path already behaved this way because its floor came from
    // log lines rather than the clock.
    const seen = line(0);
    const during = evaluateRules({
      rules: [rule],
      state: { state: { r2: { fireCount: 0, watermark: seen.timestamp } } },
      lines: [],
      now: new Date(T0 + 300_000),
    });
    expect(during.nextState["r2"]?.watermark).toBe(seen.timestamp);

    const after = evaluateRules({
      rules: [rule],
      state: { state: during.nextState },
      lines: [seen, line(60, { temperature_c: 31 }), line(310, { temperature_c: 24 })],
      now: new Date(T0 + 600_000),
    });
    expect(after.firings).toHaveLength(1);
  });

  it("catches a spike that rose and recovered between two ticks", () => {
    // 5-minute ticks over a 10-second log: inspecting only the newest line
    // throws away 29 samples out of 30, so a kettle-length spike is on disk and
    // reported nowhere.
    const lines = [
      line(0, { temperature_c: 24 }),
      line(60, { temperature_c: 31 }),
      line(120, { temperature_c: 24 }),
    ];
    const result = evaluateRules({
      rules: [rule],
      state: { state: { r2: { fireCount: 0, watermark: line(0).timestamp } } },
      lines,
      now: new Date(T0 + 300_000),
    });
    expect(result.firings).toHaveLength(1);
    // Reports the peak and says it has since recovered -- "24C" would be a
    // meaningless alert and "31C" alone would imply it is still hot.
    expect(result.firings[0]?.text).toContain("31");
    expect(result.firings[0]?.text).toContain("back to 24");
  });

  it("stays silent rather than guessing when the channel has no samples", () => {
    const distanceRule: Rule = { ...rule, id: "r3", channel: "distance_mm", op: "<", value: 150 };
    const result = evaluateRules({
      rules: [distanceRule],
      state: emptyState,
      lines: [line(0, { distance_mm: -1 })], // sketch's "no ranging result"
      now: new Date(T0 + 1000),
    });
    expect(result.firings).toHaveLength(0);
    // Crucially not `fired: false` from a real reading -- a dead sensor must not
    // be recorded as a healthy one reading "not below threshold".
    expect(result.nextState["r3"]?.fired).toBeUndefined();
  });
});

describe("sustained rules", () => {
  const rule: Rule = {
    id: "s1",
    author: "system",
    createdAt: new Date(T0).toISOString(),
    expiresAt: null,
    enabled: true,
    kind: "sustained",
    channel: "temperature_c",
    op: ">",
    value: 25,
    forSeconds: 600,
  };

  it("does not fire when the hot window is shorter than required", () => {
    // Two hot samples a few seconds apart must not satisfy "hot for 10 minutes".
    const lines = [line(-30, { temperature_c: 26 }), line(-10, { temperature_c: 26 })];
    const result = evaluateRules({ rules: [rule], state: emptyState, lines, now: new Date(T0) });
    expect(result.firings).toHaveLength(0);
  });

  it("fires when every sample across the window satisfies the threshold", () => {
    const lines = Array.from({ length: 60 }, (_, i) => line(-600 + i * 10, { temperature_c: 26 }));
    const result = evaluateRules({ rules: [rule], state: emptyState, lines, now: new Date(T0) });
    expect(result.firings).toHaveLength(1);
  });

  it("does not fire when one sample in the window dipped below", () => {
    const lines = Array.from({ length: 60 }, (_, i) =>
      line(-600 + i * 10, { temperature_c: i === 30 ? 24 : 26 }),
    );
    const result = evaluateRules({ rules: [rule], state: emptyState, lines, now: new Date(T0) });
    expect(result.firings).toHaveLength(0);
  });
});

describe("state_duration rules", () => {
  const rule: Rule = {
    id: "d1",
    author: "system",
    createdAt: new Date(T0).toISOString(),
    expiresAt: null,
    enabled: true,
    kind: "state_duration",
    channel: "door",
    match: "door_open",
    forSeconds: 600,
  };

  it("fires once the state has been held long enough", () => {
    const result = evaluateRules({
      rules: [rule],
      state: emptyState,
      lines: [line(-900, { event: "door_open" })],
      now: new Date(T0),
    });
    expect(result.firings).toHaveLength(1);
    expect(result.firings[0]?.text).toContain("door_open");
  });

  it("does not fire when the closing edge came later", () => {
    const result = evaluateRules({
      rules: [rule],
      state: emptyState,
      lines: [line(-900, { event: "door_open" }), line(-800, { event: "door_closed" })],
      now: new Date(T0),
    });
    expect(result.firings).toHaveLength(0);
  });

  it("says so when the closing edge has never been logged at all", () => {
    // Live firmware emits door_open but no door_closed, so the duration is a
    // lower bound and the latch will never clear. Reporting "open for 7.9h"
    // without that caveat states a close was ruled out, which it wasn't.
    const lines = [line(-900, { event: "door_open" })];
    const result = evaluateRules({
      rules: [rule],
      state: emptyState,
      lines,
      now: new Date(T0),
      baselines: computeBaselines(lines),
    });
    expect(result.firings).toHaveLength(1);
    expect(result.firings[0]?.text).toContain("no door_closed has ever been logged");
  });

  it("drops the caveat once the board has proved it emits the closing edge", () => {
    const history = [
      line(-7200, { event: "door_open" }),
      line(-7100, { event: "door_closed" }),
      line(-900, { event: "door_open" }),
    ];
    const result = evaluateRules({
      rules: [rule],
      state: emptyState,
      lines: history,
      now: new Date(T0),
      baselines: computeBaselines(history),
    });
    expect(result.firings[0]?.text).not.toContain("never been logged");
  });
});

describe("staleness and lifecycle", () => {
  const staleRule: Rule = {
    id: "f1",
    author: "system",
    createdAt: new Date(T0).toISOString(),
    expiresAt: null,
    enabled: true,
    kind: "stale",
    forSeconds: 600,
  };

  it("fires when the feed has gone quiet", () => {
    const result = evaluateRules({
      rules: [staleRule],
      state: emptyState,
      lines: [line(-1200)],
      now: new Date(T0),
    });
    expect(result.firings).toHaveLength(1);
    expect(result.firings[0]?.text).toContain("silent");
  });

  it("reports events from the final window before announcing expiry", () => {
    // A door that opened four minutes before a 24h watch lapsed still happened
    // inside the watch. Emitting only the expiry notice loses it.
    const expiresAt = new Date(T0 + 60_000).toISOString();
    const expiring = doorRule({ expiresAt, armedAt: new Date(T0).toISOString() });
    const lines = [
      line(30, { event: "door_open" }), // inside the window
      line(90, { event: "door_open" }), // after expiry -- must NOT be reported
      line(100),
    ];
    const result = evaluateRules({
      rules: [expiring],
      state: emptyState,
      lines,
      now: new Date(T0 + 120_000),
    });
    expect(result.firings).toHaveLength(2);
    expect(result.firings[0]?.text).toContain("door_open");
    expect(result.firings[1]?.text).toContain("expired");
    // The count in the notice must include the final-window event.
    expect(result.firings[1]?.text).toContain("fired 1 time");
  });

  it("announces expiry exactly once, then goes permanently inert", () => {
    const expiring = doorRule({ expiresAt: new Date(T0 - 1000).toISOString(), note: "24h door watch" });
    const lines = [line(0, { event: "door_open" })];

    const first = evaluateRules({ rules: [expiring], state: emptyState, lines, now: new Date(T0) });
    expect(first.firings).toHaveLength(1);
    expect(first.firings[0]?.text).toContain("expired");
    expect(first.firings[0]?.text).toContain("24h door watch");

    const second = evaluateRules({
      rules: [expiring],
      state: { state: first.nextState },
      lines,
      now: new Date(T0 + 5000),
    });
    expect(second.firings).toHaveLength(0);
  });

  it("skips disabled rules without touching their state", () => {
    const muted = doorRule({ enabled: false });
    const prior = { r1: { fireCount: 7, watermark: line(-100).timestamp } };
    const result = evaluateRules({
      rules: [muted],
      state: { state: prior },
      lines: [line(0, { event: "door_open" })],
      now: new Date(T0 + 1000),
    });
    expect(result.firings).toHaveLength(0);
    // Re-enabling must resume, not replay: the watermark survives the mute.
    expect(result.nextState["r1"]).toEqual(prior.r1);
  });
});
