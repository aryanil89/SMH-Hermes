import { describe, expect, it, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { TelegramPoller, type InboundMessage } from "./telegram-poll.js";

/**
 * Exercises the real long-poll loop against a stub standing in for
 * api.telegram.org, because the failure modes that matter here -- a 409 from a
 * competing consumer, backlog skipping, allowlist filtering -- only appear when
 * the loop actually runs.
 */

let server: Server | undefined;

async function startStub(handler: (url: URL) => { status: number; body: unknown }): Promise<string> {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const { status, body } = handler(url);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error("timed out waiting for condition"));
      setTimeout(check, 10);
    };
    check();
  });
}

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
  server = undefined;
});

describe("TelegramPoller (loop)", () => {
  it("delivers a phone message and marks itself live", async () => {
    const apiBase = await startStub((url) => {
      // offset=-1 is the backlog-skipping prime call; return nothing so the
      // first real poll starts clean.
      if (url.searchParams.get("offset") === "-1") return { status: 200, body: { ok: true, result: [] } };
      return {
        status: 200,
        body: {
          ok: true,
          result: [
            {
              update_id: 41,
              message: {
                date: 1785000000,
                text: "whats the status of zone-east?",
                from: { id: 12345, first_name: "Chris" },
              },
            },
          ],
        },
      };
    });

    const received: InboundMessage[] = [];
    const poller = new TelegramPoller({
      token: "t",
      bot: "dedicated",
      apiBase,
      onMessage: (m) => received.push(m),
    });
    poller.start();

    await waitFor(() => received.length > 0);
    poller.stop();

    expect(received[0]?.text).toBe("whats the status of zone-east?");
    expect(received[0]?.from).toBe("Chris");
    expect(poller.getStatus().mode).toBe("live");
  });

  it("stops permanently on 409 instead of fighting the Hermes gateway", async () => {
    let calls = 0;
    const apiBase = await startStub(() => {
      calls += 1;
      return { status: 409, body: { ok: false, description: "terminated by other getUpdates request" } };
    });

    const poller = new TelegramPoller({ token: "t", bot: "shared", apiBase, onMessage: () => {} });
    poller.start();

    await waitFor(() => poller.getStatus().mode === "conflict");
    const callsAtConflict = calls;
    // Give it room to retry if it were going to; it must not.
    await new Promise((r) => setTimeout(r, 150));

    expect(poller.getStatus().mode).toBe("conflict");
    expect(poller.getStatus().detail).toContain("hermes gateway");
    expect(calls).toBe(callsAtConflict);
  });

  it("drops messages from ids outside the allowlist", async () => {
    // Serve the batch once and then go quiet, the way Telegram does after the
    // poller confirms them by advancing its offset.
    const apiBase = await startStub((url) => {
      const offset = url.searchParams.get("offset");
      if (offset === "-1" || (offset !== null && Number(offset) > 2)) {
        return { status: 200, body: { ok: true, result: [] } };
      }
      return {
        status: 200,
        body: {
          ok: true,
          result: [
            { update_id: 1, message: { text: "let me in", from: { id: 999, first_name: "Stranger" } } },
            { update_id: 2, message: { text: "status?", from: { id: 12345, first_name: "Chris" } } },
          ],
        },
      };
    });

    const received: InboundMessage[] = [];
    const poller = new TelegramPoller({
      token: "t",
      bot: "dedicated",
      apiBase,
      allowedUsers: ["12345"],
      onMessage: (m) => received.push(m),
    });
    poller.start();

    await waitFor(() => received.length > 0);
    poller.stop();

    // A display standing in front of an audience must not render text from
    // anyone who happens to find the bot.
    expect(received.map((m) => m.text)).toEqual(["status?"]);
  });

  it("skips the backlog so an old chat is not replayed as if it were live", async () => {
    const seen: string[] = [];
    const apiBase = await startStub((url) => {
      const offset = url.searchParams.get("offset");
      seen.push(offset ?? "none");
      if (offset === "-1") {
        return { status: 200, body: { ok: true, result: [{ update_id: 500, message: { text: "old" } }] } };
      }
      return { status: 200, body: { ok: true, result: [] } };
    });

    const received: InboundMessage[] = [];
    const poller = new TelegramPoller({
      token: "t",
      bot: "dedicated",
      apiBase,
      onMessage: (m) => received.push(m),
    });
    poller.start();

    await waitFor(() => seen.length >= 2);
    poller.stop();

    expect(received).toHaveLength(0);
    // Resumes just past the last known update rather than from the start.
    expect(seen[1]).toBe("501");
  });
});
