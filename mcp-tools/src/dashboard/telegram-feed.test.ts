import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramFeed } from "./telegram-feed.js";
import type { WatchRunner } from "./watch-health.js";
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
  /**
   * What the watchdog's health endpoint reports this tick. Mutable because the
   * delivery verdict on a watchdog page is drawn from here, not from the state
   * file, so the tests have to be able to move it between ticks.
   */
  let runner: WatchRunner;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "hermes-tg-"));
    statePath = join(dir, "environmental-watch.json");
    // A healthy loop that has delivered everything up to the far future, so the
    // tests that are not about delivery see pages settle as delivered.
    runner = { mode: "loop", canDeliver: true, lastMessageAt: "2099-01-01T00:00:00.000Z" };
    feed = new TelegramFeed({
      statePath,
      botLabel: "Hermes Ops",
      chatTitle: "On-call",
      ingestUrl: "http://127.0.0.1:7788/api/telegram",
      // Stubbed: the real probe opens a loopback socket, so without this the
      // suite's answer would depend on whether the developer happens to have a
      // watch loop running on port 7789.
      watchRunner: async () => runner,
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

  /**
   * The regression this whole delivery-confirmation path exists for.
   *
   * runWatchTick writes the state file before watch-loop attempts the send, and
   * the send failure path is swallowed so the loop survives a WiFi drop. Marking
   * the bubble delivered off the state file therefore paged nobody while the
   * wall said the on-call had been paged -- a false all-clear during exactly the
   * incident the panel exists for.
   */
  it("does not claim delivery when the watchdog's send failed", async () => {
    const now = new Date("2026-08-04T19:10:00.000Z");
    runner = {
      mode: "loop",
      canDeliver: true,
      lastDeliveryError: "fetch failed: ENOTFOUND api.telegram.org",
    };
    await feed.update(reading(), now);

    await writeFile(
      statePath,
      JSON.stringify({ lastStatus: "critical", lastAlertedAt: "2026-08-04T19:11:00.000Z" }),
    );
    const view = await feed.update(
      reading({ status: "critical", leakDetected: true }),
      new Date("2026-08-04T19:11:30.000Z"),
    );

    const alert = view.messages.find((m) => m.kind === "alert");
    expect(alert?.delivered).toBe(false);
    expect(alert?.text).toContain("[not delivered: fetch failed: ENOTFOUND api.telegram.org]");
  });

  it("promotes the page to delivered once the watchdog reports the send completed", async () => {
    const now = new Date("2026-08-04T19:10:00.000Z");
    runner = { mode: "loop", canDeliver: true };
    await feed.update(reading(), now);

    await writeFile(
      statePath,
      JSON.stringify({ lastStatus: "critical", lastAlertedAt: "2026-08-04T19:11:00.000Z" }),
    );
    const inflight = await feed.update(
      reading({ status: "critical", leakDetected: true }),
      new Date("2026-08-04T19:11:00.500Z"),
    );
    // The send is still in flight: recorded, but not asserted as delivered.
    expect(inflight.messages.find((m) => m.kind === "alert")?.delivered).toBe(false);
    expect(inflight.messages.find((m) => m.kind === "alert")?.text).toContain("not yet confirmed");

    runner = { mode: "loop", canDeliver: true, lastMessageAt: "2026-08-04T19:11:01.000Z" };
    const settled = await feed.update(
      reading({ status: "critical", leakDetected: true }),
      new Date("2026-08-04T19:11:02.000Z"),
    );

    const alert = settled.messages.find((m) => m.kind === "alert");
    expect(alert?.delivered).toBe(true);
    // Promoted verbatim -- the confirmation suffix is gone, not left stranded.
    expect(alert?.text).not.toContain("not yet confirmed");
    expect(alert?.text).toContain("CRITICAL");
  });

  it("says the loop cannot page rather than showing a delivered bubble", async () => {
    const now = new Date("2026-08-04T19:10:00.000Z");
    runner = { mode: "loop", canDeliver: false };
    await feed.update(reading(), now);

    await writeFile(
      statePath,
      JSON.stringify({ lastStatus: "critical", lastAlertedAt: "2026-08-04T19:11:00.000Z" }),
    );
    const view = await feed.update(
      reading({ status: "critical", leakDetected: true }),
      new Date("2026-08-04T19:11:30.000Z"),
    );

    const alert = view.messages.find((m) => m.kind === "alert");
    expect(alert?.delivered).toBe(false);
    expect(alert?.text).toContain("no Telegram credentials");
  });

  it("admits it cannot confirm delivery when no watch loop answers", async () => {
    const now = new Date("2026-08-04T19:10:00.000Z");
    runner = { mode: "unknown", detail: "nothing on the health port" };
    await feed.update(reading(), now);

    await writeFile(
      statePath,
      JSON.stringify({ lastStatus: "critical", lastAlertedAt: "2026-08-04T19:11:00.000Z" }),
    );
    const view = await feed.update(
      reading({ status: "critical", leakDetected: true }),
      new Date("2026-08-04T19:11:30.000Z"),
    );

    const alert = view.messages.find((m) => m.kind === "alert");
    expect(alert?.delivered).toBe(false);
    expect(alert?.text).toContain("delivery not confirmed");
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

  it("shows real pushes the server made, not just watchdog alerts", async () => {
    // The reported bug: an access challenge reached the on-call's phone while
    // this panel sat empty, because only the cron watchdog fed it.
    const sends = [
      { at: "2026-08-05T19:10:05.000Z", text: "ACCESS CRITICAL - zone-east", delivered: true },
    ];
    const withDrain = new TelegramFeed({
      statePath,
      botLabel: "Hermes Ops",
      chatTitle: "On-call",
      ingestUrl: "http://127.0.0.1:7788/api/telegram",
      drainOutbound: () => sends.splice(0, sends.length),
    });

    const view = await withDrain.update(reading(), new Date("2026-08-04T19:10:00.000Z"));

    const push = view.messages.find((m) => m.text.includes("ACCESS CRITICAL"));
    expect(push?.direction).toBe("outbound");
    expect(push?.delivered).toBe(true);
    expect(view.ingestedCount).toBe(1);
  });

  it("marks a failed push undelivered instead of claiming the on-call was paged", async () => {
    const sends = [
      {
        at: "2026-08-05T19:10:05.000Z",
        text: "ACCESS CRITICAL - zone-east",
        delivered: false,
        error: "fetch failed",
      },
    ];
    const withDrain = new TelegramFeed({
      statePath,
      botLabel: "Hermes Ops",
      chatTitle: "On-call",
      ingestUrl: "http://127.0.0.1:7788/api/telegram",
      drainOutbound: () => sends.splice(0, sends.length),
    });

    const view = await withDrain.update(reading(), new Date("2026-08-04T19:10:00.000Z"));

    const push = view.messages.find((m) => m.text.includes("ACCESS CRITICAL"));
    expect(push?.delivered).toBe(false);
    expect(push?.text).toContain("fetch failed");
  });

  it("reports an unconfigured inbound path rather than looking merely quiet", async () => {
    const view = await feed.update(reading(), new Date("2026-08-04T19:10:00.000Z"));

    expect(view.inbound.mode).toBe("off");
    expect(view.inbound.bot).toBe("none");
    expect(view.inbound.detail).toMatch(/TELEGRAM_WALL_BOT_TOKEN|api\/telegram/);
  });

  it("passes a live inbound status straight through", async () => {
    const withInbound = new TelegramFeed({
      statePath,
      botLabel: "Hermes Ops",
      chatTitle: "On-call",
      ingestUrl: "http://127.0.0.1:7788/api/telegram",
      inboundStatus: () => ({ mode: "live", detail: "long-polling getUpdates", bot: "dedicated" }),
    });

    const view = await withInbound.update(reading(), new Date("2026-08-04T19:10:00.000Z"));

    expect(view.inbound).toEqual({
      mode: "live",
      detail: "long-polling getUpdates",
      bot: "dedicated",
    });
  });

  it("says so when the watchdog has never run", async () => {
    const view = await feed.update(reading(), new Date("2026-08-04T19:10:00.000Z"));

    expect(view.watchdog.stateFound).toBe(false);
    expect(view.messages[0]?.text).toContain("No watchdog state file");
  });

  it("reports the watchdog cadence the loop declares, not a hard-coded one", async () => {
    const withLoop = new TelegramFeed({
      statePath,
      botLabel: "Hermes Ops",
      chatTitle: "On-call",
      ingestUrl: "http://127.0.0.1:7788/api/telegram",
      watchRunner: async () => ({
        mode: "loop" as const,
        intervalMs: 15000,
        canDeliver: true,
        lastTickAt: "2026-08-04T19:09:58.000Z",
      }),
    });

    const view = await withLoop.update(reading(), new Date("2026-08-04T19:10:00.000Z"));

    expect(view.watchdog.runner.mode).toBe("loop");
    expect(view.watchdog.runner.intervalMs).toBe(15000);
    expect(view.watchdog.runner.canDeliver).toBe(true);
  });

  it("does not claim a loop is running when nothing answers the health port", async () => {
    runner = { mode: "unknown", detail: "nothing on the health port" };
    const view = await feed.update(reading(), new Date("2026-08-04T19:10:00.000Z"));

    // "unknown", never a guessed interval: the alert path might be hermes cron,
    // or nothing at all, and the wall cannot tell those apart from out here.
    expect(view.watchdog.runner.mode).toBe("unknown");
    expect(view.watchdog.runner.intervalMs).toBeUndefined();
  });
});
