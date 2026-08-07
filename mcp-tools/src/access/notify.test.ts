import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { challengeText, drainSentNotifications, notifyChallenge, resetNotifications } from "./notify.js";
import type { AccessEvent } from "./types.js";

const event = (over: Partial<AccessEvent> = {}): AccessEvent => ({
  id: "acc_20260805T120000Z",
  at: "2026-08-05T12:00:00.000Z",
  zone: "zone-east",
  trigger: "object_entered",
  faces: [{ match: "unknown", name: null, similarity: 0.12 }],
  identityMethod: "qr-badge",
  doorOpenCount: 1,
  verdict: "challenge",
  severity: "warning",
  reasons: ["1 face detected, 1 not on the roster"],
  approval: { required: true, state: "pending" },
  ...over,
});

const realFetch = globalThis.fetch;

/** Let the fire-and-forget send settle without exposing a promise from the API. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  resetNotifications();
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
});

describe("challengeText", () => {
  it("says plainly that the message cannot authorise entry", () => {
    // The layering claim has to survive contact with the actual bytes sent: the
    // relay carries the question, never the answer.
    expect(challengeText(event())).toMatch(/cannot authorise entry/);
  });

  it("leads with severity and zone, then who", () => {
    const text = challengeText(event());
    expect(text.split("\n")[0]).toBe("ACCESS WARNING - zone-east");
    expect(text).toMatch(/1 unidentified person at the rack/);
  });

  it("names known people and counts unknown ones together", () => {
    const text = challengeText(
      event({
        faces: [
          { match: "known", name: "Lauren R", similarity: 0.8 },
          { match: "unknown", name: null, similarity: 0.1 },
        ],
        verdict: "tailgating",
        severity: "critical",
      }),
    );
    expect(text).toMatch(/ACCESS CRITICAL/);
    expect(text).toMatch(/1 unidentified person at the rack \(with Lauren R\)/);
  });

  it("describes a capture that resolved nobody without pretending it did", () => {
    expect(challengeText(event({ faces: [] }))).toMatch(/has not been identified/);
  });

  it("carries every reason, so the phone shows the same evidence as the wall", () => {
    const text = challengeText(event({ reasons: ["reason one", "reason two"] }));
    expect(text).toMatch(/- reason one/);
    expect(text).toMatch(/- reason two/);
  });
});

describe("notifyChallenge", () => {
  // None of these tests are about the network, but notifyChallenge fires a real
  // fetch the moment it has a token and a chat id. Stub it, then let every send
  // settle and drain the log before leaving -- a rejection from an unstubbed
  // fetch can land during a *later* test and put a phantom entry in its sent
  // log. That is not hypothetical: it made this file fail 326/327 on a
  // teammate's machine while passing here.
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch;
  });

  afterEach(async () => {
    await settle();
    drainSentNotifications();
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("is a silent no-op when unconfigured -- the default", () => {
    // Nothing in the access loop may depend on a messaging gateway existing.
    expect(notifyChallenge(event())).toBe(false);
  });

  it("does nothing with a token but no chat id", () => {
    expect(notifyChallenge(event(), { botToken: "t" })).toBe(false);
  });

  it("sends once per challenge, not once per tick", () => {
    // The sentry calls this from a 2s render loop. Without de-duplication a
    // person standing at a rack becomes a pager.
    const config = { botToken: "t", chatId: "c" };
    const e = event();
    expect(notifyChallenge(e, config)).toBe(true);
    expect(notifyChallenge(e, config)).toBe(false);
    expect(notifyChallenge(e, config)).toBe(false);
  });

  it("treats a new challenge as a new notification", () => {
    const config = { botToken: "t", chatId: "c" };
    expect(notifyChallenge(event({ id: "acc_a" }), config)).toBe(true);
    expect(notifyChallenge(event({ id: "acc_b" }), config)).toBe(true);
  });

  it("returns synchronously and never throws, even with no network", () => {
    // The WiFi-off beat guarantees this call fails. It must be invisible.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("fetch failed");
    }) as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const config = { botToken: "not-a-real-token", chatId: "0" };
    expect(() => notifyChallenge(event(), config)).not.toThrow();
  });
});

describe("sent-notification log (what the wall display shows)", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("records a successful push so the phone panel can show it", async () => {
    // The reported bug: an access challenge reached the on-call's phone while the
    // wall's Telegram panel stayed empty, because nothing told the panel.
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch;

    notifyChallenge(event(), { botToken: "t", chatId: "c" });
    await settle();

    const sent = drainSentNotifications();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.delivered).toBe(true);
    expect(sent[0]?.text).toMatch(/ACCESS WARNING - zone-east/);
  });

  it("records a failed push as undelivered rather than dropping it", async () => {
    // During the WiFi-off beat this WILL fail. The wall must show that the page
    // did not get through, not a confident outbound bubble.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("fetch failed");
    }) as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => {});

    notifyChallenge(event(), { botToken: "t", chatId: "c" });
    await settle();

    const sent = drainSentNotifications();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.delivered).toBe(false);
    expect(sent[0]?.error).toContain("fetch failed");
  });

  it("drains, so two readers cannot double-count one push", async () => {
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch;

    notifyChallenge(event(), { botToken: "t", chatId: "c" });
    await settle();

    expect(drainSentNotifications()).toHaveLength(1);
    expect(drainSentNotifications()).toHaveLength(0);
  });

  it("records nothing when Telegram is not configured", async () => {
    notifyChallenge(event(), {});
    await settle();

    expect(drainSentNotifications()).toHaveLength(0);
  });
});
