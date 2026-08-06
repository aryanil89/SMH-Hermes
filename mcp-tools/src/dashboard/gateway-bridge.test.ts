import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HermesGatewayBridge, mergeInbound, resolveHermesStateDb } from "./gateway-bridge.js";

/**
 * These run against a real SQLite file with Hermes's schema rather than a stub:
 * the whole point of the bridge is that it reads someone else's database
 * correctly, and a hand-rolled fake would only ever prove that it reads the fake.
 *
 * node:sqlite is Node 22.5+, and the package floor is Node 20, so the suite skips
 * itself rather than failing on an older runtime -- the same degradation the
 * bridge itself performs.
 */
const sqlite = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.(
  "node:sqlite",
) as { DatabaseSync: new (path: string, options?: unknown) => WritableDb } | undefined;

interface WritableDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown; all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
  close(): void;
}

const HERMES_SCHEMA = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    chat_id TEXT,
    started_at REAL NOT NULL
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,
    content TEXT,
    tool_name TEXT,
    timestamp REAL NOT NULL
  );
`;

const describeIf = sqlite ? describe : describe.skip;

describeIf("HermesGatewayBridge", () => {
  let dir: string;
  let dbPath: string;
  let db: WritableDb;
  let seq = 0;

  /** One transcript row, in the shape `hermes gateway` actually writes. */
  function say(role: string, content: string | null, opts: { session?: string; tool?: string } = {}): void {
    seq += 1;
    db.prepare("INSERT INTO messages (session_id, role, content, tool_name, timestamp) VALUES (?, ?, ?, ?, ?)").run(
      opts.session ?? "tg-1",
      role,
      content,
      opts.tool ?? null,
      1785967748 + seq,
    );
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "hermes-bridge-"));
    dbPath = join(dir, "state.db");
    db = new sqlite!.DatabaseSync(dbPath);
    db.exec(HERMES_SCHEMA);
    db.prepare("INSERT INTO sessions (id, source, chat_id, started_at) VALUES (?, ?, ?, ?)").run(
      "tg-1",
      "telegram",
      "8835805121",
      1785967748,
    );
    db.prepare("INSERT INTO sessions (id, source, chat_id, started_at) VALUES (?, ?, ?, ?)").run(
      "cli-1",
      "cli",
      null,
      1785967748,
    );
    seq = 0;
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("carries both directions verbatim, oldest first", async () => {
    say("user", "Is the door open?");
    say("assistant", "The door has been closed for 41 minutes.");

    const bridge = new HermesGatewayBridge({ dbPath, backfill: 10 });
    const drained = await bridge.drain();
    bridge.close();

    expect(drained.map((m) => [m.direction, m.text])).toEqual([
      ["inbound", "Is the door open?"],
      ["outbound", "The door has been closed for 41 minutes."],
    ]);
    expect(drained[0]?.kind).toBe("question");
    expect(drained[1]?.kind).toBe("reply");
    // Real transcript time, not "when the wall noticed" -- the panel prints it.
    expect(drained[0]?.at).toBe(new Date(1785967749 * 1000).toISOString());
  });

  it("drops tool traffic and internal markers, which never reached a phone", async () => {
    say("user", "What is the temperature");
    say("assistant", ""); // a tool-call turn
    say("tool", "<untrusted_tool_result source=\"get_environmental_status\">…", { tool: "env" });
    say("assistant", "[This response was interrupted by a user correction.]");
    say("session_meta", "{}");
    say("assistant", "23.1 °C, humidity 64.2 %RH.");

    const bridge = new HermesGatewayBridge({ dbPath, backfill: 10 });
    const drained = await bridge.drain();
    bridge.close();

    expect(drained.map((m) => m.text)).toEqual(["What is the temperature", "23.1 °C, humidity 64.2 %RH."]);
  });

  it("ignores sessions that are not the phone channel", async () => {
    say("user", "typed at the laptop", { session: "cli-1" });
    say("user", "typed on the phone");

    const bridge = new HermesGatewayBridge({ dbPath, backfill: 10 });
    const drained = await bridge.drain();
    bridge.close();

    expect(drained.map((m) => m.text)).toEqual(["typed on the phone"]);
  });

  it("emits each message once, and picks up new ones as they land", async () => {
    say("user", "first");

    const bridge = new HermesGatewayBridge({ dbPath, backfill: 10 });
    expect((await bridge.drain()).map((m) => m.text)).toEqual(["first"]);
    // A second drain with nothing new must not replay the thread -- the panel
    // appends, so a repeat would look like the on-call asked twice.
    expect(await bridge.drain()).toEqual([]);

    say("assistant", "second");
    expect((await bridge.drain()).map((m) => m.text)).toEqual(["second"]);

    bridge.close();
  });

  it("bounds the backfill and reports live", async () => {
    for (let i = 1; i <= 12; i += 1) say("user", `message ${i}`);

    const bridge = new HermesGatewayBridge({ dbPath, backfill: 3 });
    const drained = await bridge.drain();

    expect(drained.map((m) => m.text)).toEqual(["message 10", "message 11", "message 12"]);
    expect(bridge.getStatus().mode).toBe("live");
    expect(bridge.getStatus().bot).toBe("gateway");
    bridge.close();
  });

  it("advances past a long run of tool rows instead of rescanning them", async () => {
    say("user", "first");
    const bridge = new HermesGatewayBridge({ dbPath, backfill: 10, batchSize: 2 });
    await bridge.drain();

    for (let i = 0; i < 50; i += 1) say("tool", "…", { tool: "env" });
    expect(await bridge.drain()).toEqual([]);

    say("assistant", "after the tools");
    expect((await bridge.drain()).map((m) => m.text)).toEqual(["after the tools"]);
    bridge.close();
  });

  it("reports an unreadable transcript rather than throwing into the tick loop", async () => {
    const bridge = new HermesGatewayBridge({ dbPath: join(dir, "does-not-exist.db") });

    await expect(bridge.drain()).resolves.toEqual([]);
    expect(bridge.getStatus().mode).toBe("error");
    expect(bridge.getStatus().detail).toMatch(/does-not-exist\.db|sqlite|Node 22/i);
  });

  it("says what is missing when node:sqlite is unavailable", async () => {
    const bridge = new HermesGatewayBridge({ dbPath }, () => {
      throw new Error("Cannot find module 'node:sqlite'");
    });

    await expect(bridge.drain()).resolves.toEqual([]);
    expect(bridge.getStatus().detail).toContain("Node 22.5+");
  });
});

describe("resolveHermesStateDb", () => {
  it("is off when HERMES_BRIDGE=0, whatever else is set", () => {
    expect(resolveHermesStateDb({ HERMES_BRIDGE: "0", HERMES_STATE_DB: "C:/x/state.db" })).toBeUndefined();
  });

  it("honours an explicit path even when it is missing, so the panel can say why", () => {
    expect(resolveHermesStateDb({ HERMES_STATE_DB: "C:/nope/state.db" })).toBe("C:/nope/state.db");
  });

  it("follows HERMES_HOME, which is what the agent itself reads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hermes-home-"));
    await writeFile(join(dir, "state.db"), "");
    try {
      expect(resolveHermesStateDb({ HERMES_HOME: dir })).toBe(join(dir, "state.db"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("mergeInbound", () => {
  it("reports live when any source is live", () => {
    const merged = mergeInbound(
      { mode: "off", detail: "no bot", bot: "none" },
      { mode: "live", detail: "transcript", bot: "gateway" },
    );
    expect(merged?.mode).toBe("live");
    expect(merged?.bot).toBe("gateway");
  });

  it("prefers a real failure to silence, so the panel says why", () => {
    const merged = mergeInbound(
      { mode: "off", detail: "not configured", bot: "none" },
      { mode: "conflict", detail: "409", bot: "shared" },
    );
    expect(merged?.mode).toBe("conflict");
  });

  it("is undefined when there is no source at all", () => {
    expect(mergeInbound(undefined, undefined)).toBeUndefined();
  });
});
