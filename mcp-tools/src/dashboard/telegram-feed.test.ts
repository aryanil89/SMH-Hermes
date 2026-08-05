import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramFeed } from "./telegram-feed.js";
import type { EnvironmentalResult } from "../environmental/types.js";

function reading(overrides: Partial<EnvironmentalResult> = {}): EnvironmentalResult {
  return {
    temperatureC: 23.1,
    humidityPct: 64.2,
    leakDetected: false,
    status: "ok",
    source: "real",
    via: "file",
    ageSeconds: 4,
    generatedAt: "2026-08-04T19:10:00.000Z",
    ...overrides,
  };
}

describe("TelegramFeed", () => {
  let dir: string;
  let statePath: string;
  let feed: TelegramFeed;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "hermes-tg-"));
    statePath = join(dir, "environmental-watch.json");
    feed = new TelegramFeed({
      statePath,
      botLabel: "Hermes Ops",
      chatTitle: "On-call",
      ingestUrl: "http://127.0.0.1:7788/api/telegram",
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("attaches without inventing a delivery history", async () => {
    await writeFile(
      statePath,
      JSON.stringify({ lastStatus: "critical", lastAlertedAt: "2026-08-04T18:00:00.000Z" }),
    );

    const view = await feed.update(reading(), new Date("2026-08-04T19:10:00.000Z"));

    // One system line about attaching -- and nothing claiming the phone received
    // alerts that were sent before this process existed.
    expect(view.messages).toHaveLength(1);
    expect(view.messages[0]?.kind).toBe("system");
    expect(view.watchdog.lastStatus).toBe("critical");
    expect(view.watchdog.stateFound).toBe(true);
  });

  it("queues the alert the watchdog will send, marked undelivered", async () => {
    const now = new Date("2026-08-04T19:10:00.000Z");
    await feed.update(reading(), now);

    const view = await feed.update(reading({ status: "critical", leakDetected: true, leakVia: "event" }), now);

    expect(view.pending).toBeDefined();
    expect(view.pending?.delivered).toBe(false);
    expect(view.pending?.text).toContain("CRITICAL");
    expect(view.pending?.text).toContain("LEAK DETECTED (leak event)");
    // Still nothing in the thread: the watchdog has not run.
    expect(view.messages.filter((m) => m.kind === "alert")).toHaveLength(0);
  });

  it("promotes the queued text verbatim once the state file records a delivery", async () => {
    const now = new Date("2026-08-04T19:10:00.000Z");
    await feed.update(reading(), now);
    const queued = (await feed.update(reading({ status: "critical", leakDetected: true }), now))?.pending;

    await writeFile(
      statePath,
      JSON.stringify({ lastStatus: "critical", lastAlertedAt: "2026-08-04T19:11:00.000Z" }),
    );
    const view = await feed.update(
      reading({ status: "critical", leakDetected: true }),
      new Date("2026-08-04T19:11:30.000Z"),
    );

    const alert = view.messages.find((m) => m.kind === "alert");
    expect(alert?.delivered).toBe(true);
    expect(alert?.text).toBe(queued?.text);
    expect(alert?.origin).toBe("watchdog");
  });

  it("detects recovery from the status transition, not from lastAlertedAt", async () => {
    // The recovery path clears lastAlertedAt, so watching that field alone would
    // silently miss the "recovered to OK" push.
    await writeFile(
      statePath,
      JSON.stringify({ lastStatus: "critical", lastAlertedAt: "2026-08-04T19:00:00.000Z" }),
    );
    await feed.update(reading({ status: "critical" }), new Date("2026-08-04T19:10:00.000Z"));

    await writeFile(statePath, JSON.stringify({ lastStatus: "ok" }));
    const view = await feed.update(reading(), new Date("2026-08-04T19:12:00.000Z"));

    const recovery = view.messages.find((m) => m.kind === "recovery");
    expect(recovery?.delivered).toBe(true);
    expect(recovery?.text).toContain("recovered to OK");
  });

  it("carries ingested gateway traffic in both directions", async () => {
    const now = new Date("2026-08-04T19:10:00.000Z");
    await feed.update(reading(), now);

    feed.ingest({ direction: "inbound", text: "what is the temperature in rack B1?" });
    feed.ingest({ direction: "outbound", text: "23.1 C, humidity 64.2%." });
    const view = await feed.update(reading(), now);

    expect(view.ingestedCount).toBe(2);
    const inbound = view.messages.find((m) => m.direction === "inbound");
    expect(inbound?.kind).toBe("question");
    expect(inbound?.origin).toBe("gateway");
    expect(inbound?.delivered).toBe(true);
  });

  it("stays silent while the reading is ok", async () => {
    const now = new Date("2026-08-04T19:10:00.000Z");
    await feed.update(reading(), now);
    const view = await feed.update(reading(), now);

    expect(view.pending).toBeUndefined();
    expect(view.messages.filter((m) => m.kind !== "system")).toHaveLength(0);
  });

  it("says so when the watchdog has never run", async () => {
    const view = await feed.update(reading(), new Date("2026-08-04T19:10:00.000Z"));

    expect(view.watchdog.stateFound).toBe(false);
    expect(view.messages[0]?.text).toContain("No watchdog state file");
  });
});
